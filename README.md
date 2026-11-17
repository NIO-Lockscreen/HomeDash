# Home Organizer

A Vercel-hosted always-on home organizer with a Surface Pro display mode and a phone admin mode.

## What changed in this version

- Events/tasks are saved to Vercel Blob only.
- Repeating tasks are stored as **one master task** with a repeat rule. The app no longer needs to create many copied tasks for weekly/biweekly/yearly repeats.
- If the server is busy/offline, phone/admin changes are saved locally on the phone first and retried automatically.
- Pending saves are kept in `localStorage` until Vercel accepts them.

## Required Vercel setup

Create/connect a Vercel Blob store, then add this environment variable:

```txt
ADMIN_PIN=your_pin_here
```

Vercel Blob should provide `BLOB_READ_WRITE_TOKEN` automatically when the store is connected to the project.

Redeploy after changing environment variables.

## URLs

Display mode for the Surface Pro:

```txt
https://your-project.vercel.app/?display=1
```

Phone admin mode:

```txt
https://your-project.vercel.app/?admin=1
```

## Offline / busy-server safety

When you create, edit, complete, or delete a task from the phone, the app first stores the change on the phone in a pending queue. It then sends the change to Vercel. If Vercel is busy or the network fails, the task stays in the local queue and the app retries by itself after 15 seconds, then 30 seconds, 1, 2 and 5 minutes, and whenever the phone comes back online, the screen is tapped or the task list is refreshed. The automatic retries stop after that, because each attempt costs Blob reads; a save that is still stuck waits for the next refresh, tap or reconnect.

Open the hidden config menu by holding anywhere on the dashboard/admin screen. It shows the number of pending saves and has a retry button. It also reports tasks that are drawn on this device but that the server has not confirmed yet, so a task can no longer look saved while it is missing everywhere else. It names the app version this page is running and, when they differ, the version the server answered with — a page can sit open on the wall for days after a deploy, and "it is not doing the new thing" is usually just an old page. Reload it. If the server refused a new picture, that is reported there too, with the task it belongs to.

## How concurrent saves are kept safe

All tasks live in one shared `events.json` in Vercel Blob, so every save is a
read-modify-write of the whole file. Three things keep two devices saving at
once from erasing each other:

- **Every read is checked against the store.** The Blob URL is CDN-backed and
  the path is reused on every overwrite, so for up to a minute after a save the
  CDN can still hand back the older copy of `events.json`. A unique query string
  does **not** get past it: the Blob CDN leaves the query out of its cache key
  (measured: `?v=<random>` comes back as a cache HIT with the same age). So every
  read is compared against `head()`, which answers from the Blob API rather than
  the CDN. The byte length has to match, and so does the store's ETag (an MD5 of
  the content). Length alone used to let a same-length older copy through —
  moving a task from 10:00 to 11:00 keeps the length — and a save built on it
  silently undid that move.
- **A write is never built on a replayed copy.** If a read cannot be confirmed
  as current, the save answers `503` instead of rewriting the whole file from an
  old snapshot. That one rule prevents the worst failure this app can have:
  rewriting `events.json` without the tasks and pictures added since the copy
  was made — and it also stops a `404 Event not found` for a task that plainly
  exists, which the phone would treat as permanent and drop the edit.
- **Writes are confirmed against the store, not against a cached read.** After
  each write, `head()` is asked whether the stored file is the exact document
  just written (same byte length and same MD5 ETag). If it is, the write is
  done — no CDN read involved. Otherwise the
  document is read back, and the answer is one of three, each handled
  differently:
  - the change is there → done;
  - a **newer** document is stored without the change → another device really did
    overwrite it, so the change is re-applied on top of the winner, up to three
    times;
  - every read still answers with a copy **older** than the write → nothing has
    replaced it and only the reading side is behind. The write stands. This used
    to answer `503 "another device saved at the same time"` for a change the
    server had in fact stored, which left it queued on the phone forever, and
    every later change stuck in the queue behind it.
- **A failed read never becomes a write.** Blob trouble answers `5xx` rather
  than overwriting the file with a guess, and only genuine validation problems
  (missing title or start) answer `4xx`.
- **One stuck change does not hold up the others.** When the server refuses a
  change, the phone keeps it queued and moves on to the other tasks in the
  queue; only further saves of that same task wait for it. A genuine network
  failure still stops the pass, since nothing else would get through either.

If a task still goes missing from the server shortly after it was accepted, the
device that created it notices on its next fresh read and sends it once more.
Past a ten-minute repair window it assumes the task was deleted from another
device and stops drawing it, so a delete is never resurrected.

## Repeating tasks

Repeating tasks use these fields on the single master event:

```json
{
  "repeat": "weekly",
  "completedDates": ["2026-05-10"],
  "excludedDates": ["2026-05-17"]
}
```

The browser expands those into temporary occurrences for display only. The server keeps just the master task.

## New in cleanup/refresh version

- Event images are **no longer deleted the moment** a task is deleted or its picture replaced. The reminder cron (`/api/reminders-cron`, twice a day) sweeps images that no task has referenced for **7 days**, tracked in `home-organizer/image-sweep.json`. A picture lost to a bad save therefore stays in the Blob store for a week: find it under `home-organizer/images/` in the Vercel Blob dashboard and paste its URL into the task's image field. The sweep never deletes anything when `events.json` cannot be read, and never deletes an image uploaded less than 7 days ago.
- A device holding an older copy of a task (it marks it done, moves its date, adds a reminder) can no longer swap that task's image for the old one it remembers, or clear it. It may still set a genuinely newer upload, so a resync from that device works as before.
- Display mode loads cached tasks instantly, then performs one fresh server refresh on page boot and at midnight, and picks up changes from other devices through the version marker (see **Keeping every screen in step** below).
- Desktop admin mode shows a large **Back to normal view** button so you can return to the Surface display after editing.
- If admin and display are open in two tabs on the same device, the display tab is notified immediately after a successful save. Across different devices the version marker carries the change (see below).

## Keeping every screen in step

