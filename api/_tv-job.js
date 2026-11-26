// Keeps the HomeDash TV album in step with the calendar. Runs once a day,
// just after midnight (Vercel cron), with a catch-up run a couple of hours
// later that only does anything when the first left work over or never ran;
// and by hand from the Q panel or /tv.html.
//
// What a run costs:
//   nothing to do     - two reads off the Blob CDN (cache hits, not billed as
//                       Blob operations) and a few milliseconds of function.
//   a task is over    - its picture is taken out of the album: one confirmed
//                       state read and one state write. The task list is not
//                       read.
//   tasks changed or  - the task list and the state are read (four simple
//   a new day         - operations), only the slides whose content changed
//                       are drawn and uploaded, and the state is written once
//                       (one advanced operation).
//
// A new picture is uploaded first, confirmed in the album, and only then is
// the one it replaces taken out, so a failed upload leaves the last good
// slide on the TV.
import { dateKeyInTimeZone } from './_reminders.js';
import { buildTvPlan, renderTvSlide, tvLanguage, tvWeeks, TV_LAYOUT_VERSION } from './_tv-render.js';
import {
  readTvStateCheap,
  readTvStateFresh,
  writeTvState,
  readVersionStamp,
  readEventsForTv,
  openSecret
} from './_tv-state.js';
import {
  GoogleError,
  accessTokenFrom,
  createAlbum,
  getAlbum,
  uploadToAlbum,
  albumItems,
  removeFromAlbum
} from './_tv-google.js';

// The function is cut off at 60 seconds (vercel.json). No new slide is
// started after this much, leaving time to confirm, tidy up and save.
const UPLOAD_BUDGET_MS = 38 * 1000;
// After three failures in a row with the same error, try at most every six
// hours, so a broken connection cannot keep spending Blob operations.
const BACKOFF_AFTER_FAILURES = 3;
const BACKOFF_MS = 6 * 60 * 60 * 1000;
// Pictures somebody else's run may have just uploaded are left alone.
const STRAY_GRACE_MS = 5 * 60 * 1000;

export function albumTitle() {
  return String(process.env.TV_ALBUM_TITLE || 'HomeDash TV').trim().slice(0, 500) || 'HomeDash TV';
}

// Language and weeks ahead, as picked in the wall's Q panel (stored in the
// TV state), else from TV_LANGUAGE / TV_WEEKS, else English and two weeks.
export function tvSettings(state) {
  const config = state?.config || {};
  return {
    language: config.language === 'nb' || config.language === 'en' ? config.language : tvLanguage(),
    weeks: Number.isInteger(config.weeks) && config.weeks >= 1 && config.weeks <= 4 ? config.weeks : tvWeeks()
  };
}

function settingsKey(state) {
  const { language, weeks } = tvSettings(state);
  return `${TV_LAYOUT_VERSION}|${language}|${weeks}`;
}

// Why the album needs work, or '' when it does not. Decided from the cheap
// reads alone.
function reasonToWork(state, { stamp, todayKey, now }) {
  if (!state.seen) return 'first run';
  if (state.pending) return 'unfinished upload';
  if (!stamp || state.seen.sourceVersion !== stamp) return 'tasks changed';
  if (state.seen.dateKey !== todayKey) return 'new day';
  if (state.seen.settings !== settingsKey(state)) return 'settings changed';
  if (Object.values(state.slides || {}).some(slide => slide.until && Date.parse(slide.until) <= now.getTime())) return 'task over';
  return '';
}

function backingOff(state, now) {
  const error = state.lastError;
  if (!error) return '';
  if (error.reconnect) return 'Google Photos needs to be connected again.';
  if (Number(error.count) >= BACKOFF_AFTER_FAILURES && now.getTime() - Date.parse(error.at) < BACKOFF_MS) {
    return `Failed ${error.count} times in a row; trying again at most every six hours.`;
  }
  return '';
}

function slideFileName(slide) {
  const kind = slide.kind === 'event' ? 'task' : slide.kind;
  return `homedash-tv-${kind}-${slide.hash.slice(0, 10)}.jpg`;
}

function slideDescription(slide) {
  const model = slide.model;
  if (slide.kind === 'event') return `HomeDash TV: ${model.title}, ${model.when}`.slice(0, 1000);
  if (slide.kind === 'week') return `HomeDash TV: ${model.date.heading}, ${model.date.sub}`.slice(0, 1000);
  return `HomeDash TV: calendar overview, ${model.date.heading} ${model.date.big} ${model.date.sub}`.slice(0, 1000);
}

