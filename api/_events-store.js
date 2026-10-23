// The shared task list in Blob storage: read so that it is never an older
// copy, and written so that two devices can never overwrite each other.
//
// Why reads need care: events.json lives at one path that every save
// overwrites, and its contents are served through the Blob CDN, which keeps
// handing out the copy from before an overwrite for up to a minute. A query
// string does not get past it (the Blob CDN leaves the query out of its cache
// key). head(), on the other hand, answers from the Blob API and is always
// current, so it says which version is the latest - just not what is in it.
//
// So every save also writes the same bytes to an immutable snapshot whose path
// is that version's ETag: home-organizer/snapshots/<etag>.json. A reader asks
// head() for the ETag and fetches that snapshot. A path that has never been
// requested cannot be sitting in the CDN, and a path that is never overwritten
// cannot go stale, so the read is current the moment the save returns. Other
// screens fetching the same version afterwards get it from the CDN cache,
// which Blob does not bill as an operation. (404s are not cached, so a reader
// that arrives a moment before the snapshot is written just asks again.)
//
// Writes are compare-and-swap: put(..., { ifMatch: <etag of the version the
// change was built on> }). If another device saved in between, the store
// refuses, and the change is re-applied onto the newer version. That replaces
// the old read-back verification, which needed extra reads per save and could
// still be fooled by the CDN.
import { head, put, del, BlobPreconditionFailedError } from '@vercel/blob';
import crypto from 'crypto';
import { isBlobNotFoundError } from './_image-rules.js';
import { normalizeDaughterPeriods } from './_daughter-periods.js';

export const EVENTS_PATH = 'home-organizer/events.json';
const SNAPSHOT_PREFIX = 'home-organizer/snapshots/';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
// events.json keeps a long cache life so screens can watch it straight off the
// CDN for free: an unchanged copy is a cache HIT, and every save purges it.
// Nothing on the server reads it through the CDN any more except as a checked
// fallback, so a long life cannot feed a save an old copy.
export const EVENTS_CACHE_MAX_AGE_S = 30 * 24 * 60 * 60;
const SNAPSHOT_CACHE_MAX_AGE_S = 365 * 24 * 60 * 60;
// A snapshot is written straight after its save; a reader that arrives within
// this window and finds none waits once and looks again.
const FRESH_SAVE_WINDOW_MS = 15 * 1000;
const SNAPSHOT_RETRY_DELAY_MS = 300;
const ADOPT_RECHECK_MS = 10 * 60 * 1000;
let lastAdoptAttempt = { rev: '', at: 0 };

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

export function normalizeEtag(value) {
  return String(value || '').trim().replace(/^W\//i, '').replace(/^"+|"+$/g, '');
}

// A path-safe name for one stored version.
export function revOf(etag) {
  const clean = normalizeEtag(etag);
  if (!clean) return '';
  return /^[A-Za-z0-9_-]{1,128}$/.test(clean)
    ? clean.toLowerCase()
    : crypto.createHash('sha256').update(clean).digest('hex').slice(0, 40);
}

function snapshotPath(rev) {
  return `${SNAPSHOT_PREFIX}${rev}.json`;
}

function urlFor(blobUrl, pathname) {
  const url = new URL(blobUrl);
  url.pathname = `/${pathname}`;
  url.search = '';
  return url.toString();
}

export function sortEvents(events) {
  return [...events].sort((a, b) => new Date(a.start) - new Date(b.start));
}

export function emptyDocument() {
  return { updatedAt: '', previousRev: '', events: [], daughterPeriods: normalizeDaughterPeriods(null) };
}

function parseDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('events.json from Blob could not be read as JSON.');
  }
  return {
    updatedAt: String(parsed?.updatedAt || ''),
    previousRev: String(parsed?.previousRev || ''),
    events: Array.isArray(parsed?.events) ? parsed.events : [],
    daughterPeriods: normalizeDaughterPeriods(parsed?.daughterPeriods)
  };
}

export function isPreconditionFailed(error) {
  return error instanceof BlobPreconditionFailedError
    || Number(error?.status) === 412
    || /precondition failed/i.test(String(error?.message || ''));
}

// The snapshot for the version head() named, or null when there is none yet.
async function readSnapshot(meta, rev) {
  const url = urlFor(meta.url, snapshotPath(rev));
  const justSaved = Date.now() - new Date(meta.uploadedAt || 0).getTime() < FRESH_SAVE_WINDOW_MS;
  for (let attempt = 1; attempt <= (justSaved ? 2 : 1); attempt += 1) {
    const response = await fetch(url, { cache: 'no-store' });
    if (response.ok) {
      const text = await response.text();
      // Byte-for-byte the document head() describes.
      if (Buffer.byteLength(text, 'utf8') === Number(meta.size)) return text;
      console.warn(`Snapshot ${rev} does not match the stored events.json; ignoring it.`);
      return null;
    }
    if (response.status !== 404) throw new Error(`Could not read the task list snapshot from Blob (${response.status}).`);
    if (attempt === 1 && justSaved) await sleep(SNAPSHOT_RETRY_DELAY_MS);
  }
  return null;
}

// The CDN copy of events.json is current only when it is byte for byte what
// head() describes. Length alone let a same-length older copy through (moving
// a task from 10:00 to 11:00 keeps the length), so the ETag is compared too.
function isCurrentCopy(meta, text, response) {
  if (Buffer.byteLength(text, 'utf8') !== Number(meta.size)) return false;
  const stored = normalizeEtag(meta.etag).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(stored)) return true;
  return normalizeEtag(response.headers.get('etag')).toLowerCase() === stored || md5(text) === stored;
}

