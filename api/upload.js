import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { formidable } from 'formidable';
import { head, put } from '@vercel/blob';

const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function verifyAdmin(req, res) {
  if (!process.env.ADMIN_PIN) {
    send(res, 500, { error: 'ADMIN_PIN is missing. Add it in Vercel environment variables before uploading.' });
    return false;
  }
  if (req.headers['x-admin-pin'] !== process.env.ADMIN_PIN) {
    send(res, 401, { error: 'Wrong admin PIN.' });
    return false;
  }
  return true;
}

function parseForm(req) {
  const form = formidable({
    multiples: false,
    maxFileSize: MAX_IMAGE_SIZE,
    filter: part => part.name === 'image' && ALLOWED_TYPES.has(part.mimetype || '')
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function isForcedUpload(req) {
  try {
    return new URL(req.url, `https://${req.headers.host || 'localhost'}`).searchParams.get('force') === '1';
  } catch {
    return false;
  }
}

function safeExtension(file) {
  const byType = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif'
  };
  return byType[file.mimetype] || path.extname(file.originalFilename || '').toLowerCase() || '.jpg';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    send(res, 405, { error: 'Method not allowed.' });
    return;
  }

  if (!verifyAdmin(req, res)) return;

  try {
    const { files } = await parseForm(req);
    const image = Array.isArray(files.image) ? files.image[0] : files.image;
    if (!image) {
      send(res, 400, { error: 'Upload an image file under the form field name "image".' });
      return;
    }

    if (!ALLOWED_TYPES.has(image.mimetype)) {
      send(res, 400, { error: 'Only JPEG, PNG, WEBP and GIF images are supported.' });
      return;
    }

    const buffer = await fs.readFile(image.filepath);
    const ext = safeExtension(image);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Normal uploads reuse the blob for identical bytes, which keeps duplicates
    // out of the store. A forced upload must NOT do that: it exists to repair a
    // picture that never appears, and the usual suspect is the URL itself —
    // deleted and re-created at the same path, or a stale copy pinned in a CDN
    // or browser cache by the one-year cache header. Re-sending the same bytes
    // to the same URL cannot fix any of those, so a resync mints a fresh path
    // that nothing has cached yet.
    const forced = isForcedUpload(req);
    const suffix = forced ? `-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}` : '';
    const pathname = `home-organizer/images/${hash.slice(0, 2)}/${hash.slice(0, 32)}${suffix}${ext}`;

    if (!forced) {
      try {
        const existing = await head(pathname);
        send(res, 200, { url: existing.url, pathname: existing.pathname || pathname, reused: true });
        return;
      } catch {}
    }

    const blob = await put(pathname, buffer, {
      access: 'public',
      contentType: image.mimetype,
      addRandomSuffix: false,
      cacheControlMaxAge: 60 * 60 * 24 * 365
    });

    send(res, 200, { url: blob.url, pathname: blob.pathname, reused: false, forced });
  } catch (error) {
    send(res, 400, { error: error.message || 'Upload failed.' });
  }
}
