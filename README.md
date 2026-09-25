# White Mountain Handyman — Scheduler

A lightweight job scheduling app for a small handyman/contracting business: track customers, jobs, estimates, statuses, a calendar, and job-site photos. It runs entirely as static HTML/CSS/JS and now ships with an optional local backend so customer intake forms and schedule data can be captured on a server instead of only living in one browser's local storage.

## Contents

| File | Purpose |
|---|---|
| [index.html](index.html) | The scheduler app itself (dashboard, add job, customers, calendar, notes, guide). Single-file HTML/CSS/JS, no build step. |
| [landing.html](landing.html) | Public marketing/landing page with a "Join Schedule" link into the app and a "Call Now" link. |
| [customer-intake-form.html](customer-intake-form.html) | A standalone form customers fill out. Submits directly to the backend when available; otherwise downloads a JSON file for the customer to email back. |
| [server/server.js](server/server.js) | Optional Node backend: serves the app, stores schedule data in server memory (persisted to disk), and receives intake submissions directly. |
| `scheduler-backup-*.json` | Example/point-in-time exports of the app's data (customers, jobs, notes). Produced by the app's "Backup" button. |
| `02_handyman_bust_clean.png`, `landingpage.png` | Images used by the landing page / repo preview. |

## How the app works

`index.html` is a single-page app (no framework, no build tools) with these views: **Dashboard**, **Add job**, **Customers**, **Calendar**, **Notes**, **How it works**, and a **Customer detail** page (edit customer, add/edit/delete jobs, upload job photos).

Data model (kept in one in-memory object, `state.data`):
```
{ version, businessNotes, customers: [...], jobs: [...], photos: [...] }
```

### Data persistence (two modes)

1. **Offline / single browser (default, always works):**
   - Every change autosaves to `localStorage` (`stephen-campbell-scheduler-autosave`), so a reload restores your work.
   - The **Backup** button downloads a timestamped JSON snapshot; the file picker next to it restores from a backup.
   - This mode needs nothing installed — just open `index.html` in a browser. Data does **not** sync between devices/browsers and is limited by `localStorage` size (a few MB, shared with photo data URLs).

2. **With the backend running (recommended for a shared/office setup, and required for cloud hosting):** see [server/server.js](server/server.js) below. The app detects the server automatically, auto-merges any customers the server has that the browser doesn't, and adds **Save to server** / **Load from server** buttons.

### Customer intake flow (fully automatic)

Send customers the link to `customer-intake-form.html` (e.g. `https://your-domain.example/customer-intake-form.html`). When they click **Submit**:
- The form POSTs directly to `/api/intake` on the same server. The backend immediately creates the matching customer and job records — **no manual import step, no email round-trip.**
- Anyone with the scheduler open sees a "customer added automatically from the intake form" notice on the Add Job page within ~20 seconds (or immediately on navigating to Dashboard/Customers/Add Job), because the app polls `/api/state` and merges in any new customers it doesn't already have. Existing local edits are never overwritten — only genuinely new customers are added.
- If the backend isn't reachable (e.g. the form was opened as a plain file, or the server is down), the form falls back to downloading a JSON file for the customer to email back, and it can still be uploaded manually on the **Add job** page.

## Running it

**Offline only:** open [index.html](index.html) directly in a browser. Nothing to install.

**With the backend (local):**
```powershell
cd schedule/server
npm start
# then open http://localhost:3000/index.html
```

**On a cloud server:** copy the `schedule/` folder to the server, run `npm start` inside `schedule/server` (use a process manager like `pm2` or a systemd service so it stays running), and put it behind HTTPS — either a reverse proxy (nginx/Caddy) terminating TLS in front of port 3000, or set `PORT` to whatever your proxy forwards to. Since the intake form posts to a **relative** URL (`/api/intake`), no code changes are needed for the domain — send customers `https://your-domain.example/customer-intake-form.html` and submissions land straight in the server's `data/state.json`. The server also serves `landing.html` and `index.html` at the same origin, so everything works from one address. Data is stored in `schedule/server/data/` (created automatically, git-ignored) — back this directory up.

## Backend API (server/server.js)

A dependency-free Node HTTP server (no `npm install` required — uses only Node core modules):

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/state` | Returns the current schedule (customers, jobs, photos, notes) from server memory. |
| PUT | `/api/state` | Replaces the stored schedule (used by "Save to server"). |
| GET | `/api/intake` | Lists recently received intake submissions (already imported) for the "added automatically" notice. |
| POST | `/api/intake` | Receives a new intake submission and immediately creates the customer + job in server state. |
| DELETE | `/api/intake/:id` | Dismisses a submission from the notice list (does not delete the customer it already created). |

Request bodies are size-limited (413 on oversized payloads) and validated before being written to disk, and static file serving is restricted to the `schedule/` directory (no path traversal).

## Refactoring notes (this pass)

- **Fixed a broken link:** `landing.html`'s "Join Schedule" button pointed at a non-existent `Scheduling_App.html`; it now correctly points at `index.html#newForm`.
- **Added a backend** so intake forms and schedule data don't depend solely on a single browser's local storage and manual file emailing — submissions now populate the scheduler's fields automatically the moment a customer hits Submit.
- The client app is unchanged in structure (still a dependency-free single HTML file) but now progressively enhances itself with server features when they're available, and degrades gracefully to the original offline/localStorage/backup-file workflow when they're not.

## Suggestions for further improvement

- **Move photos out of `localStorage`/JSON.** Photos are currently stored as base64 data URLs inside the same JSON blob as everything else, which can blow past `localStorage`'s ~5–10MB limit and makes backup files huge. If the backend is adopted long-term, store photo files on disk (or object storage) and reference them by URL/id instead.
- **Add authentication to `/api/state`** before exposing it beyond a trusted network — `/api/intake` is meant to be public (that's how customers submit), but `GET`/`PUT /api/state` expose and can overwrite the whole schedule and should require a login or API key once this is on the public internet.
- **Rate-limit `/api/intake`** (e.g. by IP) since it's a public, unauthenticated endpoint once deployed — this prevents spam/abuse from filling the schedule with junk entries.
- **Consider a real database** (SQLite is a natural next step) once the business has enough customers/jobs that a single JSON file becomes unwieldy or multiple people need to write concurrently.
- **HTTPS is required in production.** Put the server behind a reverse proxy (Caddy/nginx) or platform load balancer that terminates TLS — the app and API send plain JSON, including customer contact details, so this shouldn't run over plain HTTP on the public internet.

