import { head, put } from '@vercel/blob';
import crypto from 'crypto';

const CONFIG_PATH = 'home-organizer/config.json';
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
      if (body.length > 1_500_000) {
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
    send(res, 500, { error: 'ADMIN_PIN is missing. Add it in Vercel environment variables before saving config.' });
    return false;
  }

  const suppliedPin = req.headers['x-admin-pin'];
  if (suppliedPin !== process.env.ADMIN_PIN) {
    send(res, 401, { error: 'Wrong admin PIN.' });
    return false;
  }
  return true;
}

async function loadRawConfig() {
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

async function saveRawConfig(config) {
  await put(
    CONFIG_PATH,
    JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2),
    {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json; charset=utf-8',
      cacheControlMaxAge: 0
    }
  );
}

function encryptionKey() {
  if (!process.env.ADMIN_PIN) throw new Error('ADMIN_PIN is required to encrypt Google credentials.');
  return crypto.createHash('sha256').update(process.env.ADMIN_PIN).digest();
}

function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

function normalizeServiceAccount(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  let jsonText = text;
  if (!text.startsWith('{')) {
    try {
      jsonText = Buffer.from(text, 'base64').toString('utf8').trim();
    } catch {
      throw new Error('Service account key must be JSON or base64 encoded JSON.');
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Could not parse the Google service account key. Paste the full JSON key or base64 JSON.');
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('The Google service account key must include client_email and private_key.');
  }

  return JSON.stringify(parsed);
}

function publicConfig(raw) {
  return {
    googleCalendarSyncEnabled: raw.googleCalendarSyncEnabled === true,
    googleCalendarId: raw.googleCalendarId || process.env.GOOGLE_CALENDAR_ID || '',
    googleCalendarTimezone: raw.googleCalendarTimezone || DEFAULT_TIMEZONE,
    hasGoogleServiceAccount: Boolean(raw.googleServiceAccountEncrypted || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64),
    serviceAccountSource: raw.googleServiceAccountEncrypted ? 'config-menu' : ((process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) ? 'vercel-env' : ''),
    envCalendarIdAvailable: Boolean(process.env.GOOGLE_CALENDAR_ID),
    updatedAt: raw.updatedAt || ''
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const raw = await loadRawConfig();
      send(res, 200, { config: publicConfig(raw) });
      return;
    }

    if (req.method !== 'PUT') {
      res.setHeader('Allow', 'GET, PUT');
      send(res, 405, { error: 'Method not allowed.' });
      return;
    }

    if (!verifyAdmin(req, res)) return;

    const payload = JSON.parse(await readBody(req) || '{}');
    const raw = await loadRawConfig();

    const next = {
      ...raw,
      googleCalendarSyncEnabled: payload.googleCalendarSyncEnabled === true,
      googleCalendarId: String(payload.googleCalendarId ?? raw.googleCalendarId ?? '').trim(),
      googleCalendarTimezone: String(payload.googleCalendarTimezone ?? raw.googleCalendarTimezone ?? '').trim() || DEFAULT_TIMEZONE
    };

    if (payload.clearGoogleServiceAccount === true) {
      delete next.googleServiceAccountEncrypted;
    }

    const suppliedSecret = String(payload.googleServiceAccountSecret || '').trim();
    if (suppliedSecret) {
      const normalized = normalizeServiceAccount(suppliedSecret);
      next.googleServiceAccountEncrypted = encryptSecret(normalized);
    }

    await saveRawConfig(next);
    send(res, 200, { config: publicConfig(next), saved: true });
  } catch (error) {
    send(res, 400, { error: error.message || 'Could not save config.' });
  }
}
