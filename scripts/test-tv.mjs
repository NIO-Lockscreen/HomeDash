// End-to-end test of the TV screensaver sync, with Vercel Blob and Google
// Photos replaced by fakes in memory. Counts the Blob operations each run
// costs, so "a run with nothing to do is free" is checked rather than assumed.
//
//   npm install
//   node --experimental-test-module-mocks scripts/test-tv.mjs
//
// Add SLIDES=1 to also write every uploaded picture to scripts/tv-test-out/.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import jpeg from 'jpeg-js';

process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_StoreTest1_secret';
process.env.GOOGLE_CLIENT_ID = 'client-id';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.ADMIN_PIN = '1234';
process.env.CRON_SECRET = 'cron-secret';
process.env.ORGANIZER_TIME_ZONE = 'Europe/Oslo';

// ---------------------------------------------------------------- fake Blob
const HOST = 'https://storetest1.public.blob.vercel-storage.com';
const blobs = new Map();
const cdn = new Map();
// The CDN remembers "not there" for a while after a blob is first written:
// it answers 404 for this many more reads.
const cdnNotFound = new Map();
const ops = { simple: 0, advanced: 0, cdnHits: 0 };
const md5 = text => crypto.createHash('md5').update(text).digest('hex');

function storeBlob(pathname, body) {
  const text = String(body);
  blobs.set(pathname, { text, etag: `"${md5(text)}"`, size: Buffer.byteLength(text) });
  cdn.delete(pathname);
}

mock.module('@vercel/blob', {
  namedExports: {
    head: async pathname => {
      ops.simple += 1;
      const blob = blobs.get(pathname);
      if (!blob) {
        const error = new Error('The requested blob does not exist');
        error.name = 'BlobNotFoundError';
        throw error;
      }
      return { url: `${HOST}/${pathname}`, size: blob.size, etag: blob.etag, uploadedAt: new Date() };
    },
    put: async (pathname, body) => {
      ops.advanced += 1;
      storeBlob(pathname, body);
      return { url: `${HOST}/${pathname}`, pathname };
    },
    del: async () => {},
    list: async () => ({ blobs: [] })
  }
});

// -------------------------------------------------------------- fake Google
let photoSeq = 0;
const albums = new Map();
const library = new Map();
const uploadTokens = new Map();
const google = {
  refreshFails: false,
  uploads: 0,
  removes: 0,
  // Pictures made while this is on are left out of album listings until
  // reveal(): Google listing a new picture a while after it was created.
  lag: false,
  // The nth batchCreate from now answers 429.
  failUploadAt: 0,
  // Taking pictures out of the album keeps failing.
  failRemove: false
};
function reveal() {
  for (const item of library.values()) item.hidden = false;
}
// Moves every picture's creation time back, as if that much time had passed.
function ageLibrary(ms) {
  for (const item of library.values()) item.creationTime = new Date(Date.parse(item.creationTime) - ms).toISOString();
}

