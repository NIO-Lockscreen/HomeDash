# Always-on Home Organizer

A clean, minimal HTML home dashboard with:

- Large clock/date
- Daily weather + forecast
- Featured daily event image card
- Upcoming event cards
- Phone admin mode for adding events to a shared calendar
- Image upload to Vercel Blob
- Client-side compression for images over 4 MB before upload
- Event storage in Vercel Blob as JSON

## Files

```text
index.html          Static app UI
api/events.js       Calendar API, backed by Vercel Blob JSON
api/upload.js       Image upload API, backed by Vercel Blob
package.json        Vercel dependencies
.env.example        Local env example
vercel.json         Function settings/security headers
```

## Setup on Vercel

1. Create a new Vercel project from this folder/repo.
2. In Vercel, open **Storage** -> **Create Database** -> **Blob**.
3. Connect the Blob store to this project. Vercel will add `BLOB_READ_WRITE_TOKEN` automatically.
4. Add an environment variable named `ADMIN_PIN` with a PIN you choose.
5. Deploy.

## Local setup

```bash
npm install
cp .env.example .env.local
# Fill in ADMIN_PIN and BLOB_READ_WRITE_TOKEN
npx vercel dev
```

## Usage

- Desktop / tablet display: open `/`.
- Phone admin mode: open `/` on phone, or force it with `/?admin=1`.
- Force display mode on any device: `/?display=1`.
- The admin PIN is stored only in that browser's localStorage.
- Images over 4 MB are compressed in the browser before being sent to Vercel. The app converts oversized images to space-saving JPEGs, capped around 1600 px on the longest side and reduced further if needed. Animated GIFs over 4 MB will upload as a still JPEG preview.

## Weather location

Edit this line in `index.html` to change the weather city:

```js
const WEATHER_CONFIG = { name: 'Trondheim', lat: 63.4305, lon: 10.3951, timezone: 'Europe/Oslo' };
```