Every save the server confirms also rewrites a tiny marker,
`home-organizer/events-version.json`, holding the stamp of the stored task list.
Every open screen reads that marker straight off the Blob CDN every 30 seconds
(and when it wakes, comes back online, is tapped, or the camera dimmer sees
someone). Only when the marker has moved does it read `/api/events`.

Why this costs nothing against the Hobby limits:

- The marker is uploaded with a 30-day cache life, so while nothing changes the
  CDN answers from its cache and the browser gets a `304`. Blob does not bill a
  cache HIT as an operation; it only counts as a CDN request (Hobby includes a
  million a month; one screen polling every 30 seconds is about 86,000).
- Overwriting the marker purges the CDN copy, so a change reaches every screen
  within about a minute: one billed cache miss on the marker, plus one task-list
  read per screen.
- `events.json` itself keeps its short cache life on purpose. The save path reads
  it through the same CDN, and a purge that went missing must not be able to
  hold a stale copy there for a month.

The timed reads stay as a safety net, but while the marker is being read the
hourly one only actually runs every few hours, and a tap only looks at the
marker unless the last full read is more than 15 minutes old.

When the server can only get the CDN's older copy of the task list it says so
(`fresh: false`). The screen keeps what it has and asks again after 15, 30 and
60 seconds, instead of showing the old list and refusing to read again for a
minute — which is what used to make a tap right after a change on the phone
show nothing.

Every request the screens make is time-limited. One that never answered used to
leave the screen believing a refresh was still under way, and from then on it
never refreshed again until somebody reloaded it.

The marker does not exist until the first save after this is deployed. A screen
that finds it missing asks the server to create it and falls back to timed reads
for half an hour.

The wall display also reloads itself after a deploy, once it is back on the home
view and nobody has touched it for a minute, so fixes reach it without anyone
reloading it by hand. It does not do this while the page is in browser
fullscreen (double-press on the clock), since a reload would drop fullscreen;
the config menu says a reload is due instead. Fullscreen started by the browser
or a kiosk mode is not affected.

The config menu shows whether live updates are working and when the last full
read was.

## Daughter periods are shared

The blue daughter periods in the month view, and every change to them, used to
be stored only on the device they were made on, so a period moved on the phone
never reached the wall display. They are now stored in `events.json` next to the
tasks (as `daughterPeriods`), so every refresh a screen already does brings them
along without an extra Blob read, and the marker carries their changes too.

- Each edit (move, delete, reset, add) is sent as one change and applied to what
  the store holds, so edits to different periods from two screens both survive.
- Edits go through the same pending queue as task saves: shown at once, kept on
  the device until the server has them. Saving needs the admin PIN, like
  completing a task on the display.
- The first time a device loads this version, its old device-only edits are
  sent to the server once. They only fill periods the server has no entry for,
  so a screen that is reloaded days late cannot overwrite newer edits made
  elsewhere. A device without the PIN saved keeps its old edits until it has
  one.
- **Delete all tasks/events** clears tasks only; the periods are kept.


## Resyncing a stuck image

Sometimes one task keeps showing the calm placeholder while every other task
shows its photo. The editor has a **Resync image** button under the image field
for that. It only appears while editing a task that already exists.

What it does:

1. Takes the photo you picked in the file field. If you did not pick one, it
   downloads the photo the task currently points at, cache-busted, so it works
   from whatever Blob storage really holds right now.
2. Uploads it to `/api/upload?force=1`. A forced upload **skips the
   reuse-by-content shortcut** and writes a brand new path, so the picture comes
   back on a link nothing has cached.
3. Saves the task with the new link and waits for the server instead of handing
   the change to the background queue, then reads back what the server kept.
4. Reports one of three outcomes: confirmed, still queued (server busy — it
   retries by itself), or the server refused the link.

Why the forced upload matters: a normal upload hashes the file and reuses the
existing blob for identical bytes. Re-uploading the same photo therefore returns
the *same* URL — which is useless when the URL itself is the problem (the blob
was deleted and re-created at that path, or a CDN/browser is holding a stale copy
behind the one-year cache header). That is why uploading the same picture again
never fixed the last stuck image, and why a resync mints a fresh path.

If the stored image cannot be downloaded at all — it was deleted from Blob
storage — the button says so. Pick the photo again in the file field and resync;
that path does not depend on the dead link.

## Fysio, lege and MR tasks borrow an old photo

The physio, the doctor and the MR scanner come round again and again, and nobody
wants to pick a photo for the twentieth one. So a task whose title names one of
these and that is saved **without** an image is given a random picture from an
older task of the **same kind**, instead of the calm placeholder.

- **Which titles count:** `fysio`, `lege` and `mr`, case and accent insensitive.
  `fysio` and `lege` count inside a longer word at either end, because that is
  how they are written down: `Fysioterapi`, `Fysioterapeut`, `Tannlege`,
  `Legetime`, `Legevakt`. A word that only happens to end in one of them
  (`college`, `privilege`) does not. `mr` is two letters, so it only ever counts
  as a word of its own — `MR`, `MR-time`, `MR undersøkelse`, and `MRI` — never
  the inside of some unrelated word, so `Mrs` and `Mormor` are left alone.
- **Kinds never lend to each other.** A fysio task is only ever given a fysio
  photo, an MR task an MR photo. If that kind has no photo yet, the task gets the
  placeholder: that is the better wrong answer. Kinds used to lend to each other
  so the first ever fysio task could show a lege photo — and that one borrowed
  photo then sat on a fysio card, was read back as a fysio photo, and was handed
  to every fysio task after it.
- **A picture you pick always wins.** The borrow only ever fills an empty slot;
  nothing decided by the upload, by the task's stored image, or by the
  stale-device rules is overruled by it.
- **Which photo:** a random one from the same kind, preferring a photo somebody
  actually chose over one that was itself borrowed, so a single picture cannot
  take over every card.
- **The framing travels with it.** Pan, zoom and the focus box come from the task
  the photo was borrowed from, which is the framing somebody once chose for that
  picture.
