// Pure decisions about event images: no Blob calls, no network, no clock of its
// own. Everything here can be run under plain node with no credentials, which
// is what lets the delete logic be tested before it is ever pointed at the
// real store. _images.js does the reading and deleting.

export const IMAGE_PREFIX = 'home-organizer/images/';
export const IMAGE_GRACE_DAYS = 7;
export const IMAGE_GRACE_MS = IMAGE_GRACE_DAYS * 24 * 60 * 60 * 1000;

export function isOrganizerBlobImage(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.startsWith(IMAGE_PREFIX)) return true;
  try {
    const url = new URL(text);
    return url.pathname.includes(`/${IMAGE_PREFIX}`);
  } catch {
    return text.includes(IMAGE_PREFIX);
  }
}

export function isBlobNotFoundError(error) {
  return String(error?.name || '') === 'BlobNotFoundError'
    || /does not exist|not.?found/i.test(String(error?.message || ''));
}

// "home-organizer/images/ab/abc.jpg" for a full Blob URL, a bare pathname, or
// a URL carrying a cache-busting query; '' for anything that is not ours.
export function organizerImagePathname(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let path = text;
  try { path = new URL(text).pathname; } catch {}
  path = path.replace(/^\/+/, '').split('?')[0];
  return path.startsWith(IMAGE_PREFIX) ? path : '';
}

export function referencedImagePathnames(events) {
  return new Set((Array.isArray(events) ? events : [])
    .map(event => organizerImagePathname(event?.imageUrl))
    .filter(Boolean));
}

// A device whose copy of the task is older than the one the server holds.
// Devices send updatedAt back untouched, so it tells the two apart without
// any extra state. A payload that carries no stamp cannot be judged and is
// treated as fresh, which is the pre-existing behaviour.
export function isStaleClientCopy(payload, previousEvent) {
  const sent = Date.parse(String(payload?.updatedAt || ''));
  const held = Date.parse(String(previousEvent?.updatedAt || ''));
  return Number.isFinite(sent) && Number.isFinite(held) && sent < held;
}

// A stale device proposes an image different from the newer one on the
// server. `requestedMeta` / `currentMeta` are { exists, uploadedAt } (ms or
// null). Returns the URL to keep, or null when this rule does not apply and
// the ordinary rules should decide.
export function chooseImageForStaleClient({ requested, current, requestedMeta, currentMeta }) {
  // Nothing newer to protect: let the ordinary rules run.
  if (!currentMeta?.exists) return null;
  // The one thing a stale device may still do is bring a genuinely newer
  // upload (a resync, a freshly picked photo). Anything else it sends - the
  // old URL it remembers, an empty value, something it cannot prove is newer -
  // is an echo of the past and loses to what the server already has.
  const requestedAt = Number(requestedMeta?.uploadedAt);
  const currentAt = Number(currentMeta.uploadedAt);
  if (requestedMeta?.exists && Number.isFinite(requestedAt) && Number.isFinite(currentAt) && requestedAt > currentAt) {
    return requested;
  }
  return current;
}

