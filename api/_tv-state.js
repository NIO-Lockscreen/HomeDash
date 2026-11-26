// Blob I/O for the TV screensaver, tuned so an hour in which nothing changed
// costs no Blob operation at all.
//
// The hourly check reads two small files straight off the Blob CDN at their
// known public addresses - the TV state below and the version marker every
// save already rewrites - without asking head() first. Both are stored with a
// 30-day cache life, so while they are unchanged the CDN answers from cache,
// and a cache HIT is not billed as a Blob operation. Overwriting a file purges
// its CDN copy, so a change still shows on the next hourly check.
//
// The state is public like everything else in this store (the store's address
// reaches every screen through `versionUrl`), so the Google refresh token in
// it is sealed with AES-256-GCM under a key derived from GOOGLE_CLIENT_SECRET,
// which only the server has.
import { head, put } from '@vercel/blob';
import crypto from 'crypto';
import { isBlobNotFoundError } from './_image-rules.js';

export const TV_STATE_PATH = 'home-organizer/tv/state.json';
export const EVENTS_PATH = 'home-organizer/events.json';
export const VERSION_PATH = 'home-organizer/events-version.json';
const STATE_CACHE_MAX_AGE_S = 30 * 24 * 60 * 60;
const READ_TIMEOUT_MS = 8000;
const MAX_FRESH_READS = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = READ_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// The public URL of a blob in this store, worked out from the read-write
// token the way @vercel/blob itself does (vercel_blob_rw_<storeId>_<secret>
// -> https://<storeId>.public.blob.vercel-storage.com/<pathname>). '' when
// the token is missing or shaped differently; callers then fall back to
// head(), which costs a simple operation.
export function publicBlobUrl(pathname) {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();
  const storeId = token.split('_')[3] || '';
  if (!/^[A-Za-z0-9]+$/.test(storeId)) return '';
  return `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com/${pathname}`;
}

// Reads a small JSON blob off the CDN. null when it does not exist, or when
// its address cannot be worked out. Throws on any other failure, so a glitch
// is never mistaken for "not connected".
async function readJsonFromCdn(pathname) {
  const url = publicBlobUrl(pathname);
  if (!url) return null;
  const response = await fetchWithTimeout(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read ${pathname} from the Blob CDN (${response.status}).`);
  return response.json();
}

function normalizeEtag(value) {
  return String(value || '').trim().replace(/^W\//i, '').replace(/^"+|"+$/g, '').toLowerCase();
}

// Reads a JSON blob and confirms it is the copy the store holds, like
// events.js does: the CDN can hand back the copy from before the last
// overwrite for up to a minute, so the bytes are checked against head(),
// which answers from the Blob API. Costs one head() and, usually, one CDN
// miss. Returns { value, fresh } - value null when the blob does not exist.
export async function readJsonFresh(pathname, { attempts = MAX_FRESH_READS } = {}) {
  let text = '';
  let fresh = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let meta;
    try {
      meta = await head(pathname);
    } catch (error) {
      if (isBlobNotFoundError(error)) return { value: null, fresh: true };
      throw error;
    }
    const response = await fetchWithTimeout(`${meta.url}?v=${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read ${pathname} from Blob (${response.status}).`);
    text = await response.text();
    const stored = normalizeEtag(meta.etag);
    const sameLength = Buffer.byteLength(text, 'utf8') === Number(meta.size);
    const md5 = crypto.createHash('md5').update(text, 'utf8').digest('hex');
    fresh = sameLength && (!/^[0-9a-f]{32}$/.test(stored) || stored === md5 || normalizeEtag(response.headers.get('etag')) === stored);
    if (fresh) break;
    if (attempt < attempts) await sleep(400 * attempt);
  }
  try {
    return { value: JSON.parse(text), fresh };
  } catch {
    throw new Error(`${pathname} from Blob could not be read as JSON.`);
  }
}

// The task list as the store holds it right now, or null when it cannot be
// confirmed (the CDN is still replaying an older copy). A picture drawn from
// an older copy would sit on the TV until the next change, so the caller
// tries again next hour instead.
export async function readEventsForTv() {
  const { value, fresh } = await readJsonFresh(EVENTS_PATH);
  if (!fresh) return null;
  return {
    updatedAt: String(value?.updatedAt || ''),
    events: Array.isArray(value?.events) ? value.events : []
  };
}

// The version marker's stamp, off the CDN: free while it is unchanged.
// '' when it is missing or cannot be read; the caller then reads the task list.
export async function readVersionStamp() {
  try {
    const marker = await readJsonFromCdn(VERSION_PATH);
    return String(marker?.updatedAt || '');
  } catch {
    return '';
  }
}

export function emptyTvState() {
  return { v: 1, google: null, album: null, current: null, seen: null, lastError: null, updatedAt: '' };
}

function normalizeState(value) {
  const base = emptyTvState();
  if (!value || typeof value !== 'object') return base;
  return { ...base, ...value };
}

// The hourly path: one CDN read, free on a cache hit.
export async function readTvStateCheap() {
  const url = publicBlobUrl(TV_STATE_PATH);
  if (!url) return readTvStateFresh();
  return normalizeState(await readJsonFromCdn(TV_STATE_PATH));
}

// Connect, disconnect, status and manual runs: confirmed against the store,
// so a change made a few seconds ago is never read as missing.
export async function readTvStateFresh() {
  const { value } = await readJsonFresh(TV_STATE_PATH);
  return normalizeState(value);
}

export async function writeTvState(state) {
  const next = { ...normalizeState(state), updatedAt: new Date().toISOString() };
  await put(TV_STATE_PATH, JSON.stringify(next, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: STATE_CACHE_MAX_AGE_S
  });
  return next;
}

// ---------------------------------------------------------------------------
// Sealing the refresh token, and signing the OAuth `state` parameter.

function derivedKey(purpose) {
  const secret = String(process.env.GOOGLE_CLIENT_SECRET || '');
  if (!secret) throw new Error('GOOGLE_CLIENT_SECRET is missing in Vercel environment variables.');
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'homedash-tv', purpose, 32));
}

export function sealSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey('refresh-token'), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function openSecret(sealed) {
  const [version, iv, body, tag] = String(sealed || '').split('.');
  if (version !== 'v1' || !iv || !body || !tag) throw new Error('The stored Google connection is unreadable. Connect Google Photos again.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey('refresh-token'), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // The key comes from GOOGLE_CLIENT_SECRET: a changed secret cannot open
    // a token sealed under the old one.
    throw new Error('The stored Google connection cannot be opened (was GOOGLE_CLIENT_SECRET changed?). Connect Google Photos again.');
  }
}

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

export function signOAuthState() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + OAUTH_STATE_TTL_MS, n: crypto.randomBytes(9).toString('base64url') })).toString('base64url');
  const mac = crypto.createHmac('sha256', derivedKey('oauth-state')).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyOAuthState(value) {
  const [payload, mac] = String(value || '').split('.');
  if (!payload || !mac) return false;
  const expected = crypto.createHmac('sha256', derivedKey('oauth-state')).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    return Number(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp) > Date.now();
  } catch {
    return false;
  }
}
