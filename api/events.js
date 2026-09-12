import { head, put } from '@vercel/blob';
import crypto from 'crypto';
import { syncReminderSchedulesForEvents } from './_reminders.js';
import { organizerImageMeta } from './_images.js';
import {
  IMAGE_GRACE_DAYS,
  isOrganizerBlobImage,
  isBlobNotFoundError,
  isStaleClientCopy,
  chooseImageForStaleClient,
  pickAutoImage
} from './_image-rules.js';

const EVENTS_PATH = 'home-organizer/events.json';
// Reported on every GET so the live server build can be read straight from
// /api/events, rather than inferred from whether a save worked.
const API_BUILD = '2026-09-12-a';
const EVENTS_CACHE_MS = 60 * 1000;
const MAX_WRITE_ATTEMPTS = 3;
const MAX_READ_ATTEMPTS = 3;
const MAX_VERIFY_READS = 3;
const VERIFY_RETRY_DELAY_MS = 250;
// The function itself is cut off at 10 seconds (vercel.json), and a reply that
// never arrives is worse than one that says the store has not caught up: stop
// confirming in time to answer.
const WRITE_BUDGET_MS = 7000;
let eventsCache = null;
let eventsCacheAt = 0;
// Serializes mutations that land on the same warm instance so they cannot
// read-modify-write over each other locally.
let mutationChain = Promise.resolve();
const HARD_CODED_REMINDER_RECIPIENTS = new Set(['theresesaksgard@hotmail.com', 'diemetrix@gmail.com']);

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function httpError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parsePayload(body) {
  try {
    const parsed = JSON.parse(body || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object.');
    return parsed;
  } catch {
    throw httpError(400, 'Could not read the task that was sent.');
  }
}

function verifyAdmin(req, res) {
  if (!process.env.ADMIN_PIN) {
    send(res, 500, { error: 'ADMIN_PIN is missing. Add it in Vercel environment variables before writing events.' });
    return false;
  }
  const suppliedPin = req.headers['x-admin-pin'];
  if (suppliedPin !== process.env.ADMIN_PIN) {
    send(res, 401, { error: 'Wrong admin PIN.' });
    return false;
  }
  return true;
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanPercent(value, existingValue, fallback = null) {
  const raw = value ?? existingValue;
  const number = Number(raw);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number * 10) / 10));
}

function cleanPositiveInt(value, existingValue, fallback = 0) {
  const raw = value ?? existingValue;
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.round(number);
}

function cleanZoom(value, existingValue, fallback = 1.01) {
  const raw = value ?? existingValue;
  const number = Number(raw);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(1.8, Math.round(number * 100) / 100));
}