- **Only live links.** The picture is checked against Blob storage before it is
  handed on, so a task never inherits a dead link.
- The borrowed picture is stored on the task like any other image, so it stays
  put on later saves. Upload a photo for the task and the borrowed one is
  replaced. The editor says which is which under the image field.

### What a borrowed picture remembers

`imageInheritedFrom` records the task the picture came from, and
`imageInheritedKeyword` which kind it is. The kind matters because a borrowed
photo keeps the kind of the task it came from, whatever the task carrying it is
called: a fysio card showing a lege photo is holding a **lege** photo, and
lending that on as a fysio photo is exactly how one stray picture reached every
fysio card. Both marks live and die with the image they describe — a task that
gets a picture of its own loses them.

Pictures borrowed before the kind was written down are traced back through
`imageInheritedFrom` instead. An origin that can no longer be established — the
task it came from was deleted — is treated as unknown: the picture stays where it
is, but it is never lent on.

A borrowed picture of the wrong kind is let go on the task's next save, and the
slot is filled with a photo of the right kind, or left to the placeholder. Only
ever a borrowed one: a photo somebody chose is never taken away. Until that save
the card keeps showing it, and the editor says so under the image field.

The rule lives in `api/_image-rules.js` (`autoImageKeyword`, `autoImageKindOf`,
`isMismatchedBorrowedImage`, `pickAutoImage`) and is applied by `api/events.js` to
whatever any device sends. The admin page holds a copy of the same rule so a task
saved on the phone draws its borrowed picture straight away rather than a
placeholder that swaps out a second later, and so a task saved with no signal
still gets one. Keep the two in step.

## Face-aware image cropping

When you upload a task image, the admin page tries to detect faces in the browser and saves a simple focus point with the event. The dashboard then uses that focus point for daily, selected, upcoming, and admin thumbnails so faces are less likely to be cropped out.
## Email reminders

This version adds email reminders without adding a separate database.

### What is included

- The task editor has a **Use email reminders** checkbox.
- Recipients are hardcoded to **Therese** and **Thomas**.
- You can choose Therese, Thomas, both, or none.
- The selected recipients are saved onto the task in Vercel Blob.
- The server sends a task-created email through Resend when a new task is created, then schedules the task-day reminder.
- A daily `/api/reminders-cron` job refreshes the schedule so repeating/future reminders stay covered.

### Required environment variables

Add these in Vercel → Project → Settings → Environment Variables:

```txt
RESEND_API_KEY=re_your_resend_api_key
REMINDER_FROM=Home Organizer <reminders@yourdomain.com>
CRON_SECRET=make-a-long-random-secret
ORGANIZER_TIME_ZONE=Europe/Oslo
```

Keep your existing variables too:

```txt
ADMIN_PIN=your_pin_here
BLOB_READ_WRITE_TOKEN=created_by_vercel_blob
```

### About the sender address

Resend requires a verified sending identity/domain for reliable sending. Use your verified domain in `REMINDER_FROM`, for example:

```txt
REMINDER_FROM=Home Organizer <reminders@reminders.yourdomain.com>
```

For quick testing, Resend accounts often allow sending to your own verified account address, but family reminders should use a verified domain.

### How reminders work

1. You create or edit a task.
2. You tick **Use email reminders**.
3. You select Therese, Thomas, or both.
4. The task is saved to Vercel Blob.
5. The Vercel API sends a task-created email now.
6. It schedules another reminder for 08:00 on the task day.
7. If the task starts before 08:00, it schedules the reminder for 12:00 the day before with “Remember this task early tomorrow”.
8. The daily cron checks all tasks again and schedules upcoming repeating reminders.

The cron in `vercel.json` runs once per day:

```json
{
  "path": "/api/reminders-cron",
  "schedule": "22 3 * * *"
}
```

That works with Vercel Hobby. The exact delivery time is handled by Resend scheduled emails, not by the once-per-day Vercel cron.

### Manual cron test

After deploying, open this URL in your browser, replacing the domain and secret:

```txt
https://your-project.vercel.app/api/reminders-cron?secret=your_CRON_SECRET
```

A good response looks like JSON with `ok: true`.

## Blob efficiency changes

This version is tuned to use far fewer Vercel Blob operations:

- The dashboard no longer polls `/api/events` every 10 seconds, 10 minutes, or 2 minutes. It watches the version marker on the Blob CDN instead, which is free while nothing changes.
- Events are cached in `localStorage`, so the screen renders instantly from the last known calendar and keeps working if Blob/API is temporarily unavailable.
- On page boot the app now performs one fresh `/api/events?fresh=1` read so loading/reloading the dashboard gets the newest server data.
- After boot, fresh reads happen when the version marker moves, at midnight, and as a few-hourly safety net. Interactions are debounced and only look at the marker unless the last full read is old.
- A save of a task with no email reminders (before or after the save) skips the reminder bookkeeping, which used to cost a Blob read and a Blob write on every save. The reminder state is also no longer rewritten when a sync changed nothing.
- The display re-renders locally every minute so date/time/day changes still update without calling Blob.
- Normal `/api/events` reads still use short API/CDN caching and a small in-memory cache per serverless instance. Fresh boot/midnight reads bypass that cache on purpose.
- Uploaded images are optimized before upload, usually targeting about 650 KB instead of allowing multi-megabyte photos.
- Re-uploading the exact same image now reuses the existing Blob URL by hashing the file instead of creating duplicates.

## Picking a day on the display

Tapping the clock opens the day selector in the left card. Picking a day there shows that day's task in the big hero panel on the right, and the selector **stays up** with the picked day outlined, so the next day is one tap away. The task is deliberately not repeated in the left card. If a day holds several tasks the selector shows the count and the hero cycles through them; flipping the hero gives complete / edit / delete for whichever one is showing. Tapping the clock again returns to today and brings the weather back.

## YouTube from your phone

