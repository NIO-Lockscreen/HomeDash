# Always-on Home Organizer

A clean, minimal HTML home dashboard with:

- Large 24-hour clock/date
- Daily weather + forecast
- Weather effects and hourly weather table
- Featured daily event image card
- Clickable 14-day mini week view when there is no daily task
- Upcoming event cards
- Phone admin mode for adding events
- Image upload to Vercel Blob
- Client-side compression for images over 4 MB before upload
- Event storage in Vercel Blob as JSON
- Optional Google Calendar sync for events created/edited/deleted in admin mode
- Long-press config menu for enabling/disabling Google Calendar sync

## Files

```text
index.html          Static app UI
api/events.js       Calendar API, backed by Vercel Blob JSON + optional Google Calendar sync
api/config.js       Config API for Google Calendar sync settings
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

## Config menu

Hold anywhere on the dashboard/display for about one second to open the config menu. On phone/admin mode, hold on empty space, not inside an input field.

In the menu you can:

- Save the admin PIN on that device
- Enable/disable Google Calendar sync
- Add the shared Google Calendar ID
- Add timezone, for example `Europe/Oslo`
- Paste the Google service account JSON key or base64 JSON key

Google Calendar sync is **off by default**. Vercel environment variables alone will not enable sync until you turn it on in the config menu.

The service account key saved in the config menu is encrypted on the server using `ADMIN_PIN` before being stored in Vercel Blob. You can also keep using Vercel environment variables for the key if you prefer.

## Google Calendar setup

This uses a Google service account because the Surface/phone admin app should not need every user to log in with Google.

1. Go to Google Cloud Console.
2. Create or open a project.
3. Enable **Google Calendar API**.
4. Go to **APIs & Services** -> **Credentials**.
5. Create a **Service Account**.
6. Create a JSON key for that service account and download it.
7. Open Google Calendar in the browser.
8. Create or choose the shared calendar you want this organizer to write to.
9. Open that calendar's **Settings and sharing**.
10. Under **Share with specific people or groups**, add the service account email from the JSON file. It looks like:

```text
something@your-project.iam.gserviceaccount.com
```

11. Give it **Make changes to events** permission.
12. In the calendar settings, scroll to **Integrate calendar** and copy the **Calendar ID**.
13. Open the organizer and hold anywhere on the display to open the config menu.
14. Enter the admin PIN, Calendar ID, timezone, and service account JSON.
15. Enable Google Calendar sync and save.

You can still use Vercel environment variables instead of pasting the key in the menu:

```text
GOOGLE_CALENDAR_ID=your_calendar_id_here
GOOGLE_CALENDAR_TIMEZONE=Europe/Oslo
GOOGLE_SERVICE_ACCOUNT_JSON={...full JSON key...}
```

If Vercel has trouble with raw JSON, base64 encode the JSON file and use:

```text
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=base64_encoded_json_here
```

Only use one of `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`. Redeploy after adding/changing environment variables, then enable sync from the config menu.

## How Google Calendar sync works

- Google Calendar sync is off by default and must be enabled in the config menu.
- New admin events are inserted into the shared Google Calendar.
- Edited admin events update the existing Google Calendar event.
- Deleted admin events are removed from the Google Calendar if the event was originally synced.
- The local Vercel Blob JSON is still used by the display, so the home screen remains fast and stable.
- Events created manually inside Google Calendar are not imported back into the dashboard in this version.

## Local setup

```bash
npm install
cp .env.example .env.local
# Fill in ADMIN_PIN, BLOB_READ_WRITE_TOKEN, and optional Google Calendar variables
npx vercel dev
```

## Usage

- Desktop / tablet display: open `/`.
- Open config: hold anywhere on the display for about one second.
- Phone admin mode: open `/` on phone, or force it with `/?admin=1`.
- Force display mode on any device: `/?display=1`.
- The admin PIN is stored only in that browser's localStorage.
- Images over 4 MB are compressed in the browser before being sent to Vercel. The app converts oversized images to space-saving JPEGs, capped around 1600 px on the longest side and reduced further if needed. Animated GIFs over 4 MB will upload as a still JPEG preview.

## Weather location

Edit this line in `index.html` to change the weather city:

```js
const WEATHER_CONFIG = { name: 'Trondheim', lat: 63.4305, lon: 10.3951, timezone: 'Europe/Oslo' };
```

## New task interaction features

- In admin mode, tap a task card in the Shared calendar list to flip it over.
- The back side shows the note/details entered when the task was created.
- From the back side you can change the date, edit the full task, delete it, or mark it complete.
- Completed one-off tasks are hidden from the big display. Repeating tasks can be completed per occurrence.

## Repeating tasks

When creating or editing a task, use the Repeat dropdown:

- Does not repeat
- Every year, for birthdays and anniversaries
- Every week
- Every other week, for things like DND Sunday

For “every other Sunday”, create the first task on a Sunday and choose “Every other week”.