function normalizeFocusBox(value, existingValue = null) {
  const source = value && typeof value === 'object'
    ? value
    : existingValue && typeof existingValue === 'object'
      ? existingValue
      : null;
  if (!source) return null;
  const left = cleanPercent(source.left, null, 0);
  const top = cleanPercent(source.top, null, 0);
  const right = cleanPercent(source.right, null, 100);
  const bottom = cleanPercent(source.bottom, null, 100);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function normalizeDateKeys(values, existing = []) {
  const source = Array.isArray(values) ? values : existing;
  return [...new Set(source
    .map(value => String(value || '').slice(0, 10))
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
  )].slice(0, 1000);
}


function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function cleanEmailReminder(input = {}, existing = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const existingSource = existing && typeof existing === 'object' ? existing : {};
  const recipients = Array.isArray(source.recipients)
    ? [...new Set(source.recipients.map(cleanEmail).filter(email => isValidEmail(email) && HARD_CODED_REMINDER_RECIPIENTS.has(email)))].slice(0, 12)
    : Array.isArray(existingSource.recipients)
      ? [...new Set(existingSource.recipients.map(cleanEmail).filter(email => isValidEmail(email) && HARD_CODED_REMINDER_RECIPIENTS.has(email)))].slice(0, 12)
      : [];
  const creationEmailSentAt = String(source.creationEmailSentAt || existingSource.creationEmailSentAt || '').trim();
  const createdRecipientsSource = Array.isArray(source.createdRecipients)
    ? source.createdRecipients
    : Array.isArray(existingSource.createdRecipients)
      ? existingSource.createdRecipients
      : (creationEmailSentAt && Array.isArray(existingSource.recipients) ? existingSource.recipients : []);
  const createdRecipients = [...new Set(createdRecipientsSource.map(cleanEmail).filter(email => isValidEmail(email) && HARD_CODED_REMINDER_RECIPIENTS.has(email)))].slice(0, 60);
  return {
    enabled: Boolean(source.enabled ?? existingSource.enabled) && recipients.length > 0,
    recipients,
    creationEmailSentAt: /^\d{4}-\d{2}-\d{2}T/.test(creationEmailSentAt) ? creationEmailSentAt : '',
    createdRecipients
  };
}

async function safeSyncReminders(events, options) {
  try {
    return await syncReminderSchedulesForEvents(events, options);
  } catch (error) {
    return { ok: false, error: error.message || 'Reminder sync failed.' };
  }
}

function reminderRecipients(event) {
  return Array.isArray(event?.emailReminder?.recipients)
    ? [...new Set(event.emailReminder.recipients.map(cleanEmail).filter(email => isValidEmail(email) && HARD_CODED_REMINDER_RECIPIENTS.has(email)))]
    : [];
}

function reminderCreatedRecipients(event) {
  const reminder = event?.emailReminder || {};
  if (Array.isArray(reminder.createdRecipients) && reminder.createdRecipients.length) {
    return [...new Set(reminder.createdRecipients.map(cleanEmail).filter(email => isValidEmail(email) && HARD_CODED_REMINDER_RECIPIENTS.has(email)))];
  }
  if (reminder.creationEmailSentAt) return reminderRecipients(event);
  return [];
}

function newlyAddedReminderRecipients(previousEvent, nextEvent) {
  const previousCreated = new Set(reminderCreatedRecipients(previousEvent));
  return reminderRecipients(nextEvent).filter(email => !previousCreated.has(email));
}

function markCreatedRecipients(event, recipients) {
  const existing = reminderCreatedRecipients(event);
  const merged = [...new Set([...existing, ...(recipients || []).map(cleanEmail).filter(email => isValidEmail(email) && HARD_CODED_REMINDER_RECIPIENTS.has(email))])];
  event.emailReminder = {
    ...(event.emailReminder || {}),
    creationEmailSentAt: event.emailReminder?.creationEmailSentAt || new Date().toISOString(),
    createdRecipients: merged,
  };
}

// `updatedAt` must be supplied by the caller and stay identical across every
// retry of one request. It doubles as the write's verification token, so a
// fresh stamp per attempt would move the target the read-back is checked
// against and make a lagging read impossible to ever match.
function cleanEvent(input, existing = {}, updatedAt = new Date().toISOString()) {
  const id = existing.id || input.id || crypto.randomUUID();
  const title = String(input.title || '').trim().slice(0, 80);
  if (!title) throw httpError(400, 'Title is required.');

  const start = String(input.start || '').trim();
  if (!start || !parseDate(start)) throw httpError(400, 'Valid start date/time is required.');

  const end = String(input.end || '').trim();
  const imageUrl = String(input.imageUrl || '').trim();
  // A borrowed fysio/lege picture carries the id of the task it came from, so
  // a later borrow can prefer a photo somebody actually chose over one that is
  // already making the rounds. The mark lives and dies with the image it
  // describes: a task that gets a picture of its own loses it.
  const imageInheritedFrom = !imageUrl
    ? ''
    : imageUrl === String(existing.imageUrl || '')
      ? String(existing.imageInheritedFrom || input.imageInheritedFrom || '').trim().slice(0, 80)
      : String(input.imageInheritedFrom || '').trim().slice(0, 80);
  const imageFocusX = cleanPercent(input.imageFocusX, existing.imageFocusX, 50);
  const imageFocusY = cleanPercent(input.imageFocusY, existing.imageFocusY, 38);
  const imageFocusSource = String(input.imageFocusSource || existing.imageFocusSource || 'manual').trim().slice(0, 40);
  const imageZoom = cleanZoom(input.imageZoom, existing.imageZoom, 1.01);
  const imageFocusBox = normalizeFocusBox(input.imageFocusBox, existing.imageFocusBox);
  const imageNaturalWidth = cleanPositiveInt(input.imageNaturalWidth, existing.imageNaturalWidth, 0);
  const imageNaturalHeight = cleanPositiveInt(input.imageNaturalHeight, existing.imageNaturalHeight, 0);
  const allowedRepeats = new Set(['none', 'yearly', 'weekly', 'biweekly']);
  const repeat = allowedRepeats.has(String(input.repeat || existing.repeat || 'none'))
    ? String(input.repeat || existing.repeat || 'none')
    : 'none';
  const emailReminder = cleanEmailReminder(input.emailReminder, existing.emailReminder);

  // Repeatable tasks are stored as ONE master task.
  // completedDates/excludedDates describe individual virtual occurrences.
  return {
    id,
    title,
    start,
    end: end && parseDate(end) ? end : '',
    repeat,
    completed: Boolean(input.completed ?? existing.completed ?? false),
    completedDates: normalizeDateKeys(input.completedDates, Array.isArray(existing.completedDates) ? existing.completedDates : []),
    excludedDates: normalizeDateKeys(input.excludedDates, Array.isArray(existing.excludedDates) ? existing.excludedDates : []),
    location: String(input.location || '').trim().slice(0, 90),
    note: String(input.note || '').trim().slice(0, 300),
    imageUrl,
    imageInheritedFrom,
    imageFocusX,
    imageFocusY,
    imageFocusSource,
    imageZoom,
    imageFocusBox,
    imageNaturalWidth,
    imageNaturalHeight,
    featured: Boolean(input.featured ?? existing.featured),
    emailReminder,
    updatedAt,
    createdAt: existing.createdAt || new Date().toISOString()
  };
}

function sortEvents(events) {
  return [...events].sort((a, b) => new Date(a.start) - new Date(b.start));
}

// Reads the authoritative copy, or throws. Never falls back to a cached array:
// a caller that is about to overwrite the whole file must not build on a guess.
//
// The blob URL is CDN-backed and the path is reused on every overwrite, so the
// edge can still replay a previous version of events.json. `cache: 'no-store'`
// only governs this process's own fetch cache, not that CDN, so every read has
// to bust it with a unique query string (same trick as _reminders.js).
// Reads the document and says whether it is really the current version. head()
// comes from the Blob API and carries the authoritative byte length; the
// contents come from the CDN, which can still hand back the copy from before
// the last write even with a unique query string on the URL. When the two
// disagree the CDN is replaying an older version, and `fresh` says so.
//
// This matters most on the write path. A save that builds on a replayed copy
// does not merely miss a task: it writes the whole document back without the
// tasks that were added since, and answers 404 for a task that plainly exists.
async function readEventsDocument() {
  let meta;
  let text = '';
  let fresh = false;

  for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
    try {
      meta = await head(EVENTS_PATH);
    } catch (error) {
      if (isBlobNotFoundError(error)) return { updatedAt: '', events: [], fresh: true };
      throw error;
    }
    const bust = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const response = await fetch(`${meta.url}?v=${bust}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read events.json from Blob (${response.status}).`);
    text = await response.text();
    fresh = Buffer.byteLength(text, 'utf8') === Number(meta.size);
    if (fresh) break;
    console.warn(`events.json came back as an older copy than the store holds; re-reading (attempt ${attempt}/${MAX_READ_ATTEMPTS}).`);
    if (attempt < MAX_READ_ATTEMPTS) await sleep(VERIFY_RETRY_DELAY_MS * attempt);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('events.json from Blob could not be read as JSON.');
  }
  // The document's own stamp is what tells a read that has not caught up yet
  // (an older copy) apart from another device's newer write.
  return {
    updatedAt: String(parsed?.updatedAt || ''),
    events: Array.isArray(parsed?.events) ? parsed.events : [],
    fresh
  };
}