function photo(seed) {
  const width = 160;
  const height = 120;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = (i * seed) % 255;
    data[i * 4 + 1] = 120;
    data[i * 4 + 2] = 200 - seed * 10;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 80).data);
}
const photos = { 'https://test.local/a.jpg': photo(3), 'https://test.local/b.jpg': photo(7) };

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function fakeFetch(input, init = {}) {
  const url = new URL(String(input));
  const method = (init.method || 'GET').toUpperCase();
  if (url.origin === HOST) {
    const pathname = url.pathname.slice(1);
    const blob = blobs.get(pathname);
    if (!blob) {
      ops.simple += 1;
      cdnNotFound.set(pathname, 2);
      return new Response('Not found', { status: 404 });
    }
    if (cdnNotFound.get(pathname) > 0) {
      cdnNotFound.set(pathname, cdnNotFound.get(pathname) - 1);
      ops.simple += 1;
      return new Response('Not found', { status: 404 });
    }
    if (cdn.get(pathname) === blob.etag) ops.cdnHits += 1;
    else {
      ops.simple += 1;
      cdn.set(pathname, blob.etag);
    }
    return new Response(blob.text, { headers: { etag: blob.etag } });
  }
  if (url.origin === 'https://test.local') return photos[url.href] ? new Response(photos[url.href]) : new Response('', { status: 404 });
  if (url.hostname === 'cdn.jsdelivr.net') return new Response('', { status: 404 });
  if (url.href === 'https://oauth2.googleapis.com/token') {
    const params = new URLSearchParams(String(init.body));
    if (params.get('grant_type') === 'refresh_token' && google.refreshFails) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
    return json({
      access_token: 'access',
      refresh_token: params.get('grant_type') === 'authorization_code' ? 'refresh-token' : undefined,
      scope: 'https://www.googleapis.com/auth/photoslibrary.appendonly https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata'
    });
  }
  if (url.hostname === 'oauth2.googleapis.com') return new Response('');
  if (url.hostname === 'photoslibrary.googleapis.com') {
    const path = url.pathname.replace('/v1', '');
    const body = init.body && !(init.body instanceof Buffer) ? JSON.parse(init.body) : null;
    if (path === '/albums' && method === 'POST') {
      const id = `album-${albums.size + 1}`;
      albums.set(id, { id, title: body.album.title, items: [] });
      return json({ id, title: body.album.title, productUrl: `https://photos.google.com/album/${id}` });
    }
    const albumGet = path.match(/^\/albums\/([^/:]+)$/);
    if (albumGet) return albums.has(albumGet[1]) ? json({ id: albumGet[1], title: albums.get(albumGet[1]).title }) : json({ error: { code: 404, message: 'Not found' } }, 404);
    if (path === '/uploads') {
      const token = `up-${uploadTokens.size + 1}`;
      uploadTokens.set(token, Buffer.from(init.body));
      return new Response(token);
    }
    if (path === '/mediaItems:batchCreate') {
      const album = albums.get(body.albumId);
      if (!album) return json({ error: { code: 400, message: 'Invalid album' } }, 400);
      if (google.failUploadAt && --google.failUploadAt === 0) return json({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, 429);
      const bytes = uploadTokens.get(body.newMediaItems[0].simpleMediaItem.uploadToken);
      // Google gives the same bytes the same media item, name and all.
      const existing = [...library.values()].find(item => item.md5 === md5(bytes));
      const item = existing || {
        id: `photo-${++photoSeq}`,
        md5: md5(bytes),
        bytes,
        filename: body.newMediaItems[0].simpleMediaItem.fileName,
        description: body.newMediaItems[0].description,
        creationTime: new Date(Date.now() + photoSeq).toISOString(),
        hidden: google.lag
      };
      library.set(item.id, item);
      google.uploads += 1;
      if (!album.items.includes(item.id)) {
        const position = body.albumPosition || {};
        const at = position.position === 'AFTER_MEDIA_ITEM' ? album.items.indexOf(position.relativeMediaItemId) + 1 : 0;
        album.items.splice(at, 0, item.id);
      }
      return json({ newMediaItemResults: [{ status: { message: 'Success' }, mediaItem: { id: item.id, mediaMetadata: { creationTime: item.creationTime } } }] });
    }
    if (path === '/mediaItems:search') {
      const album = albums.get(body.albumId);
      if (!album) return json({ error: { code: 400, message: 'Invalid album' } }, 400);
      const listed = album.items.filter(id => !library.get(id).hidden);
      return json({ mediaItems: listed.map(id => ({ id, filename: library.get(id).filename, mediaMetadata: { creationTime: library.get(id).creationTime } })) });
    }
    const remove = path.match(/^\/albums\/([^/:]+):batchRemoveMediaItems$/);
    if (remove) {
      const album = albums.get(remove[1]);
      if (google.failRemove) return json({ error: { code: 500, message: 'Internal error' } }, 500);
      for (const id of body.mediaItemIds) assert.ok(album.items.includes(id), `removing ${id} that is not in the album`);
      album.items = album.items.filter(id => !body.mediaItemIds.includes(id));
      google.removes += body.mediaItemIds.length;
      return json({});
    }
  }
  throw new Error(`Unexpected fetch ${method} ${url.href}`);
}
globalThis.fetch = fakeFetch;

const { runTvSync } = await import('../api/_tv-job.js');
const { default: handler } = await import('../api/tv/[action].js');
const { buildTvPlan } = await import('../api/_tv-render.js');

// ------------------------------------------------------------------ helpers
function call(method, path, headers = {}, body = undefined) {
  return new Promise(resolve => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      end(body) { resolve({ status: this.statusCode, headers: this.headers, body: Buffer.isBuffer(body) ? body : String(body || '') }); }
    };
    handler({ method, url: path, headers: { host: 'homedash.test', ...headers }, body }, res);
  });
}

