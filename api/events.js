import { head, put } from '@vercel/blob';
import { google } from 'googleapis';
import crypto from 'crypto';

const EVENTS_PATH = 'home-organizer/events.json';
const CONFIG_PATH = 'home-organizer/config.json';
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const DEFAULT_TIMEZONE = process.env.GOOGLE_CALENDAR_TIMEZONE || 'Europe/Oslo';

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
  )].slice(0, 500);
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
  const completedDates = normalizeDateKeys(input.completedDates, Array.isArray(existing.completedDates) ? existing.completedDates : []);
  const excludedDates = normalizeDateKeys(input.excludedDates, Array.isArray(existing.excludedDates) ? existing.excludedDates : []);

  return {
    id,
    title,
    start,
    end: end && parseDate(end) ? end : '',
    repeat,
    completed: Boolean(input.completed ?? existing.completed ?? false),
    completedDates,
    excludedDates,
    location: String(input.location || '').trim().slice(0, 90),
    note: String(input.note || '').trim().slice(0, 300),
    imageUrl,
    featured: Boolean(input.featured),
    googleEventId: existing.googleEventId || String(input.googleEventId || '').trim(),
    googleHtmlLink: existing.googleHtmlLink || String(input.googleHtmlLink || '').trim(),
    googleSyncedAt: existing.googleSyncedAt || '',
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

async function loadOrganizerConfig() {
  try {
    const meta = await head(CONFIG_PATH);
    const response = await fetch(`${meta.url}?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return {};
    const parsed = await response.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function encryptionKey() {
  if (!process.env.ADMIN_PIN) throw new Error('ADMIN_PIN is required to decrypt Google credentials.');
  return crypto.createHash('sha256').update(process.env.ADMIN_PIN).digest();
}

function decryptSecret(encrypted) {
  if (!encrypted) return '';
  try {
    const iv = Buffer.from(encrypted.iv, 'base64');
    const tag = Buffer.from(encrypted.tag, 'base64');
    const data = Buffer.from(encrypted.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt the saved Google service account key. Re-save it from the config menu.');
  }
}

function parseCredentials(credentialsText) {
  let credentials;
  try {
    credentials = JSON.parse(credentialsText);
  } catch {
    throw new Error('Could not parse the Google service account JSON. Check the config menu or Vercel environment variable.');
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('The Google service account JSON must include client_email and private_key.');
  }

  credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  return credentials;
}

async function getGoogleCalendarConfig() {
  const appConfig = await loadOrganizerConfig();

  // Default is intentionally off. Env vars alone will not enable syncing.
  if (appConfig.googleCalendarSyncEnabled !== true) {
    return { enabled: false, disabled: true, reason: 'sync-off' };
  }

  const calendarId = appConfig.googleCalendarId || process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    throw new Error('Google Calendar sync is on, but GOOGLE_CALENDAR_ID/calendar ID is missing. Open the config menu and add it.');
  }

  let credentialsText = '';
  if (appConfig.googleServiceAccountEncrypted) {
    credentialsText = decryptSecret(appConfig.googleServiceAccountEncrypted);
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentialsText = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
    credentialsText = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8');
  }

  if (!credentialsText) {
    throw new Error('Google Calendar sync is on, but the service account key is missing. Open the config menu and add it, or add it in Vercel env.');
  }

  return {
    enabled: true,
    disabled: false,
    reason: 'enabled',
    calendarId,
    credentials: parseCredentials(credentialsText),
    timezone: appConfig.googleCalendarTimezone || DEFAULT_TIMEZONE
  };
}

function getGoogleCalendarClient(config) {
  const auth = new google.auth.JWT({
    email: config.credentials.client_email,
    key: config.credentials.private_key,
    scopes: GOOGLE_SCOPES
  });

  return google.calendar({ version: 'v3', auth });
}

function googleLocalDateTimeFromKey(dateKey, event) {
  const startDate = parseDate(event.start) || new Date();
  const [year, month, day] = String(dateKey || '').split('-');
  if (!year || !month || !day) return '';
  const hh = String(startDate.getHours()).padStart(2, '0');
  const mm = String(startDate.getMinutes()).padStart(2, '0');
  const ss = String(startDate.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}T${hh}${mm}${ss}`;
}

function googleRecurrenceFromEvent(event, timezone) {
  const lines = [];
  switch (event.repeat || 'none') {
    case 'yearly': lines.push('RRULE:FREQ=YEARLY'); break;
    case 'weekly': lines.push('RRULE:FREQ=WEEKLY'); break;
    case 'biweekly': lines.push('RRULE:FREQ=WEEKLY;INTERVAL=2'); break;
    default: break;
  }

  const excludedDates = normalizeDateKeys(event.excludedDates || []);
  if (lines.length && excludedDates.length) {
    const exDates = excludedDates.map(key => googleLocalDateTimeFromKey(key, event)).filter(Boolean);
    if (exDates.length) lines.push(`EXDATE;TZID=${timezone}:${exDates.join(',')}`);
  }

  return lines.length ? lines : undefined;
}

function googleRequestBodyFromEvent(event, timezone) {
  const startDate = parseDate(event.start);
  if (!startDate) throw new Error('Event start date is invalid.');

  let endDate = event.end ? parseDate(event.end) : null;
  if (!endDate || endDate <= startDate) {
    endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  }

  const descriptionParts = [];
  if (event.note) descriptionParts.push(event.note);
  if (event.completed) descriptionParts.push('Marked complete in Home Organizer.');
  if (event.repeat && event.repeat !== 'none') descriptionParts.push(`Repeats: ${event.repeat}.`);
  if (event.excludedDates?.length) descriptionParts.push(`Skipped dates: ${event.excludedDates.join(', ')}.`);
  if (event.imageUrl) descriptionParts.push(`Image: ${event.imageUrl}`);
  descriptionParts.push('Created from Home Organizer admin mode.');

  return {
    summary: event.title,
    location: event.location || undefined,
    description: descriptionParts.join('\n\n'),
    start: {
      dateTime: startDate.toISOString(),
      timeZone: timezone
    },
    end: {
      dateTime: endDate.toISOString(),
      timeZone: timezone
    },
    recurrence: googleRecurrenceFromEvent(event, timezone) || [],
    extendedProperties: {
      private: {
        homeOrganizerId: event.id
      }
    },
    source: event.imageUrl
      ? { title: 'Home Organizer image', url: event.imageUrl }
      : undefined
  };
}

async function upsertGoogleCalendarEvent(event, existing = {}) {
  const config = await getGoogleCalendarConfig();
  if (!config.enabled) {
    return { event, googleCalendar: { disabled: true, synced: false, reason: config.reason || 'disabled' } };
  }

  const calendar = getGoogleCalendarClient(config);
  const requestBody = googleRequestBodyFromEvent(event, config.timezone);
  const googleEventId = event.googleEventId || existing.googleEventId;
  const syncedAt = new Date().toISOString();

  if (googleEventId) {
    try {
      const result = await calendar.events.patch({
        calendarId: config.calendarId,
        eventId: googleEventId,
        requestBody
      });
      return {
        event: {
          ...event,
          googleEventId: result.data.id || googleEventId,
          googleHtmlLink: result.data.htmlLink || event.googleHtmlLink || '',
          googleSyncedAt: syncedAt
        },
        googleCalendar: { disabled: false, synced: true, action: 'updated' }
      };
    } catch (error) {
      if (![404, 410].includes(Number(error.code))) {
        throw new Error(`Google Calendar update failed: ${error.message}`);
      }
      // The old Google event was deleted manually. Create a new one below.
    }
  }

  const result = await calendar.events.insert({
    calendarId: config.calendarId,
    requestBody
  });

  return {
    event: {
      ...event,
      googleEventId: result.data.id || '',
      googleHtmlLink: result.data.htmlLink || '',
      googleSyncedAt: syncedAt
    },
    googleCalendar: { disabled: false, synced: true, action: 'created' }
  };
}

async function deleteGoogleCalendarEvent(event) {
  const config = await getGoogleCalendarConfig();
  if (!config.enabled) return { disabled: true, synced: false, reason: config.reason || 'disabled' };
  if (!event.googleEventId) return { disabled: false, synced: false, skipped: true };

  const calendar = getGoogleCalendarClient(config);
  try {
    await calendar.events.delete({
      calendarId: config.calendarId,
      eventId: event.googleEventId
    });
    return { disabled: false, synced: true, action: 'deleted' };
  } catch (error) {
    if ([404, 410].includes(Number(error.code))) {
      return { disabled: false, synced: true, action: 'already-deleted' };
    }
    throw new Error(`Google Calendar delete failed: ${error.message}`);
  }
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
      let event = cleanEvent(payload);
      const sync = await upsertGoogleCalendarEvent(event);
      event = sync.event;
      events.push(event);
      events.sort((a, b) => new Date(a.start) - new Date(b.start));
      await saveEvents(events);
      send(res, 201, { event, events, googleCalendar: sync.googleCalendar });
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
      let event = cleanEvent(payload, events[index]);
      const sync = await upsertGoogleCalendarEvent(event, events[index]);
      event = sync.event;
      events[index] = event;
      events.sort((a, b) => new Date(a.start) - new Date(b.start));
      await saveEvents(events);
      send(res, 200, { event, events, googleCalendar: sync.googleCalendar });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, `https://${req.headers.host}`);
      const deleteAll = url.searchParams.get('all') === '1';
      const id = url.searchParams.get('id');
      const events = await loadEvents();

      if (deleteAll) {
        const googleResults = [];
        for (const event of events) {
          try {
            googleResults.push({ id: event.id, ...(await deleteGoogleCalendarEvent(event)) });
          } catch (error) {
            googleResults.push({ id: event.id, synced: false, error: error.message || 'Google Calendar delete failed.' });
          }
        }
        await saveEvents([]);
        send(res, 200, { events: [], googleCalendar: { bulk: true, results: googleResults } });
        return;
      }

      const deletedEvent = events.find(event => event.id === id);
      if (!deletedEvent) {
        send(res, 404, { error: 'Event not found.' });
        return;
      }

      const googleCalendar = await deleteGoogleCalendarEvent(deletedEvent);
      const next = events.filter(event => event.id !== id);
      await saveEvents(next);
      send(res, 200, { events: next, googleCalendar });
      return;
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    send(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    send(res, 400, { error: error.message || 'Something went wrong.' });
  }
}