// The base a mutation is built on must be the current document. Rewriting the
// whole file from a replayed copy is how tasks and pictures disappear, so a
// read that cannot be confirmed stops the write instead. 503 keeps the change
// queued on the device, which then retries it.
async function readEventsForWrite() {
  const document = await readEventsDocument();
  if (!document.fresh) {
    throw httpError(503, 'The store is still answering with an older copy of the task list, so this change was not applied. It stays queued on this device and will retry.');
  }
  return document.events;
}

async function readEventsFromBlob() {
  return (await readEventsDocument()).events;
}

async function loadEvents(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (!force && Array.isArray(eventsCache) && now - eventsCacheAt < EVENTS_CACHE_MS) {
    return eventsCache;
  }

  try {
    const document = await readEventsDocument();
    // A copy the store could not confirm as current is still worth answering
    // with, but it must not become this instance's truth for the next minute.
    return document.fresh ? rememberEventsCache(document.events) : sortEvents(document.events);
  } catch (error) {
    console.warn('Serving cached events after a Blob read failure:', error);
    return Array.isArray(eventsCache) ? eventsCache : [];
  }
}

function rememberEventsCache(events) {
  eventsCache = sortEvents(events);
  eventsCacheAt = Date.now();
  return eventsCache;
}

// Returns what was written - the document stamp and its exact byte length -
// so the write can be confirmed against the store's own metadata afterwards.
async function saveEvents(events) {
  const sorted = sortEvents(events);
  const stamp = new Date().toISOString();
  const body = JSON.stringify({ updatedAt: stamp, events: sorted }, null, 2);
  await put(EVENTS_PATH, body, {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 0
  });
  rememberEventsCache(sorted);
  return { stamp, bytes: Buffer.byteLength(body, 'utf8'), events: sorted };
}

