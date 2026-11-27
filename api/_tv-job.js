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
//
// The album describes itself: every picture's file name carries the start of
// the hash of what it shows. A run that was cut off, failed half way, or
// uploaded a picture Google did not list in time leaves pictures the state
// does not know about. The next full run recognises them by name - one that
// shows a slide as it should be is taken into use instead of being drawn and
// uploaded again, and every other HomeDash picture in the album is taken out.
// So the album always settles on exactly one picture per slide, whatever the
// last run went through.
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
// Nothing waits on Google past this point (uploads are timed out, the album
// is not listed again), so a run still gets to take old pictures out and
// save what it did before Vercel stops it.
const HARD_STOP_MS = 50 * 1000;
// Google can take a moment to list a picture it has just created. Waits
// before listing the album again, while some new pictures are missing.
const CONFIRM_WAITS_MS = [1500, 3000];
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

// Every picture has carried this name since the first version, so pictures
// already in an album are recognised too.
const HASH_IN_NAME = 10;
function slideFileName(slide) {
  const kind = slide.kind === 'event' ? 'task' : slide.kind;
  return `homedash-tv-${kind}-${slide.hash.slice(0, HASH_IN_NAME)}.jpg`;
}

// The hash start in a picture's file name, or '' for any other name.
function hashInFileName(name) {
  const match = /^homedash-tv-(?:overview|week|task)-([0-9a-f]{10})\.jpe?g$/i.exec(String(name || ''));
  return match ? match[1].toLowerCase() : '';
}