The wall display has a hidden panel by the clock. A slim handle sits on the left
edge of the screen, level with the clock: pull it to the right and the panel
slides out, like Android's edge panel. A tap on the handle only nudges the panel
out and back to show that it wants pulling, so a stray touch on the edge opens
nothing. Tap beside the panel or push it back left and it slides away again. Leave
it for ten seconds, or pull it on to the right until it comes off, and it goes up
in a mini nuke (see *The mini nuke* below).

The pull does not have to start on the very edge. The grab area is 112px wide
and about a third of the screen tall, so the finger can start well inside the
screen: a swipe that starts right on the edge is taken by Windows (Widgets /
Task View) and never reaches the page. Past the first 30px the grab area lies
over the clock, so a tap there (no pull) is handed on to the clock, and its tap
and double tap still work right up to its edge. Only a tap on the grip itself
peeks the panel.

The panel has one button, **YouTube**, which shows a QR code. Scan it and the
phone opens a small page (this same site with `?ytsend=<session>`) with a field
for a link. Paste a YouTube link — watch, youtu.be share, Shorts, live or
playlist, with any `t=` start time kept — and tap **Play on the wall screen**. The
wall closes the QR code and plays the video in YouTube's own player. **Another
video** shows a fresh QR code while the current video keeps playing underneath;
the × closes the player.

