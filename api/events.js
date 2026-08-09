import { head, put, del } from '@vercel/blob';
import crypto from 'crypto';
import { syncReminderSchedulesForEvents } from './_reminders.js';

const EVENTS_PATH = 'home-organizer/events.json';
const EVENTS_CACHE_MS = 60 * 1000;
const MAX_WRITE_ATTEMPTS = 3;
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

function cleanEvent(input, existing = {}) {
  const id = existing.id || input.id || crypto.randomUUID();
  const title = String(input.title || '').trim().slice(0, 80);
  if (!title) throw httpError(400, 'Title is required.');

  const start = String(input.start || '').trim();
  if (!start || !parseDate(start)) throw httpError(400, 'Valid start date/time is required.');

  const end = String(input.end || '').trim();
  const imageUrl = String(input.imageUrl || '').trim();
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
    imageFocusX,
    imageFocusY,
    imageFocusSource,
    imageZoom,
    imageFocusBox,
    imageNaturalWidth,
    imageNaturalHeight,
    featured: Boolean(input.featured ?? existing.featured),
    emailReminder,
    updatedAt: new Date().toISOString(),
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
async function readEventsFromBlob() {
  let meta;
  try {
    meta = await head(EVENTS_PATH);
  } catch (error) {
    if (isBlobNotFoundError(error)) return [];
    throw error;
  }
  const bust = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const response = await fetch(`${meta.url}?v=${bust}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not read events.json from Blob (${response.status}).`);
  const parsed = await response.json();
  return Array.isArray(parsed?.events) ? parsed.events : [];
}

async function loadEvents(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (!force && Array.isArray(eventsCache) && now - eventsCacheAt < EVENTS_CACHE_MS) {
    return eventsCache;
  }

  try {
    return rememberEventsCache(await readEventsFromBlob());
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

async function saveEvents(events) {
  const sorted = sortEvents(events);
  await put(EVENTS_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), events: sorted }, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 0
  });
  rememberEventsCache(sorted);
}

// Every write is a read-modify-write over one shared document, so two devices
// saving at once race: the slower one bases its copy on a snapshot taken before
// the faster one landed and puts it back, silently erasing the other device's
// task. Guard that by reading the file back after each put and re-applying the
// change onto the winner's snapshot when ours did not survive.
//
// `apply` receives the freshest snapshot and returns { events, verify }, where
// verify(savedEvents) reports whether this change is present in what the store
// actually kept. It may run more than once, so it must not have side effects.
async function mutateEvents(apply) {
  const run = async () => {
    let outcome = null;
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const current = await readEventsFromBlob();
      const { events, verify } = await apply(current, attempt);
      const next = sortEvents(events);
      await saveEvents(next);
      outcome = { events: next, verified: false };

      const saved = await readEventsFromBlob();
      if (typeof verify !== 'function' || verify(saved)) {
        // Return what the store actually holds so the reply carries any
        // concurrent change from another device too.
        return { events: rememberEventsCache(saved), verified: true };
      }
      console.warn(`events.json was overwritten by a concurrent write; retrying (attempt ${attempt}/${MAX_WRITE_ATTEMPTS}).`);
    }
    return outcome || { events: [], verified: false };
  };

  const queued = mutationChain.then(run, run);
  mutationChain = queued.then(() => undefined, () => undefined);
  return queued;
}

function eventSurvived(savedEvents, event) {
  return (savedEvents || []).some(item => String(item.id) === String(event.id) && item.updatedAt === event.updatedAt);
}

// 503 keeps the change in the phone's pending queue so it retries, instead of
// the client dropping it as a permanent failure.
function sendUnverified(res) {
  send(res, 503, { error: 'Another device saved at the same time and the change could not be confirmed. It stays queued on this device and will retry.' });
}

function isOrganizerBlobImage(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.startsWith('home-organizer/images/')) return true;
  try {
    const url = new URL(text);
    return url.pathname.includes('/home-organizer/images/');
  } catch {
    return text.includes('home-organizer/images/');
  }
}

function isBlobNotFoundError(error) {
  return String(error?.name || '') === 'BlobNotFoundError'
    || /does not exist|not.?found/i.test(String(error?.message || ''));
}

