import { head, put } from '@vercel/blob';

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

function cleanEvent(input, existing = {}) {
  const id = existing.id || input.id || crypto.randomUUID();
  const title = String(input.title || '').trim().slice(0, 80);
  if (!title) throw new Error('Title is required.');

  const start = String(input.start || '').trim();
  if (!start || Number.isNaN(Date.parse(start))) throw new Error('Valid start date/time is required.');

  const end = String(input.end || '').trim();
  const imageUrl = String(input.imageUrl || '').trim();

  return {
    id,
    title,
    start,
    end: end && !Number.isNaN(Date.parse(end)) ? end : '',
    location: String(input.location || '').trim().slice(0, 90),
    note: String(input.note || '').trim().slice(0, 300),
    imageUrl,
    featured: Boolean(input.featured),
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString()
  };
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
  await put(
    EVENTS_PATH,
    JSON.stringify({ updatedAt: new Date().toISOString(), events }, null, 2),
    {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json; charset=utf-8',
      cacheControlMaxAge: 0
    }
  );
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const events = await loadEvents();
      send(res, 200, { events });
      return;
    }

    if (!verifyAdmin(req, res)) return;

    if (req.method === 'POST') {
      const payload = JSON.parse(await readBody(req) || '{}');
      const events = await loadEvents();
      const event = cleanEvent(payload);
      events.push(event);
      events.sort((a, b) => new Date(a.start) - new Date(b.start));
      await saveEvents(events);
      send(res, 201, { event, events });
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
      events[index] = cleanEvent(payload, events[index]);
      events.sort((a, b) => new Date(a.start) - new Date(b.start));
      await saveEvents(events);
      send(res, 200, { event: events[index], events });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, `https://${req.headers.host}`);
      const id = url.searchParams.get('id');
      const events = await loadEvents();
      const next = events.filter(event => event.id !== id);
      if (events.length === next.length) {
        send(res, 404, { error: 'Event not found.' });
        return;
      }
      await saveEvents(next);
      send(res, 200, { events: next });
      return;
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    send(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    send(res, 400, { error: error.message || 'Something went wrong.' });
  }
}