function costOf(fn) {
  return async () => {
    const before = { ...ops };
    const result = await fn();
    return { result, simple: ops.simple - before.simple, advanced: ops.advanced - before.advanced };
  };
}

// Oslo wall-clock time on a day in late November 2026 (UTC+1).
const oslo = (day, hour, minute = 0) => new Date(Date.UTC(2026, 10, day, hour - 1, minute)).toISOString();
let events = [
  { id: 'dentist', title: 'Tannlege', start: oslo(26, 14, 30), end: oslo(26, 15, 15), repeat: 'none', imageUrl: 'https://test.local/a.jpg' },
  { id: 'football', title: 'Fotballtrening', start: oslo(27, 17, 30), repeat: 'weekly', location: 'Lade' },
  { id: 'doctor', title: 'Sofia lege', start: oslo(30, 13), repeat: 'none', note: 'Ta med helsekort', imageUrl: 'https://test.local/b.jpg' },
  { id: 'work', title: 'Work meeting', start: oslo(27, 10), repeat: 'none', scope: 'work' },
  { id: 'done', title: 'Already done', start: oslo(28, 10), repeat: 'none', completed: true },
  { id: 'far', title: 'Far away', start: oslo(20, 10).replace('-11-', '-12-'), repeat: 'none' }
];
let stamp = 0;
function saveEvents() {
  const updatedAt = new Date(Date.UTC(2026, 10, 1) + (stamp += 1) * 1000).toISOString();
  storeBlob('home-organizer/events.json', JSON.stringify({ updatedAt, events }));
  storeBlob('home-organizer/events-version.json', JSON.stringify({ updatedAt }));
}

function album() {
  return [...albums.values()][0];
}

function count(prefix) {
  return albumDescriptions().filter(text => text.startsWith(prefix)).length;
}

function albumDescriptions() {
  return album().items.map(id => library.get(id).description.replace(/^HomeDash TV: /, ''));
}

// -------------------------------------------------------------------- tests
const at = when => ({ now: new Date(when), budgetMs: 10 * 60 * 1000 });

test('the plan: overview, this week, next week overview, next week, family only', () => {
  const plan = buildTvPlan({ events, now: new Date(oslo(26, 9)), language: 'en', weeks: 2 });
  assert.deepEqual(plan.map(slide => slide.key), [
    'overview',
    'event:dentist:2026-11-26:14:30',
    'event:football:2026-11-27:17:30',
    'week:2026-11-30',
    'event:doctor:2026-11-30:13:00',
    'event:football:2026-12-04:17:30'
  ]);
  assert.equal(plan[1].model.when, 'Thursday 26 November · 14:30–15:15');
  assert.equal(plan[1].until, oslo(26, 15, 15));
  assert.equal(plan[2].until, oslo(27, 18, 30), 'a task without an end is over an hour after it starts');
  const tomorrow = buildTvPlan({ events, now: new Date(oslo(27, 9)), language: 'en', weeks: 2 });
  assert.equal(tomorrow.find(slide => slide.key === 'event:doctor:2026-11-30:13:00').hash, plan[4].hash, 'a task slide does not change from one day to the next');
  assert.notEqual(tomorrow[0].hash, plan[0].hash, 'the overview does');
});

test('not connected: the daily run does nothing and costs no Blob operation', async () => {
  saveEvents();
  const { result, simple, advanced } = await costOf(() => runTvSync(at(oslo(26, 8))))();
  assert.equal(result.skipped, 'not connected');
  assert.equal(advanced, 0);
  assert.ok(simple <= 1, `a missing state file is one CDN miss, got ${simple}`);
});