- **How the link travels.** Through [ntfy.sh](https://ntfy.sh), a free, no-signup
  pub/sub relay — the same one the car lockscreen uses. The phone posts the link
  to a topic named after the session, and the wall holds one open stream
  (`/sse`) to that topic while the QR code is up. Nothing goes through Vercel, so
  a video costs no Blob operations and needs no admin PIN.
- **Why a stream and not polling.** ntfy limits requests per address, and at home
  the wall and the phone share one. Polling every few seconds would spend the
  allowance the phone needs to send its link. If ntfy refuses a send anyway
  (`429`), the phone says so and the button can be tapped again.
- **Who can send.** An ntfy topic is public. The session id is 64 random bits, a
  new one for every QR code, the wall only listens while that code is up, and it
  only plays YouTube links — it checks the link again itself rather than trusting
  the phone. The worst a stranger who guessed a live id could do is put a YouTube
  video on the screen.
- **Idle.** A playing video is not an idle wall: while it plays it keeps both the
  five-minute idle reset and the camera dimmer away, since nobody touches the
  screen while they watch. Paused or finished, the usual five minutes apply and
  the idle reset closes it. A QR code left up closes the same way.
- **What it loads.** The QR library (from jsDelivr) and YouTube's IFrame API are
  only fetched the first time they are needed. The IFrame API is used instead of
  a bare embed because the wall has to know whether the video is playing. Some
  owners forbid playing their videos outside YouTube; the player says so instead
  of showing a black box.

### The mini nuke

A panel left open wiggles loose, its YouTube icon glowing and spitting sparks like
a lit fuse, hops off its dock and tumbles off the bottom of the screen trailing
smoke. Pulled on to the right past open, it comes off the same way at the finger's
speed. Where it leaves the screen it goes off:

- A white flash lights the whole screen and fades to a warm orange glow.
- A fireball swells at the bottom edge and rises into a mushroom cloud. The cap
  rolls over on itself like a real one (a vortex ring: puffs carried up the
  middle, out over the top and down the outside), its underside lit by the fire
  below, cooling from orange through brown to grey. The stem draws dust up from
  a flared base, and a white condensation collar flashes round it.
- A shock ring races out from the blast across the whole screen. It is what hits
  the weather card (see *The nuke's shock wave* under *Weather effects*).
- Dust rolls out along the bottom edge both ways.
- Embers and pieces of the panel fly out: frosted bits of the tray, red bits of
  the YouTube icon and its white play triangle. The biggest trail smoke.
- The dashboard shakes hard and rumbles out over about a second and a half; the
  weather's pop-out layer shakes with it so it stays on the card.

**The picture cards rattle.** Pulling the panel out *primes* the photo cards:
each card in the Upcoming strip becomes a small 3D object (the card is its front;
plates behind it give it a card-stock edge about 7px thick and a back like the
back of a mounted photo; a light and a shade in front of it follow its tilt), and
the cards lift a little off the strip. When the nuke's shock ring reaches a card,
it is hit away from the blast, harder the closer it went off: it is shoved and
pops towards you, the side that was hit lifts like a playing card in a gust, it
spins about the corner the ring reached first and chatters against the strip,
and springs settle it back in a second or two. A card right over the blast is
thrown up and tumbles over, showing its back, before it lands with a bounce and
rattles. The big task photo (when one is up) only rocks. The strip stops
clipping its cards while they are primed, so a thrown card can fly out over it.

Priming is what keeps this free in everyday use: until the panel is pulled out
the cards are plain flat elements, with no extra elements, layers or animation
loop. A moment after the panel goes away without going off, or once the cards
have settled after a nuke, they are lowered and taken apart again. The rattle
itself only moves and fades composited layers. The Q panel's nuke buttons
rattle the cards too (they prime them on the spot).

It is all drawn on one canvas in the edge panel's layer, in front of the
dashboard, and takes about four seconds. The handle comes back after about three,
as the cloud clears. With reduced motion the panel just slides shut. The cloud
scales with the screen height, so it looks the same on any screen.

### A new task drops in

When a task this screen has not seen before loads into the Upcoming page on
show (saved on the phone, in another tab, ...), it is not just drawn there: it
drops in.

- The cards become the same small 3D objects the nuke rattles. The new card
  falls out of the air towards its slot from a little above it, swinging
  through flat once and turned a little, fastest just before it lands. Its
  shadow sharpens under it as it comes down.
- It lands with a thump: the nuke's shock ring, smaller and quicker, runs out
  across the strip. It starts as the card's own rounded outline and rounds off
  into a circle as it grows. A little dust puffs out from under the card and
  the dashboard jolts.
- The cards that have to make room are shoved along into their new places,
  nearest first. On a full page the last card goes over the end of the strip,
  tips over its edge and drops away (it is on the next page now).
- The ring hits every card as it reaches it, like the nuke's only softer: the
  card is pushed away from the landing, its near side lifts, it chatters, and
  springs settle it back. Then the cards are taken apart again, as after a nuke.
- More than one new card at once (a new repeating task, say) land one after
  another, 0.4 s apart.

**What counts.** Only a task whose id this screen has not seen, and only when it
lands on the page on show. Paging, the minute tick, a resize, an edited task
that moved, or a repeat coming into range redraw the strip as before. Counting
starts with the first fresh list from the server, so a reload never drops its
whole list in, and a task added while the screen was dimmed is simply there when
it wakes. Nothing moves while the page is hidden, the camera dimmer has dimmed
the screen, an overlay is up, the nuke is going off, or with reduced motion.

The ring runs on over the weather card and hits it just as the nuke's does (see
*The nuke's shock wave* under *Weather effects*): water torn off as spray, snow
scoured away, mist blown off, clouds, sun and moon knocked aside. It sets off
from the point of the landed card nearest the weather card, so the card is hit
just as the drawn ring reaches it, and a card landing right under it hits it
hardest. New tasks are rare, so the sky can afford it.

While the cards are moving the strip is not redrawn for nothing (a sync always
redraws it twice in a row, which used to throw away whatever was on it); a
change that really alters the strip puts the cards straight down first.

### Card shadows

While a card is in the air (the nuke's rattle, a card dropping in) the room
light casts its shadow on the strip. It is not a blurred square trailing the
card: the card's face, turned and tilted as it is, is projected along the light
onto the strip, so the shadow is the card's real outline there. It narrows to a
sliver as the card stands on edge, swings round and stretches as the card flips
over, slides out from under it and spreads and pales as it rises, and tucks
back in under it as it lands. While its card is down it lies under every card;
while its card is up it lies over the ones resting on the strip, so a card
thrown over its neighbour shades it. The card's own drop shadow, which sticks
to it wherever it goes, is dropped meanwhile (Sofia's pink ring stays).

It costs two blurred layers per card, which only move and fade (both done by
the compositor), built when the cards take off and removed once they settle.
The Q panel can turn it off (*Card shadows*), which the screen remembers.

### The backs of the cards

A card thrown over by the nuke (or turned over by the Q panel's test) shows its
back. There are five designs, picked in the Q panel under *Back of the cards*
and remembered on the screen:

- **Blurred** (the default): the photo on the front coming through the paper
  from behind, blurred and washed out, a little brighter in the middle as if
  lit through. It is the front image itself, not turned round, so a card turned
  over shows it the way a print held up to the light does: mirrored left to
  right when it turns over sideways, upside down when it turns over end to end.
  It is framed like the front (the photo's focus point and zoom).
- **Card stock**: the back of a mounted photo (the first design).
- **Photo paper**: off-white, with *HOME ORGANIZER · PHOTO PAPER* printed over
  it in faint slanted lines.
- **Playing card**: a white border round a red panel with a fine lattice and a
  little house in the middle.
- **Postcard**: the task's time and title written by hand on the left, a stamp,
  a postmark and address lines on the right. On Windows the handwriting is
  Segoe Print.

The printed designs face outwards from the back, so they read the right way
round on a card turned over sideways, and upside down on one turned over end to
end, as a real card would. The back is lit like the front as it turns: brighter
turned towards the light, darker turned away. Like the rest of the 3D card, the
back only exists while the cards are primed.

## Sofia's tasks

A task that names Sofia gets a pink glowing ring and hearts floating up around it.
"Names Sofia" means the word *Sofia* in its title, place or note, in any case, and
also *Sofias* or *Sofia's* (so "Sofias bursdag" and "Hente sofia" count), but not
a longer word that only starts with it (*Sofiahallen*), nor *Sofie* or *Sophia*.

- **On an Upcoming card**: a pink ring with a softly pulsing glow, and eight
  hearts that float up and sway around the card's edges. The card itself clips
  what is inside it, so the hearts sit in a separate layer laid over the card's
  place in the strip and reaching a little past it. While the cards rattle after
  the mini nuke, the hearts step aside and come back once the cards settle.
- **As the big task photo** (a featured task today, or one picked from the strip):
  the ring outside, and a pink glow and hearts rising inside the photo along its
  bottom and sides.
- **On the phone's tent slides**: the glow and hearts inside the slide.
- **In the admin list**: the ring and a small heart after the title.

It is all CSS: only opacity and transform animate, so it runs on the compositor
and costs next to nothing. It pauses while the camera dimmer has dimmed the
screen, and with reduced motion the glow is steady and the hearts stand still.

## Tent view on the iPhone Duo

Fold the iPhone Duo shut and stand it up like a tent, so its outer screen is
landscape, and HomeDash turns into a full-screen slideshow of the **next 7
tasks** with their photos — the same one the car lockscreen opens. Swipe left
and right between them, or leave it and it moves on every 30 seconds. Turn the
phone upright or open it and the page underneath is back exactly as it was.

- **Which tasks.** The next seven in start order: what is on now, then what is
  coming. Finished ones drop off (a task without an end counts as one hour long),
  so do completed ones, and frequent repeats appear no further ahead than the
  wall display shows them. Each occurrence of a repeat is its own slide.
- **Photos.** Framed exactly like everywhere else in HomeDash (focus point and
  zoom from the editor). A task without a photo, or with one that is gone from
  Blob storage, gets the calm placeholder.
- **How only the outer screen gets it.** Both Duo screens are the same shape,
  about 1:1.45. Opened, the inner screen is as tall as the outer one and twice
  as wide, so held normally it is landscape too, and it can be drawn at the
  outer screen's size. It turns on only when all of these hold:
  - **this is an iPhone Duo**: the browser says iPhone, and the physical screen
    (`screen.width`/`height`) is phone-sized and between 1:1.34 and 1:1.6.
    Either Duo screen passes; other iPhones are long and thin (about 1:2.17).
    The reported screen is trusted only this far: after the phone is folded or
    opened it can go on describing the screen that was left until a reload;
  - the **window is at most 2350 real pixels wide**: the outer screen is 2034
    across in landscape, the inner one 2670, however large those pixels are
    drawn. The window and pixel ratio always describe the screen in use now;
  - the **window fits on the reported screen**: a page on the inner screen that
    is still told the outer screen's size is wider than it;
  - the **phone itself is turned on its side** (90° or 270°). A tent is the
    folded phone stood on its long edge; opened and held normally the phone is
    upright, even though its inner screen is wider than tall;
  - the window is wider than tall.
- **Rotation protection.** Turning, folding or opening the phone is a burst of
  events, and for a moment the window, the pixel ratio and the turn angle can
  disagree. Acting on such a moment could flash the slideshow onto the inner
  screen during a turn, and a change that came without an event (or with its
  event ahead of the new readings) was missed. Now:
  - the slideshow only comes up once the same readings have held for 0.7 s, and
    goes away on the first reading that says no;
  - on a Duo the readings are also taken every second, not only on resize,
    turn, pixel-ratio change and return to the page;
  - the slides are placed in percentages of their own width and re-placed by a
    `ResizeObserver`, so a size change cannot leave the next photo peeking in.
- **Rotation lock** has to be off on the phone, or the page never turns to
  landscape. Added to the home screen, HomeDash runs without Safari's bars and
  the slideshow fills the whole screen.
- **The screen stays on** while the slideshow is up (Screen Wake Lock), since the
  phone stands on the table untouched. It is let go as soon as the phone is
  turned upright.
- **Swiping.** A swipe that starts while the previous slide is still settling
  (or while the slideshow is moving on by itself) carries on from the slide that
  was arriving. It used to be able to reach only the slide already in view, so a
  quick second swipe seemed to get stuck. The car lockscreen had the same fault
  and has the same fix.
- **Checking a phone.** The config menu (hold anywhere) has a *Tent view* line
  with what the phone reports now (screen size and shape, pixel ratio, window
  size and its width in real pixels, how far the phone is turned), followed by
  the last six times the slideshow came up or went away, each with what was
  read at that moment. The list is kept per tab, so it survives a reload. If a
  screen is ever recognised wrongly, that line is what the check needs to be
  adjusted to.
- **Preview or switch off.** `?tent=1` shows it on any screen held in landscape,
  so it can be looked at on a PC; `?tent=0` keeps it off. Neither is remembered.

### Phone calendar on the outer screen, held upright

The phone calendar uses the outer screen's full width. iOS reports about 84px
of unsafe area down the outer screen's right side for its status icons, although
they only take the top corner. Padding the whole page by it left an empty strip
down one side. The phone layout's `padding` also had the left and right insets
swapped, so the strip ended up on the left. The sides are now the right way
round, and in portrait the page ignores the side insets (other iPhones report
none upright). On its side, the insets still keep the page clear of the island.

## Weather effects

The whole dashboard lives in `index.html` — the `<style>` and `<script>` blocks inside it are what the browser runs. There is no separate bundle to edit. (Two exported copies, `script.js` and `inline.js`, used to sit next to it; nothing loaded them, and two bug fixes were accidentally applied only to those copies and never reached the app. They have been deleted — put dashboard changes in `index.html`.)

The weather card paints an ambience layer (`#weatherEffect`) behind the readout:

- Every condition gets a full-card colour wash, so rain, snow, fog, sun and thunder are recognisable from across the room. The wash is on in both layouts — previously the effects were invisible whenever a task was showing.
- Particles are generated per condition: rain streaks and ground splashes, swaying snowflakes at three depths, drifting fog banks, layered clouds, a sun with a corona and slow rays, a moon with a star field, and lightning with a full-card flash.
- Day/night comes from Open-Meteo's `is_day`. At night the card swings dark and the readout flips to light text (`.wx-dark`).
- Wind above 7.5 m/s adds gust streaks and appends the speed to the description line.
- Particles move in container-query units so they cross the card itself, and they are only rebuilt when the sky actually changes — the minute-by-minute re-render no longer restarts every animation.
- `prefers-reduced-motion` keeps the wash and static sky but drops everything that moves.

### Weather that leaves the card

Every sky now has something that leaves the weather card. Four canvases, drawn
by one animation loop (`weatherFx` in the script), sit on top of the CSS sky:

- `#weatherFx` is inside the card, in front of the readout. Water and snow on it
  stop just below the lowest line of text that is fully on the card, so the
  readout stays dry. (Behind the frosted hourly table they could hardly be seen.)
- `#weatherSpill` lies in the dashboard frame, over the weather card but under
  every other card (clock, photo, Upcoming), and is clipped so it only ever
  paints outside the weather card. Something crossing the card edge is drawn on
  both, so it leaves without a seam, and fades out over its first 16px under a
  neighbouring card: it slides *under* the photo or the clock.
- `#weatherPop` is fixed over the whole window, in front of every card but under
  the overlays, the edge panel and the screen controls. It holds what stands
  *out* of the card over its border, the old out-of-bounds trick: drawn across
  the border, with a soft shadow on whatever lies behind it, an object seems to
  stand out of the card towards you.
- `#upcomingFx` is inside the Upcoming strip, between its background and its
  content. Water and snow that spill over the strip's top edge run down here,
  behind the title and under the photos.

What each sky does:

- **Clear, day**: the sun is a glowing ball that bulges out of the card's top
  corner, its long beams slowly turning and shining on over the clock and the
  photo. Every half minute or so a lens flare shoots out: a bright streak
  across the dashboard, a starburst on the sun, and a chain of coloured ghosts
  down the line through the card and out the other side.
- **Clear, night**: the moon (shaded, with craters) floats out of the corner,
  casting a soft shadow; every 12 to 24 seconds a shooting star streaks out of
  the card and over the next card.
- **Partly cloudy**: the sun or the moon, with a puffy cloud in front of it that
  hangs over the top edge, and a small cloud over the other corner. Flares and
  shooting stars come less often.
- **Cloudy**: clouds hang over a top corner, the top edge and the side facing a
  neighbouring card, drifting slowly, each with a shadow on whatever is behind
  it. About once a minute a small cloud breaks off and drifts away over the
  next card. Clouds are kept clear of the temperature and its icon.
- **Fog**: the card stands in a bank of mist. Many soft puffs, each lit from
  above (pale on top, cool grey underneath), ride a slow, turbulent flow, so
  the mist curls rather than slides. Cold mist sinks: it spills over the card's
  bottom edge like dry ice over a shelf, drops into the gap, pools on the
  Upcoming strip's edge and creeps along it, and about a third of it curls on
  over the front of the strip and fades. Wisps also slip out of the card's
  sides and drift over its top. The puffs are gathered in a small
  low-resolution buffer and laid over the dashboard slightly blurred, so they
  merge into one soft bank instead of showing as separate blobs. Over the
  readout itself the mist thins out, so the text stays legible. At night it is
  a pale, moonlit blue, since the frame around the card stays light.
- **Wind** (any sky): streaks blow out of the card's side, towards the
  neighbouring card.

- **Rain and drizzle** fill the bottom of the card with water: a surface seen
  from just above, rings where the drops land, the odd splash and bubble, slow
  light shafts. Full, it trembles for three seconds and then springs two or
  three leaks. Thin streams pour out of the bottom edge, where the surface dips
  over each hole, and land on the top edge of the Upcoming strip (see *The
  Upcoming strip as a ledge* below).
  On the outside, drops fall onto the card's top edge and splash, beads of
  water sit on it, and every 9 to 18 seconds (drizzle: 16 to 30) a drop runs
  down one of the card's sides in fits and starts, leaving a wet trail, and
  drips off the bottom. Water drains with the
  square root of its depth, so the streams slow down, break into drips, and
  leave beads hanging under the card that drip for about half a minute. A
  dotted tide mark shows where the water stood and dries up. Steady rain takes
  about three minutes to fill the card (heavier rain faster, drizzle about
  twice as long); the leak takes about twenty seconds.
- **Thunder** is rain, plus each lightning flash brings a branching bolt that
  strikes from above the card, over the border, down into the water, where it
  splashes. The frame around the card lights up with the flash. The card's own
  cartoon bolts are hidden while this runs.
- **Snow** piles up on the bottom of the card (lumpy, banked up at the sides,
  with the odd glinting crystal). Once full, part of it sifts out through the
  bottom edge in a powdery fall. Every few seconds a flake falls out of the
  card, and every half minute or so a gust blows a few out sideways, towards
  the photo (or towards the clock, when no task is shown) and under it. Wind
  banks the pile up on one side and blows more flakes out.
  On the outside, a cap of snow grows on the card's top edge with a shadow
  under its overhang, icicles grow from the bottom edge and drip, and large,
  soft, out-of-focus flakes fall past the card's sides as if close to the eye.
- **Fog** pours over the bottom edge as a grey haze that pools under the card.
### A few particles leak out

The card's own CSS rain drops and snowflakes are cut off at its border, but
about one in a hundred of the ones that reach it is not. The rate is worked out
from the particles actually animating in the card (each one's fall time), so it
stays at 1% whatever the sky: roughly 20 to 35 drops a minute in rain, 8 in
drizzle, 2 to 4 flakes a minute in snow. Each leaker copies the size, length,
slant, speed and sway of a randomly picked live particle and is drawn on the
spill layer, outside the card only, so it seems to pass through the border
rather than appear at it.

- Drops fall out of the bottom and splash on the Upcoming strip. The gap there
  is short, so about a third slip out of a side instead (mostly the left, as
  the rain drifts left), nudged outwards, and fall the whole way down beside
  the card. Outside, on the pale frame, they are drawn in the day colour even
  at night, or they would not show.
- Flakes drift out of the bottom onto the Upcoming strip's heap, or sway out
  over a side and slide under the next card.
- In the Q panel, *Leak now* / *Spill snow now* also sends five of them at once.

### The Upcoming strip as a ledge

Water and snow that fall out of the bottom of the weather card land on the top
edge of the Upcoming strip instead of vanishing under it.

- **Water** splashes where it lands and gathers along the edge in a thin film
  that bulges over the edge and spreads sideways. Where the film gets thicker
  than about 1.6px it floods over and runs down the face of the strip as a
  sheet, behind the *Upcoming* title and on under the photos (it shows again in
  the gaps between them):
  - Each spill fans out along the edge as it goes over, and comes down the
    face as a curtain with a rounded head that swells and creeps where it meets
    dry strip. Thick water runs faster and spreads; thin water drifts towards
    the face's faint grooves (a fixed, gently wandering pattern, new on every
    visit), so a sheet gathers into streams that wander a little and merge. When
    the supply stops, the tail thins and breaks into tapering drips.
  - Everywhere water has run keeps a damp trail, which dries in from its edges
    over about ten seconds. A small spill uses itself up wetting the strip and
    stops on the way down; a big one runs off the bottom edge.
  - It is drawn the way water was on the N64: tiling textures of streaks laid
    over one another, each scrolling down at its own speed and size, so they
    slide past each other like layers of moving water. Thicker water gets more
    layers: a slow dark one and a quicker light one where it runs, a bigger,
    faster one in its deeper core, and racing froth and glints where it is a
    full sheet. Its edges catch the light on the upper left and throw a thin
    shadow on the lower right, and a bright lip shows where it rolls over the
    edge.
  - Under the hood the face is a grid of cells 4px wide and 5px tall, each
    holding how thick the water on it is; the shapes are traced through a
    softened copy of it, so the grid never shows. Drawing it takes about a
    millisecond a frame, and only while there is water on the strip.
- **Snow** (sifted powder, falling flakes) builds a small heap on the edge,
  right under the weather card where it falls; it keeps a natural slope but
  never creeps along the rest of the strip, and only the heap itself is drawn.
  Where it grows too tall, a lump slides over and tumbles down the face, under
  the photos. The heap settles slowly.
- Drips from the icicles splash on the edge.

When there is no Upcoming strip under the card, things fall on under whatever
card is there, as before.

### The nuke's shock wave

When the YouTube panel's mini nuke goes off, its shock ring sweeps over the
weather card and blows away whatever the card's sky has on it and around it. (So
does the quicker ring of a new task landing in the Upcoming strip, 1.3 screen
diagonals a second, from the edge of that card; see *A new task drops in*.) Nothing
here is physics. The ring is a circle growing at the same fixed speed the nuke
draws it (0.8 screen diagonals a second), and whatever it passes is shoved straight
away from the blast by a gust that dies away behind the ring. So where the panel
landed decides how the card is hit:

- **Which part first**: the corner nearest the blast is hit first, and the ring
  can be seen sweeping across the card from there.
- **Which way**: everything blows away from the blast. A blast right under the
  card throws things up and out over its top; one far to the side blows them
  sideways across the card and out of the other side.
- **How hard**: the push falls off with distance. Right under the card it is
  about three times as strong as from the far side of the screen, and the near
  side of the card gets more than the far side.

What each sky does when it is hit:

- **Rain, drizzle and thunder**: the water is torn off its surface as spray and a
  haze of it, and a good part of it is lost (a fifth to two thirds, more the closer
  the blast). Spray flies out over the card's border, falls back into the water,
  onto the Upcoming strip or off the screen. What is left piles up on the side away
  from the blast and sloshes back and forth, heaves up if the blast was below,
  and a swell runs off across it. The beads on the top edge, drops running down
  the sides, beads under the holes and the film on the Upcoming strip are blown
  off; streams and drips bend over in the gust. The beads grow back.
- **Snow**: the pile, the cap on the top edge and the heap on the Upcoming strip
  are scoured off in a burst of powder and spindrift that drifts down slowly and
  settles back on the pile or the strip. The icicles snap off, tumble and shatter
  on the strip. The cap grows back over about forty seconds, the icicles over
  half a minute, the pile at its usual rate.
- **Fog**: the mist is blown away from the card and thinned, no new mist comes
  for two and a half seconds, then it rolls back in all at once.
- **Clouds, sun and moon**: each is knocked away from the blast as the ring
  reaches it and springs back over a few seconds, thinning while it is out of
  place. A wisp tears off the clouds and drifts away. The sun flares.
- **Every sky**: streaks of the gust race across the card away from the blast,
  and the card's own CSS rain, snow, mist and clouds are pushed aside and thinned
  where the ring passes (rain is bent over too), then ease back.

Falling drops, flakes, mist and shooting stars caught by the gust are pushed along
with it. Spray, powder, haze and broken icicles are drawn on the pop-out layer, so
they fly out over the card's border. If the card is hidden or covered when the
nuke goes off, nothing happens to it.

### When it runs

The loop runs only while the card shows the weather, the page is in view, no
overlay (weekly weather, month view, config, YouTube) covers it and the camera
dimmer has not dimmed the screen; an overlay's blurred backdrop would otherwise
have to be re-blurred every frame. `prefers-reduced-motion` turns it off (the
card then shows its static CSS sky, sun and moon included). The snow pile and
the snow cap are drawn into strips of their own and only redrawn when they have
grown visibly; the sun, moon, clouds and fog banks are drawn once per size and
then only moved. Calm skies (sun, moon, clouds, fog) run at 30 frames a second
unless a flare, a shooting star or a gust is on.

### Weather test panel (press Q)

On the wall display, press **Q** to open a small panel in the top right corner:

- **Sky**: Live, or one of clear, partly, clouds, fog, drizzle, rain, snow,
  thunder. Only the card's sky changes; the temperature and description stay
  live.
- **Night** and **Windy** switch on the dark sky and the wind gusts. Used on the
  live sky, they start a test of that same sky.
- In fog, *Pour mist now* and *Mist rolls in* both send a burst of mist over
  the edge for a few seconds.
- **Fill up now** fills the water or the snow pile (and the snow cap and
  icicles) to full, so the leak or the spill follows a few seconds later.
  **Leak now** (or *Spill snow now* / *Pour mist now*) starts it straight away.
- The wide button below plays the sky's out-of-the-card effect at once: *Sun
  flare now*, *Shooting star now*, *Cloud drifts off*, *Mist rolls in*, *Drop
  runs down*, *Lightning now* (the card's flash jumps to its next strike) or
  *Snow flurry now*. With wind on, it also sends a few gusts.
- **Mini nuke goes off at**: *Left edge*, *Middle* or *Under card* closes the
  panel and sets the nuke off at that place at the bottom of the screen (without
  the panel falling), to see how the shock wave hits the card from there.
  *Fill up now* first gives it the most to blow away.
- **New task drops into Upcoming at**: *First*, *Middle* or *Last* closes the
  panel and drops a made-up task ("New task (test)") into that place on the
  page on show, through the same path a real new task takes, so the cards in
  the way are shoved along and, on a full page, the last one goes over the end.
  The test task is only drawn, never saved, and cannot be opened. About three
  and a half seconds after it settles it lifts off again and the cards slide
  back.
- **Card shadows** turns the cards' shadows on the strip on or off (see *Card
  shadows* under *The mini nuke*), to compare. The choice is remembered on this
  screen.
- **Back of the cards**: *Blurred*, *Card stock*, *Photo paper*, *Playing card*
  or *Postcard* picks what a card shows when it is turned over (see *The backs
  of the cards*); remembered on this screen. **Turn over** closes the panel and
  turns every card on the strip over, one after another, holds them face down
  for a couple of seconds and turns them back. Every other card turns over end
  to end and the rest sideways, so the back can be seen both ways round.
- **Speed** (1×, 4×, 12×, 40×) only speeds up the filling. The leak and the
  spill always run at their real speed, so they can be judged as they will look.
- A status line shows the sky, how full the card is and what it is doing.

Q or Esc closes the panel and the test stays on; a dark pill at the top of the
screen says so. Live ends it. A test left on also ends with the five-minute idle
reset, or with a reload, so a forgotten one cannot keep the wall on the wrong
weather. Q is ignored while typing in a field.
