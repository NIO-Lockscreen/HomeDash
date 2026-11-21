// Stock pictures: words that come up again and again ("Tannlege", "Fotball",
// "Fysio") and the default photos for each. A task whose title names a stock
// word and that is saved without a photo of its own is given one of that
// word's photos. This grew out of the fysio/lege/MR borrowing in
// _image-rules.js: those three became the first stock words, seeded from the
// photos somebody once chose for such tasks, and the library is now managed in
// the app instead of being hardcoded.
//
// Stored in events.json as `stock`:
//   { seededAt, words: { '<id>': { word, aliases: [], compound, images: [ {
//       id, imageUrl, imageFocusX, imageFocusY, imageFocusSource, imageZoom,
//       imageFocusBox, imageNaturalWidth, imageNaturalHeight, addedAt } ],
//     updatedAt } } }
//
// A task carrying a stock picture says so with three fields, which live and
// die with the picture like the lege borrow marks:
//   imageStockWord     the word's id
//   imageStockImageId  which of its photos
//   imageStockManual   picked or reframed by hand for this task; never released
//                      when the title changes and never reframed by the library
//
// Everything here is pure (no Blob calls, no clock of its own), so it runs
// under plain node. index.html holds a copy of the matcher and the picker so a
// task saved on the phone shows its stock picture straight away and a task
// saved with no signal still gets one. Keep the two in step.

import crypto from 'crypto';
import {
  AUTO_IMAGE_KINDS,
  AUTO_IMAGE_FIELDS,
  normalizeTitleWords,
  wordNamesKind,
  autoImageIndex,
  autoImageKindOf
} from './_image-rules.js';

export const STOCK_MAX_WORDS = 60;
export const STOCK_MAX_IMAGES = 12;
export const STOCK_MAX_ALIASES = 8;
export const STOCK_MAX_WORD_LENGTH = 40;
// A one-word term this long or longer may also count inside a longer word
// ("lege" in "Tannlege"); a shorter one only ever counts as a word of its own,
// the way `mr` always has.
export const STOCK_COMPOUND_MIN_LENGTH = 4;

const STOCK_ID = /^[A-Za-z0-9_-]{1,60}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T/;
const SEED_LABELS = Object.freeze({ fysio: 'Fysio', lege: 'Lege', mr: 'MR' });
const DEFAULT_FRAMING = Object.freeze({
  imageFocusX: 50,
  imageFocusY: 38,
  imageFocusSource: 'manual',
  imageZoom: 1.01,
  imageFocusBox: null,
  imageNaturalWidth: 0,
  imageNaturalHeight: 0
});

function stockError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function clampNumber(value, min, max, fallback, digits = 10) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number * digits) / digits));
}

function cleanStamp(value) {
  const text = String(value || '').trim();
  return ISO.test(text) && Number.isFinite(Date.parse(text)) ? text : '';
}

function cleanFocusBox(value) {
  if (!value || typeof value !== 'object') return null;
  const box = {
    left: clampNumber(value.left, 0, 100, 0),
    top: clampNumber(value.top, 0, 100, 0),
    right: clampNumber(value.right, 0, 100, 100),
    bottom: clampNumber(value.bottom, 0, 100, 100)
  };
  return box.right > box.left && box.bottom > box.top ? box : null;
}

function cleanPositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

// How a photo is framed. Travels with the photo onto every task that shows it.
export function cleanStockFraming(source = {}, fallback = DEFAULT_FRAMING) {
  return {
    imageFocusX: clampNumber(source.imageFocusX ?? fallback.imageFocusX, 0, 100, 50),
    imageFocusY: clampNumber(source.imageFocusY ?? fallback.imageFocusY, 0, 100, 38),
    imageFocusSource: String(source.imageFocusSource ?? fallback.imageFocusSource ?? 'manual').trim().slice(0, 40) || 'manual',
    imageZoom: clampNumber(source.imageZoom ?? fallback.imageZoom, 1, 1.8, 1.01, 100),
    imageFocusBox: cleanFocusBox(source.imageFocusBox === undefined ? fallback.imageFocusBox : source.imageFocusBox),
    imageNaturalWidth: cleanPositiveInt(source.imageNaturalWidth ?? fallback.imageNaturalWidth),
    imageNaturalHeight: cleanPositiveInt(source.imageNaturalHeight ?? fallback.imageNaturalHeight)
  };
}