test('connect: the sign-in link, the callback, the first upload', async () => {
  const unauthorized = await call('POST', '/api/tv/connect');
  assert.equal(unauthorized.status, 401);
  const connect = await call('POST', '/api/tv/connect', { 'x-admin-pin': '1234' });
  const { url, redirectUri } = JSON.parse(connect.body);
  assert.equal(redirectUri, 'https://homedash.test/api/tv/callback');
  const state = new URL(url).searchParams.get('state');
  assert.equal(new URL(url).searchParams.get('access_type'), 'offline');

  const forged = await call('GET', '/api/tv/callback?code=x&state=forged');
  assert.equal(forged.status, 400);

  const page = await call('GET', `/api/tv/callback?code=good&state=${encodeURIComponent(state)}`);
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /Google Photos is connected/);
  // The CDN still says the state is not there (it was asked for while
  // nothing was connected); the first upload must not trip over that.
  assert.doesNotMatch(page.body, /first upload failed/);
  assert.match(page.body, /pictures are already in the album/);
  assert.equal(albums.size, 1);
  assert.equal(album().title, 'HomeDash TV');
  const stored = JSON.parse(blobs.get('home-organizer/tv/state.json').text);
  assert.ok(!JSON.stringify(stored).includes('refresh-token'), 'the refresh token is never stored in the clear');
});

test('the album holds every slide, in slideshow order', async () => {
  // Pressed at once: the CDN's remembered 404 is waited out, not an error.
  cdnNotFound.set('home-organizer/tv/state.json', 2);
  // The callback's first run may stop at its time budget; finish it.
  let result = await runTvSync({ ...at(oslo(26, 9)), force: true });
  while (result.more) result = await runTvSync({ ...at(oslo(26, 9)), force: true });
  assert.equal(result.slides, album().items.length, 'an update reports the album\'s own count');
  assert.deepEqual(albumDescriptions(), [
    'calendar overview, Thursday 26 November 2026',
    'Tannlege, Thursday 26 November · 14:30–15:15',
    'Fotballtrening, Friday 27 November · 17:30',
    'Next week, Nov 30 – Dec 6',
    'Sofia lege, Monday 30 November · 13:00',
    'Fotballtrening, Friday 4 December · 17:30'
  ]);
  if (process.env.SLIDES) {
    fs.mkdirSync(new URL('./tv-test-out/', import.meta.url), { recursive: true });
    album().items.forEach((id, index) => fs.writeFileSync(new URL(`./tv-test-out/${index}.jpg`, import.meta.url), library.get(id).bytes));
  }
});

test('a run with nothing to do (the catch-up) costs no Blob operation and uploads nothing', async () => {
  // Warm the CDN copies the way the first run after a write would.
  await runTvSync(at(oslo(26, 10)));
  const uploads = google.uploads;
  const { result, simple, advanced } = await costOf(() => runTvSync(at(oslo(26, 11))))();
  assert.equal(result.skipped, 'nothing changed');
  assert.equal(simple, 0);
  assert.equal(advanced, 0);
  assert.equal(google.uploads, uploads);
});

test('a task that is over leaves the album without reading the task list', async () => {
  const before = album().items.length;
  const { result, simple, advanced } = await costOf(() => runTvSync(at(oslo(26, 16))))();
  assert.equal(result.reason, 'task over');
  assert.equal(result.removed, 1);
  assert.equal(advanced, 1);
  assert.equal(album().items.length, before - 1);
  assert.ok(!albumDescriptions().some(text => text.startsWith('Tannlege')));
  // The confirmed state read (head + one CDN miss); the task list is not read.
  assert.ok(simple <= 2, `expected at most 2 simple operations, got ${simple}`);
});

test('an edited task: the new picture first, then the old one out; only the slides showing it upload', async () => {
  events = events.map(event => event.id === 'doctor' ? { ...event, title: 'Sofia lege (Lade)' } : event);
  saveEvents();
  const uploads = google.uploads;
  const { result, advanced } = await costOf(() => runTvSync(at(oslo(26, 17))))();
  assert.equal(result.reason, 'tasks changed');
  // The doctor's own slide, the next-week overview whose big card is it, and
  // today's overview, whose Upcoming strip shows it. Nothing else.
  assert.equal(google.uploads - uploads, 3);
  assert.equal(advanced, 1);
  const texts = albumDescriptions();
  assert.ok(texts.some(text => text.startsWith('Sofia lege (Lade), Monday 30 November')));
  assert.ok(!texts.some(text => text.startsWith('Sofia lege, ')));
  assert.equal(texts[2], 'Next week, Nov 30 – Dec 6');
  assert.equal(texts[3], 'Sofia lege (Lade), Monday 30 November · 13:00', 'the new picture took the old one\'s place');
});

test('a deleted task leaves the album', async () => {
  events = events.filter(event => event.id !== 'doctor');
  saveEvents();
  await runTvSync(at(oslo(26, 18)));
  assert.ok(!albumDescriptions().some(text => text.startsWith('Sofia lege')));
});

