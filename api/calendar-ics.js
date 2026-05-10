function send(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(body);
}

function clean(value = '') {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
}

function escapeIcs(value = '') {
  return clean(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIcsUtc(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function foldLine(line) {
  const limit = 74;
  if (line.length <= limit) return line;
  const chunks = [];
  let remaining = line;
  chunks.push(remaining.slice(0, limit));
  remaining = remaining.slice(limit);
  while (remaining.length) {
    chunks.push(` ${remaining.slice(0, limit - 1)}`);
    remaining = remaining.slice(limit - 1);
  }
  return chunks.join('\r\n');
}

function icsLine(key, value) {
  return foldLine(`${key}:${value}`);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return send(res, 405, 'Use GET', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const title = clean(req.query.title || 'Family task');
  const location = clean(req.query.location || '');
  const note = clean(req.query.note || '');
  const start = parseDate(req.query.start);
  let end = parseDate(req.query.end);

  if (!start) {
    return send(res, 400, 'Missing or invalid start date.', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (!end || end <= start) {
    end = new Date(start.getTime() + 60 * 60 * 1000);
  }

  const now = new Date();
  const uidSeed = `${title}-${start.toISOString()}-${location}`;
  const uid = Buffer.from(uidSeed).toString('base64url').slice(0, 48) + '@home-organizer';
  const safeFilename = `${title || 'family-task'}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'family-task';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Home Organizer//Family Task//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    icsLine('UID', escapeIcs(uid)),
    icsLine('DTSTAMP', toIcsUtc(now)),
    icsLine('DTSTART', toIcsUtc(start)),
    icsLine('DTEND', toIcsUtc(end)),
    icsLine('SUMMARY', escapeIcs(title)),
  ];

  if (location) lines.push(icsLine('LOCATION', escapeIcs(location)));
  if (note) lines.push(icsLine('DESCRIPTION', escapeIcs(note)));

  lines.push('END:VEVENT', 'END:VCALENDAR');

  return send(res, 200, `${lines.join('\r\n')}\r\n`, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safeFilename}.ics"`,
    'Cache-Control': 'no-store',
  });
}