async function failed(state, error, now) {
  const message = String(error?.message || error || 'Unknown error').slice(0, 500);
  const previous = state.lastError;
  const count = previous && previous.message === message ? Number(previous.count || 1) + 1 : 1;
  const lastError = { at: now.toISOString(), message, reconnect: Boolean(error?.reconnect), count };
  // A repeat of the same failure is only written while it is still counting
  // up to the back-off, so a failure that sticks does not write every run.
  if (!previous || previous.message !== message || count <= BACKOFF_AFTER_FAILURES || error?.reconnect !== previous.reconnect || count % 4 === 0) {
    try {
      await writeTvState({ ...state, lastError });
    } catch {}
  }
  return { ok: false, error: message, reconnect: lastError.reconnect, failures: count };
}

// Takes the pictures of tasks that are over out of the album. Nothing else
// changes, so the task list is not read.
async function removeExpired(state, accessToken, now) {
  const slides = { ...(state.slides || {}) };
  const expired = Object.entries(slides).filter(([, slide]) => slide.until && Date.parse(slide.until) <= now.getTime());
  const liveIds = new Set(Object.entries(slides).filter(([key]) => !expired.some(([gone]) => gone === key)).map(([, slide]) => slide.id));
  const present = new Set((await albumItems(accessToken, state.album.id)).map(item => item.id));
  const ids = expired.map(([, slide]) => slide.id).filter(id => present.has(id) && !liveIds.has(id));
  if (ids.length) await removeFromAlbum(accessToken, state.album.id, ids);
  for (const [key] of expired) delete slides[key];
  return { slides, removed: ids.length };
}

// The full pass: plan, reconcile with the album, upload what changed, take
// out what is gone.
async function syncAlbum(state, accessToken, { events, now, rebuild, startedAt, budgetMs }) {
  const plan = buildTvPlan({ events, now, ...tvSettings(state) });
  let album = state.album;
  let albumRecreated = false;
  let inAlbum = null;

  if (album?.id) {
    try {
      inAlbum = await albumItems(accessToken, album.id);
    } catch (error) {
      if (!(error instanceof GoogleError) || ![400, 403, 404].includes(error.status)) throw error;
      if (await getAlbum(accessToken, album.id)) throw error;
      album = null;
    }
  }
  if (!album?.id) {
    // Deleted in Google Photos, or never made: a new one, which then has to
    // be picked on the TV once.
    albumRecreated = Boolean(state.album?.id);
    const created = await createAlbum(accessToken, albumTitle());
    album = { ...created, createdAt: now.toISOString() };
    inAlbum = [];
  }

  const presentIds = new Set(inAlbum.map(item => item.id));
  // Slides somebody deleted in Google Photos have left the album too; they
  // are simply uploaded again.
  const known = {};
  for (const [key, slide] of Object.entries(albumRecreated ? {} : state.slides || {})) {
    if (presentIds.has(slide.id)) known[key] = slide;
  }
  const desired = new Map(plan.map(slide => [slide.key, slide]));
  const toUpload = plan.filter(slide => rebuild || known[slide.key]?.hash !== slide.hash);

  // Upload in slideshow order, each one placed after the slide before it.
  const current = { ...known };
  const replaced = [];
  const uploaded = [];
  let pending = false;
  for (const slide of toUpload) {
    if (Date.now() - startedAt > budgetMs) {
      pending = true;
      break;
    }
    const index = plan.indexOf(slide);
    const before = plan.slice(0, index).reverse().find(other => current[other.key]?.id);
    const image = await renderTvSlide(slide.model, { renderedAt: now });
    const item = await uploadToAlbum(accessToken, {
      albumId: album.id,
      bytes: image.jpeg,
      mimeType: 'image/jpeg',
      fileName: slideFileName(slide),
      description: slideDescription(slide),
      afterId: before ? current[before.key].id : ''
    });
    const previous = current[slide.key];
    if (previous?.id && previous.id !== item.id) replaced.push({ key: slide.key, id: previous.id, newId: item.id });
    current[slide.key] = {
      id: item.id,
      hash: slide.hash,
      kind: slide.kind,
      until: slide.until,
      title: slide.kind === 'event' ? slide.model.title : slide.kind,
      bytes: image.bytes,
      uploadedAt: new Date().toISOString()
    };
    uploaded.push(slide.key);
  }

  // Confirm the new pictures really are in the album before anything they
  // replace is taken out.
  const after = uploaded.length ? await albumItems(accessToken, album.id) : inAlbum;
  const afterIds = new Set(after.map(item => item.id));
  const notConfirmed = uploaded.filter(key => !afterIds.has(current[key].id));
  for (const key of notConfirmed) {
    if (known[key]) current[key] = known[key];
    else delete current[key];
  }

  // Gone from the plan: deleted, completed, over, or past the horizon.
  for (const key of Object.keys(current)) {
    if (!desired.has(key)) delete current[key];
  }
  const keepIds = new Set(Object.values(current).map(slide => slide.id));
  const removeIds = new Set();
  for (const [key, slide] of Object.entries(known)) {
    if (!desired.has(key) && !keepIds.has(slide.id)) removeIds.add(slide.id);
  }
  for (const swap of replaced) {
    if (!notConfirmed.includes(swap.key) && !keepIds.has(swap.id)) removeIds.add(swap.id);
  }
  // HomeDash pictures the state does not know (from a run that failed half
  // way) are taken out too, unless they are only minutes old.
  for (const item of after) {
    const created = Date.parse(item.creationTime);
    if (!keepIds.has(item.id) && Number.isFinite(created) && created < startedAt - STRAY_GRACE_MS) removeIds.add(item.id);
  }
  const removable = [...removeIds].filter(id => afterIds.has(id));
  if (removable.length) await removeFromAlbum(accessToken, album.id, removable);

  return {
    album,
    albumRecreated,
    slides: current,
    pending,
    uploaded: uploaded.length - notConfirmed.length,
    removed: removable.length,
    notConfirmed: notConfirmed.length,
    planned: plan.length,
    remaining: plan.filter(slide => current[slide.key]?.hash !== slide.hash).length
  };
}

