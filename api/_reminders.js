import { head, put } from '@vercel/blob';
import crypto from 'crypto';

const EVENTS_PATH = 'home-organizer/events.json';
const REMINDER_STATE_PATH = 'home-organizer/reminders-state.json';
const RESEND_SCHEDULE_HORIZON_MS = 29 * 24 * 60 * 60 * 1000; // Resend allows up to 30 days. Keep a safety buffer.
const RESEND_SEND_NOW_GRACE_MS = 90 * 1000;
const MAX_OCCURRENCE_LOOKAHEAD_MS = 45 * 24 * 60 * 60 * 1000;
const DEFAULT_TIME_ZONE = 'Europe/Oslo';

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getReminderConfig(event) {
  const reminder = event?.emailReminder || {};
  const recipients = Array.isArray(reminder.recipients)
    ? [...new Set(reminder.recipients.map(normalizeEmail).filter(isValidEmail))]
    : [];

  return {
    enabled: Boolean(reminder.enabled) && recipients.length > 0,
    recipients,
  };
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(dateLike) {
  const timeZone = process.env.ORGANIZER_TIME_ZONE || DEFAULT_TIME_ZONE;
  return new Intl.DateTimeFormat('nb-NO', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(dateLike));
}

function dateKeyInTimeZone(dateLike) {
  const timeZone = process.env.ORGANIZER_TIME_ZONE || DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(dateLike));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function zonedParts(dateLike) {
  const timeZone = process.env.ORGANIZER_TIME_ZONE || DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(dateLike));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
  };
}

function zonedDateTimeToUtc(year, month, day, hour = 0, minute = 0) {
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = targetUtc;

  for (let i = 0; i < 4; i += 1) {
    const parts = zonedParts(new Date(guess));
    const renderedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    const diff = renderedUtc - targetUtc;
    if (diff === 0) break;
    guess -= diff;
  }

  return new Date(guess);
}

function previousLocalDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  date.setUTCDate(date.getUTCDate() - 1);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function dailyReminderTimeForOccurrence(occurrenceStart) {
  const parts = zonedParts(occurrenceStart);
  const isEarlyTask = parts.hour < 8;

  if (isEarlyTask) {
    const previous = previousLocalDateParts(parts.year, parts.month, parts.day);
    return {
      remindAt: zonedDateTimeToUtc(previous.year, previous.month, previous.day, 12, 0),
      variant: 'earlyTomorrow',
    };
  }

  return {
    remindAt: zonedDateTimeToUtc(parts.year, parts.month, parts.day, 8, 0),
    variant: 'dayOfTask',
  };
}


function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function eventDurationMs(event) {
  const start = parseDate(event.start);
  const end = parseDate(event.end);
  if (!start || !end || end <= start) return 0;
  return end.getTime() - start.getTime();
}

function isOccurrenceCompletedOrExcluded(event, occurrenceStart) {
  const key = dateKeyInTimeZone(occurrenceStart);
  if ((event.excludedDates || []).includes(key)) return true;
  if (event.repeat === 'none' && event.completed) return true;
  if (event.repeat !== 'none' && (event.completedDates || []).includes(key)) return true;
  return false;
}

function makeOccurrence(event, occurrenceStart, index) {
  const duration = eventDurationMs(event);
  return {
    eventId: event.id,
    title: event.title,
    note: event.note || '',
    location: event.location || '',
    occurrenceKey: `${dateKeyInTimeZone(occurrenceStart)}-${index}`,
    start: occurrenceStart.toISOString(),
    end: duration ? new Date(occurrenceStart.getTime() + duration).toISOString() : '',
  };
}

function expandEventOccurrences(event, rangeStart, rangeEnd) {
  const start = parseDate(event.start);
  if (!event?.id || !start) return [];

  const repeat = event.repeat || 'none';
  const occurrences = [];
  const pushOccurrence = (date, index) => {
    if (date < rangeStart || date > rangeEnd) return;
    if (isOccurrenceCompletedOrExcluded(event, date)) return;
    occurrences.push(makeOccurrence(event, date, index));
  };

  if (repeat === 'none') {
    pushOccurrence(start, 0);
    return occurrences;
  }

  if (repeat === 'weekly' || repeat === 'biweekly') {
    const intervalMs = (repeat === 'biweekly' ? 14 : 7) * 24 * 60 * 60 * 1000;
    let index = Math.max(0, Math.floor((rangeStart.getTime() - start.getTime()) / intervalMs) - 1);
    for (let i = 0; i < 120; i += 1) {
      const occurrenceStart = new Date(start.getTime() + index * intervalMs);
      if (occurrenceStart > rangeEnd) break;
      pushOccurrence(occurrenceStart, index);
      index += 1;
    }
    return occurrences;
  }

  if (repeat === 'yearly') {
    let index = 0;
    for (let year = rangeStart.getFullYear() - 1; year <= rangeEnd.getFullYear() + 1; year += 1) {
      const occurrenceStart = new Date(start);
      occurrenceStart.setFullYear(year);
      if (occurrenceStart.getMonth() !== start.getMonth()) continue;
      if (occurrenceStart < start) continue;
      pushOccurrence(occurrenceStart, index);
      index += 1;
    }
  }

  return occurrences;
}

