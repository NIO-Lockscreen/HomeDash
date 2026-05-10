import { loadEventsForReminderCron, syncReminderSchedulesForEvents } from './_reminders.js';

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function verifyCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    send(res, 500, { ok: false, error: 'CRON_SECRET is missing in Vercel environment variables.' });
    return false;
  }

  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const supplied = req.headers.authorization === `Bearer ${secret}`
    || req.headers['x-cron-secret'] === secret
    || url.searchParams.get('secret') === secret;

  if (!supplied) {
    send(res, 401, { ok: false, error: 'Unauthorized reminder cron request.' });
    return false;
  }

  return true;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      send(res, 405, { ok: false, error: 'Method not allowed.' });
      return;
    }

    if (!verifyCron(req, res)) return;

    const events = await loadEventsForReminderCron();
    const result = await syncReminderSchedulesForEvents(events, { all: true });

    send(res, result.ok ? 200 : 207, {
      ok: result.ok,
      checkedEvents: events.length,
      ...result,
    });
  } catch (error) {
    send(res, 500, { ok: false, error: error.message || 'Reminder cron failed.' });
  }
}