// Does the store hold the bytes we just wrote? head() answers from the Blob
// API, not from the CDN that serves the file's contents, so unlike a read of
// the document itself it can never be a cached replay of an older version. A
// byte length equal to what we wrote means our document is the one in the
// store - or a byte-identical one from another device, which says the same
// thing about our change.
async function writtenDocumentIsStored(written) {
  try {
    const meta = await head(EVENTS_PATH);
    return Number(meta?.size) === written.bytes;
  } catch (error) {
    // Metadata we could not read proves nothing either way; the content
    // read-back below decides.
    if (!isBlobNotFoundError(error)) console.warn('Could not read events.json metadata after writing:', error);
    return false;
  }
}

// Was the write kept? Three answers, and they need opposite handling:
//
//   'stored'  - the store holds our document, or a document carrying our
//               change. Done.
//   'lagging' - the put succeeded and every read still answers with a copy
//               OLDER than the one we just wrote. Nothing has replaced our
//               write; a read is simply behind. Writing again cannot fix a
//               read, and this is what used to be reported to the phone as
//               "another device saved at the same time", leaving a change
//               queued forever that the server had in fact stored.
//   'lost'    - a document NEWER than ours is stored and it does not carry
//               our change. Another device really did overwrite us, and the
//               change has to be re-applied onto the winner's snapshot.
async function confirmWrite(written, verify, deadline) {
  for (let attempt = 1; attempt <= MAX_VERIFY_READS; attempt += 1) {
    if (await writtenDocumentIsStored(written)) return { status: 'stored', events: written.events };

    const saved = await readEventsDocument();
    if (typeof verify !== 'function' || verify(saved.events)) {
      // Return what the store holds so the reply carries any concurrent change
      // from another device too.
      return { status: 'stored', events: saved.events };
    }
    if (saved.updatedAt && saved.updatedAt >= written.stamp) return { status: 'lost', events: saved.events };
    if (Date.now() >= deadline) break;
    if (attempt < MAX_VERIFY_READS) await sleep(VERIFY_RETRY_DELAY_MS * attempt);
  }
  // Only ever saw copies older than our own write, so nothing has replaced it.
  return { status: 'lagging', events: written.events };
}

