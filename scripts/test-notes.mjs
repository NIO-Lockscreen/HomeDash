// Tests for the shared notes' rules (api/_notes.js). Pure functions, so plain
// node runs them with nothing installed:
//
//   node --test scripts/test-notes.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTE_MAX_ITEMS,
  NOTE_MAX_TEXT,
  NOTE_MAX_TITLE,
  NOTE_KEEP_DELETED_MS,
  normalizeNotes,
  applyNoteChanges,
  noteChangesSurvived,
  cleanNoteText
} from '../api/_notes.js';

const T0 = new Date('2026-11-27T12:00:00.000Z');
const later = ms => new Date(T0.getTime() + ms);

test('an empty or broken store reads as no notes', () => {
  assert.deepEqual(normalizeNotes(null), { items: {}, deleted: {} });
  assert.deepEqual(normalizeNotes({ items: [1, 2], deleted: 'x' }), { items: {}, deleted: {} });
  const notes = normalizeNotes({
    items: {
      ok: { title: 'Wifi', text: 'Guest network' },
      'bad id!': { title: 'Dropped' },
      empty: { title: '  ', text: '\n\n' }
    }
  });
  assert.deepEqual(Object.keys(notes.items), ['ok']);
});

test('add, edit and delete a note', () => {
  let notes = applyNoteChanges(null, { action: 'add', id: 'n1', title: '  Gift  ideas ', text: 'Lego\nBook' }, T0);
  assert.deepEqual(notes.items.n1, {
    title: 'Gift ideas',
    text: 'Lego\nBook',
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString()
  });

  notes = applyNoteChanges(notes, { action: 'set', id: 'n1', text: 'Lego\nBook\nScarf' }, later(1000));
  assert.equal(notes.items.n1.title, 'Gift ideas');
  assert.equal(notes.items.n1.text, 'Lego\nBook\nScarf');
  assert.equal(notes.items.n1.createdAt, T0.toISOString());
  assert.equal(notes.items.n1.updatedAt, later(1000).toISOString());

  notes = applyNoteChanges(notes, { action: 'delete', id: 'n1' }, later(2000));
  assert.equal(notes.items.n1, undefined);
  assert.equal(notes.deleted.n1, later(2000).toISOString());
});

test('a change sent twice lands the same way twice', () => {
  const add = { action: 'add', id: 'n1', title: 'Milk', text: '' };
  const once = applyNoteChanges(null, add, T0);
  const twice = applyNoteChanges(once, add, later(5000));
  assert.deepEqual(twice.items, once.items);

  const set = { action: 'set', id: 'n1', title: 'Milk and bread' };
  const setOnce = applyNoteChanges(once, set, later(1000));
  const setTwice = applyNoteChanges(setOnce, set, later(9000));
  // Nothing changed the second time, so the stamp stays.
  assert.equal(setTwice.items.n1.updatedAt, later(1000).toISOString());
});

test('a retried add cannot bring back a note deleted elsewhere', () => {
  let notes = applyNoteChanges(null, { action: 'add', id: 'n1', title: 'Old' }, T0);
  notes = applyNoteChanges(notes, { action: 'delete', id: 'n1' }, later(1000));
  notes = applyNoteChanges(notes, { action: 'add', id: 'n1', title: 'Old' }, later(2000));
  assert.equal(notes.items.n1, undefined);
  // An edit of a deleted note leaves the delete standing.
  notes = applyNoteChanges(notes, { action: 'set', id: 'n1', title: 'Edited' }, later(3000));
  assert.equal(notes.items.n1, undefined);
});

test('the memory of a delete is dropped after a month', () => {
  let notes = applyNoteChanges(null, { action: 'add', id: 'n1', title: 'Old' }, T0);
  notes = applyNoteChanges(notes, { action: 'delete', id: 'n1' }, T0);
  notes = applyNoteChanges(notes, { action: 'add', id: 'n2', title: 'New' }, later(NOTE_KEEP_DELETED_MS + 1));
  assert.equal(notes.deleted.n1, undefined);
  assert.ok(notes.items.n2);
});

test('empty notes, bad ids and unknown changes are refused with a 400', () => {
  const refuses = (change, current = null) => assert.throws(() => applyNoteChanges(current, change, T0), error => error.statusCode === 400);
  refuses({ action: 'add', id: 'n1', title: ' ', text: '\n ' });
  refuses({ action: 'add', id: '../etc', title: 'x' });
  refuses({ action: 'shout', id: 'n1' });
  refuses([]);
  const one = applyNoteChanges(null, { action: 'add', id: 'n1', title: 'x' }, T0);
  refuses({ action: 'set', id: 'n1', title: '', text: '' }, one);
});

test('text keeps its line breaks and is held to the limits', () => {
  assert.equal(cleanNoteText('\r\n\r\nOne  \r\nTwo\t\n\n\nThree\n\n'), 'One\nTwo\n\n\nThree');
  const notes = applyNoteChanges(null, {
    action: 'add',
    id: 'n1',
    title: 'x'.repeat(NOTE_MAX_TITLE + 50),
    text: 'y'.repeat(NOTE_MAX_TEXT + 50)
  }, T0);
  assert.equal(notes.items.n1.title.length, NOTE_MAX_TITLE);
  assert.equal(notes.items.n1.text.length, NOTE_MAX_TEXT);
});

test('there is a ceiling on how many notes are kept', () => {
  let notes = null;
  const changes = [];
  for (let i = 0; i < NOTE_MAX_ITEMS; i += 1) changes.push({ action: 'add', id: `n${i}`, title: `Note ${i}` });
  for (let i = 0; i < changes.length; i += 20) notes = applyNoteChanges(notes, changes.slice(i, i + 20), T0);
  assert.equal(Object.keys(notes.items).length, NOTE_MAX_ITEMS);
  assert.throws(() => applyNoteChanges(notes, { action: 'add', id: 'one-too-many', title: 'x' }, T0), /too many notes/);
});

test('a save is confirmed only when the store kept it', () => {
  const change = { action: 'set', id: 'n1', title: 'Mine' };
  const base = applyNoteChanges(null, { action: 'add', id: 'n1', title: 'Base' }, T0);
  const expected = applyNoteChanges(base, change, later(1000));
  assert.equal(noteChangesSurvived(expected, [change], expected), true);
  // Stored by a retry a moment later: other stamps, the same note.
  const retried = applyNoteChanges(base, change, later(4000));
  assert.equal(noteChangesSurvived(retried, [change], expected), true);
  // Overwritten by another device's older copy.
  assert.equal(noteChangesSurvived(base, [change], expected), false);
  // A delete survived when the note is gone.
  const deleted = applyNoteChanges(expected, { action: 'delete', id: 'n1' }, later(2000));
  assert.equal(noteChangesSurvived(deleted, [{ action: 'delete', id: 'n1' }], deleted), true);
  assert.equal(noteChangesSurvived(expected, [{ action: 'delete', id: 'n1' }], deleted), false);
});
