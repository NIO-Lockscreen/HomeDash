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

When you create, edit, complete, or delete a task from the phone, the app first stores the change on the phone in a pending queue. It then sends the change to Vercel. If Vercel is busy or the network fails, the task stays in the local queue and the app retries automatically every 15 seconds and whenever the phone comes back online.

Open the hidden config menu by holding anywhere on the dashboard/admin screen. It shows the number of pending saves and has a retry button.

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

- Deleting a task now also deletes its stored event image from Vercel Blob when no remaining task uses that image.
- Replacing an image on a task cleans up the old Blob image when it is no longer used.
- Deleting all tasks also tries to remove all Home Organizer images under the event image paths.
- Display mode now refreshes tasks every 10 seconds, and also refreshes when the page becomes visible again.
- Desktop admin mode shows a large **Back to normal view** button so you can return to the Surface display after editing.
- If admin and display are open in two tabs on the same device, the display tab is notified immediately after a successful save. Across different devices, display mode polls every 10 seconds.


## Face-aware image cropping

When you upload a task image, the admin page tries to detect faces in the browser and saves a simple focus point with the event. The dashboard then uses that focus point for daily, selected, upcoming, and admin thumbnails so faces are less likely to be cropped out.

This is face detection only, not identity recognition. It does not know who the person is. If the browser cannot use the FaceDetector API, the app falls back to a portrait-friendly crop. Existing images need to be re-uploaded or edited with a new image to get saved face focus data.

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
