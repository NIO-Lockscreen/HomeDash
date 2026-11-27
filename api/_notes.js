// Notes: free text kept in the cloud and shared by every screen - the wall,
// the phones, a laptop in work mode. Like the to-do list they ride in
// events.json next to the tasks, so every refresh a screen already does brings
// them along without a single extra Blob read, and the version marker carries
// their changes too.
//
// They are as private as the rest of events.json, which is to say not secret:
// /api/events is public to read (the car lockscreen reads it), and it carries
// the notes like it carries the tasks and the to-do list.
//
// Stored shape:
//   { items:   { '<id>': { title, text, createdAt, updatedAt } },
//     deleted: { '<id>': '<ISO time it was deleted>' } }
//
// `deleted` remembers removed notes for a while, so an `add` that a slow phone
// retries after another screen deleted the note cannot bring it back.
//
// Everything here is pure: no Blob calls and no clock of its own (`now` is
// passed in), so it runs under plain node for testing.

export const NOTE_MAX_ITEMS = 100;
export const NOTE_MAX_TITLE = 80;
export const NOTE_MAX_TEXT = 4000;
export const NOTE_MAX_CHANGES = 20;
// The memory of a deleted note is kept this long.
export const NOTE_KEEP_DELETED_MS = 30 * 24 * 60 * 60 * 1000;

const NOTE_ID = /^[A-Za-z0-9_-]{1,60}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T/;

function noteError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// One line, no runs of spaces.
export function cleanNoteTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_TITLE);
}

// Line breaks are kept (a note is often a list); trailing spaces on a line,
// blank lines at either end and anything past the limit are not.
export function cleanNoteText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/^\n+|\n+$/g, '')
    .slice(0, NOTE_MAX_TEXT);
}

function cleanStamp(value) {
  const text = String(value || '').trim();
  return ISO.test(text) && Number.isFinite(Date.parse(text)) ? text : '';
}

function cleanItem(value) {
  if (!value || typeof value !== 'object') return null;
  const title = cleanNoteTitle(value.title);
  const text = cleanNoteText(value.text);
  if (!title && !text) return null;
  return {
    title,
    text,
    createdAt: cleanStamp(value.createdAt),
    updatedAt: cleanStamp(value.updatedAt)
  };
}

function entriesOf(value, limit) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).slice(0, limit)
    : [];
}

export function normalizeNotes(value) {
  const source = value && typeof value === 'object' ? value : {};
  const items = {};
  for (const [id, entry] of entriesOf(source.items, NOTE_MAX_ITEMS * 2)) {
    if (!NOTE_ID.test(id)) continue;
    const item = cleanItem(entry);
    if (item) items[id] = item;
  }
  const deleted = {};
  for (const [id, stamp] of entriesOf(source.deleted, 2000)) {
    if (!NOTE_ID.test(id)) continue;
    const at = cleanStamp(stamp);
    if (at) deleted[id] = at;
  }
  return { items, deleted };
}

function prune(notes, nowMs) {
  for (const [id, stamp] of Object.entries(notes.deleted)) {
    const at = Date.parse(stamp);
    if (!Number.isFinite(at) || nowMs - at > NOTE_KEEP_DELETED_MS) delete notes.deleted[id];
  }
  return notes;
}

function requireId(change) {
  const id = String(change?.id || '');
  if (!NOTE_ID.test(id)) throw noteError('That note could not be found.');
  return id;
}

// Applies one change. Every change states the result it wants, so a change
// that is sent twice lands the same way twice:
//
//   add    { id, title, text }    a new note (no-op if it exists or was deleted)
//   set    { id, title?, text? }  edit a note; the last save wins
//   delete { id }                 remove a note
function applyOne(next, change, nowIso) {
  const action = String(change?.action || '');

  if (action === 'add') {
    const id = requireId(change);
    if (next.items[id] || next.deleted[id]) return;
    const title = cleanNoteTitle(change.title);
    const text = cleanNoteText(change.text);
    if (!title && !text) throw noteError('Write something in the note first.');
    if (Object.keys(next.items).length >= NOTE_MAX_ITEMS) throw noteError('There are too many notes. Delete some old ones first.');
    next.items[id] = { title, text, createdAt: nowIso, updatedAt: nowIso };
    return;
  }

  if (action === 'set') {
    const id = requireId(change);
    const item = next.items[id];
    // Deleted elsewhere meanwhile: the delete stands.
    if (!item) return;
    const title = change.title === undefined ? item.title : cleanNoteTitle(change.title);
    const text = change.text === undefined ? item.text : cleanNoteText(change.text);
    if (!title && !text) throw noteError('A note cannot be empty. Delete it instead.');
    if (title === item.title && text === item.text) return;
    next.items[id] = { ...item, title, text, updatedAt: nowIso };
    return;
  }

  if (action === 'delete') {
    const id = requireId(change);
    delete next.items[id];
    next.deleted[id] = nowIso;
    return;
  }

  throw noteError('Unknown change to the notes.');
}

// Applies a batch of changes, in order, onto whatever the store holds right
// now.
export function applyNoteChanges(current, changes, now = new Date()) {
  const list = Array.isArray(changes) ? changes : [changes];
  if (!list.length) throw noteError('Nothing to change was sent.');
  if (list.length > NOTE_MAX_CHANGES) throw noteError('Too many note changes at once.');
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString();
  const base = normalizeNotes(current);
  const next = { items: { ...base.items }, deleted: { ...base.deleted } };
  for (const change of list) applyOne(next, change, nowIso);
  return prune(next, nowDate.getTime());
}

// The part of a note a change decides. Stamps are left out: the same change
// written by a retry carries a different stamp and is still the same change.
function itemShape(item) {
  return item ? JSON.stringify([item.title, item.text]) : 'none';
}

// Is this batch present in what the store kept?
export function noteChangesSurvived(savedNotes, changes, expectedNotes) {
  const saved = normalizeNotes(savedNotes);
  const expected = normalizeNotes(expectedNotes);
  for (const change of Array.isArray(changes) ? changes : [changes]) {
    const id = String(change?.id || '');
    if (!id) continue;
    if (itemShape(saved.items[id]) !== itemShape(expected.items[id])) return false;
  }
  return true;
}