// Splits every stored image into referenced / still inside the grace window /
// due for deletion. `unreferencedSince` maps pathname -> ISO time the sweep
// first found it unreferenced; the returned `nextSince` is the state to store
// for the next run and only ever contains images that are still unreferenced
// and still present, so re-used and deleted images drop out by themselves.
export function classifyImages({ blobs, referenced, unreferencedSince = {}, now = Date.now(), graceMs = IMAGE_GRACE_MS }) {
  const nextSince = {};
  const deleteNow = [];
  const protectedPaths = [];
  let referencedCount = 0;

  for (const blob of Array.isArray(blobs) ? blobs : []) {
    const pathname = String(blob?.pathname || '');
    // Never act on anything outside the images prefix, whatever the listing
    // returned.
    if (!pathname.startsWith(IMAGE_PREFIX)) continue;
    if (referenced.has(pathname)) {
      referencedCount += 1;
      continue;
    }

    const recorded = Date.parse(String(unreferencedSince[pathname] || ''));
    const since = Number.isFinite(recorded) ? recorded : now;
    const uploaded = Date.parse(String(blob?.uploadedAt || ''));
    // Two independent clocks must both have run out: the sweep's own record
    // and the upload time. A corrupt or back-dated state file alone can then
    // never delete a recent picture.
    const recentUpload = Number.isFinite(uploaded) && now - uploaded < graceMs;
    if (now - since >= graceMs && !recentUpload) {
      deleteNow.push({ blob, since: new Date(since).toISOString() });
    } else {
      protectedPaths.push(pathname);
      nextSince[pathname] = new Date(since).toISOString();
    }
  }

  return { referenced: referencedCount, protected: protectedPaths, deleteNow, nextSince };
}

// The physio, the doctor and the MR scanner come round again and again, and
// nobody picks a photo for the twentieth one. So a task whose title names one
// of these and that arrives without a picture borrows one at random from an
// older task of the same kind. A task that brings its own image is never
// touched by any of this: it only ever fills an empty slot.
//
// Kinds never lend to each other. They used to, so that the first ever fysio
// task could show a lege photo - and that one borrowed photo then sat on a
// fysio card, was read back as a fysio photo, and was handed to every fysio
// task after it. A placeholder is the better wrong answer.
//
// `compound` means the keyword also counts inside a longer word at either end
// ("tannlege", "legetime", "fysioterapeut"), which is how those are actually
// written down. `mr` is two letters, so it only ever counts as a word of its
// own: "MR", "MR-time", "MR undersøkelse" - never the inside of some unrelated
// word.
export const AUTO_IMAGE_KINDS = Object.freeze([
  Object.freeze({ keyword: 'fysio', compound: true, words: Object.freeze(['fysio']) }),
  Object.freeze({ keyword: 'lege', compound: true, words: Object.freeze(['lege']) }),
  Object.freeze({ keyword: 'mr', compound: false, words: Object.freeze(['mr', 'mri']) })
]);

export const AUTO_IMAGE_KEYWORDS = Object.freeze(AUTO_IMAGE_KINDS.map(kind => kind.keyword));

// Words that merely end in one of the compound keywords without meaning it.
// Compound matching is what makes "tannlege" and "fysioterapi" work, and these
// are the words it would otherwise catch by accident.
const AUTO_IMAGE_FALSE_FRIENDS = new Set(['college', 'colleges', 'privilege', 'privileges', 'allege', 'sacrilege']);

// The picture and its framing travel together. A borrowed image cropped with
// the new task's defaults would show a different part of the photo than the
// task it was borrowed from, which is exactly the part somebody once chose.
const AUTO_IMAGE_FIELDS = Object.freeze([
  'imageUrl',
  'imageFocusX',
  'imageFocusY',
  'imageFocusSource',
  'imageZoom',
  'imageFocusBox',
  'imageNaturalWidth',
  'imageNaturalHeight'
]);

function normalizeTitleWords(title) {
  return String(title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9æøå]+/)
    .filter(Boolean);
}

function wordNamesKind(word, kind) {
  if (kind.words.includes(word)) return true;
  if (!kind.compound) return false;
  if (AUTO_IMAGE_FALSE_FRIENDS.has(word)) return false;
  return word.startsWith(kind.keyword) || word.endsWith(kind.keyword);
}

// 'fysio' | 'lege' | 'mr' | '' - which kind of task this title names.
export function autoImageKeyword(title) {
  for (const word of normalizeTitleWords(title)) {
    const kind = AUTO_IMAGE_KINDS.find(item => wordNamesKind(word, item));
    if (kind) return kind.keyword;
  }
  return '';
}