function recipientHash(recipients) {
  return crypto.createHash('sha1').update([...recipients].sort().join(',')).digest('hex').slice(0, 12);
}

function reminderKey(eventId, occurrence, reminder, type) {
  return `${eventId}::${type}::${occurrence.occurrenceKey}::${recipientHash(reminder.recipients)}`;
}

function creationReminderKey(eventId, reminder) {
  return `${eventId}::created::${recipientHash(reminder.recipients)}`;
}

function addDesiredReminder(desired, reminder) {
  desired.set(reminder.key, reminder);
}

function buildDesiredReminders(events, options = {}) {
  const now = options.now || new Date();
  const newEventIdSet = Array.isArray(options.newEventIds) && options.newEventIds.length
    ? new Set(options.newEventIds.map(String))
    : new Set();
  const eventIdFilter = Array.isArray(options.eventIds) && options.eventIds.length
    ? new Set(options.eventIds.map(String))
    : null;
  const rangeStart = new Date(now.getTime() - 2 * 60 * 1000);
  const rangeEnd = new Date(now.getTime() + MAX_OCCURRENCE_LOOKAHEAD_MS);
  const scheduleUntil = now.getTime() + RESEND_SCHEDULE_HORIZON_MS;
  const desired = new Map();

  for (const event of Array.isArray(events) ? events : []) {
    if (eventIdFilter && !eventIdFilter.has(String(event.id))) continue;
    const reminder = getReminderConfig(event);
    if (!reminder.enabled) continue;

    if (newEventIdSet.has(String(event.id))) {
      addDesiredReminder(desired, {
        key: creationReminderKey(event.id, reminder),
        type: 'created',
        eventId: event.id,
        title: event.title,
        note: event.note || '',
        location: event.location || '',
        recipients: reminder.recipients,
        occurrenceKey: 'created',
        eventAt: event.start,
        remindAt: now.toISOString(),
      });
    }

    const occurrences = expandEventOccurrences(event, rangeStart, rangeEnd);
    for (const occurrence of occurrences) {
      const eventAtMs = new Date(occurrence.start).getTime();
      if (!Number.isFinite(eventAtMs)) continue;

      const reminderTime = dailyReminderTimeForOccurrence(new Date(occurrence.start));
      const remindAtMs = reminderTime.remindAt.getTime();
      if (!Number.isFinite(remindAtMs)) continue;
      if (remindAtMs < now.getTime() - 5 * 60 * 1000) continue;
      if (remindAtMs > scheduleUntil) continue;

      const key = reminderKey(event.id, occurrence, reminder, reminderTime.variant);
      addDesiredReminder(desired, {
        key,
        type: reminderTime.variant,
        eventId: event.id,
        title: event.title,
        note: event.note || '',
        location: event.location || '',
        recipients: reminder.recipients,
        occurrenceKey: occurrence.occurrenceKey,
        eventAt: occurrence.start,
        remindAt: reminderTime.remindAt.toISOString(),
      });
    }
  }

  return desired;
}

