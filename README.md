# Home Organizer

A Vercel-hosted always-on home organizer with a Surface Pro display mode and a phone admin mode.

## What changed in this version

- Google Calendar sync has been removed for now.
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