// Only minutes old: another run may have just put it up and not saved yet.
function justCreated(item, startedAt) {
  const created = Date.parse(item.creationTime);
  return Number.isFinite(created) && created >= startedAt - STRAY_GRACE_MS;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slideRecord(slide) {
  return { hash: slide.hash, kind: slide.kind, until: slide.until, title: slide.kind === 'event' ? slide.model.title : slide.kind };
}

function slideDescription(slide) {
  const model = slide.model;
  if (slide.kind === 'event') return `HomeDash TV: ${model.title}, ${model.when}`.slice(0, 1000);
  if (slide.kind === 'week') return `HomeDash TV: ${model.date.heading}, ${model.date.sub}`.slice(0, 1000);
  return `HomeDash TV: calendar overview, ${model.date.heading} ${model.date.big} ${model.date.sub}`.slice(0, 1000);
}

// The error to store, counting repeats of the same one for the back-off.
function errorRecord(previous, error, now) {
  const message = String(error?.message || error || 'Unknown error').slice(0, 500);
  const count = previous && previous.message === message ? Number(previous.count || 1) + 1 : 1;
  return { at: now.toISOString(), message, reconnect: Boolean(error?.reconnect), count };
}

async function failed(state, error, now) {
  const previous = state.lastError;
  const lastError = errorRecord(previous, error, now);
  const { message, count } = lastError;
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
  const knownById = new Map(Object.values(known).map(slide => [slide.id, slide]));

  // What a picture in the album shows: the state's record of it, else the
  // hash in its file name (a picture a run put up but never got to record).
  // Google hands back the earlier picture, name and all, for the very same
  // bytes, so the state's record goes first.
  const shows = (item, slide) => {
    const record = knownById.get(item.id);
    return record ? record.hash === slide.hash : hashInFileName(item.filename) === slide.hash.slice(0, HASH_IN_NAME);
  };

  // Slides already in the album as they should be: the state's picture, or
  // the newest one that shows it.
  const current = {};
  const taken = new Set();
  let adopted = 0;
  if (!rebuild) {
    for (const slide of plan) {
      const mine = known[slide.key];
      const candidates = mine ? [inAlbum.find(item => item.id === mine.id), ...inAlbum] : inAlbum;
      const item = candidates.find(candidate => candidate && !taken.has(candidate.id) && shows(candidate, slide));
      if (!item) continue;
      taken.add(item.id);
      const record = knownById.get(item.id);
      current[slide.key] = record
        ? { ...record, ...slideRecord(slide) }
        : { id: item.id, ...slideRecord(slide), uploadedAt: item.creationTime || now.toISOString() };
      if (!record || mine?.id !== item.id) adopted += 1;
    }
  }
  const toUpload = plan.filter(slide => !current[slide.key]);

  // Upload in slideshow order, each one placed after the slide before it.
  // A failure stops the uploads, but what did go up is still swapped in and
  // saved below; the rest is left for the next run.
  const deadline = startedAt + Math.min(HARD_STOP_MS, budgetMs + 12 * 1000);
  const uploaded = [];
  let pending = false;
  let problem = null;
  for (const slide of toUpload) {
    if (Date.now() - startedAt > budgetMs) {
      pending = true;
      break;
    }
    try {
      const index = plan.indexOf(slide);
      // After the slide before it, as it is now or by its last picture.
      const anchor = other => current[other.key]?.id || known[other.key]?.id || '';
      const before = plan.slice(0, index).reverse().find(anchor);
      const image = await renderTvSlide(slide.model, { renderedAt: now });
      const item = await uploadToAlbum(accessToken, {
        albumId: album.id,
        bytes: image.jpeg,
        mimeType: 'image/jpeg',
        fileName: slideFileName(slide),
        description: slideDescription(slide),
        afterId: before ? anchor(before) : '',
        deadline
      });
      current[slide.key] = { id: item.id, ...slideRecord(slide), bytes: image.bytes, uploadedAt: new Date().toISOString() };
      uploaded.push(slide.key);
    } catch (error) {
      if (error?.reconnect) throw error;
      problem = error;
      pending = true;
      break;
    }
  }

  // Confirm the new pictures really are in the album before anything they
  // replace is taken out. Google can be a moment late listing them.
  let after = inAlbum;
  if (uploaded.length) {
    after = await albumItems(accessToken, album.id);
    for (const wait of CONFIRM_WAITS_MS) {
      const listed = new Set(after.map(item => item.id));
      if (uploaded.every(key => listed.has(current[key].id)) || Date.now() + wait > deadline) break;
      await sleep(wait);
      after = await albumItems(accessToken, album.id);
    }
  }
  const afterIds = new Set(after.map(item => item.id));
  // Still not listed: the slide keeps its last good picture this time. The
  // new one is in the album all the same, and the next run takes it into use
  // by its name.
  const notConfirmed = uploaded.filter(key => !afterIds.has(current[key].id));
  for (const key of notConfirmed) delete current[key];
  // Until its new picture is up and listed, a slide keeps its last one.
  for (const slide of plan) {
    if (!current[slide.key] && known[slide.key]) current[slide.key] = known[slide.key];
  }

  // Every other HomeDash picture in the album goes: older versions of a
  // slide, slides no longer planned (deleted, completed, over, or past the
  // horizon), and pictures from runs that never got to save what they did.
  // One the state does not know is left alone while only minutes old, in
  // case another run has just put it up.
  const keepIds = new Set(Object.values(current).map(slide => slide.id));
  const removable = after
    .filter(item => !keepIds.has(item.id) && (knownById.has(item.id) || !justCreated(item, startedAt)))
    .map(item => item.id);
  let removed = 0;
  if (removable.length) {
    try {
      removed = await removeFromAlbum(accessToken, album.id, removable);
    } catch (error) {
      if (error?.reconnect) throw error;
      // The new pictures are recorded all the same, so the next run knows the
      // old ones for what they are and takes them out.
      problem = problem || error;
      pending = true;
    }
  }

  return {
    album,
    albumRecreated,
    slides: current,
    pending,
    problem,
    uploaded: uploaded.length - notConfirmed.length,
    adopted,
    removed,
    notConfirmed: notConfirmed.length,
    planned: plan.length,
    remaining: plan.filter(slide => current[slide.key]?.hash !== slide.hash).length
  };
}

// One run. `force` skips the free "anything to do?" check; `rebuild` draws
// and uploads every slide again (after a design change).
// `state`, when given, is the state the caller has just written (connect), so
// the run does not read back what the CDN may not hand out yet.
export async function runTvSync({ force = false, rebuild = false, now = new Date(), budgetMs = UPLOAD_BUDGET_MS, trigger = 'schedule', state: given = null } = {}) {
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
  return work({ reason: rebuild ? 'rebuild' : 'by hand', now, todayKey, rebuild, startedAt, budgetMs, trigger, expiredOnly: false, given });
}

async function work({ reason, now, todayKey, rebuild, startedAt, budgetMs, trigger, expiredOnly, given = null }) {
  // Confirmed against the store, so a connect or a run a minute ago is seen.
  let state = given;
  if (!state) {
    try {
      state = await readTvStateFresh();
    } catch (error) {
      // Nothing was changed; the next run, or the next press, tries again.
      if (error?.stale) return { ok: false, retry: true, error: error.message };
      throw error;
    }
  }
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
    const lastError = result.problem
      ? errorRecord(state.lastError, result.problem, now)
      : result.notConfirmed
        ? { at: now.toISOString(), message: `Google had not listed ${result.notConfirmed} new picture(s) yet, so the previous ones are still up; the next update swaps them.`, reconnect: false, count: 1 }
        : null;
    await writeTvState({
      ...state,
      album: result.album,
      albumRecreatedAt: result.albumRecreated ? now.toISOString() : state.albumRecreatedAt || null,
      slides: result.slides,
      pending: result.pending || result.notConfirmed > 0,
      seen: { sourceVersion: doc.updatedAt, dateKey: todayKey, settings: settingsKey(state) },
      lastError,
      lastRun: { at: now.toISOString(), trigger, reason, uploaded: result.uploaded, adopted: result.adopted, removed: result.removed, ms: Date.now() - startedAt }
    });
    if (result.problem) {
      console.warn('TV sync stopped part way:', result.problem);
      return { ok: false, error: lastError.message, reconnect: lastError.reconnect, failures: lastError.count, uploaded: result.uploaded, removed: result.removed, slides: Object.keys(result.slides).length };
    }
    return {
      ok: true,
      reason,
      uploaded: result.uploaded,
      adopted: result.adopted,
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