// Tasks by id, for looking up the task a borrowed picture came from.
export function autoImageIndex(events) {
  return new Map((Array.isArray(events) ? events : [])
    .map(event => [String(event?.id || ''), event])
    .filter(([id]) => id));
}

// Which kind of picture a task is *carrying*, which is not always the kind of
// task it is. A borrowed photo keeps the kind of the task it came from: a
// fysio task showing a lege photo holds a lege photo, and lending that on as a
// fysio photo is how one wrong picture reaches every fysio card.
//
// `imageInheritedKeyword` records this when the picture is borrowed. Pictures
// borrowed before that was written down are traced back through
// `imageInheritedFrom` instead; an origin that can no longer be established is
// reported as unknown ('') rather than guessed from the title, because that
// guess is the one that was wrong in the first place.
export function autoImageKindOf(event, byId, seen = new Set()) {
  const stamped = String(event?.imageInheritedKeyword || '').trim().toLowerCase();
  if (stamped) return AUTO_IMAGE_KEYWORDS.includes(stamped) ? stamped : '';

  const from = String(event?.imageInheritedFrom || '').trim();
  if (!from) return autoImageKeyword(event?.title);
  if (seen.has(from)) return '';
  seen.add(from);
  const donor = byId?.get?.(from);
  return donor ? autoImageKindOf(donor, byId, seen) : '';
}

// A borrowed picture of the wrong kind: one this task holds without anybody
// choosing it, and that the rule above would never hand it today. Handed out
// back when kinds lent to each other, or left behind by a retitled task. The
// caller empties the slot so the ordinary borrow can fill it with the right
// kind, or leave the placeholder. An origin that cannot be established is left
// alone - only a picture known to be from another kind is released.
export function isMismatchedBorrowedImage(event, byId) {
  if (!String(event?.imageUrl || '').trim()) return false;
  if (!String(event?.imageInheritedFrom || '').trim()) return false;
  const carried = autoImageKindOf(event, byId);
  return Boolean(carried) && carried !== autoImageKeyword(event?.title);
}

function borrowableImageFields(event) {
  const fields = {};
  for (const key of AUTO_IMAGE_FIELDS) {
    if (event?.[key] !== undefined && event?.[key] !== null) fields[key] = event[key];
  }
  return fields;
}

// Picks the image a fysio/lege/MR task should borrow, or null when the title is
// not one of ours, the task already has a picture, or no older task of that
// same kind has one to lend. `random` is injectable so the choice can be tested,
// and `skipUrls` lets a caller that has just found a picture missing from the
// store ask again without being handed the same dead link.
//
// Returns { keyword, from, image } - `from` is the donor's id and `keyword` the
// kind of the picture, both stored on the task so a borrowed picture can be
// told apart from a chosen one and never mistaken for another kind's.
export function pickAutoImage({ title, events, excludeId = '', skipUrls = [], random = Math.random } = {}) {
  const keyword = autoImageKeyword(title);
  if (!keyword) return null;

  const list = Array.isArray(events) ? events : [];
  const byId = autoImageIndex(list);
  const skip = skipUrls instanceof Set ? skipUrls : new Set(skipUrls);
  const lenders = list.filter(event =>
    String(event?.id || '') !== String(excludeId || '')
    && String(event?.imageUrl || '').trim()
    && !skip.has(String(event?.imageUrl || '').trim())
    && autoImageKindOf(event, byId) === keyword
  );
  const chosenBySomebody = event => !String(event?.imageInheritedFrom || '').trim();

  // A photo somebody actually picked for this kind of task first, then one
  // that was itself borrowed. Preferring originals keeps a single picture from
  // spreading across every card.
  const pool = [lenders.filter(chosenBySomebody), lenders].find(group => group.length);
  if (!pool) return null;

  const roll = Number(random());
  const index = Number.isFinite(roll) ? Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length))) : 0;
  const donor = pool[index];
  return { keyword, from: String(donor.id || ''), image: borrowableImageFields(donor) };
}
