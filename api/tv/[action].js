// The TV screensaver's endpoints, all in one function (Hobby allows twelve per
// deployment):
//
//   GET|POST /api/tv/refresh     daily Vercel cron (Bearer CRON_SECRET) or by hand (PIN)
//   GET      /api/tv/status      what the album holds and what it should (PIN);
//                                ?light=1 leaves the slide plan out (Q panel)
//   POST     /api/tv/settings    language and weeks ahead, from the Q panel (PIN)
//   GET      /api/tv/preview     one slide as a JPEG, nothing uploaded (PIN)
//   POST     /api/tv/connect     the Google sign-in address (PIN)
//   GET      /api/tv/callback    where Google sends the browser back
//   POST     /api/tv/disconnect  forget the Google connection (PIN)
import { buildTvPlan, renderTvSlide, TV_WIDTH, TV_HEIGHT, TV_LAYOUT_VERSION } from '../_tv-render.js';
import { runTvSync, albumTitle, tvSettings } from '../_tv-job.js';
import {
  readTvStateCheap,
  readTvStateFresh,
  writeTvState,
  readEventsForTv,
  publicBlobUrl,
  sealSecret,
  openSecret,
  signOAuthState,
  verifyOAuthState,
  TV_STATE_PATH
} from '../_tv-state.js';
import {
  googleConfigMissing,
  authorizationUrl,
  exchangeCode,
  revokeToken,
  createAlbum,
  getAlbum
} from '../_tv-google.js';

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function sendPage(res, status, title, bodyHtml) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f5f1eb;--ink:#2f2b27;--muted:#81786e;--card:rgba(255,255,255,.8)}
@media (prefers-color-scheme: dark){:root{--bg:#1f1c19;--ink:#f3ede5;--muted:#b3a99d;--card:rgba(255,255,255,.06)}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
main{max-width:560px;background:var(--card);border-radius:24px;padding:28px;box-shadow:0 18px 45px rgba(78,68,56,.12)}
h1{font-family:Georgia,serif;font-weight:500;letter-spacing:-.03em;margin:0 0 12px;font-size:32px;line-height:1.1}
p,li{color:var(--muted)} strong{color:var(--ink)} a{color:inherit}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${bodyHtml}<p><a href="/">Back to HomeDash</a> · <a href="/tv.html">TV details</a></p></main></body></html>`);
}

function actionOf(req) {
  const path = new URL(req.url, 'https://localhost').pathname;
  return decodeURIComponent(path.split('/').filter(Boolean).pop() || '') || String(req.query?.action || '');
}

function isAdmin(req) {
  return Boolean(process.env.ADMIN_PIN) && req.headers['x-admin-pin'] === process.env.ADMIN_PIN;
}

// Vercel's cron sends `Authorization: Bearer <CRON_SECRET>`.
function isCron(req) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
}

function siteOrigin(req) {
  const explicit = process.env.PUBLIC_SITE_URL || process.env.ORGANIZER_SITE_URL;
  if (explicit) return String(explicit).replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function redirectUri(req) {
  return `${siteOrigin(req)}/api/tv/callback`;
}

function missingSetup() {
  const missing = googleConfigMissing();
  if (!process.env.BLOB_READ_WRITE_TOKEN) missing.push('BLOB_READ_WRITE_TOKEN');
  if (!process.env.CRON_SECRET) missing.push('CRON_SECRET');
  return missing;
}

function publicSlides(state) {
  return Object.entries(state.slides || {}).map(([key, slide]) => ({
    key,
    kind: slide.kind,
    title: slide.title,
    until: slide.until,
    uploadedAt: slide.uploadedAt
  }));
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function status(req, res) {
  // The Q panel's quick look leaves the slide plan out. The state is read
  // confirmed against the store, not straight off the CDN, which can hand out
  // the copy from before the last update for up to a minute and showed the
  // wrong number of pictures (two small Blob reads per look).
  const light = new URL(req.url, 'https://localhost').searchParams.get('light') === '1';
  const state = await readTvStateFresh({ allowStale: true });
  const settings = tvSettings(state);
  let plan = [];
  let planError = '';
  if (!light) {
    try {
      const doc = await readEventsForTv();
      if (doc) plan = buildTvPlan({ events: doc.events, now: new Date(), ...settings });
      else planError = 'The task list could not be confirmed as current; try again in a minute.';
    } catch (error) {
      planError = error.message;
    }
  }
  send(res, 200, {
    connected: Boolean(state.google?.refreshToken),
    connectedAt: state.google?.connectedAt || null,
    album: state.album ? { title: state.album.title, url: state.album.url, createdAt: state.album.createdAt } : null,
    albumRecreatedAt: state.albumRecreatedAt || null,
    slides: publicSlides(state),
    plan: plan.map((slide, index) => ({
      index,
      key: slide.key,
      kind: slide.kind,
      title: slide.kind === 'event' ? slide.model.title : slide.model.date.heading,
      upToDate: state.slides?.[slide.key]?.hash === slide.hash
    })),
    planError,
    pending: Boolean(state.pending),
    lastRun: state.lastRun || null,
    lastError: state.lastError || null,
    settings,
    setup: {
      missing: missingSetup(),
      redirectUri: redirectUri(req),
      cheapChecks: Boolean(publicBlobUrl(TV_STATE_PATH)),
      size: `${TV_WIDTH}x${TV_HEIGHT}`,
      language: settings.language,
      weeks: settings.weeks,
      layout: TV_LAYOUT_VERSION,
      albumTitle: albumTitle()
    }
  });
}

async function preview(req, res) {
  const url = new URL(req.url, 'https://localhost');
  const doc = await readEventsForTv();
  if (!doc) {
    send(res, 503, { error: 'The task list could not be confirmed as current; try again in a minute.' });
    return;
  }
  const plan = buildTvPlan({ events: doc.events, now: new Date(), ...tvSettings(await readTvStateCheap()) });
  const wanted = url.searchParams.get('slide') || '0';
  const slide = plan.find(item => item.key === wanted) || plan[Number(wanted)] || plan[0];
  const image = await renderTvSlide(slide.model);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-TV-Slide', encodeURIComponent(slide.key));
  res.end(image.jpeg);
}

async function connect(req, res) {
  const missing = googleConfigMissing();
  if (missing.length) {
    send(res, 500, { error: `Add ${missing.join(' and ')} in Vercel environment variables first, then redeploy.` });
    return;
  }
  send(res, 200, { url: authorizationUrl({ redirectUri: redirectUri(req), state: signOAuthState() }), redirectUri: redirectUri(req) });
}

async function callback(req, res) {
  const url = new URL(req.url, 'https://localhost');
  if (url.searchParams.get('error')) {
    sendPage(res, 400, 'Google Photos was not connected', `<p>Google answered <strong>${escapeHtml(url.searchParams.get('error'))}</strong>. Nothing was changed.</p>`);
    return;
  }
  if (!verifyOAuthState(url.searchParams.get('state'))) {
    sendPage(res, 400, 'This sign-in link has expired', '<p>Start again from the TV settings page. A sign-in has to be finished within 15 minutes.</p>');
    return;
  }

  const tokens = await exchangeCode({ code: url.searchParams.get('code') || '', redirectUri: redirectUri(req) });
  if (tokens.missingScopes.length) {
    await revokeToken(tokens.refreshToken || tokens.accessToken);
    sendPage(res, 400, 'Some permissions were left unticked', `<p>HomeDash needs all three Google Photos permissions: to upload, to see its own album, and to take its own old pictures out of that album. Start again and leave every box ticked.</p>`);
    return;
  }
  if (!tokens.refreshToken) {
    sendPage(res, 400, 'Google did not hand out a long-lived sign-in', '<p>Remove HomeDash under <strong>myaccount.google.com → Security → Third-party apps</strong>, then connect again.</p>');
    return;
  }

  const state = await readTvStateFresh();
  // An album made by this same Google project for this same account is kept,
  // so the TV does not have to be pointed at a new one after a reconnect.
  let album = state.album?.id ? await getAlbum(tokens.accessToken, state.album.id) : null;
  let slides = album ? state.slides || {} : {};
  if (!album) {
    album = { ...(await createAlbum(tokens.accessToken, albumTitle())), createdAt: new Date().toISOString() };
    slides = {};
  } else {
    album = { ...state.album, ...album };
  }
  const written = await writeTvState({
    ...state,
    google: { refreshToken: sealSecret(tokens.refreshToken), connectedAt: new Date().toISOString() },
    album,
    slides,
    seen: null,
    pending: true,
    lastError: null
  });

  // The first slides go up straight away; the rest follow on the next runs.
  // The run is handed the state just written: read back at once, the CDN
  // could still answer with the copy from before (or with "not there").
  let first;
  try {
    first = await runTvSync({ force: true, trigger: 'connect', budgetMs: 30 * 1000, state: written });
  } catch (error) {
    first = { ok: false, error: error.message };
  }
  const albumLink = album.url ? `<a href="${escapeHtml(album.url)}" target="_blank" rel="noopener">${escapeHtml(album.title)}</a>` : `<strong>${escapeHtml(album.title)}</strong>`;
  const progress = first.ok
    ? `<p><strong>${first.uploaded || 0}</strong> of ${first.planned || 0} pictures are already in the album${first.more ? '; press <strong>Update the TV now</strong> in the Q panel for the rest, or they follow with the nightly update' : ''}.</p>`
    : `<p>The first upload failed: <strong>${escapeHtml(first.error || 'unknown error')}</strong>. The nightly update tries again, or press <strong>Update the TV now</strong> in the Q panel.</p>`;
  sendPage(res, 200, 'Google Photos is connected', `
<p>HomeDash keeps the album ${albumLink} in step with the calendar.</p>
${progress}
<p>On the TCL: <strong>Settings → System → Ambient mode → Google Photos</strong>, and pick <strong>${escapeHtml(album.title)}</strong>. It only has to be picked once.</p>`);
}

// Language and weeks ahead. Saved in the TV state; the next run redraws what
// they change (a new language redraws every slide, more weeks only adds).
async function saveSettings(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    send(res, 400, { error: 'Send JSON.' });
    return;
  }
  const state = await readTvStateFresh();
  const config = { ...(state.config || {}) };
  if (body.language !== undefined) {
    if (body.language !== 'en' && body.language !== 'nb') {
      send(res, 400, { error: 'Language is en or nb.' });
      return;
    }
    config.language = body.language;
  }
  if (body.weeks !== undefined) {
    const weeks = Number(body.weeks);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 4) {
      send(res, 400, { error: 'Weeks ahead is 1 to 4.' });
      return;
    }
    config.weeks = weeks;
  }
  const before = JSON.stringify(tvSettings(state));
  const next = { ...state, config };
  if (JSON.stringify(tvSettings(next)) !== before) await writeTvState(next);
  send(res, 200, { ok: true, settings: tvSettings(next) });
}

async function disconnect(req, res) {
  const state = await readTvStateFresh();
  if (state.google?.refreshToken) {
    try {
      await revokeToken(openSecret(state.google.refreshToken));
    } catch {}
  }
  // The album and what is in it stay in Google Photos; connecting the same
  // account again picks the album back up.
  await writeTvState({ ...state, google: null, seen: null, pending: false, lastError: null });
  send(res, 200, { ok: true, connected: false });
}

export default async function handler(req, res) {
  const action = actionOf(req);
  try {
    if (action === 'callback' && req.method === 'GET') return await callback(req, res);

    if (action === 'refresh' && (req.method === 'GET' || req.method === 'POST')) {
      const admin = isAdmin(req);
      if (!admin && !isCron(req)) {
        send(res, 401, { ok: false, error: process.env.CRON_SECRET ? 'Unauthorized.' : 'CRON_SECRET is missing in Vercel environment variables.' });
        return;
      }
      const url = new URL(req.url, 'https://localhost');
      const result = await runTvSync({
        // By hand it always looks; the cron only when something changed.
        force: admin || url.searchParams.get('force') === '1',
        rebuild: admin && url.searchParams.get('rebuild') === '1',
        trigger: admin ? 'by hand' : String(req.headers['user-agent'] || '').includes('vercel-cron') ? 'vercel cron' : 'schedule'
      });
      send(res, 200, result);
      return;
    }

    if (!isAdmin(req)) {
      send(res, 401, { error: process.env.ADMIN_PIN ? 'Wrong admin PIN.' : 'ADMIN_PIN is missing in Vercel environment variables.' });
      return;
    }
    if (action === 'status' && req.method === 'GET') return await status(req, res);
    if (action === 'preview' && req.method === 'GET') return await preview(req, res);
    if (action === 'connect' && req.method === 'POST') return await connect(req, res);
    if (action === 'settings' && req.method === 'POST') return await saveSettings(req, res);
    if (action === 'disconnect' && req.method === 'POST') return await disconnect(req, res);
    send(res, 404, { error: `Unknown TV action "${action}".` });
  } catch (error) {
    console.warn(`TV ${action} failed:`, error);
    if (action === 'callback') {
      sendPage(res, 500, 'Google Photos was not connected', `<p>${escapeHtml(error.message || 'Something went wrong.')}</p>`);
      return;
    }
    send(res, Number(error?.statusCode) === 503 ? 503 : 500, { ok: false, error: error.message || 'Something went wrong.' });
  }
}
