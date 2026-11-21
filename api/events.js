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
  AUTO_IMAGE_KEYWORDS,
  autoImageIndex,
  autoImageKindOf,
  isMismatchedBorrowedImage
} from './_image-rules.js';
import {
  normalizeDaughterPeriods,
  applyDaughterPeriodChange,
  daughterPeriodChangeSurvived
} from './_daughter-periods.js';
import { normalizeTodos, applyTodoChanges, todoChangesSurvived } from './_todos.js';
import {
  normalizeStockLibrary,
  seedStockLibrary,
  effectiveStockLibrary,
  pickStockForTitle,
  stockMarksValid,
  isStaleStockImage,
  applyStockChange,
  stockChangeSurvived,
  reconcileStockTasks,
  seededRandom
} from './_stock.js';

const EVENTS_PATH = 'home-organizer/events.json';
// Every confirmed save also rewrites this marker. Screens read it straight off
// the Blob CDN to learn that something changed, and only then spend a real read
// on /api/events. The long cache life is what makes that free: an unchanged
// marker is a CDN cache HIT, which Blob does not bill as an operation, and
// overwriting it purges the CDN copy, so a change still shows within about a
// minute. (events.json itself keeps its short cache life: the write path reads
// it through the same CDN, and a purge that went missing must not be able to
// hold a stale copy there for a month.)
const VERSION_PATH = 'home-organizer/events-version.json';
const VERSION_CACHE_MAX_AGE_S = 30 * 24 * 60 * 60;
const VERSION_MARKER_RECHECK_MS = 60 * 60 * 1000;
// Reported on every GET so the live server build can be read straight from
// /api/events, rather than inferred from whether a save worked.
const API_BUILD = '2026-11-21-a';
// Which deployment answered. A wall display runs the same page for days; this
// is how it notices a deploy and reloads itself.
const DEPLOYMENT_ID = String(process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || '').trim();
const EVENTS_CACHE_MS = 60 * 1000;
const MAX_WRITE_ATTEMPTS = 3;
const MAX_READ_ATTEMPTS = 3;
const MAX_VERIFY_READS = 3;
const VERIFY_RETRY_DELAY_MS = 250;
// The function itself is cut off at 10 seconds (vercel.json), and a reply that
// never arrives is worse than one that says the store has not caught up: stop
// confirming in time to answer.
const WRITE_BUDGET_MS = 7000;
// The last confirmed document: { updatedAt, events, daughterPeriods, todos,
// stock, extras }.
let eventsCache = null;
let eventsCacheAt = 0;
// Where screens read the version marker. Derived from events.json's own URL,
// since both live in the same store.
let versionUrl = '';
let versionMarkerCheckedAt = 0;
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
  // Which stock picture the task is showing, if any. Like the borrow marks
  // above, these live and die with the image: kept while the picture stays,
  // taken from the device when it brings a new one, gone with no picture. An
  // older page does not send them, so an unchanged picture keeps what it had.
  const sameImage = imageUrl === String(existing.imageUrl || '');
  const stockSource = sameImage
    ? {
      word: input.imageStockWord ?? existing.imageStockWord,
      imageId: input.imageStockImageId ?? existing.imageStockImageId,
      manual: input.imageStockManual ?? existing.imageStockManual
    }
    : { word: input.imageStockWord, imageId: input.imageStockImageId, manual: input.imageStockManual };
  const imageStockWord = imageUrl ? String(stockSource.word || '').trim().slice(0, 60) : '';
  const imageStockImageId = imageStockWord ? String(stockSource.imageId || '').trim().slice(0, 60) : '';
  const imageStockManual = Boolean(imageStockImageId) && stockSource.manual === true;
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
    imageStockWord: imageStockImageId ? imageStockWord : '',
    imageStockImageId,
    imageStockManual,
    // Family or work. Only a screen in work mode shows work tasks. Older pages
    // and changes queued on a phone before this existed send no scope, so the
    // stored one is kept.
    scope: cleanEventScope(input.scope ?? existing.scope),
    featured: Boolean(input.featured ?? existing.featured),
    emailReminder,
    updatedAt,
    createdAt: existing.createdAt || new Date().toISOString()
  };
}