function cleanImage(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '');
  const imageUrl = String(value.imageUrl || '').trim().slice(0, 800);
  if (!STOCK_ID.test(id) || !imageUrl) return null;
  return { id, imageUrl, ...cleanStockFraming(value), addedAt: cleanStamp(value.addedAt) };
}

// A word as it is written and shown ("Tannlege"), cut to size.
function cleanDisplayWord(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, STOCK_MAX_WORD_LENGTH);
}

// A word as titles are matched against it: accents off, lower case, words
// joined by single spaces. "Legé-time" -> "lege time".
export function normalizeStockTerm(value) {
  return normalizeTitleWords(value).join(' ');
}

function cleanAliases(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const seen = new Set();
  const aliases = [];
  for (const raw of list) {
    const alias = cleanDisplayWord(raw);
    const term = normalizeStockTerm(alias);
    if (term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    aliases.push(alias);
    if (aliases.length >= STOCK_MAX_ALIASES) break;
  }
  return aliases;
}

function cleanWord(value) {
  if (!value || typeof value !== 'object') return null;
  const word = cleanDisplayWord(value.word);
  if (normalizeStockTerm(word).length < 2) return null;
  const images = [];
  const seenIds = new Set();
  for (const entry of Array.isArray(value.images) ? value.images : []) {
    const image = cleanImage(entry);
    if (!image || seenIds.has(image.id)) continue;
    seenIds.add(image.id);
    images.push(image);
    if (images.length >= STOCK_MAX_IMAGES) break;
  }
  return {
    word,
    aliases: cleanAliases(value.aliases).filter(alias => normalizeStockTerm(alias) !== normalizeStockTerm(word)),
    compound: value.compound !== false,
    images,
    updatedAt: cleanStamp(value.updatedAt)
  };
}

export function normalizeStockLibrary(value) {
  const source = value && typeof value === 'object' ? value : {};
  const words = {};
  const entries = source.words && typeof source.words === 'object' && !Array.isArray(source.words)
    ? Object.entries(source.words).slice(0, STOCK_MAX_WORDS)
    : [];
  for (const [id, entry] of entries) {
    if (!STOCK_ID.test(id)) continue;
    const word = cleanWord(entry);
    if (word) words[id] = word;
  }
  return { seededAt: cleanStamp(source.seededAt), words };
}

export function stockImageIdForUrl(url) {
  return `si-${crypto.createHash('md5').update(String(url || ''), 'utf8').digest('hex').slice(0, 12)}`;
}

function framingOf(event) {
  const fields = {};
  for (const key of AUTO_IMAGE_FIELDS) {
    if (key !== 'imageUrl' && event?.[key] !== undefined && event?.[key] !== null) fields[key] = event[key];
  }
  return cleanStockFraming(fields);
}

// The first library, made from the lege system it replaces: one word for each
// of fysio, lege and MR, holding the photos somebody chose for such tasks
// (never a borrowed one), newest first, each with the framing it was given.
// A kind nobody has a photo for yet still gets its word, empty.
//
// Image ids come from the photo's URL, so the library a screen is shown before
// the seed is first stored and the one stored later agree.
export function seedStockLibrary(events, now = '') {
  const list = Array.isArray(events) ? events : [];
  const byId = autoImageIndex(list);
  const stamp = cleanStamp(now instanceof Date ? now.toISOString() : now);
  const words = {};
  for (const kind of AUTO_IMAGE_KINDS) {
    const seen = new Set();
    const images = list
      .filter(event => String(event?.imageUrl || '').trim()
        && !String(event?.imageInheritedFrom || '').trim()
        && autoImageKindOf(event, byId) === kind.keyword)
      .sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
      .filter(event => {
        const url = String(event.imageUrl).trim();
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      })
      .slice(0, STOCK_MAX_IMAGES)
      .map(event => ({
        id: stockImageIdForUrl(String(event.imageUrl).trim()),
        imageUrl: String(event.imageUrl).trim(),
        ...framingOf(event),
        addedAt: stamp
      }));
    words[kind.keyword] = {
      word: SEED_LABELS[kind.keyword] || kind.keyword,
      aliases: kind.words.filter(word => word !== kind.keyword),
      compound: kind.compound,
      images,
      updatedAt: stamp
    };
  }
  return { seededAt: stamp, words };
}

// The library in force: the stored one, or - until the first save stores it -
// the seed it will become.
export function effectiveStockLibrary(stored, events) {
  return stored && typeof stored === 'object'
    ? normalizeStockLibrary(stored)
    : seedStockLibrary(events);
}

export function stockImageUrls(stock) {
  const library = normalizeStockLibrary(stock);
  return Object.values(library.words).flatMap(entry => entry.images.map(image => image.imageUrl));
}

function entryTerms(entry) {
  return [entry.word, ...(entry.aliases || [])]
    .map(normalizeStockTerm)
    .filter(term => term.length >= 2);
}

// Which stock word a title names, or null. Phrases ("bursdag mormor") are
// tried first. Otherwise the title is read word by word from the left, and the
// first title word that names any stock word decides. Within that word an
// exact match beats a match inside a longer word, and a longer stock word
// beats a shorter one, so "Tannlege" picks the word Tannlege over Lege.
export function stockWordForTitle(title, stock) {
  const library = stock && stock.words ? stock : normalizeStockLibrary(stock);
  const words = normalizeTitleWords(title);
  if (!words.length) return null;
  const padded = ` ${words.join(' ')} `;
  const entries = Object.entries(library.words || {});

  let best = null;
  for (const [id, entry] of entries) {
    for (const term of entryTerms(entry)) {
      if (!term.includes(' ') || !padded.includes(` ${term} `)) continue;
      if (!best || term.length > best.term.length) best = { id, entry, term };
    }
  }
  if (best) return best;

  for (const word of words) {
    let wordBest = null;
    let wordScore = 0;
    for (const [id, entry] of entries) {
      for (const term of entryTerms(entry)) {
        if (term.includes(' ')) continue;
        let score = 0;
        if (word === term) score = 1000 + term.length;
        else if (entry.compound && term.length >= STOCK_COMPOUND_MIN_LENGTH
          && wordNamesKind(word, { keyword: term, compound: true, words: [] })) score = term.length;
        if (score > wordScore) {
          wordScore = score;
          wordBest = { id, entry, term };
        }
      }
    }
    if (wordBest) return wordBest;
  }
  return null;
}

// A small seeded random, so a retried save picks the same photo the first
// attempt did instead of rolling the dice again.
export function seededRandom(seed) {
  let h = 1779033703 ^ String(seed || '').length;
  for (const char of String(seed || '')) {
    h = Math.imul(h ^ char.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stockImageFields(image) {
  return { imageUrl: image.imageUrl, ...cleanStockFraming(image) };
}

// One of the word's photos for a task: chosen at random among the photos the
// fewest open tasks are showing, so two dentist visits in a row do not look
// the same. `skipUrls` lets a caller that found a photo gone from the store
// ask again without being handed the same one.
export function pickStockImage({ wordId, stock, events, excludeId = '', skipUrls = [], random = Math.random } = {}) {
  const library = stock && stock.words ? stock : normalizeStockLibrary(stock);
  const entry = library.words?.[wordId];
  const skip = skipUrls instanceof Set ? skipUrls : new Set(skipUrls);
  const images = (entry?.images || []).filter(image => !skip.has(image.imageUrl));
  if (!images.length) return null;
  const counts = new Map(images.map(image => [image.id, 0]));
  for (const event of Array.isArray(events) ? events : []) {
    if (String(event?.id || '') === String(excludeId || '') || event?.completed) continue;
    if (String(event?.imageStockWord || '') !== String(wordId)) continue;
    const id = String(event?.imageStockImageId || '');
    if (counts.has(id)) counts.set(id, counts.get(id) + 1);
  }
  const least = Math.min(...counts.values());
  const pool = images.filter(image => counts.get(image.id) === least);
  const roll = Number(random());
  const index = Number.isFinite(roll) ? Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length))) : 0;
  const image = pool[index];
  return { wordId: String(wordId), word: entry.word, imageId: image.id, image: stockImageFields(image) };
}

export function pickStockForTitle({ title, stock, events, excludeId = '', skipUrls = [], random = Math.random } = {}) {
  const match = stockWordForTitle(title, stock);
  if (!match) return null;
  return pickStockImage({ wordId: match.id, stock, events, excludeId, skipUrls, random });
}

// The marks a task carries point at a photo the library really holds, under
// the same link. Anything else is cleared (the picture itself stays).
export function stockMarksValid(event, stock) {
  const library = stock && stock.words ? stock : normalizeStockLibrary(stock);
  const image = library.words?.[String(event?.imageStockWord || '')]?.images
    ?.find(item => item.id === String(event?.imageStockImageId || ''));
  return Boolean(image) && image.imageUrl === String(event?.imageUrl || '').trim();
}

// A stock picture the task no longer names: it was retitled from "Tannlege" to
// "Middag". Let go, so the slot is filled with the right word's photo or left
// to the placeholder. Never a photo picked or reframed by hand.
export function isStaleStockImage(event, stock) {
  const wordId = String(event?.imageStockWord || '');
  if (!wordId || !String(event?.imageUrl || '').trim() || event?.imageStockManual === true) return false;
  return stockWordForTitle(event?.title, stock)?.id !== wordId;
}

function withStockPicture(event, pick) {
  return {
    ...event,
    ...pick.image,
    imageInheritedFrom: '',
    imageInheritedKeyword: '',
    imageStockWord: pick.wordId,
    imageStockImageId: pick.imageId,
    imageStockManual: false
  };
}

function withoutStockMarks(event) {
  return { ...event, imageStockWord: '', imageStockImageId: '', imageStockManual: false };
}

function withoutPicture(event) {
  return { ...withoutStockMarks(event), ...DEFAULT_FRAMING, imageUrl: '', imageInheritedFrom: '', imageInheritedKeyword: '' };
}

function sameFraming(event, image) {
  const a = cleanStockFraming(event);
  const b = cleanStockFraming(image);
  return JSON.stringify(a) === JSON.stringify(b);
}

// Still to come, so worth giving a picture: a repeating task, or one that has
// not started more than a day ago. Done tasks are left as they are.
function isUpcomingTask(event, nowMs) {
  if (event?.completed) return false;
  if (String(event?.repeat || 'none') !== 'none') return true;
  const start = Date.parse(String(event?.start || ''));
  return Number.isFinite(start) && start >= nowMs - 24 * 60 * 60 * 1000;
}

// After a change to the library, brings the tasks in step with it, in the
// same write:
//   - a word that is gone: its tasks keep the picture, which becomes their own
//   - a photo that is gone: a task framed by hand keeps it as its own; any other
//     is given another photo of the word, or the placeholder
//   - a photo that was reframed: tasks showing it take the new framing, unless
//     they were framed by hand
//   - a task whose title no longer names the word: let go and filled again
//   - an upcoming task with no picture at all whose title names a word: filled
// A photo somebody chose for a task is never touched. Returns the new list and
// the ids that changed, whose `updatedAt` is moved to `stamp`.
export function reconcileStockTasks(stock, events, { now = new Date(), random = Math.random } = {}) {
  const library = normalizeStockLibrary(stock);
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const stamp = nowDate.toISOString();
  const working = (Array.isArray(events) ? events : []).map(event => ({ ...event }));
  const changedIds = [];

  working.forEach((original, index) => {
    let event = original;
    const wordId = String(event.imageStockWord || '');
    if (wordId && String(event.imageUrl || '').trim()) {
      const entry = library.words[wordId];
      const image = entry?.images.find(item => item.id === String(event.imageStockImageId || ''));
      const manual = event.imageStockManual === true;
      if (!entry) event = withoutStockMarks(event);
      else if (!image) event = manual ? withoutStockMarks(event) : withoutPicture(event);
      else if (!manual && stockWordForTitle(event.title, library)?.id !== wordId) event = withoutPicture(event);
      else if (!manual && image.imageUrl !== String(event.imageUrl).trim()) event = withoutPicture(event);
      else if (!manual && !sameFraming(event, image)) event = { ...event, ...cleanStockFraming(image) };
    } else if (wordId) {
      event = withoutStockMarks(event);
    }

    if (!String(event.imageUrl || '').trim() && isUpcomingTask(event, nowMs)) {
      const pick = pickStockForTitle({ title: event.title, stock: library, events: working, excludeId: event.id, random });
      if (pick) event = withStockPicture(event, pick);
    }

    if (event !== original && JSON.stringify(event) !== JSON.stringify(original)) {
      working[index] = { ...event, updatedAt: stamp };
      changedIds.push(String(event.id || ''));
    }
  });

  return { events: working, changedIds };
}

function requireWordId(value) {
  const id = String(value || '');
  if (!STOCK_ID.test(id)) throw stockError('That stock word could not be found.');
  return id;
}

function clashingWord(library, id, terms) {
  for (const [otherId, entry] of Object.entries(library.words)) {
    if (otherId === id) continue;
    const otherTerms = new Set(entryTerms(entry));
    const clash = terms.find(term => otherTerms.has(term));
    if (clash) return { entry, term: clash };
  }
  return null;
}

// Applies one change to the library, onto whatever the store holds:
//   set-word     { id, word, aliases, compound }   add a word, or edit one
//   delete-word  { id }
//   add-image    { wordId, image: { id, imageUrl, ...framing } }
//   set-image    { wordId, imageId, ...framing }   reframe a photo
//   delete-image { wordId, imageId }
// Each states the result it wants, so a change sent twice lands the same way.
export function applyStockChange(current, change, now = new Date()) {
  const library = normalizeStockLibrary(current);
  const next = { seededAt: library.seededAt, words: { ...library.words } };
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const action = String(change?.action || '');

  if (action === 'set-word') {
    const id = requireWordId(change.id);
    const existing = next.words[id];
    if (!existing && Object.keys(next.words).length >= STOCK_MAX_WORDS) throw stockError('There are already as many stock words as fit.');
    const word = cleanDisplayWord(change.word);
    if (normalizeStockTerm(word).length < 2) throw stockError('Write the word, at least two letters.');
    const aliases = cleanAliases(change.aliases).filter(alias => normalizeStockTerm(alias) !== normalizeStockTerm(word));
    const candidate = { word, aliases, compound: change.compound !== false, images: existing?.images || [], updatedAt: stamp };
    const clash = clashingWord(next, id, entryTerms(candidate));
    if (clash) throw stockError(`"${clash.term}" is already part of the stock word "${clash.entry.word}".`);
    next.words[id] = candidate;
    return next;
  }

  if (action === 'delete-word') {
    const id = requireWordId(change.id);
    delete next.words[id];
    return next;
  }

  const wordId = requireWordId(change?.wordId);
  const entry = next.words[wordId];
  if (!entry) throw stockError('That stock word is gone. It may have been deleted on another screen.');

  if (action === 'add-image') {
    const image = cleanImage({ ...(change.image || {}), addedAt: stamp });
    if (!image) throw stockError('That photo could not be added.');
    if (entry.images.some(item => item.id === image.id || item.imageUrl === image.imageUrl)) return next;
    if (entry.images.length >= STOCK_MAX_IMAGES) throw stockError(`A word holds at most ${STOCK_MAX_IMAGES} photos. Remove one first.`);
    next.words[wordId] = { ...entry, images: [...entry.images, image], updatedAt: stamp };
    return next;
  }

  if (action === 'set-image') {
    const imageId = String(change.imageId || '');
    const images = entry.images.map(item => (item.id === imageId ? { ...item, ...cleanStockFraming(change, item) } : item));
    next.words[wordId] = { ...entry, images, updatedAt: stamp };
    return next;
  }

  if (action === 'delete-image') {
    const imageId = String(change.imageId || '');
    next.words[wordId] = { ...entry, images: entry.images.filter(item => item.id !== imageId), updatedAt: stamp };
    return next;
  }

  throw stockError('Unknown change to the stock pictures.');
}

// The part of a word a change decides, without stamps: the same change
// written by a retry carries a different stamp and is still the same change.
function wordShape(entry) {
  if (!entry) return 'none';
  return JSON.stringify([
    entry.word,
    entry.aliases,
    entry.compound,
    entry.images.map(({ addedAt, ...image }) => image)
  ]);
}

// Is this change present in what the store kept?
export function stockChangeSurvived(savedStock, change, expectedStock) {
  const id = String(change?.id || change?.wordId || '');
  const saved = normalizeStockLibrary(savedStock);
  const expected = normalizeStockLibrary(expectedStock);
  return wordShape(saved.words[id]) === wordShape(expected.words[id]);
}
