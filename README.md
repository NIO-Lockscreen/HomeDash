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
- **Delete all tasks/events** clears tasks only; the periods are kept, and so
  are the to-do list and the stock pictures.

### The schedule

The periods start from a schedule set in `index.html` (`DAUGHTER_SCHEDULE`). A
period runs from the day Sofia comes to the day she goes back, and both days
are blue. The schedule has three parts, each covering the periods that start
from its date:

- **Until 18 November 2026**: every other Wednesday to Wednesday, counted from
  13 May 2026.
- **The agreed Christmas and New Year handovers**: 24 Nov – 1 Dec, 6–7 Dec,
  11–16 Dec, 23–27 Dec, 31 Dec – 7 Jan and 13–21 Jan.
- **From 27 January 2027**: the opposite weeks, every other Wednesday to
  Wednesday.

A change made by hand in the month view is stored against the start date the
period has in the schedule, and wins over it; **Reset to the schedule** removes
it again. A change stored against a start date the schedule no longer has is
ignored.


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

## Stock pictures

Some words come round again and again: the dentist, football practice, the
physio. A **stock word** is such a word with one or more default photos. A task
whose title names a stock word and that is saved **without** a photo of its own
is given one of that word's photos, instead of the calm placeholder. This grew
out of the fysio/lege/MR borrowing (below): those three are now simply the first
stock words, and the list is managed in the app instead of being written into
the code.

### Two libraries: family and work

The family and work mode each have their own stock pictures. A word belongs
to one library, and a task only ever takes pictures from its own calendar's:
a work task *Møte* gets the work word's photo, a family task *Møte* the
family word's, and a family task never gets a work photo. The two libraries
may even hold the same word. The words that came from fysio/lege/MR, and any
word made before there were two libraries, are family words.

- **Stock pictures** on the phone shows the library of the phone's mode: the
  family's normally, the work words (*Stock pictures · Work*) in work mode. A
  new word goes into that library, and a word never moves to the other one.
- In the task editor, the task's **Calendar** (Family / Work) decides: the stock
  row, **Pick a stock picture** and the picture a save fills in all come from
  that calendar's library, and switching it switches them.
- A task moved to the other calendar lets go of a stock picture from its old
  library on the next save (unless it was picked or framed by hand) and gets
  the new library's photo, or the placeholder.

### Managing the words

On the phone (or the desktop admin page), open **Stock pictures** under the
calendar. Every word is a tile showing its first photo; a word with several
photos looks like a small stack of prints, and a word with no photo yet is
striped. Tap a tile to open it, or **+ New word**:

- **Word**: as it is written, e.g. *Tannlege*. Matching ignores case and accents.
- **Also matches**: other ways of writing it, comma separated (*tannlegetime,
  tannpuss*). A word with a space in it matches those words in a row.
- **Count inside longer words too**: *Lege* then also catches *Tannlege*,
  *Legetime* and *Legevakt*. Words shorter than four letters never do (so *MR*
  only ever matches *MR*, *MR-time* or *MRI*), and the false friends the lege
  rule already knew (*college*, *privilege* …) never count.
- **Matches now** lists the upcoming task titles the word, as typed, would catch.
- **Photos**: up to 12 per word. **+** uploads one (optimized like any task
  photo). Tap a photo to frame it: the pan/zoom is used on every task showing
  that photo, except tasks framed by hand. **Remove photo** and **Delete word**
  ask first.

Two words of the same library may not claim the same word or alias; the app
says which word already has it.

### Which photo a task gets

- **The title decides.** A phrase match wins; otherwise the title is read from
  the left and the first word that names a stock word decides. Within that word
  an exact match beats a match inside a longer word, and a longer stock word
  beats a shorter one, so *Tannlege* picks the word *Tannlege* over *Lege* once
  both exist.
- **Of that word's photos**, a random one among those the fewest open tasks are
  showing, so two dentist visits in a row do not look the same.
- **A photo you pick always wins.** The stock picture only ever fills an empty
  slot. Upload a photo for the task and the stock picture is replaced.