test('a change nobody can see costs one state write and no upload', async () => {
  events = [...events, { id: 'later', title: 'Next year', start: oslo(26, 10).replace('2026', '2027'), repeat: 'none' }];
  saveEvents();
  const uploads = google.uploads;
  const { result, advanced } = await costOf(() => runTvSync(at(oslo(26, 19))))();
  assert.equal(result.uploaded, 0);
  assert.equal(google.uploads, uploads);
  assert.equal(advanced, 1);
});

test('a new day uploads the new overview, and the old overview leaves', async () => {
  const { result } = await costOf(() => runTvSync(at(oslo(27, 0, 30))))();
  assert.equal(result.reason, 'new day');
  const texts = albumDescriptions();
  assert.equal(texts[0], 'calendar overview, Friday 27 November 2026');
  assert.equal(texts.filter(text => text.startsWith('calendar overview')).length, 1);
});

test('a picture deleted by hand in Google Photos is put back', async () => {
  const removedId = album().items[1];
  album().items = album().items.filter(id => id !== removedId);
  events = [...events, { id: 'nudge', title: 'Nudge', start: oslo(29, 12), repeat: 'none' }];
  saveEvents();
  await runTvSync(at(oslo(27, 9)));
  assert.equal(new Set(album().items).size, album().items.length);
  assert.ok(albumDescriptions().some(text => text.startsWith('Fotballtrening, Friday 27 November')));
});

test('pictures Google is slow to list do not pile up: the next run picks them up', async () => {
  // A new task next week redraws next week's overview (and today's, whose
  // strip has a dot on that day).
  events = [...events, { id: 'slow', title: 'Foreldremøte', start: oslo(30, 18), repeat: 'none' }];
  saveEvents();
  google.lag = true;
  const first = await runTvSync(at(oslo(27, 9, 5)));
  assert.ok(first.ok);
  // Not listed yet, so the old pictures stay up meanwhile.
  reveal();
  assert.equal(count('Next week'), 2, 'the old next week stays up until the new one is listed');

  // The next run (the catch-up), hours later: the new pictures are listed
  // now. They are taken into use and the old ones go, without drawing and
  // uploading the same thing again.
  ageLibrary(3 * 60 * 60 * 1000);
  const uploads = google.uploads;
  const second = await runTvSync(at(oslo(27, 9, 10)));
  reveal();
  google.lag = false;
  assert.ok(second.ok, second.error);
  assert.equal(count('Next week'), 1, 'one next week');
  assert.equal(count('calendar overview'), 1, 'one overview');
  assert.equal(google.uploads, uploads, 'nothing is uploaded twice');
  assert.ok(albumDescriptions().some(text => text.startsWith('Foreldremøte')));
  const plan = buildTvPlan({ events, now: new Date(oslo(27, 9, 10)), language: 'en', weeks: 2 });
  const week = album().items.map(id => library.get(id)).find(item => item.description.includes('Next week'));
  assert.ok(week.filename.includes(plan.find(slide => slide.key === 'week:2026-11-30').hash.slice(0, 10)), 'the next week left up is the new one');
});

test('an upload that fails half way: what did go up is swapped in, the rest follows on the next run', async () => {
  ageLibrary(60 * 60 * 1000);
  events = [...events, { id: 'half', title: 'Halvveis', start: oslo(1, 17).replace('-11-', '-12-'), repeat: 'none' }];
  saveEvents();
  // Today's overview goes up; the next picture is refused.
  google.failUploadAt = 2;
  const first = await runTvSync(at(oslo(27, 9, 15)));
  assert.equal(first.ok, false);
  assert.equal(count('calendar overview'), 1, 'the new overview replaced the old one although the run failed');
  google.failUploadAt = 0;
  ageLibrary(60 * 60 * 1000);
  const second = await runTvSync(at(oslo(27, 9, 20)));
  assert.ok(second.ok, second.error);
  const texts = albumDescriptions();
  assert.equal(new Set(texts).size, texts.length, `no picture twice: ${texts.join(' | ')}`);
  assert.ok(texts.some(text => text.startsWith('Halvveis')));
});

