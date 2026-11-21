// The to-do list: short things to get done, with no date. Each item belongs to
// the family list, the work list, or both. Like the daughter periods they ride
// in events.json next to the tasks, so every refresh a screen already does
// brings them along without a single extra Blob read, and the version marker
// carries their changes too.
//
// Stored shape:
//   { items:   { '<id>': { text, scope, done, doneAt, createdAt, updatedAt } },
//     deleted: { '<id>': '<ISO time it was deleted>' } }
//
// `deleted` remembers removed items for a while, so an `add` that a slow phone
// retries after another screen deleted the item cannot bring it back.
//
// Everything here is pure: no Blob calls and no clock of its own (`now` is
// passed in), so it runs under plain node for testing.

export const TODO_SCOPES = Object.freeze(['family', 'work', 'both']);
export const TODO_MAX_ITEMS = 300;
export const TODO_MAX_TEXT = 120;
export const TODO_MAX_CHANGES = 60;
// Ticked-off items are dropped this long after they were ticked, and the
// memory of a deleted item is kept this long.
export const TODO_KEEP_DONE_MS = 30 * 24 * 60 * 60 * 1000;
export const TODO_KEEP_DELETED_MS = 30 * 24 * 60 * 60 * 1000;

const TODO_ID = /^[A-Za-z0-9_-]{1,60}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T/;

function todoError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, TODO_MAX_TEXT);
}

export function cleanTodoScope(value, fallback = 'family') {
  const scope = String(value || '').trim().toLowerCase();
  return TODO_SCOPES.includes(scope) ? scope : fallback;
}

function cleanStamp(value) {
  const text = String(value || '').trim();
  return ISO.test(text) && Number.isFinite(Date.parse(text)) ? text : '';
}

function cleanItem(value) {
  if (!value || typeof value !== 'object') return null;
  const text = cleanText(value.text);
  if (!text) return null;
  const done = value.done === true;
  return {
    text,
    scope: cleanTodoScope(value.scope),
    done,
    doneAt: done ? cleanStamp(value.doneAt) : '',
    createdAt: cleanStamp(value.createdAt),
    updatedAt: cleanStamp(value.updatedAt)
  };
}

function entriesOf(value, limit) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).slice(0, limit)
    : [];
}

export function normalizeTodos(value) {
  const source = value && typeof value === 'object' ? value : {};
  const items = {};
  for (const [id, entry] of entriesOf(source.items, TODO_MAX_ITEMS * 2)) {
    if (!TODO_ID.test(id)) continue;
    const item = cleanItem(entry);
    if (item) items[id] = item;
  }
  const deleted = {};
  for (const [id, stamp] of entriesOf(source.deleted, 2000)) {
    if (!TODO_ID.test(id)) continue;
    const at = cleanStamp(stamp);
    if (at) deleted[id] = at;
  }
  return { items, deleted };
}

function prune(todos, nowMs) {
  for (const [id, item] of Object.entries(todos.items)) {
    const doneAt = Date.parse(item.doneAt || '');
    if (item.done && Number.isFinite(doneAt) && nowMs - doneAt > TODO_KEEP_DONE_MS) delete todos.items[id];
  }
  for (const [id, stamp] of Object.entries(todos.deleted)) {
    const at = Date.parse(stamp);
    if (!Number.isFinite(at) || nowMs - at > TODO_KEEP_DELETED_MS) delete todos.deleted[id];
  }
  return todos;
}

function requireId(change) {
  const id = String(change?.id || '');
  if (!TODO_ID.test(id)) throw todoError('That to-do could not be found.');
  return id;
}

// Applies one change. Every change states the result it wants rather than
// flipping something, so a change that is sent twice lands the same way twice:
//
//   add        { id, text, scope }   a new item (no-op if it exists or was deleted)
//   set        { id, text?, scope? } edit an item
//   check      { id, done }          tick off (true) or put back (false)
//   delete     { id }                remove an item
//   clear-done { ids }               remove the ticked-off items a screen showed;
//                                    one ticked back on meanwhile is kept
function applyOne(next, change, nowIso) {
  const action = String(change?.action || '');

  if (action === 'add') {
    const id = requireId(change);
    if (next.items[id] || next.deleted[id]) return;
    const text = cleanText(change.text);
    if (!text) throw todoError('Write what needs doing first.');
    if (Object.keys(next.items).length >= TODO_MAX_ITEMS) throw todoError('The to-do list is full. Clear some done items first.');
    next.items[id] = { text, scope: cleanTodoScope(change.scope), done: false, doneAt: '', createdAt: nowIso, updatedAt: nowIso };
    return;
  }

  if (action === 'set') {
    const id = requireId(change);
    const item = next.items[id];
    if (!item) return;
    const text = change.text === undefined ? item.text : cleanText(change.text);
    if (!text) throw todoError('A to-do cannot be empty.');
    const scope = change.scope === undefined ? item.scope : cleanTodoScope(change.scope, item.scope);
    next.items[id] = { ...item, text, scope, updatedAt: nowIso };
    return;
  }

  if (action === 'check') {
    const id = requireId(change);
    const item = next.items[id];
    if (!item) return;
    const done = change.done === true;
    if (item.done === done) return;
    next.items[id] = { ...item, done, doneAt: done ? nowIso : '', updatedAt: nowIso };
    return;
  }

  if (action === 'delete') {
    const id = requireId(change);
    delete next.items[id];
    next.deleted[id] = nowIso;
    return;
  }

  if (action === 'clear-done') {
    const ids = Array.isArray(change.ids) ? change.ids.map(String).filter(id => TODO_ID.test(id)).slice(0, TODO_MAX_ITEMS) : [];
    for (const id of ids) {
      if (!next.items[id]?.done) continue;
      delete next.items[id];
      next.deleted[id] = nowIso;
    }
    return;
  }

  throw todoError('Unknown change to the to-do list.');
}

// Applies a batch of changes, in order, onto whatever the store holds right
// now. A phone sends its ticks and additions in one batch, so a burst of
// taps costs one write.
export function applyTodoChanges(current, changes, now = new Date()) {
  const list = Array.isArray(changes) ? changes : [changes];
  if (!list.length) throw todoError('Nothing to change was sent.');
  if (list.length > TODO_MAX_CHANGES) throw todoError('Too many to-do changes at once.');
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString();
  const base = normalizeTodos(current);
  const next = { items: { ...base.items }, deleted: { ...base.deleted } };
  for (const change of list) applyOne(next, change, nowIso);
  return prune(next, nowDate.getTime());
}

function touchedIds(changes) {
  const ids = new Set();
  for (const change of Array.isArray(changes) ? changes : [changes]) {
    if (change?.id) ids.add(String(change.id));
    if (Array.isArray(change?.ids)) change.ids.forEach(id => ids.add(String(id)));
  }
  return ids;
}

// The part of an item a change decides. Stamps are left out: the same change
// written by a retry carries a different stamp and is still the same change.
function itemShape(item) {
  return item ? JSON.stringify([item.text, item.scope, item.done]) : 'none';
}

// Is this batch present in what the store kept?
export function todoChangesSurvived(savedTodos, changes, expectedTodos) {
  const saved = normalizeTodos(savedTodos);
  const expected = normalizeTodos(expectedTodos);
  for (const id of touchedIds(changes)) {
    if (itemShape(saved.items[id]) !== itemShape(expected.items[id])) return false;
  }
  return true;
}
