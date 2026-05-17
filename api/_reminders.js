import { head, put } from '@vercel/blob';
import crypto from 'crypto';

const EVENTS_PATH = 'home-organizer/events.json';
const REMINDER_STATE_PATH = 'home-organizer/reminders-state.json';
const REMINDER_SETTINGS_PATH = 'home-organizer/reminder-settings.json';
const RESEND_SCHEDULE_HORIZON_MS = 8 * 24 * 60 * 60 * 1000; // Only queue near-term reminders; the cron refreshes this daily.
const RESEND_SEND_NOW_GRACE_MS = 90 * 1000;
const MAX_OCCURRENCE_LOOKAHEAD_MS = 8 * 24 * 60 * 60 * 1000;
const DEFAULT_TIME_ZONE = 'Europe/Oslo';
const HARD_CODED_REMINDER_RECIPIENTS = new Set(['theresesaksgard@hotmail.com', 'diemetrix@gmail.com']);

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getReminderConfig(event) {
  const reminder = event?.emailReminder || {};
  const recipients = Array.isArray(reminder.recipients)
    ? [...new Set(reminder.recipients.map(normalizeEmail).filter(email => isValidEmail(email) && HARD_CODED_REMINDER_RECIPIENTS.has(email)))]
    : [];

  const creationEmailSentAt = String(reminder.creationEmailSentAt || '').trim();
  return {
    enabled: Boolean(reminder.enabled) && recipients.length > 0,
    recipients,
    creationEmailSentAt: /^\d{4}-\d{2}-\d{2}T/.test(creationEmailSentAt) ? creationEmailSentAt : '',
    minutesBefore: Number.isFinite(Number(reminder.minutesBefore)) ? Math.max(0, Math.min(10080, Math.round(Number(reminder.minutesBefore)))) : null,
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

function dailyReminderTimeForOccurrence(occurrenceStart, reminder = {}) {
  const parts = zonedParts(occurrenceStart);
  const minutesBefore = Number.isFinite(Number(reminder.minutesBefore)) ? Number(reminder.minutesBefore) : null;

  if (minutesBefore !== null) {
    const remindAt = new Date(occurrenceStart.getTime() - Math.max(0, minutesBefore) * 60 * 1000);
    return {
      remindAt,
      variant: minutesBefore === 0 ? 'atStart' : 'beforeTask',
    };
  }

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
    imageUrl: event.imageUrl || '',
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
  const createdRecipientsByEvent = options.createdRecipientsByEvent && typeof options.createdRecipientsByEvent === 'object'
    ? options.createdRecipientsByEvent
    : {};
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
      const createdRecipients = Array.isArray(createdRecipientsByEvent[event.id])
        ? [...new Set(createdRecipientsByEvent[event.id].map(normalizeEmail).filter(email => isValidEmail(email) && HARD_CODED_REMINDER_RECIPIENTS.has(email)))]
        : (!reminder.creationEmailSentAt ? reminder.recipients : []);
      if (createdRecipients.length) {
        const creationReminder = { ...reminder, recipients: createdRecipients };
        addDesiredReminder(desired, {
          key: creationReminderKey(event.id, creationReminder),
          type: 'created',
          eventId: event.id,
          title: event.title,
          note: event.note || '',
          location: event.location || '',
          imageUrl: event.imageUrl || '',
          recipients: createdRecipients,
          occurrenceKey: 'created',
          eventAt: event.start,
          eventEnd: event.end || '',
          remindAt: now.toISOString(),
        });
      }
    }

    const occurrences = expandEventOccurrences(event, rangeStart, rangeEnd);
    for (const occurrence of occurrences) {
      const eventAtMs = new Date(occurrence.start).getTime();
      if (!Number.isFinite(eventAtMs)) continue;

      const reminderTime = dailyReminderTimeForOccurrence(new Date(occurrence.start), reminder);
      const remindAtMs = reminderTime.remindAt.getTime();
      if (!Number.isFinite(remindAtMs)) continue;
      // Do not send task-day reminders immediately when the planned reminder time has already passed.
      // This avoids a new task causing both the creation email and a late task-day email at the same time.
      if (remindAtMs <= now.getTime() + 60 * 1000) continue;
      if (remindAtMs > scheduleUntil) continue;

      const key = reminderKey(event.id, occurrence, reminder, reminderTime.variant);
      addDesiredReminder(desired, {
        key,
        type: reminderTime.variant,
        eventId: event.id,
        title: event.title,
        note: event.note || '',
        location: event.location || '',
        imageUrl: event.imageUrl || '',
        recipients: reminder.recipients,
        occurrenceKey: occurrence.occurrenceKey,
        eventAt: occurrence.start,
        eventEnd: occurrence.end || '',
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


function absoluteSiteUrl() {
  const explicit = process.env.PUBLIC_SITE_URL || process.env.ORGANIZER_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return String(explicit).replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${String(process.env.VERCEL_URL).replace(/\/$/, '')}`;
  return '';
}

function toCalendarParam(value) {
  return encodeURIComponent(String(value || ''));
}

function calendarDownloadUrl(reminder) {
  const base = absoluteSiteUrl();
  if (!base) return '';
  const start = reminder.eventAt || reminder.remindAt;
  const end = reminder.eventEnd || '';
  const params = [
    `title=${toCalendarParam(reminder.title || 'Family task')}`,
    `start=${toCalendarParam(start)}`,
    `end=${toCalendarParam(end)}`,
    `location=${toCalendarParam(reminder.location || '')}`,
    `note=${toCalendarParam(reminder.note || '')}`,
  ].join('&');
  return `${base}/api/calendar-ics?${params}`;
}

function safeImageUrl(value) {
  const url = String(value || '').trim();
  if (!/^https:\/\//i.test(url)) return '';
  return url;
}

function buildEmailShell({ eyebrow, headline, title, when, location, note, imageUrl, calendarUrl }) {
  const image = imageUrl ? `
    <img src="${escapeHtml(imageUrl)}" alt="" style="display:block; width:100%; max-height:260px; object-fit:cover; border-radius:22px; margin:0 0 18px; border:1px solid #eadfce;" />
  ` : '';

  const locationLine = location ? `
    <tr>
      <td style="padding:7px 0; color:#8a7d6f; width:72px; vertical-align:top; font-weight:700;">Where</td>
      <td style="padding:7px 0; color:#2f2b27;">${escapeHtml(location)}</td>
    </tr>
  ` : '';

  const noteBlock = note ? `
    <div style="margin-top:16px; padding:14px 16px; border-radius:18px; background:#fffaf2; border:1px solid #efe4d2; color:#51473e;">
      ${escapeHtml(note).replaceAll('\n', '<br>')}
    </div>
  ` : '';

  const calendarButton = calendarUrl ? `
    <div style="margin-top:20px;">
      <a href="${escapeHtml(calendarUrl)}" style="display:inline-block; padding:12px 16px; border-radius:999px; background:#2f2b27; color:#fffaf2; text-decoration:none; font-weight:800; font-size:14px;">
        Add to phone calendar
      </a>
    </div>
    <p style="margin:10px 0 0; color:#8a7d6f; font-size:12px;">This opens a small calendar file your phone can save.</p>
  ` : '';

  return `
    <div style="margin:0; padding:0; background:#f4efe7; font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; color:#2f2b27; line-height:1.5;">
      <div style="max-width:620px; margin:0 auto; padding:28px 14px;">
        <div style="background:#fffdf8; border:1px solid #e6dccd; border-radius:28px; padding:22px; box-shadow:0 18px 50px rgba(47,43,39,.10);">
          ${image}
          <div style="font-size:12px; font-weight:900; color:#9a8062; text-transform:uppercase; letter-spacing:.12em;">${escapeHtml(eyebrow)}</div>
          <h1 style="margin:8px 0 8px; font-size:30px; line-height:1.08; letter-spacing:-.03em; color:#2f2b27;">${escapeHtml(headline)}</h1>
          <div style="margin:0 0 16px; font-size:20px; font-weight:850; color:#443b33;">${escapeHtml(title)}</div>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; border-top:1px solid #efe4d2; border-bottom:1px solid #efe4d2; padding:8px 0;">
            <tr>
              <td style="padding:7px 0; color:#8a7d6f; width:72px; vertical-align:top; font-weight:700;">When</td>
              <td style="padding:7px 0; color:#2f2b27;">${escapeHtml(when)}</td>
            </tr>
            ${locationLine}
          </table>
          ${noteBlock}
          ${calendarButton}
          <p style="margin:22px 0 0; color:#9b8f82; font-size:12px;">Sent by your Family Organizer dashboard.</p>
        </div>
      </div>
    </div>
  `;
}

function buildEmail(reminder) {
  const rawTitle = reminder.title || 'Family task';
  const rawNote = reminder.note || '';
  const rawLocation = reminder.location || '';
  const when = formatDateTime(reminder.eventAt);
  const imageUrl = safeImageUrl(reminder.imageUrl);
  const calendarUrl = calendarDownloadUrl(reminder);
  const calendarText = calendarUrl ? `\n\nSave to calendar: ${calendarUrl}` : '';

  if (reminder.type === 'created') {
    return {
      subject: `New task: ${rawTitle}`,
      text: `New task created: ${rawTitle}\n\nWhen: ${when}\n${rawLocation ? `Where: ${rawLocation}\n` : ''}${rawNote || ''}${calendarText}`,
      html: buildEmailShell({
        eyebrow: 'Family Organizer',
        headline: 'New task created',
        title: rawTitle,
        when,
        location: rawLocation,
        note: rawNote,
        imageUrl,
        calendarUrl,
      }),
    };
  }

  const message = reminder.type === 'earlyTomorrow'
    ? 'Remember this task early tomorrow'
    : reminder.type === 'beforeTask'
      ? 'Upcoming task reminder'
      : reminder.type === 'atStart'
        ? 'Task starting now'
        : 'Remember this task today';

  return {
    subject: `${message}: ${rawTitle}`,
    text: `${message}: ${rawTitle}\n\nWhen: ${when}\n${rawLocation ? `Where: ${rawLocation}\n` : ''}${rawNote || ''}${calendarText}`,
    html: buildEmailShell({
      eyebrow: 'Family Organizer reminder',
      headline: message,
      title: rawTitle,
      when,
      location: rawLocation,
      note: rawNote,
      imageUrl,
      calendarUrl,
    }),
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


function normalizeRecipientList(value, fallback = [...HARD_CODED_REMINDER_RECIPIENTS]) {
  const source = Array.isArray(value) ? value : fallback;
  return [...new Set(source.map(normalizeEmail).filter(email => isValidEmail(email) && HARD_CODED_REMINDER_RECIPIENTS.has(email)))];
}

function normalizeReminderSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const legacyRecipients = normalizeRecipientList(source.recipients);
  const weeklyRecipients = normalizeRecipientList(source.weeklyRecipients, legacyRecipients);
  const endOfDayRecipients = normalizeRecipientList(source.endOfDayRecipients, legacyRecipients);
  return {
    weeklyUpdates: Boolean(source.weeklyUpdates),
    endOfDayNewTasks: Boolean(source.endOfDayNewTasks),
    weeklyRecipients,
    endOfDayRecipients,
    // Kept for older clients. New code uses the per-digest recipient lists above.
    recipients: legacyRecipients,
    updatedAt: source.updatedAt || null,
  };
}

export async function loadReminderSettings() {
  return normalizeReminderSettings(await readJsonBlob(REMINDER_SETTINGS_PATH, {}));
}

export async function saveReminderSettings(settings) {
  const clean = normalizeReminderSettings({ ...settings, updatedAt: new Date().toISOString() });
  await writeJsonBlob(REMINDER_SETTINGS_PATH, clean);
  return clean;
}

function localDateAt(year, month, day, hour = 0, minute = 0) {
  return zonedDateTimeToUtc(year, month, day, hour, minute);
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function digestKey(type, dateKey, recipient = '') {
  const suffix = recipient ? `::${normalizeEmail(recipient)}` : '';
  return `digest::${type}::${dateKey}${suffix}`;
}

function shortNote(value = '') {
  const cleanValue = String(value || '').replace(/\s+/g, ' ').trim();
  if (!cleanValue) return '';
  return cleanValue.length > 180 ? `${cleanValue.slice(0, 177)}...` : cleanValue;
}

function digestItemCalendarUrl(item) {
  return calendarDownloadUrl({
    title: item.title || 'Family task',
    note: item.note || '',
    location: item.location || '',
    eventAt: item.start || item.eventAt,
    eventEnd: item.end || item.eventEnd || '',
    remindAt: item.start || item.eventAt,
  });
}

function buildDigestEmail({ type, title, intro, items }) {
  const safeItems = Array.isArray(items) ? items : [];
  const decoratedItems = safeItems.map(item => ({
    ...item,
    calendarUrl: item.calendarUrl || digestItemCalendarUrl(item),
    notePreview: shortNote(item.note || ''),
  }));
  const countText = decoratedItems.length === 1 ? '1 item' : `${decoratedItems.length} items`;
  const rows = decoratedItems.map((item, index) => {
    const calendarLine = item.calendarUrl ? `\n   Add to phone calendar: ${item.calendarUrl}` : '';
    const noteLine = item.notePreview ? `\n   Note: ${item.notePreview}` : '';
    const locationLine = item.location ? `\n   Where: ${item.location}` : '';
    return `${index + 1}. ${item.when} — ${item.title}${locationLine}${noteLine}${calendarLine}`;
  }).join('\n\n');

  const emptyState = `
    <div style="padding:18px; border-radius:18px; background:#fffaf2; border:1px dashed #dfcfb9; color:#8a7d6f; font-weight:700; text-align:center;">
      Nothing to show.
    </div>`;

  const htmlRows = decoratedItems.map(item => {
    const addButton = item.calendarUrl ? `
      <div style="margin-top:14px;">
        <a href="${escapeHtml(item.calendarUrl)}" style="display:inline-block; padding:11px 14px; border-radius:999px; background:#2f2b27; color:#fffaf2; text-decoration:none; font-weight:850; font-size:13px;">
          Add to phone calendar
        </a>
      </div>` : '';
    const locationLine = item.location ? `
      <div style="margin-top:7px; color:#6f6257; font-size:14px;">
        <span style="font-weight:850; color:#8a7d6f;">Where:</span> ${escapeHtml(item.location)}
      </div>` : '';
    const noteLine = item.notePreview ? `
      <div style="margin-top:10px; padding:10px 12px; border-radius:14px; background:#ffffff; border:1px solid #efe4d2; color:#51473e; font-size:14px;">
        ${escapeHtml(item.notePreview)}
      </div>` : '';
    return `
      <div style="margin:0 0 12px; padding:16px; border-radius:22px; background:#fffaf2; border:1px solid #efe4d2;">
        <div style="display:inline-block; margin:0 0 8px; padding:5px 9px; border-radius:999px; background:#f0e4d4; color:#80674c; font-size:12px; font-weight:900;">
          ${escapeHtml(item.when)}
        </div>
        <div style="font-size:18px; line-height:1.22; font-weight:900; color:#2f2b27; letter-spacing:-.01em;">
          ${escapeHtml(item.title)}
        </div>
        ${locationLine}
        ${noteLine}
        ${addButton}
      </div>`;
  }).join('');

  const badge = type === 'weekly' ? 'Week ahead' : 'Daily update';
  const helpText = decoratedItems.some(item => item.calendarUrl)
    ? 'Tap “Add to phone calendar” on any item to open a small calendar file your phone can save.'
    : 'Calendar links need PUBLIC_SITE_URL, ORGANIZER_SITE_URL, NEXT_PUBLIC_SITE_URL, or VERCEL_URL to be available.';

  return {
    subject: title,
    text: `${intro}\n\n${rows || 'Nothing to show.'}`,
    html: `
      <div style="margin:0; padding:0; background:#f4efe7; font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; color:#2f2b27; line-height:1.5;">
        <div style="max-width:640px; margin:0 auto; padding:26px 12px;">
          <div style="background:#fffdf8; border:1px solid #e6dccd; border-radius:30px; padding:22px; box-shadow:0 18px 50px rgba(47,43,39,.10);">
            <div style="display:inline-block; padding:6px 10px; border-radius:999px; background:#2f2b27; color:#fffaf2; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.10em;">${escapeHtml(badge)}</div>
            <h1 style="margin:12px 0 8px; font-size:30px; line-height:1.08; letter-spacing:-.03em; color:#2f2b27;">${escapeHtml(title)}</h1>
            <p style="margin:0 0 16px; color:#6f6257; font-weight:700;">${escapeHtml(intro)}</p>
            <div style="margin:0 0 16px; padding:12px 14px; border-radius:18px; background:#f8efe1; border:1px solid #eadcc7; color:#604f40; font-weight:900;">
              ${escapeHtml(countText)}
            </div>
            ${htmlRows || emptyState}
            <p style="margin:18px 0 0; color:#8a7d6f; font-size:12px;">${escapeHtml(helpText)}</p>
            <p style="margin:8px 0 0; color:#9b8f82; font-size:12px;">Sent by your Family Organizer dashboard.</p>
          </div>
        </div>
      </div>`,
  };
}

async function sendDigestEmail(key, recipient, email, state) {
  if (state.scheduled?.[key]?.sentAt) return { skipped: true, recipient };
  requireResendConfig();
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `home-organizer-${key}`,
    },
    body: JSON.stringify({ from: process.env.REMINDER_FROM, to: [recipient], subject: email.subject, text: email.text, html: email.html }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Resend error ${response.status}`);
  state.scheduled[key] = { type: 'digest', resendEmailId: data.id, sentAt: new Date().toISOString(), recipients: [recipient] };
  return { sent: true, recipient };
}

async function sendDigestToRecipients(type, dateKey, recipients, email, state) {
  const cleanRecipients = normalizeRecipientList(recipients, []);
  const result = { sent: 0, skipped: 0, recipients: [] };
  for (const recipient of cleanRecipients) {
    const sent = await sendDigestEmail(digestKey(type, dateKey, recipient), recipient, email, state);
    if (sent.sent) {
      result.sent += 1;
      result.recipients.push(recipient);
    }
    if (sent.skipped) result.skipped += 1;
  }
  return result;
}

export async function syncReminderDigests(events, options = {}) {
  const now = options.now || new Date();
  const settings = await loadReminderSettings();
  const state = await loadReminderState();
  const parts = zonedParts(now);
  const todayKey = dateKeyInTimeZone(now);
  const result = { ok: true, weeklySent: false, dailySent: false, skipped: [], errors: [] };

  try {
    const localWeekday = new Intl.DateTimeFormat('en-US', { timeZone: process.env.ORGANIZER_TIME_ZONE || DEFAULT_TIME_ZONE, weekday: 'short' }).format(now);
    if (settings.weeklyUpdates && localWeekday === 'Sun' && parts.hour >= 18) {
      const startParts = addLocalDays(parts, 1);
      const endParts = addLocalDays(parts, 8);
      const rangeStart = localDateAt(startParts.year, startParts.month, startParts.day, 0, 0);
      const rangeEnd = localDateAt(endParts.year, endParts.month, endParts.day, 0, 0);
      const occurrences = (Array.isArray(events) ? events : []).flatMap(event => expandEventOccurrences(event, rangeStart, rangeEnd));
      const items = occurrences.sort((a, b) => new Date(a.start) - new Date(b.start)).map(item => ({
        title: item.title,
        when: formatDateTime(item.start),
        location: item.location || '',
        note: item.note || '',
        start: item.start,
        end: item.end || '',
      }));
      const sent = await sendDigestToRecipients('weekly', todayKey, settings.weeklyRecipients, buildDigestEmail({
        type: 'weekly',
        title: 'Coming week in Family Organizer',
        intro: 'Everything planned for the coming Monday to Sunday.',
        items,
      }), state);
      result.weeklySent = sent.sent > 0;
      result.weeklyRecipientsSent = sent.recipients;
      if (!settings.weeklyRecipients.length) result.skipped.push('weekly has no recipients enabled');
      if (sent.skipped) result.skipped.push('weekly already sent for some recipients');
    }

    if (settings.endOfDayNewTasks && parts.hour >= 20) {
      const items = (Array.isArray(events) ? events : [])
        .filter(event => dateKeyInTimeZone(event.createdAt || event.updatedAt || event.start) === todayKey)
        .sort((a, b) => new Date(a.createdAt || a.start) - new Date(b.createdAt || b.start))
        .map(event => ({
          title: event.title,
          when: formatDateTime(event.start),
          location: event.location || '',
          note: event.note || '',
          start: event.start,
          end: event.end || '',
        }));
      if (items.length) {
        const sent = await sendDigestToRecipients('daily-new', todayKey, settings.endOfDayRecipients, buildDigestEmail({
          type: 'daily-new',
          title: 'New tasks added today',
          intro: 'These tasks were added to Family Organizer today.',
          items,
        }), state);
        result.dailySent = sent.sent > 0;
        result.dailyRecipientsSent = sent.recipients;
        if (!settings.endOfDayRecipients.length) result.skipped.push('daily has no recipients enabled');
        if (sent.skipped) result.skipped.push('daily already sent for some recipients');
      } else {
        result.skipped.push('no new tasks today');
      }
    }
  } catch (error) {
    result.ok = false;
    result.errors.push(error.message || 'Digest sync failed.');
  }

  await saveReminderState(state);
  return result;
}

export async function syncReminderSchedulesForEvents(events, options = {}) {
  const now = new Date();
  const state = await loadReminderState();
  const desired = buildDesiredReminders(events, { now, eventIds: options.eventIds, newEventIds: options.newEventIds, createdRecipientsByEvent: options.createdRecipientsByEvent });
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
    createdSentEventIds: [],
    createdSentRecipientsByEvent: {},
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
      if (reminder.type === 'created') {
        result.createdSentEventIds.push(String(reminder.eventId));
        const eventKey = String(reminder.eventId);
        result.createdSentRecipientsByEvent[eventKey] = [
          ...new Set([...(result.createdSentRecipientsByEvent[eventKey] || []), ...reminder.recipients])
        ];
      }
    } catch (error) {
      result.errors.push({ key, error: error.message });
    }
  }

  await saveReminderState(state);
  if (result.errors.length) result.ok = false;
  return result;
}
