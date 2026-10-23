import crypto from 'crypto';
import { syncReminderSchedulesForEvents } from './_reminders.js';
import { organizerImageMeta } from './_images.js';
import {
  IMAGE_GRACE_DAYS,
  isOrganizerBlobImage,
  isStaleClientCopy,
  chooseImageForStaleClient,
  pickAutoImage,
  AUTO_IMAGE_KEYWORDS,
  autoImageIndex,
  autoImageKindOf,
  isMismatchedBorrowedImage
} from './_image-rules.js';
import { normalizeDaughterPeriods, applyDaughterPeriodChange } from './_daughter-periods.js';
import { readEventsDocument, writeEventsDocument, sortEvents, emptyDocument } from './_events-store.js';

// Reported on every GET so the live server build can be read straight from
// /api/events, rather than inferred from whether a save worked.
const API_BUILD = '2026-10-23-a';
// Which deployment answered. A wall display runs the same page for days; this
// is how it notices a deploy and reloads itself.
const DEPLOYMENT_ID = String(process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || '').trim();
const EVENTS_CACHE_MS = 60 * 1000;
// A save that keeps meeting a newer version is re-applied this many times.
const MAX_WRITE_ATTEMPTS = 4;
const WRITE_RETRY_DELAY_MS = 150;
// The last confirmed document: { updatedAt, events, daughterPeriods }.
let eventsCache = null;
let eventsCacheAt = 0;
// events.json's own URL. Screens watch it straight off the CDN, for free, to
// notice changes when the instant push below is not reaching them.
let eventsUrl = '';
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

// Reminder bookkeeping costs a Blob read on every save. A task that had no
// reminders before the save and has none after it has nothing to schedule or
// cancel, so it skips that read; the twice-daily cron still reconciles everything.
function usesReminders(event) {
  return Boolean(event?.emailReminder?.enabled) && reminderRecipients(event).length > 0;
}

const NO_REMINDERS_TO_SYNC = Object.freeze({ ok: true, skipped: 'This task has no email reminders.' });

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

// `updatedAt` is supplied by the caller and stays identical across every retry
// of one request, so a change re-applied after another save landed first is
// stored exactly as it would have been the first time.
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
  // Which kind of picture it is - 'fysio', 'lege', 'mr' - which is the kind of
  // the task it was borrowed from, not this task's own. Without it a lege photo
  // sitting on a fysio card reads as a fysio photo and is handed to every fysio
  // task after it. Travels with the borrow mark and dies with it.
  const inheritedKeyword = imageUrl === String(existing.imageUrl || '')
    ? String(existing.imageInheritedKeyword || input.imageInheritedKeyword || '')
    : String(input.imageInheritedKeyword || '');
  const imageInheritedKeyword = imageInheritedFrom && AUTO_IMAGE_KEYWORDS.includes(inheritedKeyword.trim().toLowerCase())
    ? inheritedKeyword.trim().toLowerCase()
    : '';
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
    imageInheritedKeyword,
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

function rememberEventsUrl(url) {
  if (url) eventsUrl = String(url);
}

// The base a mutation is built on must be the current document. Reads are
// consistent through the snapshot; only when a version has no snapshot and the
// CDN still holds an older copy is there nothing safe to build on, and then a
// 503 keeps the change queued on the device, which retries it.
async function readEventsForWrite() {
  const document = await readEventsDocument();
  rememberEventsUrl(document.url);
  if (!document.fresh) {
    throw httpError(503, 'The store is still answering with an older copy of the task list, so this change was not applied. It stays queued on this device and will retry.');
  }
  return document;
}

async function loadEvents(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (!force && eventsCache && now - eventsCacheAt < EVENTS_CACHE_MS) {
    return { ...eventsCache, fresh: true };
  }

  try {
    const document = await readEventsDocument();
    rememberEventsUrl(document.url);
    // A copy the store could not confirm as current is still worth answering
    // with, but it must not become this instance's truth for the next minute.
    if (document.fresh) return { ...rememberEventsCache(document), fresh: true };
    return { ...document, events: sortEvents(document.events), fresh: false };
  } catch (error) {
    console.warn('Serving cached events after a Blob read failure:', error);
    return { ...(eventsCache || emptyDocument()), fresh: false };
  }
}