const EVENT_SCOPES = new Set(['family', 'work']);

function cleanEventScope(value) {
  const scope = String(value || '').trim().toLowerCase();
  return EVENT_SCOPES.has(scope) ? scope : 'family';
}

function sortEvents(events) {
  return [...events].sort((a, b) => new Date(a.start) - new Date(b.start));
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

function normalizeEtag(value) {
  return String(value || '').trim().replace(/^W\//i, '').replace(/^"+|"+$/g, '').toLowerCase();
}

// An MD5 ETag from head(), or '' when the store gave something else.
function storedMd5(meta) {
  const etag = normalizeEtag(meta?.etag);
  return /^[0-9a-f]{32}$/.test(etag) ? etag : '';
}

// Top-level keys this build reads and writes itself. Anything else found in
// events.json is carried through every write untouched, so a newer build's
// data survives a save made by this one.
const DOCUMENT_KEYS = new Set(['updatedAt', 'events', 'daughterPeriods', 'todos', 'stock']);

function documentExtras(parsed) {
  const extras = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return extras;
  for (const [key, value] of Object.entries(parsed)) {
    if (!DOCUMENT_KEYS.has(key)) extras[key] = value;
  }
  return extras;
}

// `stock` is null until the library is first stored; until then the seed made
// from the fysio/lege/MR photos stands in for it (effectiveStockLibrary).
function emptyDocument() {
  return {
    updatedAt: '',
    events: [],
    daughterPeriods: normalizeDaughterPeriods(null),
    todos: normalizeTodos(null),
    stock: null,
    extras: {}
  };
}

function rememberVersionUrl(eventsUrl) {
  if (versionUrl || !eventsUrl) return;
  try {
    const url = new URL(eventsUrl);
    url.pathname = `/${VERSION_PATH}`;
    url.search = '';
    versionUrl = url.toString();
  } catch {}
}

// Is the copy the CDN handed back the one the store holds? head() answers from
// the Blob API; the contents come from the CDN, which keeps serving the copy
// from before an overwrite for up to a minute. Byte length alone cannot tell
// the two apart when an edit keeps the length - moving a task from 10:00 to
// 11:00 does - and a save built on such a copy silently undid that edit. The
// store's ETag is an MD5 of the content, so when head() gives one the content
// has to match it as well.
function isCurrentCopy(meta, text, response) {
  if (Buffer.byteLength(text, 'utf8') !== Number(meta.size)) return false;
  const stored = storedMd5(meta);
  if (!stored) return true;
  if (normalizeEtag(response.headers.get('etag')) === stored || md5(text) === stored) return true;
  console.warn(`events.json: the CDN copy has the stored length but not the stored ETag ${stored}; treating it as an older copy.`);
  return false;
}

// Reads the document and says whether it is really the current version.
//
// The blob URL is CDN-backed and the path is reused on every overwrite, so the
// CDN can hand back the copy from before the last write for up to a minute.
// The unique query string below does NOT get past it: the Blob CDN leaves the
// query out of its cache key, so `?v=<anything>` is answered from the same
// cached copy. There is no way to bypass the CDN for a public store, so a
// replayed copy is detected instead (isCurrentCopy) and `fresh` says so.
//
// This matters most on the write path. A save that builds on a replayed copy
// does not merely miss a task: it writes the whole document back without the
// tasks that were added since, and answers 404 for a task that plainly exists.
async function readEventsDocument({ attempts = MAX_READ_ATTEMPTS } = {}) {
  let meta;
  let text = '';
  let fresh = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      meta = await head(EVENTS_PATH);
    } catch (error) {
      if (isBlobNotFoundError(error)) return { ...emptyDocument(), fresh: true };
      throw error;
    }
    rememberVersionUrl(meta.url);
    const bust = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const response = await fetch(`${meta.url}?v=${bust}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read events.json from Blob (${response.status}).`);
    text = await response.text();
    fresh = isCurrentCopy(meta, text, response);
    if (fresh) break;
    console.warn(`events.json came back as an older copy than the store holds (attempt ${attempt}/${attempts}).`);
    if (attempt < attempts) await sleep(VERIFY_RETRY_DELAY_MS * attempt);
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
    daughterPeriods: normalizeDaughterPeriods(parsed?.daughterPeriods),
    todos: normalizeTodos(parsed?.todos),
    stock: parsed?.stock && typeof parsed.stock === 'object' ? normalizeStockLibrary(parsed.stock) : null,
    extras: documentExtras(parsed),
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
  return document;
}

async function loadEvents(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (!force && eventsCache && now - eventsCacheAt < EVENTS_CACHE_MS) {
    return { ...eventsCache, fresh: true };
  }

  try {
    // A single attempt. A replayed copy is still there a few hundred
    // milliseconds later, and every try costs a billed head(); the screen is
    // told the copy is not confirmed and asks again a little later instead.
    const document = await readEventsDocument({ attempts: 1 });
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
    daughterPeriods: normalizeDaughterPeriods(document?.daughterPeriods),
    todos: normalizeTodos(document?.todos),
    stock: document?.stock ? normalizeStockLibrary(document.stock) : null,
    extras: document?.extras && typeof document.extras === 'object' ? document.extras : {}
  };
  eventsCacheAt = Date.now();
  return eventsCache;
}

// Returns what was written - the document stamp, its exact byte length and its
// MD5 - so the write can be confirmed against the store's own metadata after.
//
// Everything in the document is written back on every save - the tasks, the
// daughter periods, the to-do list, the stock library and any key this build
// does not know - so no kind of save can drop another kind's data.
async function saveEvents({ events, daughterPeriods, todos, stock, extras }) {
  const sorted = sortEvents(events);
  const periods = normalizeDaughterPeriods(daughterPeriods);
  const todoList = normalizeTodos(todos);
  const library = stock ? normalizeStockLibrary(stock) : null;
  const stamp = new Date().toISOString();
  const body = JSON.stringify({
    ...(extras && typeof extras === 'object' ? extras : {}),
    updatedAt: stamp,
    events: sorted,
    daughterPeriods: periods,
    todos: todoList,
    ...(library ? { stock: library } : {})
  }, null, 2);
  const stored = await put(EVENTS_PATH, body, {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 0
  });
  rememberVersionUrl(stored?.url);
  const document = rememberEventsCache({ updatedAt: stamp, events: sorted, daughterPeriods: periods, todos: todoList, stock: library, extras });
  return { stamp, bytes: Buffer.byteLength(body, 'utf8'), md5: md5(body), document };
}

// Rewrites the version marker every screen watches. A failure here does not
// undo the save, which is already stored; screens then pick the change up on
// their next timed read instead of within the minute.
async function publishVersion(stamp) {
  const updatedAt = String(stamp || '').trim();
  if (!updatedAt) return '';
  try {
    await put(VERSION_PATH, JSON.stringify({ updatedAt }), {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json; charset=utf-8',
      cacheControlMaxAge: VERSION_CACHE_MAX_AGE_S
    });
    versionMarkerCheckedAt = Date.now();
    return updatedAt;
  } catch (error) {
    console.warn('Could not update the version marker:', error);
    return '';
  }
}

// A screen that found no marker asks for one. Only needed until the first save
// after this was deployed: every save writes the marker from then on. Checked
// at most once an hour per instance, since anyone can ask.
async function ensureVersionMarker(document) {
  if (!document.updatedAt || Date.now() - versionMarkerCheckedAt < VERSION_MARKER_RECHECK_MS) return;
  versionMarkerCheckedAt = Date.now();
  try {
    await head(VERSION_PATH);
    return;
  } catch (error) {
    if (!isBlobNotFoundError(error)) return;
  }
  await publishVersion(document.updatedAt);
}

// Does the store hold the bytes we just wrote? head() answers from the Blob
// API, not from the CDN that serves the file's contents, so unlike a read of
// the document itself it can never be a cached replay of an older version. A
// matching MD5 (or, without one, a matching byte length) means our document is
// the one in the store - or a byte-identical one from another device, which
// says the same thing about our change.
async function writtenDocumentIsStored(written) {
  try {
    const meta = await head(EVENTS_PATH);
    if (Number(meta?.size) !== written.bytes) return false;
    // Another device's document can have exactly the same length.
    const stored = storedMd5(meta);
    return !stored || stored === written.md5;
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
    if (await writtenDocumentIsStored(written)) return { status: 'stored', document: written.document };

    const saved = await readEventsDocument();
    if (typeof verify !== 'function' || verify(saved.events, saved)) {
      // Return what the store holds so the reply carries any concurrent change
      // from another device too.
      return { status: 'stored', document: saved };
    }
    if (saved.updatedAt && saved.updatedAt >= written.stamp) return { status: 'lost', document: saved };
    if (Date.now() >= deadline) break;
    if (attempt < MAX_VERIFY_READS) await sleep(VERIFY_RETRY_DELAY_MS * attempt);
  }
  // Only ever saw copies older than our own write, so nothing has replaced it.
  return { status: 'lagging', document: written.document };
}

// A confirmed write: remember it, and tell every screen something changed.
async function settleWrite(document) {
  const remembered = rememberEventsCache(document);
  const version = await publishVersion(remembered.updatedAt);
  return { ...remembered, version, verified: true };
}

// Every write is a read-modify-write over one shared document, so two devices
// saving at once race: the slower one bases its copy on a snapshot taken before
// the faster one landed and puts it back, silently erasing the other device's
// task. Guard that by confirming each put and re-applying the change onto the
// winner's snapshot when ours did not survive.
//
// `apply(events, attempt, document)` receives the freshest snapshot and returns
// { events, verify, daughterPeriods?, todos?, stock? }, where
// verify(savedEvents, savedDocument) reports whether this change is present in
// what the store actually kept. A change that leaves `daughterPeriods`, `todos`
// or `stock` out keeps the stored ones. It may run more than once, so it must
// not have side effects.
//
// The stock library is stored on the first write of any kind: until then it is
// the seed made from the fysio/lege/MR photos, and `document.stock` already
// holds that seed when `apply` runs.
//
// Resolves to the stored document plus { verified, version }.
async function mutateEvents(apply) {
  const run = async () => {
    let outcome = null;
    const deadline = Date.now() + WRITE_BUDGET_MS;
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const current = await readEventsForWrite();
      if (!current.stock) current.stock = seedStockLibrary(current.events, new Date());
      const next = await apply(current.events, attempt, current);
      const written = await saveEvents({
        events: next.events,
        daughterPeriods: next.daughterPeriods ?? current.daughterPeriods,
        todos: next.todos ?? current.todos,
        stock: next.stock ?? current.stock,
        extras: current.extras
      });
      const verify = next.verify;
      outcome = { ...written.document, verified: false };

      const confirmation = await confirmWrite(written, verify, deadline);
      if (confirmation.status === 'stored') return settleWrite(confirmation.document);
      if (confirmation.status === 'lagging') {
        // The put succeeded, nothing newer has replaced it, and only the
        // reading side is behind. Rewriting would put the same bytes back and
        // ask the same question again; telling the device to retry would have
        // it do that every 15 seconds forever. Report it as written.
        console.warn('events.json was written but the read-back is still behind; accepting the write.');
        return { ...(await settleWrite(confirmation.document)), lagging: true };
      }
      console.warn(`events.json was overwritten by another write; re-applying (attempt ${attempt}/${MAX_WRITE_ATTEMPTS}).`);
      if (Date.now() >= deadline) break;
      if (attempt < MAX_WRITE_ATTEMPTS) await sleep(VERIFY_RETRY_DELAY_MS * attempt);
    }
    return outcome || { ...emptyDocument(), verified: false };
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
//
// It says what the server saw, not what it guesses that means. All it really
// knows is that the stored task list kept coming back carrying somebody else's
// newer write instead of this one; whether that was another device, another tab
// of the same one, or the store itself is not something it can tell. It used to
// state flatly that another device had saved at the same time, which was
// routinely untrue and sent the one person looking for the fault to look for a
// second device that was never there.
function sendUnverified(res) {
  send(res, 503, { error: 'The task list kept coming back with a newer write than this one, so the change could not be confirmed. It stays queued on this device and will retry.' });
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

// Picks a stock picture for a task that arrived without one and whose title
// names a stock word, and only ever returns a link the store really still
// answers for. Handing a dead link to a new task is precisely how a placeholder
// spreads from one card to the next. The lookups only happen on this path,
// which is rare and short. `random` is seeded from the request, so a retry
// picks the same photo.
async function stockImageForTitle({ title, scope, stock, events, excludeId, random }) {
  const skipUrls = new Set();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = pickStockForTitle({ title, scope, stock, events, excludeId, skipUrls, random });
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

// What every reply carries so a screen can keep itself in step: the document
// stamp, the marker value it can stop watching for, and where the marker is.
function syncFields(document) {
  return {
    build: API_BUILD,
    deployment: DEPLOYMENT_ID,
    updatedAt: String(document?.updatedAt || ''),
    version: String(document?.version || ''),
    versionUrl,
    daughterPeriods: normalizeDaughterPeriods(document?.daughterPeriods),
    todos: normalizeTodos(document?.todos),
    stock: effectiveStockLibrary(document?.stock, document?.events)
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, `https://${req.headers.host}`);
      const fresh = url.searchParams.get('fresh') === '1';
      // The task list is public to read, so other sites (the car lockscreen's
      // calendar widget) may read it too. Writes still need the admin PIN.
      res.setHeader('Access-Control-Allow-Origin', '*');
      // stale-while-revalidate used to run for a full day, so a client that
      // never asks for fresh=1 could be served yesterday's task list.
      res.setHeader(
        'Cache-Control',
        fresh
          ? 'no-store, max-age=0'
          : 'public, max-age=30, s-maxage=30, stale-while-revalidate=60'
      );
      const document = await loadEvents({ force: fresh });
      if (fresh && document.fresh && url.searchParams.get('ensureVersion') === '1') await ensureVersionMarker(document);
      // `fresh: false` tells the screen this is the CDN's older copy: it keeps
      // what it has and asks again shortly, instead of treating it as current.
      send(res, 200, { ...syncFields(document), events: document.events, fresh: document.fresh });
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
      // Set when the task's stored picture was a borrow from another kind, or a
      // stock picture of a word the title no longer names, and was let go. The
      // device is not being refused anything then: it sent back a picture
      // nobody had chosen.
      let imageReleased = false;
      // The stock word the saved task's picture came from, for the reply.
      let stockWordShown = '';
      // One stamp for the whole request, not one per attempt: every retry then
      // writes a byte-identical event, so a read-back that is one generation
      // behind still confirms the change instead of reporting it as lost.
      const writeStamp = new Date().toISOString();

      const outcome = await mutateEvents(async (currentEvents, attempt, current) => {
        const stock = current.stock;
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
        // Which calendar the task is on after this save, and so which stock
        // library it takes its pictures from: the family's or the work one.
        const taskScope = cleanEventScope(payload.scope ?? previousEvent?.scope);
        // A stock picture of a word the title no longer names - "Tannlege"
        // retitled "Middag" - goes the same way, and so does one from the other
        // calendar's library when the task moves between family and work.
        // Never one picked or framed by hand for this task.
        const releasesStaleStock = keepsStoredImage
          && !releasesWrongKind
          && isStaleStockImage({
            ...previousEvent,
            title: payload.title,
            scope: taskScope,
            imageStockManual: payload.imageStockManual ?? previousEvent.imageStockManual
          }, stock);
        imageReleased = releasesWrongKind || releasesStaleStock;
        const imageUrl = imageReleased ? '' : resolvedImageUrl;
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
        // A task whose title names a stock word and that ends up with no
        // picture is given one of that word's photos, framing included. This
        // only ever fills an empty slot: an image the device sent, or one the
        // task already had, has been decided above and is never overruled here.
        // (This replaced the fysio/lege/MR borrowing; those three are the first
        // stock words, seeded from the photos the borrowing lent.)
        if (!imageUrl && !autoImage) {
          autoImage = await stockImageForTitle({
            title: payload.title,
            scope: taskScope,
            stock,
            events: currentEvents,
            excludeId: payload.id,
            random: seededRandom(`${writeStamp}|${payload.id || ''}|${payload.title || ''}`)
          });
        }
        const filled = imageUrl ? null : autoImage;
        event = cleanEvent(
          {
            ...payload,
            imageUrl: filled ? filled.image.imageUrl : imageUrl,
            ...(filled
              ? {
                ...filled.image,
                imageInheritedFrom: '',
                imageInheritedKeyword: '',
                imageStockWord: filled.wordId,
                imageStockImageId: filled.imageId,
                imageStockManual: false
              }
              : stampsKeptKind
                ? { imageInheritedKeyword: stampsKeptKind }
                : {})
          },
          previousEvent || {},
          writeStamp
        );
        // Stock marks that do not point at a photo the library holds under the
        // same link are dropped; the picture itself stays as the task's own.
        if (event.imageStockImageId && !stockMarksValid(event, stock)) {
          event = { ...event, imageStockWord: '', imageStockImageId: '', imageStockManual: false };
        }
        stockWordShown = event.imageStockImageId ? String(stock?.words?.[event.imageStockWord]?.word || '') : '';
        const nextEvents = [...currentEvents];
        if (index === -1) nextEvents.push(event);
        else nextEvents[index] = event;
        return { events: nextEvents, verify: saved => eventSurvived(saved, event) };
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
          return {
            events: nextEvents,
            verify: saved => saved.some(item => String(item.id) === String(event.id)
              && item.emailReminder?.creationEmailSentAt === event.emailReminder.creationEmailSentAt)
          };
        });
        if (stamped.verified) next = stamped;
      }

      // resolveImageUrl can quietly refuse an image URL (gone from Blob, or an
      // older picture sent by a stale device) and keep the stored one instead.
      // Say so in the reply, or the phone believes it just changed a picture
      // that it did not.
      // A stock picture is not a refusal: the device asked for no image at all,
      // so nothing it sent was overruled. Neither is letting go of a borrowed
      // picture of another kind, or a stock picture of a word the title no
      // longer names: the device only echoed back what the task was holding.
      const imageAutoFilled = Boolean(autoImage)
        && String(event.imageStockImageId || '') === String(autoImage.imageId)
        && (!requestedImageUrl || imageReleased);
      const imageUrlAccepted = String(event.imageUrl || '') === requestedImageUrl || imageAutoFilled || imageReleased;
      const imageStock = event.imageStockImageId ? { wordId: event.imageStockWord, word: stockWordShown, imageId: event.imageStockImageId } : null;
      send(res, created ? 201 : 200, { ...syncFields(next), event, events: next.events, localSaved: true, synced: true, idempotent: !created, imageUrlAccepted, imageAutoFilled, imageReleased, imageStock, requestedImageUrl, imageCleanup: IMAGE_CLEANUP, reminderSync });
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
        // Clears the tasks only; the daughter periods, the to-do list and the
        // stock pictures are kept.
        send(res, 200, { ...syncFields(outcome), events: [], localDeleted: true, synced: true, imageCleanup: IMAGE_CLEANUP, reminderSync });
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
      const reminderSync = removedEvents.some(usesReminders)
        ? await safeSyncReminders(outcome.events, { eventIds: [id] })
        : NO_REMINDERS_TO_SYNC;
      send(res, 200, { ...syncFields(outcome), events: outcome.events, localDeleted: true, synced: true, imageCleanup: IMAGE_CLEANUP, reminderSync });
      return;
    }

    // One change to the daughter periods, a batch of to-do changes, or one
    // change to the stock pictures - each applied onto whatever the store holds,
    // so edits to different items from two screens all survive.
    if (req.method === 'PATCH') {
      const payload = parsePayload(await readBody(req));

      if (payload.todos !== undefined) {
        const changes = Array.isArray(payload.todos) ? payload.todos : [payload.todos];
        const outcome = await mutateEvents(async (currentEvents, attempt, current) => {
          const expected = applyTodoChanges(current.todos, changes, new Date());
          return {
            events: currentEvents,
            todos: expected,
            verify: (savedEvents, saved) => todoChangesSurvived(saved?.todos, changes, expected)
          };
        });
        if (!outcome.verified) {
          sendUnverified(res);
          return;
        }
        send(res, 200, { ...syncFields(outcome), events: outcome.events, synced: true });
        return;
      }

      if (payload.stock !== undefined) {
        const change = payload.stock;
        if (!change || typeof change !== 'object') throw httpError(400, 'Nothing to change was sent.');
        // A photo is only taken into the library once the store answers for
        // it; a dead link there would be handed to every task of that word.
        if (change.action === 'add-image') {
          const url = String(change.image?.imageUrl || '').trim();
          if (!isOrganizerBlobImage(url)) throw httpError(400, 'Only photos uploaded to the organizer can be stock pictures.');
          if (!(await organizerImageMeta(url)).exists) throw httpError(400, 'That photo is no longer in the store. Upload it again.');
        }
        const stamp = new Date().toISOString();
        let changedIds = [];
        const outcome = await mutateEvents(async (currentEvents, attempt, current) => {
          const now = new Date();
          const stock = applyStockChange(current.stock, change, now);
          // The tasks are brought in step in the same write: a reframed photo
          // is reframed on its tasks, a removed one is swapped, and upcoming
          // tasks with no picture that name a word are given one.
          const reconciled = reconcileStockTasks(stock, currentEvents, { now, random: seededRandom(`${stamp}|stock`) });
          changedIds = reconciled.changedIds;
          const byId = new Map(reconciled.events.map(item => [String(item.id), item]));
          return {
            events: reconciled.events,
            stock,
            verify: (savedEvents, saved) => stockChangeSurvived(saved?.stock, change, stock)
              && changedIds.every(id => {
                const mine = byId.get(id);
                return (savedEvents || []).some(item => String(item.id) === id
                  && String(item.imageUrl || '') === String(mine?.imageUrl || ''));
              })
          };
        });
        if (!outcome.verified) {
          sendUnverified(res);
          return;
        }
        send(res, 200, { ...syncFields(outcome), events: outcome.events, synced: true, stockTasksChanged: changedIds.length });
        return;
      }

      const change = payload.daughterPeriod;
      if (!change || typeof change !== 'object') throw httpError(400, 'Nothing to change was sent.');
      const outcome = await mutateEvents(async (currentEvents, attempt, current) => {
        const expected = applyDaughterPeriodChange(current.daughterPeriods, change);
        return {
          events: currentEvents,
          daughterPeriods: expected,
          verify: (savedEvents, saved) => daughterPeriodChangeSurvived(saved?.daughterPeriods, change, expected)
        };
      });
      if (!outcome.verified) {
        sendUnverified(res);
        return;
      }
      send(res, 200, { ...syncFields(outcome), events: outcome.events, synced: true });
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
