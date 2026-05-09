import { head, put, del } from '@vercel/blob';
import crypto from 'crypto';

const EVENTS_PATH = 'home-organizer/events.json';

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function verifyAdmin(req, res) {
  if (!process.env.ADMIN_PIN) {
    send(res, 500, { error: 'ADMIN_PIN is missing. Add it in Vercel environment variables before writing events.' });
    return false;
  }
  const suppliedPin = req.headers['x-admin-pin'];
  if (suppliedPin !== process.env.ADMIN_PIN) {
    send(res, 401, { error: 'Wrong admin PIN.' });
    return false;
  }
  return true;
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDateKeys(values, existing = []) {
  const source = Array.isArray(values) ? values : existing;
  return [...new Set(source
    .map(value => String(value || '').slice(0, 10))
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
  )].slice(0, 1000);
}

function cleanEvent(input, existing = {}) {
  const id = existing.id || input.id || crypto.randomUUID();
  const title = String(input.title || '').trim().slice(0, 80);
  if (!title) throw new Error('Title is required.');

  const start = String(input.start || '').trim();
  if (!start || !parseDate(start)) throw new Error('Valid start date/time is required.');

  const end = String(input.end || '').trim();
  const imageUrl = String(input.imageUrl || '').trim();
  const allowedRepeats = new Set(['none', 'yearly', 'weekly', 'biweekly']);
  const repeat = allowedRepeats.has(String(input.repeat || existing.repeat || 'none'))
    ? String(input.repeat || existing.repeat || 'none')
    : 'none';

  // Repeatable tasks are stored as ONE master task.
  // completedDates/excludedDates describe individual virtual occurrences.
  return {
    id,
    title,
    start,
    end: end && parseDate(end) ? end : '',
    repeat,
    completed: Boolean(input.completed ?? existing.completed ?? false),
    completedDates: normalizeDateKeys(input.completedDates, Array.isArray(existing.completedDates) ? existing.completedDates : []),
    excludedDates: normalizeDateKeys(input.excludedDates, Array.isArray(existing.excludedDates) ? existing.excludedDates : []),
    location: String(input.location || '').trim().slice(0, 90),
    note: String(input.note || '').trim().slice(0, 300),
    imageUrl,
    featured: Boolean(input.featured),
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString()
  };
}

function sortEvents(events) {
  return [...events].sort((a, b) => new Date(a.start) - new Date(b.start));
}

async function loadEvents() {
  try {
    const meta = await head(EVENTS_PATH);
    const response = await fetch(`${meta.url}?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return [];
    const parsed = await response.json();
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

async function saveEvents(events) {
  await put(EVENTS_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), events: sortEvents(events) }, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 0
  });
}

function isOrganizerBlobImage(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.startsWith('home-organizer/images/')) return true;
  try {
    const url = new URL(text);
    return url.pathname.includes('/home-organizer/images/');
  } catch {
    return text.includes('home-organizer/images/');
  }
}

function imageUrlsFromEvents(events) {
  return [...new Set((Array.isArray(events) ? events : [])
    .map(event => event && event.imageUrl)
    .filter(isOrganizerBlobImage))];
}

function imageUrlsNoLongerUsed(beforeEvents, afterEvents) {
  const after = new Set(imageUrlsFromEvents(afterEvents));
  return imageUrlsFromEvents(beforeEvents).filter(url => !after.has(url));
}

async function deleteUnusedImages(urls) {
  const uniqueUrls = [...new Set((urls || []).filter(isOrganizerBlobImage))];
  if (!uniqueUrls.length) return { attempted: 0, deleted: 0, failed: 0 };

  try {
    await del(uniqueUrls);
    return { attempted: uniqueUrls.length, deleted: uniqueUrls.length, failed: 0 };
  } catch (error) {
    console.warn('Bulk blob cleanup failed, retrying one by one:', error);
    let deleted = 0;
    let failed = 0;
    for (const url of uniqueUrls) {
      try {
        await del(url);
        deleted += 1;
      } catch (singleError) {
        failed += 1;
        console.warn('Could not delete old event image:', url, singleError);
      }
    }
    return { attempted: uniqueUrls.length, deleted, failed };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      send(res, 200, { events: await loadEvents() });
      return;
    }

    if (!verifyAdmin(req, res)) return;

    if (req.method === 'POST') {
      const payload = JSON.parse(await readBody(req) || '{}');
      const events = await loadEvents();
      const existingIndex = payload.id ? events.findIndex(event => event.id === payload.id) : -1;
      const previousEvent = existingIndex === -1 ? null : events[existingIndex];
      const event = cleanEvent(payload, previousEvent || {});
      if (existingIndex === -1) events.push(event);
      else events[existingIndex] = event;
      const next = sortEvents(events);
      await saveEvents(next);
      const imageCleanup = previousEvent ? await deleteUnusedImages(imageUrlsNoLongerUsed([previousEvent], next)) : { attempted: 0, deleted: 0, failed: 0 };
      send(res, existingIndex === -1 ? 201 : 200, { event, events: next, localSaved: true, idempotent: existingIndex !== -1, imageCleanup });
      return;
    }

    if (req.method === 'PUT') {
      const payload = JSON.parse(await readBody(req) || '{}');
      const events = await loadEvents();
      const index = events.findIndex(event => event.id === payload.id);
      if (index === -1) {
        send(res, 404, { error: 'Event not found.' });
        return;
      }
      const previousEvent = events[index];
      const event = cleanEvent(payload, previousEvent);
      events[index] = event;
      const next = sortEvents(events);
      await saveEvents(next);
      const imageCleanup = await deleteUnusedImages(imageUrlsNoLongerUsed([previousEvent], next));
      send(res, 200, { event, events: next, localSaved: true, imageCleanup });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, `https://${req.headers.host}`);
      const events = await loadEvents();
      if (url.searchParams.get('all') === '1') {
        const imagesToDelete = imageUrlsFromEvents(events);
        await saveEvents([]);
        const imageCleanup = await deleteUnusedImages(imagesToDelete);
        send(res, 200, { events: [], localDeleted: true, imageCleanup });
        return;
      }
      const id = url.searchParams.get('id');
      if (!events.some(event => event.id === id)) {
        send(res, 404, { error: 'Event not found.' });
        return;
      }
      const removedEvents = events.filter(event => event.id === id);
      const next = events.filter(event => event.id !== id);
      await saveEvents(next);
      const imageCleanup = await deleteUnusedImages(imageUrlsNoLongerUsed(removedEvents, next));
      send(res, 200, { events: next, localDeleted: true, imageCleanup });
      return;
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    send(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    send(res, 400, { error: error.message || 'Something went wrong.' });
  }
}