function rememberEventsCache(document) {
  eventsCache = {
    updatedAt: String(document?.updatedAt || ''),
    events: sortEvents(Array.isArray(document?.events) ? document.events : []),
    daughterPeriods: normalizeDaughterPeriods(document?.daughterPeriods)
  };
  eventsCacheAt = Date.now();
  return eventsCache;
}

// Every write is a read-modify-write of one shared document. Two devices saving
// at once used to race - the slower one put back a copy built before the
// faster one landed - and the old guard against that re-read the document
// after every save. Now the save itself is conditional: it only lands if the
// stored version is still the one the change was built on. If another save got
// there first, the store refuses and the change is applied again on top of it.
//
// `apply(events, attempt, document)` receives the current snapshot and returns
// { events, daughterPeriods? }; leaving daughterPeriods out keeps the stored
// ones. It may run more than once, so it must not have side effects.
//
// Resolves to the stored document plus { verified, version }.
async function mutateEvents(apply) {
  const run = async () => {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const current = await readEventsForWrite();
      const { events, daughterPeriods } = await apply(current.events, attempt, current);
      const written = await writeEventsDocument({ events, daughterPeriods: daughterPeriods ?? current.daughterPeriods }, current);
      if (!written.conflict) {
        rememberEventsUrl(written.url);
        const stored = rememberEventsCache(written.document);
        return { ...stored, version: stored.updatedAt, verified: true };
      }
      console.warn(`events.json changed while this save was being made; re-applying (attempt ${attempt}/${MAX_WRITE_ATTEMPTS}).`);
      if (attempt < MAX_WRITE_ATTEMPTS) await sleep(WRITE_RETRY_DELAY_MS * attempt);
    }
    return { ...emptyDocument(), verified: false };
  };

  const queued = mutationChain.then(run, run);
  mutationChain = queued.then(() => undefined, () => undefined);
  return queued;
}