test('Google refusing to take old pictures out: they go on the next run, nothing is uploaded again', async () => {
  ageLibrary(60 * 60 * 1000);
  events = events.map(event => event.id === 'half' ? { ...event, title: 'Halvveis (flyttet)' } : event);
  saveEvents();
  google.failRemove = true;
  const first = await runTvSync(at(oslo(27, 9, 22)));
  assert.equal(first.ok, false);
  google.failRemove = false;
  ageLibrary(60 * 60 * 1000);
  const uploads = google.uploads;
  const second = await runTvSync(at(oslo(27, 9, 24)));
  assert.ok(second.ok, second.error);
  assert.equal(google.uploads, uploads, 'the pictures the failed run put up are kept');
  const texts = albumDescriptions();
  assert.equal(new Set(texts).size, texts.length, `no picture twice: ${texts.join(' | ')}`);
  assert.ok(!texts.some(text => text === 'Halvveis, Tuesday 1 December · 17:00'));
});

test('the Q panel: a current status read, and language and weeks stored for the album', async () => {
  const before = { ...ops };
  const light = JSON.parse((await call('GET', '/api/tv/status?light=1', { 'x-admin-pin': '1234' })).body);
  assert.ok(ops.simple - before.simple <= 2, 'the quick status is a head() and at most one CDN miss');
  assert.equal(ops.advanced - before.advanced, 0);
  assert.equal(light.connected, true);
  assert.equal(light.slides.length, album().items.length, 'the count is the album\'s, not an older copy\'s');
  assert.deepEqual(light.settings, { language: 'en', weeks: 2 });

  const bad = await call('POST', '/api/tv/settings', { 'x-admin-pin': '1234' }, { weeks: 9 });
  assert.equal(bad.status, 400);
  const saved = JSON.parse((await call('POST', '/api/tv/settings', { 'x-admin-pin': '1234' }, { language: 'nb' })).body);
  assert.deepEqual(saved.settings, { language: 'nb', weeks: 2 });
  let result = await runTvSync(at(oslo(27, 9, 30)));
  assert.equal(result.reason, 'settings changed');
  while (result.more) result = await runTvSync({ ...at(oslo(27, 9, 30)), force: true });
  assert.ok(albumDescriptions()[0].startsWith('calendar overview, Fredag 27'), albumDescriptions()[0]);
  assert.ok(albumDescriptions().some(text => text.includes('Neste uke')));

  // One week ahead: next week's overview and tasks leave, nothing is redrawn.
  const uploads = google.uploads;
  await call('POST', '/api/tv/settings', { 'x-admin-pin': '1234' }, { weeks: 1 });
  await runTvSync(at(oslo(27, 9, 40)));
  assert.equal(google.uploads, uploads);
  assert.ok(!albumDescriptions().some(text => text.includes('Neste uke')));
});

test('a revoked Google connection is reported once, then costs nothing per run', async () => {
  google.refreshFails = true;
  events = [...events, { id: 'new', title: 'Ny avtale', start: oslo(29, 15), repeat: 'none' }];
  saveEvents();
  const first = await runTvSync(at(oslo(27, 10)));
  assert.equal(first.ok, false);
  assert.equal(first.reconnect, true);
  await runTvSync(at(oslo(27, 11)));
  const { result, simple, advanced } = await costOf(() => runTvSync(at(oslo(27, 12))))();
  assert.equal(result.skipped, 'backing off');
  assert.equal(simple + advanced, 0);
  google.refreshFails = false;
});

test('status and preview need the PIN; preview answers with a 16:9 JPEG', async () => {
  assert.equal((await call('GET', '/api/tv/status')).status, 401);
  const status = JSON.parse((await call('GET', '/api/tv/status', { 'x-admin-pin': '1234' })).body);
  assert.equal(status.connected, true);
  assert.equal(status.setup.cheapChecks, true);
  assert.equal(status.setup.size, '3840x2160');
  const preview = await call('GET', '/api/tv/preview?slide=0', { 'x-admin-pin': '1234' });
  assert.equal(preview.headers['content-type'], 'image/jpeg');
  const decoded = jpeg.decode(preview.body, { useTArray: true });
  assert.equal(decoded.width / decoded.height, 16 / 9);
});

test('the cron run needs the cron secret', async () => {
  assert.equal((await call('GET', '/api/tv/refresh')).status, 401);
  const ok = await call('GET', '/api/tv/refresh', { authorization: 'Bearer cron-secret' });
  assert.equal(ok.status, 200);
});
