// Google OAuth and the Google Photos Library API, for the TV screensaver.
//
// Since March 2025 the Library API only lets an app see and edit what it
// created itself. That is enough here: HomeDash creates its own album, puts
// its own snapshots in it and takes its own old ones out again. Taking a
// snapshot out of the album does not delete it - the Library API has no way
// to delete or trash anything - so old snapshots stay in the account's
// library until somebody deletes them there.
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://photoslibrary.googleapis.com/v1';

export const PHOTOS_SCOPES = [
  // Upload, create media items, create the album.
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  // See what is in the app's own album, to confirm an upload landed there.
  'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
  // Take the app's old snapshots out of the app's own album.
  'https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata'
];

export class GoogleError extends Error {
  constructor(message, { status = 0, reason = '', reconnect = false } = {}) {
    super(message);
    this.name = 'GoogleError';
    this.status = status;
    this.reason = reason;
    // True when only connecting again can fix it (revoked or expired grant).
    this.reconnect = reconnect;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw new GoogleError(error?.name === 'AbortError' ? `Google did not answer in time (${new URL(url).pathname}).` : `Could not reach Google: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readError(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {}
  const error = body?.error;
  const message = typeof error === 'string'
    ? `${error}${body?.error_description ? `: ${body.error_description}` : ''}`
    : error?.message || `HTTP ${response.status}`;
  const reason = typeof error === 'string' ? error : String(error?.status || '');
  return { message, reason };
}

export function googleConfigMissing() {
  return ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter(name => !String(process.env[name] || '').trim());
}

export function authorizationUrl({ redirectUri, state }) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: PHOTOS_SCOPES.join(' '),
    // A refresh token, so the hourly job works with every browser closed.
    access_type: 'offline',
    // Always hand out a new refresh token, also on a second connect.
    prompt: 'consent',
    state
  }).toString();
  return url.toString();
}

async function tokenRequest(params) {
  const response = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      ...params
    }).toString()
  });
  if (!response.ok) {
    const { message, reason } = await readError(response);
    throw new GoogleError(`Google refused the sign-in: ${message}`, { status: response.status, reason, reconnect: reason === 'invalid_grant' });
  }
  return response.json();
}

export async function exchangeCode({ code, redirectUri }) {
  const tokens = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const granted = new Set(String(tokens.scope || '').split(/\s+/).filter(Boolean));
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || '',
    missingScopes: PHOTOS_SCOPES.filter(scope => !granted.has(scope))
  };
}

export async function accessTokenFrom(refreshToken) {
  const tokens = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  return tokens.access_token;
}

export async function revokeToken(token) {
  try {
    await request(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }, 8000);
  } catch {}
}

async function api(accessToken, path, { method = 'GET', body, headers = {}, timeoutMs } = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await request(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body)
    }, timeoutMs);
    // Google asks for at least 30 seconds after a 429; that does not fit in
    // one run, so a 429 fails the run and the next hour tries again.
    if (response.status >= 500 && attempt < 3) {
      await sleep(800 * attempt);
      continue;
    }
    if (!response.ok) {
      const { message, reason } = await readError(response);
      throw new GoogleError(`Google Photos: ${message}`, { status: response.status, reason, reconnect: response.status === 401 });
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
  throw new GoogleError('Google Photos kept failing.');
}

export async function createAlbum(accessToken, title) {
  const album = await api(accessToken, '/albums', { method: 'POST', body: { album: { title } } });
  return { id: album.id, title: album.title || title, url: album.productUrl || '' };
}

// The album, or null when it is gone or belongs to another app or account.
export async function getAlbum(accessToken, albumId) {
  try {
    const album = await api(accessToken, `/albums/${encodeURIComponent(albumId)}`);
    return { id: album.id, title: album.title || '', url: album.productUrl || '' };
  } catch (error) {
    if (error instanceof GoogleError && [400, 403, 404].includes(error.status)) return null;
    throw error;
  }
}

async function uploadBytes(accessToken, bytes, mimeType) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await request(`${API}/uploads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'X-Goog-Upload-Content-Type': mimeType,
        'X-Goog-Upload-Protocol': 'raw'
      },
      body: bytes
    }, 30000);
    if (response.ok) return (await response.text()).trim();
    if (response.status >= 500 && attempt < 2) {
      await sleep(1000);
      continue;
    }
    const { message, reason } = await readError(response);
    throw new GoogleError(`Google Photos refused the upload: ${message}`, { status: response.status, reason, reconnect: response.status === 401 });
  }
  throw new GoogleError('Google Photos refused the upload.');
}

// Uploads one picture straight into the album, after `afterId` (or first in
// the album without one), so the slideshow keeps its order. Returns the new
// media item. Uploading the very same bytes again returns the same item.
export async function uploadToAlbum(accessToken, { albumId, bytes, mimeType, fileName, description, afterId = '' }) {
  const uploadToken = await uploadBytes(accessToken, bytes, mimeType);
  const result = await api(accessToken, '/mediaItems:batchCreate', {
    method: 'POST',
    timeoutMs: 30000,
    body: {
      albumId,
      newMediaItems: [{ description, simpleMediaItem: { uploadToken, fileName } }],
      albumPosition: afterId
        ? { position: 'AFTER_MEDIA_ITEM', relativeMediaItemId: afterId }
        : { position: 'FIRST_IN_ALBUM' }
    }
  });
  const entry = result?.newMediaItemResults?.[0];
  const item = entry?.mediaItem;
  const status = entry?.status;
  if (!item?.id || (status?.code && status.code !== 0)) {
    throw new GoogleError(`Google Photos did not create the picture: ${status?.message || 'no media item came back'}`, { status: 502, reason: 'BATCH_CREATE' });
  }
  return { id: item.id, url: item.productUrl || '', creationTime: item.mediaMetadata?.creationTime || '' };
}

// Every picture this app has in the album (the API only ever lists the app's
// own), newest first.
export async function albumItems(accessToken, albumId) {
  const items = [];
  let pageToken = '';
  for (let page = 0; page < 10; page += 1) {
    const result = await api(accessToken, '/mediaItems:search', {
      method: 'POST',
      body: { albumId, pageSize: 100, ...(pageToken ? { pageToken } : {}) }
    });
    for (const item of result?.mediaItems || []) {
      items.push({ id: item.id, creationTime: item.mediaMetadata?.creationTime || '' });
    }
    pageToken = result?.nextPageToken || '';
    if (!pageToken) break;
  }
  return items.sort((a, b) => String(b.creationTime).localeCompare(String(a.creationTime)));
}

export async function removeFromAlbum(accessToken, albumId, mediaItemIds) {
  const ids = [...new Set(mediaItemIds.filter(Boolean))];
  for (let index = 0; index < ids.length; index += 50) {
    await api(accessToken, `/albums/${encodeURIComponent(albumId)}:batchRemoveMediaItems`, {
      method: 'POST',
      body: { mediaItemIds: ids.slice(index, index + 50) }
    });
  }
  return ids.length;
}