async function organizerImageExists(url) {
  try {
    await head(url);
    return true;
  } catch (error) {
    if (isBlobNotFoundError(error)) return false;
    // Transient blob/network error: assume the image is still there rather
    // than dropping a live reference.
    return true;
  }
}

// Two devices can edit the same event: device A replaces the image (the old
// blob gets deleted below), then device B re-sends the event with the old,
// now-deleted URL from its stale local copy. Without this check that stale
// write would point the event at a dead blob AND trigger deletion of the
// image device A just uploaded. Never accept an organizer blob URL that no
// longer exists: keep the currently stored image, or fall back to none.
async function resolveImageUrl(inputUrl, existingUrl) {
  const requested = String(inputUrl || '').trim();
  if (!isOrganizerBlobImage(requested)) return requested;
  if (await organizerImageExists(requested)) return requested;
  const current = String(existingUrl || '').trim();
  if (current && current !== requested && (!isOrganizerBlobImage(current) || await organizerImageExists(current))) {
    return current;
  }
  return '';
}

function imageUrlsFromEvents(events) {
  return [...new Set((Array.isArray(events) ? events : [])
    .map(event => event && event.imageUrl)
    .filter(isOrganizerBlobImage))];
}

function imageUrlsNoLongerUsed(beforeEvents, afterEvents) {
  const after = new Set(imageUrlsFromEvents(afterEvents));
  return imageUrlsFromEvents(beforeEvents).filter(url => !after.has(url));
}

async function deleteUnusedImages(urls) {
  const uniqueUrls = [...new Set((urls || []).filter(isOrganizerBlobImage))];
  if (!uniqueUrls.length) return { attempted: 0, deleted: 0, failed: 0 };

  try {
    await del(uniqueUrls);
    return { attempted: uniqueUrls.length, deleted: uniqueUrls.length, failed: 0 };
  } catch (error) {
    console.warn('Bulk blob cleanup failed, retrying one by one:', error);
    let deleted = 0;
    let failed = 0;
    for (const url of uniqueUrls) {
      try {
        await del(url);
        deleted += 1;
      } catch (singleError) {
        failed += 1;
        console.warn('Could not delete old event image:', url, singleError);
      }
    }
    return { attempted: uniqueUrls.length, deleted, failed };
  }
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
      send(res, 200, { events: await loadEvents({ force: fresh }) });
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

      const outcome = await mutateEvents(async currentEvents => {
        const index = payload.id ? currentEvents.findIndex(item => item.id === payload.id) : -1;
        if (isPut && index === -1) throw httpError(404, 'Event not found.');
        previousEvent = index === -1 ? null : currentEvents[index];
        created = index === -1;
        const imageUrl = await resolveImageUrl(payload.imageUrl, previousEvent?.imageUrl);
        event = cleanEvent({ ...payload, imageUrl }, previousEvent || {});
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

      const imageCleanup = previousEvent
        ? await deleteUnusedImages(imageUrlsNoLongerUsed([previousEvent], next))
        : { attempted: 0, deleted: 0, failed: 0 };
      // resolveImageUrl can quietly refuse an image URL that no longer exists in
      // Blob storage and keep the previous one instead. Say so in the reply, or
      // the phone believes it just fixed a picture that is still broken.
      const imageUrlAccepted = String(event.imageUrl || '') === requestedImageUrl;
      send(res, created ? 201 : 200, { event, events: next, localSaved: true, synced: true, idempotent: !created, imageUrlAccepted, requestedImageUrl, imageCleanup, reminderSync });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, `https://${req.headers.host}`);

      if (url.searchParams.get('all') === '1') {
        let imagesToDelete = [];
        const outcome = await mutateEvents(async currentEvents => {
          imagesToDelete = [...new Set([...imagesToDelete, ...imageUrlsFromEvents(currentEvents)])];
          return { events: [], verify: saved => saved.length === 0 };
        });
        if (!outcome.verified) {
          sendUnverified(res);
          return;
        }
        const reminderSync = await safeSyncReminders([], { all: true });
        const imageCleanup = await deleteUnusedImages(imagesToDelete);
        send(res, 200, { events: [], localDeleted: true, synced: true, imageCleanup, reminderSync });
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
      const imageCleanup = await deleteUnusedImages(imageUrlsNoLongerUsed(removedEvents, next));
      send(res, 200, { events: next, localDeleted: true, synced: true, imageCleanup, reminderSync });
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