// Every write is a read-modify-write over one shared document, so two devices
// saving at once race: the slower one bases its copy on a snapshot taken before
// the faster one landed and puts it back, silently erasing the other device's
// task. Guard that by confirming each put and re-applying the change onto the
// winner's snapshot when ours did not survive.
//
// `apply` receives the freshest snapshot and returns { events, verify }, where
// verify(savedEvents) reports whether this change is present in what the store
// actually kept. It may run more than once, so it must not have side effects.
async function mutateEvents(apply) {
  const run = async () => {
    let outcome = null;
    const deadline = Date.now() + WRITE_BUDGET_MS;
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const current = await readEventsForWrite();
      const { events, verify } = await apply(current, attempt);
      const written = await saveEvents(events);
      outcome = { events: written.events, verified: false };

      const confirmation = await confirmWrite(written, verify, deadline);
      if (confirmation.status === 'stored') {
        return { events: rememberEventsCache(confirmation.events), verified: true };
      }
      if (confirmation.status === 'lagging') {
        // The put succeeded, nothing newer has replaced it, and only the
        // reading side is behind. Rewriting would put the same bytes back and
        // ask the same question again; telling the device to retry would have
        // it do that every 15 seconds forever. Report it as written.
        console.warn('events.json was written but the read-back is still behind; accepting the write.');
        return { events: rememberEventsCache(written.events), verified: true, lagging: true };
      }
      console.warn(`events.json was overwritten by another write; re-applying (attempt ${attempt}/${MAX_WRITE_ATTEMPTS}).`);
      if (Date.now() >= deadline) break;
      if (attempt < MAX_WRITE_ATTEMPTS) await sleep(VERIFY_RETRY_DELAY_MS * attempt);
    }
    return outcome || { events: [], verified: false };
  };

  const queued = mutationChain.then(run, run);
  mutationChain = queued.then(() => undefined, () => undefined);
  return queued;
}

// Is this change present in what the store kept? Two tabs of the same phone can
// send the same queued change twice; each request stamps it with its own
// `updatedAt`, so the copy that is stored can be the same change under a
// different stamp. Re-writing over that only starts the race again, so compare
// the content too.
function sameEventContent(a, b) {
  const withoutStamp = event => {
    const { updatedAt, ...rest } = event || {};
    return JSON.stringify(rest);
  };
  return withoutStamp(a) === withoutStamp(b);
}

function eventSurvived(savedEvents, event) {
  return (savedEvents || []).some(item => String(item.id) === String(event.id)
    && (item.updatedAt === event.updatedAt || sameEventContent(item, event)));
}

// 503 keeps the change in the phone's pending queue so it retries, instead of
// the client dropping it as a permanent failure.
function sendUnverified(res) {
  send(res, 503, { error: 'Another device saved at the same time and the change could not be confirmed. It stays queued on this device and will retry.' });
}

// Two devices can edit the same event. Device A replaces the image; device B,
// still holding the old copy, then re-sends the whole task (marks it done,
// moves its date, adds a reminder) with the old URL. Two guards keep that from
// undoing A's change:
//
//  1. A copy older than what the server holds may not swap the image for an
//     older one, or clear it. It may still bring a genuinely newer upload,
//     which is how a resync from a stale device keeps working.
//  2. An organizer URL that no longer exists in Blob is never accepted: keep
//     the stored image, or fall back to none.
async function resolveImageUrl(inputUrl, existingUrl, options = {}) {
  const requested = String(inputUrl || '').trim();
  const current = String(existingUrl || '').trim();

  if (options.stale && current && requested !== current && isOrganizerBlobImage(current)) {
    const currentMeta = await organizerImageMeta(current);
    const requestedMeta = isOrganizerBlobImage(requested) ? await organizerImageMeta(requested) : null;
    const kept = chooseImageForStaleClient({ requested, current, requestedMeta, currentMeta });
    if (kept !== null) return kept;
  }

  if (!isOrganizerBlobImage(requested)) return requested;
  if ((await organizerImageMeta(requested)).exists) return requested;
  if (current && current !== requested && (!isOrganizerBlobImage(current) || (await organizerImageMeta(current)).exists)) {
    return current;
  }
  return '';
}