function maxAgeOf(cacheControl) {
  const match = /max-age=(\d+)/i.exec(String(cacheControl || ''));
  return match ? Number(match[1]) : null;
}

async function writeSnapshot(rev, body) {
  try {
    await put(snapshotPath(rev), body, {
      access: 'public',
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: JSON_CONTENT_TYPE,
      cacheControlMaxAge: SNAPSHOT_CACHE_MAX_AGE_S
    });
    return true;
  } catch (error) {
    // The save itself is stored. Readers fall back to the checked CDN copy.
    console.warn(`Could not write snapshot ${rev}:`, error);
    return false;
  }
}

// A version saved before snapshots existed, or whose snapshot write failed,
// read from a CDN copy that has been checked as current. Give it a snapshot so
// the next read is consistent, and move a document still on the old short
// cache life onto the long one (a one-off rewrite of the same bytes), so
// screens can watch it for free. At most once per version per instance.
async function adoptDocument(meta, text, rev) {
  const now = Date.now();
  if (lastAdoptAttempt.rev === rev && now - lastAdoptAttempt.at < ADOPT_RECHECK_MS) return;
  lastAdoptAttempt = { rev, at: now };
  const maxAge = maxAgeOf(meta.cacheControl);
  if (maxAge !== null && maxAge < EVENTS_CACHE_MAX_AGE_S && meta.etag) {
    try {
      const stored = await put(EVENTS_PATH, text, {
        access: 'public',
        allowOverwrite: true,
        contentType: JSON_CONTENT_TYPE,
        cacheControlMaxAge: EVENTS_CACHE_MAX_AGE_S,
        ifMatch: meta.etag
      });
      const storedRev = revOf(stored?.etag);
      if (storedRev) await writeSnapshot(storedRev, text);
      return;
    } catch (error) {
      if (isPreconditionFailed(error)) return;
      console.warn('Could not move events.json onto the long cache life:', error);
    }
  }
  if (rev) await writeSnapshot(rev, text);
}

// Reads the current task list. `fresh` is false only when no snapshot was
// found and the CDN's copy could not be confirmed as current either; callers
// that are about to save must not build on such a copy.
//
// Resolves to { updatedAt, previousRev, events, daughterPeriods, fresh,
// exists, etag, rev, url }.
export async function readEventsDocument() {
  let meta;
  try {
    meta = await head(EVENTS_PATH);
  } catch (error) {
    if (isBlobNotFoundError(error)) return { ...emptyDocument(), fresh: true, exists: false, etag: '', rev: '', url: '' };
    throw error;
  }
  const rev = revOf(meta.etag);
  const base = { exists: true, etag: String(meta.etag || ''), rev, url: meta.url };

  if (rev) {
    const snapshot = await readSnapshot(meta, rev);
    if (snapshot !== null) return { ...parseDocument(snapshot), ...base, fresh: true };
  }

  const response = await fetch(`${meta.url}?v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not read events.json from Blob (${response.status}).`);
  const text = await response.text();
  const fresh = isCurrentCopy(meta, text, response);
  if (fresh) await adoptDocument(meta, text, rev);
  else console.warn('events.json: no snapshot for the current version and the CDN copy is older; reporting it as not current.');
  return { ...parseDocument(text), ...base, fresh };
}

// Saves a new version built on `base` (a document from readEventsDocument).
// Resolves to { conflict: true } when another save landed after `base` was
// read; the caller re-reads and re-applies. Otherwise to the stored document.
export async function writeEventsDocument({ events, daughterPeriods }, base) {
  const document = {
    updatedAt: new Date().toISOString(),
    // The version this one replaced, so the snapshot before that can go.
    previousRev: String(base?.rev || ''),
    events: sortEvents(Array.isArray(events) ? events : []),
    daughterPeriods: normalizeDaughterPeriods(daughterPeriods)
  };
  const body = JSON.stringify(document, null, 2);
  let stored;
  try {
    stored = await put(EVENTS_PATH, body, {
      access: 'public',
      allowOverwrite: true,
      contentType: JSON_CONTENT_TYPE,
      cacheControlMaxAge: EVENTS_CACHE_MAX_AGE_S,
      // Without an ETag (a brand new store) there is nothing to compare with.
      ...(base?.etag ? { ifMatch: base.etag } : {})
    });
  } catch (error) {
    if (isPreconditionFailed(error)) return { conflict: true };
    throw error;
  }
  const rev = revOf(stored?.etag);
  if (rev) await writeSnapshot(rev, body);
  else console.warn('The store returned no ETag for events.json; reads fall back to the checked CDN copy.');

  // Keep the snapshot this save replaced, for any screen that read its ETag a
  // moment ago; drop the one before it. Deletes cost no billed operation.
  const stale = String(base?.previousRev || '');
  if (stale && stale !== rev && stale !== base?.rev) {
    try {
      await del(snapshotPath(stale));
    } catch (error) {
      if (!isBlobNotFoundError(error)) console.warn(`Could not delete old snapshot ${stale}:`, error);
    }
  }
  return { conflict: false, document, etag: String(stored?.etag || ''), rev, url: stored?.url || base?.url || '' };
}