// One run. `force` skips the free "anything to do?" check; `rebuild` draws
// and uploads every slide again (after a design change).
export async function runTvSync({ force = false, rebuild = false, now = new Date(), budgetMs = UPLOAD_BUDGET_MS, trigger = 'schedule' } = {}) {
  const startedAt = Date.now();
  const todayKey = dateKeyInTimeZone(now);

  const cheap = force ? null : await readTvStateCheap();
  if (cheap) {
    if (!cheap.google?.refreshToken) return { ok: true, skipped: 'not connected' };
    const hold = backingOff(cheap, now);
    if (hold) return { ok: false, skipped: 'backing off', error: hold, reconnect: Boolean(cheap.lastError?.reconnect) };
    const stamp = await readVersionStamp();
    const reason = reasonToWork(cheap, { stamp, todayKey, now });
    if (!reason) return { ok: true, skipped: 'nothing changed', slides: Object.keys(cheap.slides || {}).length };
    return work({ reason, now, todayKey, rebuild, startedAt, budgetMs, trigger, expiredOnly: reason === 'task over' });
  }
  return work({ reason: rebuild ? 'rebuild' : 'by hand', now, todayKey, rebuild, startedAt, budgetMs, trigger, expiredOnly: false });
}

async function work({ reason, now, todayKey, rebuild, startedAt, budgetMs, trigger, expiredOnly }) {
  // Confirmed against the store, so a connect or a run a minute ago is seen.
  const state = await readTvStateFresh();
  if (!state.google?.refreshToken) return { ok: true, skipped: 'not connected' };

  try {
    const accessToken = await accessTokenFrom(openSecret(state.google.refreshToken));

    if (expiredOnly && state.album?.id) {
      const { slides, removed } = await removeExpired(state, accessToken, now);
      await writeTvState({ ...state, slides, lastError: null, lastRun: { at: now.toISOString(), trigger, reason, uploaded: 0, removed, ms: Date.now() - startedAt } });
      return { ok: true, reason, uploaded: 0, removed, slides: Object.keys(slides).length };
    }

    const doc = await readEventsForTv();
    if (!doc) {
      // The CDN is still replaying an older task list. Drawing from it would
      // put stale pictures up until the next change; the next run tries again.
      return { ok: true, skipped: 'task list not confirmed yet; trying again next run' };
    }

    const result = await syncAlbum(state, accessToken, { events: doc.events, now, rebuild, startedAt, budgetMs });
    const lastError = result.notConfirmed
      ? { at: now.toISOString(), message: `${result.notConfirmed} new picture(s) did not show up in the album; the previous ones were kept.`, reconnect: false, count: 1 }
      : null;
    await writeTvState({
      ...state,
      album: result.album,
      albumRecreatedAt: result.albumRecreated ? now.toISOString() : state.albumRecreatedAt || null,
      slides: result.slides,
      pending: result.pending || result.notConfirmed > 0,
      seen: { sourceVersion: doc.updatedAt, dateKey: todayKey, settings: settingsKey(state) },
      lastError,
      lastRun: { at: now.toISOString(), trigger, reason, uploaded: result.uploaded, removed: result.removed, ms: Date.now() - startedAt }
    });
    return {
      ok: true,
      reason,
      uploaded: result.uploaded,
      removed: result.removed,
      slides: Object.keys(result.slides).length,
      planned: result.planned,
      more: result.pending,
      remaining: result.remaining,
      albumRecreated: result.albumRecreated,
      ms: Date.now() - startedAt
    };
  } catch (error) {
    console.warn('TV sync failed:', error);
    return failed(state, error, now);
  }
}
