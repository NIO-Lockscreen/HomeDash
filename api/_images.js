// Blob I/O for event images. The decisions live in _image-rules.js.
import { head, put, del, list } from '@vercel/blob';
import crypto from 'crypto';
import {
  IMAGE_PREFIX,
  IMAGE_GRACE_DAYS,
  isBlobNotFoundError,
  referencedImagePathnames,
  classifyImages
} from './_image-rules.js';

const EVENTS_PATH = 'home-organizer/events.json';
const SWEEP_STATE_PATH = 'home-organizer/image-sweep.json';

// { exists, uploadedAt } for one stored image. A transient error reports the
// image as present with an unknown age: better to keep a live reference than
// to drop it because Blob hiccuped.
export async function organizerImageMeta(url) {
  try {
    const meta = await head(url);
    const uploadedAt = meta?.uploadedAt ? new Date(meta.uploadedAt).getTime() : NaN;
    return { exists: true, uploadedAt: Number.isFinite(uploadedAt) ? uploadedAt : null };
  } catch (error) {
    if (isBlobNotFoundError(error)) return { exists: false, uploadedAt: null };
    return { exists: true, uploadedAt: null };
  }
}

// Reads a JSON blob, or throws. Returns null only when the blob does not
// exist. Unlike the lenient readers elsewhere this never falls back to an
// empty document: a sweep that mistook a failed read for "no tasks" would
// start the clock on every image in the store.
async function readJsonBlobStrict(path) {
  let meta;
  try {
    meta = await head(path);
  } catch (error) {
    if (isBlobNotFoundError(error)) return null;
    throw error;
  }
  const bust = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const response = await fetch(`${meta.url}?v=${bust}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not read ${path} from Blob (${response.status}).`);
  return response.json();
}

async function listAllImages() {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix: IMAGE_PREFIX, limit: 1000, cursor });
    blobs.push(...(page?.blobs || []));
    cursor = page?.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function deleteBlobs(entries) {
  if (!entries.length) return { deleted: 0, failed: [] };
  try {
    await del(entries.map(entry => entry.blob.url));
    return { deleted: entries.length, failed: [] };
  } catch (error) {
    console.warn('Bulk image delete failed, retrying one by one:', error);
    let deleted = 0;
    const failed = [];
    for (const entry of entries) {
      try {
        await del(entry.blob.url);
        deleted += 1;
      } catch (singleError) {
        failed.push(entry);
        console.warn('Could not delete unreferenced image:', entry.blob.pathname, singleError);
      }
    }
    return { deleted, failed };
  }
}

// Deletes images no task has referenced for IMAGE_GRACE_DAYS. Run from the
// cron. An image only leaves the store once two clocks have both run out:
// the time since a sweep first saw it unreferenced, and the time since it
// was uploaded. Until then it is recoverable from the Blob dashboard.
export async function sweepUnreferencedImages({ now = Date.now() } = {}) {
  const eventsDoc = await readJsonBlobStrict(EVENTS_PATH);
  if (eventsDoc === null) {
    return { ok: true, skipped: 'events.json does not exist; nothing deleted.', graceDays: IMAGE_GRACE_DAYS };
  }
  const events = Array.isArray(eventsDoc.events) ? eventsDoc.events : [];
  const referenced = referencedImagePathnames(events);

  const [blobs, stateDoc] = await Promise.all([listAllImages(), readJsonBlobStrict(SWEEP_STATE_PATH)]);
  const unreferencedSince = stateDoc?.unreferencedSince && typeof stateDoc.unreferencedSince === 'object'
    ? stateDoc.unreferencedSince
    : {};

  const plan = classifyImages({ blobs, referenced, unreferencedSince, now });
  const { deleted, failed } = await deleteBlobs(plan.deleteNow);

  // A failed delete keeps its original timestamp so the next sweep retries
  // it instead of granting it a fresh grace period.
  const nextSince = { ...plan.nextSince };
  for (const entry of failed) nextSince[entry.blob.pathname] = entry.since;

  await put(SWEEP_STATE_PATH, JSON.stringify({ updatedAt: new Date(now).toISOString(), unreferencedSince: nextSince }, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 0
  });

  return {
    ok: failed.length === 0,
    graceDays: IMAGE_GRACE_DAYS,
    scanned: blobs.length,
    referenced: plan.referenced,
    protected: plan.protected.length,
    deleted,
    failed: failed.length
  };
}