- **Picked by hand.** In the task editor, under the image field, a row says
  which stock picture the task shows or will show. **Change** / **Pick a stock
  picture** lists every word's photos; one picked there belongs to that task
  whatever its title says. Moving the pan/zoom sliders on a stock picture also
  makes it the task's own framing.
- **Retitled.** A stock picture the title no longer names (*Tannlege* renamed
  *Middag*) is let go on the next save, and the slot is filled with the right
  word's photo or left to the placeholder. Never one picked or framed by hand.
- **Own photo that matches a word.** The editor offers **Add to stock**, which
  puts the task's photo into that word's photos.

### When the library changes

Every change to the library is one write, and the tasks are brought in step in
that same write:

- **A word or photo is added**: every upcoming task with no picture whose title
  names a word gets one.
- **A photo is reframed**: tasks showing it take the new framing, unless framed
  by hand.
- **A photo is removed**: tasks showing it get another photo of the word, or the
  placeholder. A task that picked or framed it by hand keeps it as its own.
- **A word is deleted**: its tasks keep their pictures, as their own.

A task somebody gave a photo of their own is never touched. Past and completed
tasks are left as they are.

### Where it is stored

The library rides in `events.json` as `stock`, next to the tasks, so every
screen gets it with the task list it already reads (no extra Blob read), and the
version marker carries its changes. A task showing a stock picture carries
`imageStockWord` (the word's id), `imageStockImageId` (which photo) and
`imageStockManual` (picked or framed by hand); like the borrow marks, they live
and die with the picture. Changes go through the same pending queue as task
saves: shown at once, kept on the phone until the server has them.

The image sweep in the reminder cron counts the stock photos as referenced, so a
library photo that no task happens to show is never deleted.

### Seeded from the fysio/lege/MR photos

Until the library is first stored, the server answers with a library made from
the old rule: the words **Fysio**, **Lege** and **MR** (*MRI* as an alias), each
holding the photos somebody once chose for such tasks (never a borrowed one,
newest first, at most 12), with the framing they were given. A kind nobody has a
photo for still gets its word, empty. The first save of any kind after this
deploy stores that library, and from then on it is edited like any other.

The rules live in `api/_stock.js` (`stockWordForTitle`, `pickStockImage`,
`isStaleStockImage`, `reconcileStockTasks`, `applyStockChange`,
`seedStockLibrary`) and are applied by `api/events.js` to whatever any device
sends. The admin page holds a copy of the matcher and the picker so a task saved
on the phone draws its stock picture straight away, and so a task saved with no
signal still gets one. Keep the two in step.

## Fysio, lege and MR tasks borrow an old photo

*Superseded by **Stock pictures** above: the server no longer lends photos
between tasks; fysio, lege and MR are stock words now. What follows still
applies to pictures that were borrowed before, and the matching rules for words
inside longer words come from here.*

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
- The only recipient is **Thomas** (hardcoded). Tick him, or leave it unticked
  for none. Therese was removed as a recipient: a task or a reminder setting that
  still lists her address is read without it, and any reminder already scheduled
  for her at Resend is cancelled by the next cron run (or a manual one, below) and
  scheduled again for Thomas alone.
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
3. You tick Thomas.
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
nothing.

Pulled out, the panel is **armed** until the next full hour: pulled out at 14:20,
it goes at 15:00. Meanwhile nothing dims or covers the dashboard, so the wall
stays bright and every card can still be tapped (a tap beside the panel no longer
closes it); its YouTube icon just smoulders with a slow, faint glow. While it is
armed the camera dimmer stays away, as it does while a video plays, and a new
deployment waits to reload. On the hour it wiggles loose and is thrown off at
random, anything from a hop to a lob just under the top of the screen, coming
down anywhere along the bottom, where it goes up in a mini nuke (see *The mini
nuke* below). Push it back left (or press Escape) to disarm it; tapping
**YouTube** disarms it too. Pulled on to the right until it comes off, it goes up
straight away.

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

When the hour comes, an armed panel wiggles loose, its YouTube icon glowing and
spitting sparks like a lit fuse, is thrown off its dock at random and tumbles off
the bottom of the screen trailing smoke. Pulled on to the right past open, it comes off the same way at the finger's
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

**The picture cards rattle.** Pulling the panel, and the panel working loose,
*prime* the photo cards (an armed panel only waiting for its hour lets them settle
back):
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

Priming is what keeps this free in everyday use: until the panel is pulled or
goes off the cards are plain flat elements, with no extra elements, layers or animation
loop. A moment after the panel goes away without going off, or once the cards
have settled after a nuke, they are lowered and taken apart again. The rattle
itself only moves and fades composited layers.

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

### The back of a card

A card thrown over by the nuke (or turned over by the Q panel's test) shows its
back, which is a postcard: the task's time and title written by hand on the
left, a stamp, a postmark and address lines on the right. On Windows the
handwriting is Segoe Print.

It is printed facing outwards from the back, so it reads the right way round on
a card turned over sideways, and upside down on one turned over end to end, as
a real postcard would. It is lit like the front as it turns: brighter turned
towards the light, darker turned away. Like the rest of the 3D card, the back
only exists while the cards are primed.

## Sofia's tasks

A task that names Sofia gets a pink glowing ring and hearts floating up around it.
"Names Sofia" means the word *Sofia* in its title, place or note, in any case, and
also *Sofias* or *Sofia's* (so "Sofias bursdag" and "Hente sofia" count), but not
a longer word that only starts with it (*Sofiahallen*), nor *Sofie* or *Sophia*.

None of it shows before **1 December 2026** (from midnight, in the screen's own
time zone); from then on it is always on. The wall redraws every minute, so it
switches on by itself within a minute of midnight, without a reload.

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

### Event borders

The **Event borders** switch, in the month view's footer (for touch screens
with no Q key) and in the Q panel, draws a thin ring with a soft glow, like
Sofia's pink one, around every task card on the wall: the Upcoming cards, the
big task photo and the picked-task panel. It is **blue** when the task starts
on one of Sofia's days (the blue days in the month view, hand edits included)
and **black** on the others. Sofia's own pink ring, and the work ring among
family tasks, win where they apply. It is a still ring, with nothing animated,
and it belongs to that one screen (the phone's list is left as it is). A period
moved on another screen shows within a minute, as the wall redraws.

## Work mode

A screen can be put in **work mode**. It then shows only the tasks made in work
mode, and the family calendar can be shown alongside them with one tap. A screen
in the ordinary **family mode** shows only family tasks, so work meetings never
turn up on the family's wall or phones.

### Switching it

Work mode is hidden behind the **Q panel**, and it belongs to that one screen:
switching the desk's laptop to work does not change the wall or anybody's phone.

- **Wall**: press **Q**, or (no keyboard) **hold the date** under the clock for
  about a second. A plain tap on the date still does what it always did.
- **Phone / admin page**: **hold the clock** in the top right for about a second,
  or press **Q** on a keyboard. On the phone the Q panel is only the mode switch.

The panel's **Mode · this screen** section has **Family** / **Work**, and below
them **Family calendar: hidden / shown**. The choice survives reloads and the
five-minute idle reset.

### What changes

- **The whole frame cools** from the warm paper colour to an indigo-grey, so the
  mode is clear at a glance. Upcoming reads *Upcoming · Work*.
- **A Work pill** sits under the date, next to the to-do chip: *Work · family
  hidden* or *Work · + family*. Tapping it shows or hides the family calendar.
- **Every view filters the same way**: the big task photo, Upcoming, the week
  dots, the day selector, the month view, the tent view on the phone and the
  admin list. It is done once, where all of them get their tasks
  (`expandEventsInRange`), so no view can miss it.
- **Work tasks are marked only among family tasks** (work mode with the family
  calendar shown): an indigo ring and a *Work* badge on the Upcoming card, a
  ring and a *Work* tag on the big photo, an indigo dot in the month view, a
  *Work* chip in the admin list. On their own they look like any task. Sofia's
  pink ring wins on a task that is both.
- **The to-do list takes the weather card's place** (see below), with a small
  weather pill to flip back to the weather.
- **On the phone**: a *Work* pill by the clock, *Create a new work task*, and
  the list subtitle says which tasks are shown.

### Which tasks are work

A task has a `scope`: `family` or `work`. A task made on a screen in work mode is
a work task. The editor shows a **Calendar: Family / Work** choice, but only on a
device where work mode has been switched on at least once, or for a task that is
already work, so it never puzzles anybody else. Older pages and changes queued
before this existed send no scope; the server then keeps the stored one, and a
task without one is family.

- The **weekly Sunday email** and the **end-of-day new tasks** email are the
  family's digests and leave work tasks out. A work task's own email reminder,
  which somebody switched on for it, is still sent.
- Work mode is *hidden*, not secret: `/api/events` is public to read (the car
  lockscreen's calendar widget reads it), and it carries every task.
- A wall page that was open before this deploy shows work tasks as family ones
  until it reloads; it reloads by itself when it notices the new deploy.

## To-do list

Short things to get done, with no date: *Kjøpe melk*, *Send Q4 numbers*. Each
item is on the **family** list, the **work** list, or **both**. A screen in
family mode shows family and both; a screen in work mode shows work and both
(the family-calendar toggle is about the calendar, not the list).

### On the wall

- A chip under the date says how many are open (*3 to do*). Tap it and the list
  takes the weather card's place; tap it again, or the small weather pill in the
  list's header, for the weather. In work mode the list is the card's home
  content and the weather is the one you flip to. The idle reset puts the
  card back to its mode's home.
- **Tap a row** to tick it off (and again to put it back). The circle pops and
  the text is struck through; the row moves to the done ones a moment later.
- **+** opens a field at the top (the touch keyboard comes up), with Family /
  Work / Both once work mode has been used on that screen. Enter or **Add** adds.
- **Hold a row** for **Delete** / **Keep**.
- Ticked-off items stay on the wall, struck through, for 12 hours or until
  **Clear done**, which clears the ones that screen shows.
- Like completing a task, this needs the admin PIN saved on the wall.

### On the phone

**To-do list** under the calendar: add, tick, tap an item's text to edit it,
change its list, or delete it. The done ones fold away under *Done (n)* with
**Clear all done**.

### Where it is stored

The list rides in `events.json` as `todos`, like the daughter periods: no extra
Blob read, and the version marker carries changes to every screen. A burst of
taps is saved together: each change is queued at once (so a reload loses
nothing), and the queue sends every waiting to-do change in **one write** two and
a half seconds after the last tap, or as soon as the page is hidden. Each change
states its result (*done*, not *toggle*), so a retried write lands the same way,
and a deleted item is remembered for 30 days so a slow phone retrying its *add*
cannot bring it back. Ticked-off items are dropped from the store 30 days after
the tick. The rules live in `api/_todos.js`.

## The phone app on the wall

The Q panel's **Open the phone app** (under the mode switch) lays a phone over
the wall, and in it runs the real phone app: the same page a phone opens with
`?admin=1`, at phone size, so it looks and works exactly as it does on a phone.
Add tasks, change or delete them, tick off to-dos, edit stock pictures. It opens
like an app: the phone rises from below, its screen shows the app icon for a
moment, then the app.

- **On a wide screen (a PC, the wall) the phone docks beside the calendar**: the
  calendar slides over to the left, drawn exactly as always but smaller, and
  the phone slides in from the right. The calendar stays live and can still be
  tapped, so a task saved on the phone can be watched dropping into Upcoming
  straight away. The **×** at the top left of the phone, where its clock would
  be, puts everything back. (While docked,
  the weather that spills out of its card and the ring a landing card sends out
  are left out: they are drawn in screen pixels, the calendar is scaled.)
- **On a narrow or upright screen** the phone is laid over the middle of the
  wall instead, and the wall behind it waits: a task added on the phone drops
  into the Upcoming strip as the phone is put away.
- **Space** on the wall (with a keyboard) puts the phone up, and presses it away
  again, without opening the Q panel. Typing in a field keeps its space.
- **Putting it away**: the **×** at the top left of the phone (where its clock
  would be), the home bar at the
  bottom of it, a tap outside it (over the middle of the wall), or Esc (Esc
  inside the app first closes whatever is open in it, such as the editor). The
  idle reset puts it away after five minutes without a touch, touches inside
  the phone included.
- **"Change date / edit"** on the wall's task cards opens the phone on that task,
  instead of leaving the wall for the admin page.
- **It shares everything with the wall**, because it is the same browser: the
  admin PIN, the queue of saves still on their way, and the screen's mode. Work
  mode switched inside the phone switches the wall, and the other way round.
- The phone is drawn at its real size (390×844 points) and only scaled down on a
  screen too short for it (docked, to at most 88% of the screen's height). Its page is unloaded when the phone is put away, so
  it does not keep syncing in the background; a save it had not finished
  sending is still in the shared queue, and the wall sends it.

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

### The Q panel (press Q)

On the wall display, press **Q** (or hold the date under the clock) to open a
small panel in the top right corner, the **Q panel**. Its first section is the
screen's **Mode** (see *Work mode*), then **Open the phone app** (see *The phone
app on the wall*), then the **TV screensaver** (see *The TV screensaver* below):

- A status line: how many pictures are in the TV album, when the album was last
  checked, or what is wrong.
- **Connect** (or *Connect again*) opens the Google sign-in in a new tab, so the
  wall stays where it is. **Update the TV now** runs the daily update straight
  away and keeps going until every picture is up.
- **Language on the TV** (*English* / *Norsk*) and **Weeks ahead on the TV**
  (1–4) are stored for the TV album, not for this screen, and the TV is updated
  at once.
- *Previews, set-up and disconnect* opens `/tv.html`.

Opening the panel reads the TV state off the Blob CDN, so it costs no Blob
operation. The PIN is the admin PIN the screen already has; without one, the
first TV button asks for it.

The tests follow:

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
- **Event borders** puts a thin ring around every task card, blue on Sofia's
  days and black on the others (see *Event borders*). Off until it is turned
  on; the choice is remembered on this screen.
- **Turn the cards over** closes the panel and turns every card on the strip
  over, one after another, to show its postcard back (see *The back of a card*),
  holds them face down for a couple of seconds and turns them back. Every other
  card turns over end to end and the rest sideways, so the back can be seen both
  ways round.

The weather test (sky, night, wind, fill, leak and pop-out), the mini nuke test
and the fill speed are no longer in the panel. The weather card always shows the
live weather. Q or Esc closes the panel; Q is ignored while typing in a field.

## The TV screensaver (TCL / Google TV)

HomeDash keeps a Google Photos album, **HomeDash TV**, in step with the
calendar. The TCL plays it in ambient mode, so the calendar is on the TV
whenever nobody is watching anything. No PC, no open browser: Vercel draws the
pictures and uploads them itself.

### What is in the album

In slideshow order:

1. **Today's overview**: the date, this week and next with a dot on every busy
   day, the big task (a featured task today, else today's first, else the next
   one) and the next four. It is the wall display reflowed to 16:9.
2. **A full-screen picture for every task left this week**: its photo edge to
   edge (framed with the task's own focus point and zoom), a calendar leaf with
   the day, the date and time, the place and the note.
3. **For each later week** (next week by default): an overview of that week,
   then a picture for each of its tasks.

Family tasks only, like the wall outside work mode; done tasks are left out,
and repeating tasks are cut off at the end of next month as on the wall.

Every picture is **3840 × 2160, 16:9**: the TCL's 4K panel, scaled down
cleanly on a 1080p set. It leaves out the time and the weather on purpose:
Google TV draws its own live clock and weather over ambient mode, and the
bottom-right corner of every picture is kept clear for that overlay (and for
TVs that overscan). Each overview has a small *Updated* line at the bottom left,
which shows how far behind the TV is.

### When pictures change

- A task **added, edited or moved**: its picture is drawn again. The new one
  is uploaded first, checked to be in the album, and only then is the old one
  taken out, so a failed upload leaves the last good picture up. The overviews
  that show the task are redrawn too, nothing else.
- A task **deleted, marked done, or over**: its picture leaves the album at the
  next daily update. "Over" is the task's end, or an hour after its start when
  it has no end, so a task that was on today stays up until the night.
- **A new day**: today's overview is redrawn (once a day). A task's own picture
  says "Thursday 3 December", never "tomorrow", so it is not redrawn every
  night.
- A picture **deleted by hand** in Google Photos is noticed and uploaded again.
- The album itself deleted: a new one is made on the next run; pick it again on
  the TV (`/tv.html` says so).

### Old pictures stay in the Google Photos library

**Taking a picture out of the album does not delete it.** Google's Library API
has no way to delete or trash anything, so every replaced or finished picture
stays in the account's library and counts against its storage (about 0.4–1 MB
each, JPEG). Uploads only happen when a picture changes, which keeps this to a
few a day.

To clean up, search Google Photos for **HomeDash TV**: every upload has that in
its description. Anything uploaded more than **15 days** ago (with the default
two weeks ahead; `TV_WEEKS` × 7 + 1 days in general) is no longer in the album
and can be deleted. Deleting one that is still in the album takes it off the TV
until the next change puts it back.

### Keeping Vercel use down

The album is updated **once a day**, by a Vercel cron just after midnight
(`/api/tv/refresh` at 23:05 UTC, which Hobby fires some time within that hour:
00:05–01:05 in Oslo in winter, an hour later in summer). Hobby allows cron jobs
that run once a day, so nothing else is needed. A second daily cron at 01:35
UTC is a catch-up: it only does anything when the first run left pictures over
(a run stops after about 40 seconds) or never ran, and otherwise costs no Blob
operation. A change made during the day shows on the TV the next night, or at
once with **Update the TV now** in the Q panel.

What a run costs:

| The run | Blob operations | Uploads |
| --- | --- | --- |
| Nothing to do (the catch-up, most nights) | **none** | none |
| Tasks changed, or a new day (every night) | about 5 simple, 1 advanced | only the pictures that changed |
| A change no picture shows (a to-do, a task next year) | about 5 simple, 1 advanced | none |

That is about 150 simple and 30 advanced operations a month, out of Hobby's
10,000 and 2,000, and about 60 short function runs.

A run with nothing to do works like the version marker: it reads two small
files straight off the Blob CDN at their known addresses, the TV state and
`events-version.json`, both stored with a 30-day cache life. Unchanged, they
are CDN cache hits, which Blob does not bill as operations. Overwriting one
purges its CDN copy, so the next run sees the change. The addresses come from
`BLOB_READ_WRITE_TOKEN` the way `@vercel/blob` builds them; `/tv.html` says
*Daily check: Free when nothing changed* when that worked.

A failure that repeats is written once, not on every run. After three in a row
the job waits at least six hours between tries, and a revoked Google sign-in
waits for you to connect again.

All of it is one function (`api/tv/[action].js`): Hobby allows twelve per
deployment and HomeDash now uses seven. Drawing a picture takes 1–4 seconds; a
run stops starting new pictures after 38 seconds (the function's limit is 60),
saves what it did, and answers `"more": true`. The catch-up cron and the
**Update the TV now** button then simply call it again.

### Setting it up

1. **Google Cloud** ([console.cloud.google.com](https://console.cloud.google.com/)):
   make a project and enable the **Photos Library API**.
2. **Google Auth platform → Audience**: choose *External* and press **Publish
   app** so it says *In production*. An app left in *Testing* gets a sign-in
   that Google ends after 7 days, and the TV would stop updating. Publishing
   needs no review for your own account; Google only shows an "unverified app"
   warning when you connect.
3. **Clients → Create client → Web application**, with the redirect URI
   `https://your-project.vercel.app/api/tv/callback` (`/tv.html` shows the exact
   one for your domain).
4. **Vercel → Settings → Environment Variables**: add `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`. `CRON_SECRET` (from the email reminders) is used too:
   Vercel's cron sends it, and the TV endpoint checks it. Redeploy.
5. On the wall, press **Q** and, under *TV screensaver*, press **Connect** (or
   open **`/tv.html`** on any device and press **Connect Google Photos**). At Google's warning choose **Advanced → Go to …**
   and leave all three permissions ticked: upload, see its own album, take its
   own pictures out of that album. HomeDash makes the album and uploads the
   first pictures straight away.
6. **On the TCL**: *Settings → System → Ambient mode → Google Photos* (or the
   ambient mode settings in the Google Home app) and pick **HomeDash TV**. Only
   once.

Day to day it is run from the wall's **Q panel** (see *The Q panel* above).
`/tv.html` previews every slide exactly as it will be uploaded (nothing is
uploaded by a preview), says which are already on the TV, lists the set-up
steps with your exact redirect URI, and has **Disconnect**.

### Settings

**Language on the TV** (English or Norsk) and **Weeks ahead** (1–4, default 2:
this week and next) are picked in the wall's Q panel and stored in the TV state
(`config`). A new language redraws every picture, so expect one burst of
uploads. More weeks only adds pictures, and fewer only takes them out.

Environment variables, all optional, used until something is picked in the Q
panel:

```txt
TV_LANGUAGE=nb          # en (default, like the wall) or nb
TV_WEEKS=2              # 1-4
TV_ALBUM_TITLE=HomeDash TV
```

At most 40 pictures are kept in the album.

### What is not known yet

- **How quickly the TV notices a new picture.** The album is updated every
  night; how soon the TCL's ambient mode picks a replacement up needs
  a test on the TV.
- **Whether ambient mode keeps the album's order.** HomeDash places every
  picture in slideshow order (overview, the week's tasks, next week's
  overview …). If the TV shuffles, the order is lost; the overviews still come
  round, one per week.

### Limits

- Task photos stored as **WebP** are shown with the calm placeholder: the
  renderer draws JPEG, PNG and GIF. Photos the app re-encoded on upload are
  JPEG; only a small WebP uploaded as it was stays WebP.
- Emoji in titles are drawn from Twemoji, fetched at drawing time. If that
  fetch fails, the title is drawn without them.
- The refresh token is stored in `home-organizer/tv/state.json`, sealed with
  AES-256-GCM under a key made from `GOOGLE_CLIENT_SECRET`. Changing that secret
  means connecting again.

### Files

- `api/_tv-render.js`: the slide plan (`buildTvPlan`) and the drawing
  (`renderTvSlide`, satori + resvg, JPEG via jpeg-js). Bump
  `TV_LAYOUT_VERSION` after changing the look, so every picture is redrawn.
- `api/_tv-job.js`: the daily sync (`runTvSync`).
- `api/_tv-google.js`: Google sign-in and the Photos Library calls.
- `api/_tv-state.js`: the state file, the free CDN reads, token sealing.
- `api/_tv-fonts.js`: Inter and Gelasio (a free face drawn to Georgia's
  metrics), embedded; licences in `api/_tv-fonts-LICENSE.txt`.
- `api/tv/[action].js`: the endpoints. `tv.html`: the settings page. The Q
  panel's TV section is in `index.html` (`renderTvPanel`, `bindTvPanel`).
- `scripts/test-tv.mjs`: an end-to-end test with Blob and Google faked, which
  also counts the Blob operations of each kind of run:

```txt
npm install
node --experimental-test-module-mocks scripts/test-tv.mjs
```

The repeat expansion is shared with the email reminders
(`expandEventOccurrences` in `api/_reminders.js`), so the TV and the emails agree
on when a repeating task falls.
