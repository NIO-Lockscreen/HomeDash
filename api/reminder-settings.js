import { loadReminderSettings, saveReminderSettings } from './_reminders.js';

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
      if (body.length > 200_000) {
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
    send(res, 500, { ok: false, error: 'ADMIN_PIN is missing in Vercel environment variables.' });
    return false;
  }
  if (req.headers['x-admin-pin'] !== process.env.ADMIN_PIN) {
    send(res, 401, { ok: false, error: 'Wrong admin PIN.' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      send(res, 200, { ok: true, settings: await loadReminderSettings() });
      return;
    }

    if (req.method === 'PUT') {
      if (!verifyAdmin(req, res)) return;
      const payload = JSON.parse(await readBody(req) || '{}');
      send(res, 200, { ok: true, settings: await saveReminderSettings(payload.settings || payload) });
      return;
    }

    res.setHeader('Allow', 'GET, PUT');
    send(res, 405, { ok: false, error: 'Method not allowed.' });
  } catch (error) {
    send(res, 400, { ok: false, error: error.message || 'Reminder settings failed.' });
  }
}