async function readJsonBlob(path, fallback) {
  try {
    const meta = await head(path);
    const response = await fetch(`${meta.url}?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

async function writeJsonBlob(path, value) {
  await put(path, JSON.stringify(value, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 0,
  });
}

export async function loadEventsForReminderCron() {
  const parsed = await readJsonBlob(EVENTS_PATH, { events: [] });
  return Array.isArray(parsed.events) ? parsed.events : [];
}

async function loadReminderState() {
  const state = await readJsonBlob(REMINDER_STATE_PATH, { scheduled: {} });
  return {
    scheduled: state && typeof state.scheduled === 'object' && state.scheduled ? state.scheduled : {},
    updatedAt: state?.updatedAt || null,
  };
}

async function saveReminderState(state) {
  const now = Date.now();
  const scheduled = {};

  for (const [key, value] of Object.entries(state.scheduled || {})) {
    const eventAtMs = new Date(value.eventAt || value.remindAt || 0).getTime();
    if (Number.isFinite(eventAtMs) && eventAtMs < now - 90 * 24 * 60 * 60 * 1000) continue;
    scheduled[key] = value;
  }

  await writeJsonBlob(REMINDER_STATE_PATH, {
    updatedAt: new Date().toISOString(),
    scheduled,
  });
}

function requireResendConfig() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is missing in Vercel environment variables.');
  if (!process.env.REMINDER_FROM) throw new Error('REMINDER_FROM is missing in Vercel environment variables.');
}

function buildEmail(reminder) {
  const title = escapeHtml(reminder.title || 'Family reminder');
  const note = reminder.note ? `<p style="margin: 12px 0 0;">${escapeHtml(reminder.note)}</p>` : '';
  const location = reminder.location ? `<p style="margin: 8px 0 0;"><strong>Where:</strong> ${escapeHtml(reminder.location)}</p>` : '';
  const when = escapeHtml(formatDateTime(reminder.eventAt));

  if (reminder.type === 'created') {
    return {
      subject: `New task created: ${reminder.title || 'Family task'}`,
      text: `New task created: ${reminder.title || 'Family task'}\n\nWhen: ${formatDateTime(reminder.eventAt)}\n${reminder.location ? `Where: ${reminder.location}\n` : ''}${reminder.note || ''}`,
      html: `
        <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; color: #2f2b27; line-height: 1.5;">
          <div style="max-width: 560px; padding: 22px; border: 1px solid #e5ddd0; border-radius: 22px; background: #fffaf2;">
            <div style="font-size: 13px; font-weight: 800; color: #8a7d6f; text-transform: uppercase; letter-spacing: .08em;">Family Organizer</div>
            <h1 style="margin: 8px 0 10px; font-size: 26px; line-height: 1.15;">New task created</h1>
            <p style="margin: 0; font-size: 18px;"><strong>${title}</strong></p>
            <p style="margin: 8px 0 0;"><strong>When:</strong> ${when}</p>
            ${location}
            ${note}
          </div>
        </div>
      `,
    };
  }

  const message = reminder.type === 'earlyTomorrow'
    ? 'Remember this task early tomorrow'
    : 'Remember this task today';

  return {
    subject: `${message}: ${reminder.title || 'Family task'}`,
    text: `${message}: ${reminder.title || 'Family task'}\n\nWhen: ${formatDateTime(reminder.eventAt)}\n${reminder.location ? `Where: ${reminder.location}\n` : ''}${reminder.note || ''}`,
    html: `
      <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; color: #2f2b27; line-height: 1.5;">
        <div style="max-width: 560px; padding: 22px; border: 1px solid #e5ddd0; border-radius: 22px; background: #fffaf2;">
          <div style="font-size: 13px; font-weight: 800; color: #8a7d6f; text-transform: uppercase; letter-spacing: .08em;">Family Organizer</div>
          <h1 style="margin: 8px 0 10px; font-size: 26px; line-height: 1.15;">${escapeHtml(message)}</h1>
          <p style="margin: 0; font-size: 18px;"><strong>${title}</strong></p>
          <p style="margin: 8px 0 0;"><strong>When:</strong> ${when}</p>
          ${location}
          ${note}
        </div>
      </div>
    `,
  };
}

async function resendSend(reminder, now = new Date()) {
  requireResendConfig();
  const email = buildEmail(reminder);
  const remindAtMs = new Date(reminder.remindAt).getTime();
  const body = {
    from: process.env.REMINDER_FROM,
    to: reminder.recipients,
    subject: email.subject,
    text: email.text,
    html: email.html,
  };

  if (remindAtMs > now.getTime() + RESEND_SEND_NOW_GRACE_MS) {
    body.scheduledAt = reminder.remindAt;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `home-organizer-${reminder.key}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Resend error ${response.status}`);

  return {
    resendEmailId: data.id,
    sentImmediately: !body.scheduledAt,
    scheduledAt: body.scheduledAt || null,
  };
}

async function resendCancel(emailId) {
  if (!emailId || !process.env.RESEND_API_KEY) return { skipped: true };
  const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(emailId)}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ignored: true, data };
  return { ok: true, data };
}

export async function syncReminderSchedulesForEvents(events, options = {}) {
  const now = new Date();
  const state = await loadReminderState();
  const desired = buildDesiredReminders(events, { now, eventIds: options.eventIds, newEventIds: options.newEventIds });
  const currentEntries = Object.entries(state.scheduled || {});
  const eventIdFilter = Array.isArray(options.eventIds) && options.eventIds.length
    ? new Set(options.eventIds.map(String))
    : null;

  const result = {
    ok: true,
    scheduled: 0,
    sentNow: 0,
    kept: 0,
    cancelled: 0,
    skipped: 0,
    errors: [],
  };

  for (const [key, existing] of currentEntries) {
    const applies = options.all || !eventIdFilter || eventIdFilter.has(String(existing.eventId));
    if (!applies) continue;
    if (desired.has(key)) {
      result.kept += 1;
      continue;
    }

    try {
      await resendCancel(existing.resendEmailId);
      delete state.scheduled[key];
      result.cancelled += 1;
    } catch (error) {
      result.errors.push({ key, error: error.message });
    }
  }

  for (const [key, reminder] of desired.entries()) {
    if (state.scheduled[key]) continue;

    try {
      const sent = await resendSend(reminder, now);
      state.scheduled[key] = {
        ...reminder,
        ...sent,
        createdAt: new Date().toISOString(),
      };
      if (sent.sentImmediately) result.sentNow += 1;
      else result.scheduled += 1;
    } catch (error) {
      result.errors.push({ key, error: error.message });
    }
  }

  await saveReminderState(state);
  if (result.errors.length) result.ok = false;
  return result;
}
