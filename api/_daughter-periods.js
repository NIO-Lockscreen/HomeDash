// Daughter periods: the every-other-week pattern plus the one-off changes made
// to it. They used to live in each device's localStorage, so a period moved on
// the phone never reached the wall display. They now ride in events.json next
// to the tasks, which means every refresh a screen already does brings them
// along without spending a single extra Blob read.
//
// Stored shape:
//   { overrides: { 'YYYY-MM-DD': { start, end } | { deleted: true } },
//     extra:     { '<id>': { start, end } } }
// An override is keyed by the default start date of the generated period it
// changes. An extra is a period added by hand.

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const EXTRA_ID = /^[A-Za-z0-9_-]{1,80}$/;
const EXTRA_PREFIX = 'extra:';
const MAX_ENTRIES = 1000;

function periodError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function cleanRange(value) {
  if (!value || typeof value !== 'object') return null;
  const start = String(value.start || '');
  const end = String(value.end || '');
  if (!DATE_KEY.test(start) || !DATE_KEY.test(end)) return null;
  return end < start ? { start: end, end: start } : { start, end };
}

function entriesOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).slice(0, MAX_ENTRIES)
    : [];
}

export function normalizeDaughterPeriods(value) {
  const source = value && typeof value === 'object' ? value : {};
  const overrides = {};
  for (const [key, entry] of entriesOf(source.overrides)) {
    if (!DATE_KEY.test(key)) continue;
    if (entry?.deleted === true) {
      overrides[key] = { deleted: true };
      continue;
    }
    const range = cleanRange(entry);
    if (range) overrides[key] = range;
  }
  const extra = {};
  for (const [id, entry] of entriesOf(source.extra)) {
    if (!EXTRA_ID.test(id)) continue;
    const range = cleanRange(entry);
    if (range) extra[id] = range;
  }
  return { overrides, extra };
}

// Applies one change to whatever the store holds right now, rather than
// replacing the whole set, so two screens adjusting different periods at the
// same time both keep their edit.
//
//   set    { key, start, end }  move a generated period, or edit/add an extra
//   delete { key }              hide a generated period, or remove an extra
//   reset  { key }              put a generated period back to the pattern
//   import { overrides, extra } a device's old local-only edits; only fills
//                               periods the store has no entry for, so a
//                               device reloaded days late cannot overwrite
//                               newer edits made elsewhere
export function applyDaughterPeriodChange(current, change) {
  const periods = normalizeDaughterPeriods(current);
  const next = { overrides: { ...periods.overrides }, extra: { ...periods.extra } };
  const action = String(change?.action || '');

  if (action === 'import') {
    const incoming = normalizeDaughterPeriods(change);
    for (const [key, entry] of Object.entries(incoming.overrides)) {
      if (!(key in next.overrides)) next.overrides[key] = entry;
    }
    for (const [id, entry] of Object.entries(incoming.extra)) {
      if (!(id in next.extra)) next.extra[id] = entry;
    }
    return next;
  }

  const key = String(change?.key || '');
  if (key.startsWith(EXTRA_PREFIX)) {
    const id = key.slice(EXTRA_PREFIX.length);
    if (!EXTRA_ID.test(id)) throw periodError('That daughter period could not be found.');
    if (action === 'set') {
      const range = cleanRange(change);
      if (!range) throw periodError('Choose both a valid start date and end date.');
      next.extra[id] = range;
    } else if (action === 'delete') {
      delete next.extra[id];
    } else {
      throw periodError('Unknown change to a daughter period.');
    }
    return next;
  }

  if (!DATE_KEY.test(key)) throw periodError('That daughter period could not be found.');
  if (action === 'set') {
    const range = cleanRange(change);
    if (!range) throw periodError('Choose both a valid start date and end date.');
    next.overrides[key] = range;
  } else if (action === 'delete') {
    next.overrides[key] = { deleted: true };
  } else if (action === 'reset') {
    delete next.overrides[key];
  } else {
    throw periodError('Unknown change to a daughter period.');
  }
  return next;
}