// 503 keeps the change in the phone's pending queue so it retries, instead of
// the client dropping it as a permanent failure. Only reached when other saves
// kept landing first, several times over.
function sendUnverified(res) {
  send(res, 503, { error: 'Other saves kept landing first, so this change was not applied yet. It stays queued on this device and will retry.' });
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

function hasAdminPin(req) {
  return Boolean(process.env.ADMIN_PIN) && req.headers['x-admin-pin'] === process.env.ADMIN_PIN;
}

// The ntfy.sh topic every screen listens on for "something changed" pings.
// A ping carries only a timestamp, never task contents, but anyone who knows
// the topic can send one and make the screens re-read, so it is derived from a
// server secret and only handed to requests that carry the admin PIN.
function syncTopic() {
  const secret = process.env.SYNC_TOPIC_SECRET || process.env.CRON_SECRET || process.env.BLOB_READ_WRITE_TOKEN || process.env.ADMIN_PIN || '';
  if (!secret) return '';
  const digest = crypto.createHmac('sha256', secret).update('homedash-sync-topic-v1').digest('hex');
  return `homedash-sync-${digest.slice(0, 32)}`;
}

// What every reply carries so a screen can keep itself in step: the document
// stamp (also the version it can stop watching for), the URL it can watch for
// free, and - for a PIN holder - where the instant pings arrive.
function syncFields(document, { withTopic = false } = {}) {
  return {
    build: API_BUILD,
    deployment: DEPLOYMENT_ID,
    updatedAt: String(document?.updatedAt || ''),
    version: String(document?.version || document?.updatedAt || ''),
    versionUrl: eventsUrl,
    ...(withTopic ? { syncTopic: syncTopic() } : {}),
    daughterPeriods: normalizeDaughterPeriods(document?.daughterPeriods)
  };
}

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
      const document = await loadEvents({ force: fresh });
      // `fresh: false` tells the screen this is the CDN's older copy: it keeps
      // what it has and asks again shortly, instead of treating it as current.
      // The push topic only goes into replies that are never cached.
      send(res, 200, { ...syncFields(document, { withTopic: fresh && hasAdminPin(req) }), events: document.events, fresh: document.fresh });
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
      // Set when the task's stored picture was a borrow from another kind and
      // was let go. The device is not being refused anything then: it sent back
      // a picture nobody had chosen.
      let imageReleased = false;
      // One stamp for the whole request, not one per attempt: a retry after
      // another save landed first writes the same event again.
      const writeStamp = new Date().toISOString();

      const outcome = await mutateEvents(async currentEvents => {
        const index = payload.id ? currentEvents.findIndex(item => item.id === payload.id) : -1;
        if (isPut && index === -1) throw httpError(404, 'Event not found.');
        previousEvent = index === -1 ? null : currentEvents[index];
        created = index === -1;
        const resolvedImageUrl = await resolveImageUrl(payload.imageUrl, previousEvent?.imageUrl, {
          stale: isStaleClientCopy(payload, previousEvent)
        });
        // A picture the task borrowed from another kind - a lege photo on a
        // fysio card, from back when kinds lent to each other - is nobody's
        // choice and is let go, so the borrow below can fill the slot with the
        // right kind or leave the placeholder. Only ever a borrowed picture,
        // and only one whose origin is known to be another kind.
        const byId = autoImageIndex(currentEvents);
        const keepsStoredImage = Boolean(previousEvent) && resolvedImageUrl === String(previousEvent.imageUrl || '');
        const releasesWrongKind = keepsStoredImage
          && isMismatchedBorrowedImage({ ...previousEvent, title: payload.title }, byId);
        if (releasesWrongKind) imageReleased = true;
        const imageUrl = releasesWrongKind ? '' : resolvedImageUrl;
        // A picture borrowed before the kind was written down keeps it now,
        // while the task it came from is still there to ask. Tracing the borrow
        // back is a fallback for old data, not a standing arrangement: once the
        // donor is deleted the origin can no longer be established at all.
        const stampsKeptKind = keepsStoredImage
          && !releasesWrongKind
          && Boolean(imageUrl)
          && Boolean(String(previousEvent.imageInheritedFrom || '').trim())
          && !String(previousEvent.imageInheritedKeyword || '').trim()
          ? autoImageKindOf(previousEvent, byId)
          : '';
        // A fysio, lege or MR task that ends up with no picture borrows one at
        // random from an older task of the same kind, framing included. This
        // only ever fills an empty slot: an image the device sent, or one the
        // task already had, has been decided above and is never overruled here.
        if (!imageUrl && !autoImage) {
          autoImage = await borrowImageForTitle({ title: payload.title, events: currentEvents, excludeId: payload.id });
        }
        const borrowed = imageUrl ? null : autoImage;
        event = cleanEvent(
          {
            ...payload,
            imageUrl,
            ...(borrowed
              ? { ...borrowed.image, imageInheritedFrom: borrowed.from, imageInheritedKeyword: borrowed.keyword }
              : stampsKeptKind
                ? { imageInheritedKeyword: stampsKeptKind }
                : {})
          },
          previousEvent || {},
          writeStamp
        );
        const nextEvents = [...currentEvents];
        if (index === -1) nextEvents.push(event);
        else nextEvents[index] = event;
        return { events: nextEvents };
      });

      if (!outcome.verified) {
        sendUnverified(res);
        return;
      }

      let next = outcome;
      const createdRecipientsToSend = created ? reminderRecipients(event) : newlyAddedReminderRecipients(previousEvent, event);
      const reminderSync = usesReminders(previousEvent) || usesReminders(event)
        ? await safeSyncReminders(next.events, {
          eventIds: [event.id],
          newEventIds: createdRecipientsToSend.length ? [event.id] : [],
          createdRecipientsByEvent: createdRecipientsToSend.length ? { [event.id]: createdRecipientsToSend } : {}
        })
        : NO_REMINDERS_TO_SYNC;
      const sentCreatedRecipients = reminderSync?.createdSentRecipientsByEvent?.[event.id] || [];
      if (sentCreatedRecipients.length) {
        markCreatedRecipients(event, sentCreatedRecipients);
        const stamped = await mutateEvents(async currentEvents => {
          const index = currentEvents.findIndex(item => String(item.id) === String(event.id));
          if (index === -1) return { events: currentEvents };
          const nextEvents = [...currentEvents];
          nextEvents[index] = { ...nextEvents[index], emailReminder: event.emailReminder };
          return { events: nextEvents };
        });
        if (stamped.verified) next = stamped;
      }

      // resolveImageUrl can quietly refuse an image URL (gone from Blob, or an
      // older picture sent by a stale device) and keep the stored one instead.
      // Say so in the reply, or the phone believes it just changed a picture
      // that it did not.
      // A borrowed fysio/lege/MR picture is not a refusal: the device asked for
      // no image at all, so nothing it sent was overruled. Neither is letting go
      // of a picture borrowed from another kind: the device only echoed back
      // what the task was already holding.
      const imageAutoFilled = Boolean(event.imageInheritedFrom) && (!requestedImageUrl || imageReleased);
      const imageUrlAccepted = String(event.imageUrl || '') === requestedImageUrl || imageAutoFilled || imageReleased;
      send(res, created ? 201 : 200, { ...syncFields(next, { withTopic: true }), event, events: next.events, localSaved: true, synced: true, idempotent: !created, imageUrlAccepted, imageAutoFilled, imageReleased, requestedImageUrl, imageCleanup: IMAGE_CLEANUP, reminderSync });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, `https://${req.headers.host}`);

      if (url.searchParams.get('all') === '1') {
        const outcome = await mutateEvents(async () => ({ events: [] }));
        if (!outcome.verified) {
          sendUnverified(res);
          return;
        }
        const reminderSync = await safeSyncReminders([], { all: true });
        // Clears the tasks only; the daughter periods are kept.
        send(res, 200, { ...syncFields(outcome, { withTopic: true }), events: [], localDeleted: true, synced: true, imageCleanup: IMAGE_CLEANUP, reminderSync });
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
        return { events: currentEvents.filter(item => item.id !== id) };
      });
      if (!outcome.verified) {
        sendUnverified(res);
        return;
      }
      const reminderSync = removedEvents.some(usesReminders)
        ? await safeSyncReminders(outcome.events, { eventIds: [id] })
        : NO_REMINDERS_TO_SYNC;
      send(res, 200, { ...syncFields(outcome, { withTopic: true }), events: outcome.events, localDeleted: true, synced: true, imageCleanup: IMAGE_CLEANUP, reminderSync });
      return;
    }

    // One change to the daughter periods, applied onto whatever the store holds
    // so edits to different periods from two screens both survive.
    if (req.method === 'PATCH') {
      const payload = parsePayload(await readBody(req));
      const change = payload.daughterPeriod;
      if (!change || typeof change !== 'object') throw httpError(400, 'Nothing to change was sent.');
      const outcome = await mutateEvents(async (currentEvents, attempt, current) => ({
        events: currentEvents,
        daughterPeriods: applyDaughterPeriodChange(current.daughterPeriods, change)
      }));
      if (!outcome.verified) {
        sendUnverified(res);
        return;
      }
      send(res, 200, { ...syncFields(outcome, { withTopic: true }), events: outcome.events, synced: true });
      return;
    }

    res.setHeader('Allow', 'GET, POST, PUT, PATCH, DELETE');
    send(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    // Only genuine validation problems are 4xx. Blob or network trouble has to
    // stay 5xx so the phone keeps the change queued and retries it instead of
    // discarding it as permanently rejected.
    send(res, Number(error?.statusCode) || 500, { error: error.message || 'Something went wrong.' });
  }
}