// Picks a picture for a fysio/lege task that arrived without one, and only ever
// returns a link the store really still answers for. Handing a dead link to a
// new task is precisely how a placeholder spreads from one card to the next.
// The lookups only happen on the borrow path, which is rare and short.
async function borrowImageForTitle({ title, events, excludeId }) {
  const skipUrls = new Set();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = pickAutoImage({ title, events, excludeId, skipUrls });
    if (!candidate) return null;
    const url = String(candidate.image?.imageUrl || '');
    if (!isOrganizerBlobImage(url) || (await organizerImageMeta(url)).exists) return candidate;
    skipUrls.add(url);
  }
  return null;
}

// Old images are no longer deleted on the write path. The cron sweeps images
// that no task has referenced for IMAGE_GRACE_DAYS, so a picture lost to a bad
// save stays recoverable from the Blob store for that long. This also takes
// the slowest, least reversible step out of the 10-second write budget.
const IMAGE_CLEANUP = Object.freeze({ deferred: true, gracePeriodDays: IMAGE_GRACE_DAYS });

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, `https://${req.headers.host}`);
      const fresh = url.searchParams.get('fresh') === '1';
      // stale-while-revalidate used to run for a full day, so a client that
      // never asks for fresh=1 could be served yesterday's task list.
      res.setHeader(
        'Cache-Control',
        fresh
          ? 'no-store, max-age=0'
          : 'public, max-age=30, s-maxage=30, stale-while-revalidate=60'
      );
      send(res, 200, { build: API_BUILD, events: await loadEvents({ force: fresh }) });
      return;
    }

    if (!verifyAdmin(req, res)) return;

    if (req.method === 'POST' || req.method === 'PUT') {
      const payload = parsePayload(await readBody(req));
      const isPut = req.method === 'PUT';
      const requestedImageUrl = String(payload.imageUrl || '').trim();
      let previousEvent = null;
      let event = null;
      let created = false;
      // Picked once, not once per write attempt, so a retry stores the same
      // picture the first attempt chose instead of rolling the dice again.
      let autoImage = null;
      // One stamp for the whole request, not one per attempt: every retry then
      // writes a byte-identical event, so a read-back that is one generation
      // behind still confirms the change instead of reporting it as lost.
      const writeStamp = new Date().toISOString();

      const outcome = await mutateEvents(async currentEvents => {
        const index = payload.id ? currentEvents.findIndex(item => item.id === payload.id) : -1;
        if (isPut && index === -1) throw httpError(404, 'Event not found.');
        previousEvent = index === -1 ? null : currentEvents[index];
        created = index === -1;
        const imageUrl = await resolveImageUrl(payload.imageUrl, previousEvent?.imageUrl, {
          stale: isStaleClientCopy(payload, previousEvent)
        });
        // A fysio or lege task that ends up with no picture borrows one at
        // random from an older task of the same kind, framing included. This
        // only ever fills an empty slot: an image the device sent, or one the
        // task already had, has been decided above and is never overruled here.
        if (!imageUrl && !autoImage) {
          autoImage = await borrowImageForTitle({ title: payload.title, events: currentEvents, excludeId: payload.id });
        }
        const borrowed = imageUrl ? null : autoImage;
        event = cleanEvent(
          { ...payload, imageUrl, ...(borrowed ? { ...borrowed.image, imageInheritedFrom: borrowed.from } : {}) },
          previousEvent || {},
          writeStamp
        );
        const nextEvents = [...currentEvents];
        if (index === -1) nextEvents.push(event);
        else nextEvents[index] = event;
        return { events: nextEvents, verify: saved => eventSurvived(saved, event) };
      });

      if (!outcome.verified) {
        sendUnverified(res);
        return;
      }

      let next = outcome.events;
      const createdRecipientsToSend = created ? reminderRecipients(event) : newlyAddedReminderRecipients(previousEvent, event);
      const reminderSync = await safeSyncReminders(next, {
        eventIds: [event.id],
        newEventIds: createdRecipientsToSend.length ? [event.id] : [],
        createdRecipientsByEvent: createdRecipientsToSend.length ? { [event.id]: createdRecipientsToSend } : {}
      });
      const sentCreatedRecipients = reminderSync?.createdSentRecipientsByEvent?.[event.id] || [];
      if (sentCreatedRecipients.length) {
        markCreatedRecipients(event, sentCreatedRecipients);
        const stamped = await mutateEvents(async currentEvents => {
          const index = currentEvents.findIndex(item => String(item.id) === String(event.id));
          if (index === -1) return { events: currentEvents };
          const nextEvents = [...currentEvents];
          nextEvents[index] = { ...nextEvents[index], emailReminder: event.emailReminder };
          return {
            events: nextEvents,
            verify: saved => saved.some(item => String(item.id) === String(event.id)
              && item.emailReminder?.creationEmailSentAt === event.emailReminder.creationEmailSentAt)
          };
        });
        if (stamped.verified) next = stamped.events;
      }

      // resolveImageUrl can quietly refuse an image URL (gone from Blob, or an
      // older picture sent by a stale device) and keep the stored one instead.
      // Say so in the reply, or the phone believes it just changed a picture
      // that it did not.
      // A borrowed fysio/lege picture is not a refusal: the device asked for no
      // image at all, so nothing it sent was overruled.
      const imageAutoFilled = Boolean(event.imageInheritedFrom) && !requestedImageUrl;
      const imageUrlAccepted = String(event.imageUrl || '') === requestedImageUrl || imageAutoFilled;
      send(res, created ? 201 : 200, { build: API_BUILD, event, events: next, localSaved: true, synced: true, idempotent: !created, imageUrlAccepted, imageAutoFilled, requestedImageUrl, imageCleanup: IMAGE_CLEANUP, reminderSync });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, `https://${req.headers.host}`);

      if (url.searchParams.get('all') === '1') {
        const outcome = await mutateEvents(async () => ({ events: [], verify: saved => saved.length === 0 }));
        if (!outcome.verified) {
          sendUnverified(res);
          return;
        }
        const reminderSync = await safeSyncReminders([], { all: true });
        send(res, 200, { events: [], localDeleted: true, synced: true, imageCleanup: IMAGE_CLEANUP, reminderSync });
        return;
      }

      const id = url.searchParams.get('id');
      let removedEvents = [];
      const outcome = await mutateEvents(async currentEvents => {
        const matches = currentEvents.filter(item => item.id === id);
        // A retry that no longer finds the task has already reached its goal,
        // so only the first pass may report it as missing.
        if (!matches.length && !removedEvents.length) throw httpError(404, 'Event not found.');
        if (matches.length) removedEvents = matches;
        return {
          events: currentEvents.filter(item => item.id !== id),
          verify: saved => !saved.some(item => String(item.id) === String(id))
        };
      });
      if (!outcome.verified) {
        sendUnverified(res);
        return;
      }
      const next = outcome.events;
      const reminderSync = await safeSyncReminders(next, { eventIds: [id] });
      send(res, 200, { events: next, localDeleted: true, synced: true, imageCleanup: IMAGE_CLEANUP, reminderSync });
      return;
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    send(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    // Only genuine validation problems are 4xx. Blob or network trouble has to
    // stay 5xx so the phone keeps the change queued and retries it instead of
    // discarding it as permanently rejected.
    send(res, Number(error?.statusCode) || 500, { error: error.message || 'Something went wrong.' });
  }
}
