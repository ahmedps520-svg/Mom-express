# MomExpress

**Your personal family delivery service.** Mom asks for something — a glass of water, her charger, a hand with something — and her runner gets it instantly, accepts, sets an ETA and brings it over. Mom watches it happen live, like a delivery app, but for one household.

It's a private app for a small family: no public sign-up, no payments, no maps. Just fast requests, live tracking and notifications that work.

## Features

**For Mom**
- A friendly home screen: greeting, one big **New request** button, and shortcuts for **Water**, **Snack**, **Help** and **Medicine** that pre-fill the form (everything stays editable).
- Ask for anything in plain text. Only *what* and *where* are needed; details, priority (Normal / High / Urgent) and notes for the runner are optional.
- Live tracking for every request: status, a progress tracker with timestamps, and a countdown such as *“Arriving in about 5 minutes”* that runs on the device and adjusts the moment the runner changes the ETA. If the ETA passes, it says so plainly instead of counting into negative numbers. Estimates are always labelled as estimates.
- Edit or cancel a request any time before it's delivered, and **Request again** from anything in history.

**For the runner**
- A dashboard built around incoming work: new requests sorted by urgency with destination, priority, notes and waiting time visible on the card, plus **Accept** and **Decline** right there.
- Accepting asks for an ETA in one tap (2–30 min or a custom value). Then **Start delivery**, **Update ETA** and **Mark delivered**, in that order — the app won't let a request be delivered before it's accepted and started.
- A chime (and vibration on phones) when a request arrives, today's numbers, recent activity and full history.

**For both**
- Everything is live: a change on one device shows up on the other within a second, with no refreshing.
- Notifications in the app (with an unread count and a notification centre) and as real push notifications on phones and computers, which open straight to the request when tapped. Each kind of notification can be switched off.
- History with filters (All / Delivered / Cancelled / Declined). Finished requests are kept permanently.
- Works as an installed app (PWA) on iPhone, Android and desktop, with light and dark themes.
- Honest about connectivity: a live/offline indicator, the last synced data while offline, and requests made offline are clearly marked **Not sent yet** until the server confirms them. Success messages only appear after the server has saved the change.

## Quick start

Requires **Node.js 22.13 or newer** (it uses Node's built-in SQLite, so there are no native modules to compile).

```bash
npm install
npm run build

# Create the family's accounts (there is no public sign-up)
npm run users -- add --username mom --role mom --name "Mom"
npm run users -- add --username sam --role runner --name "Sam"

npm start          # http://localhost:3000
```

For development, `npm run dev` runs the API on :3000 and the Vite dev server on http://localhost:5173 with hot reload. Use `npm run users:dev -- add` to create accounts without building first.

### Managing accounts

```bash
npm run users -- list
npm run users -- add                     # asks for everything
npm run users -- passwd mom              # also signs Mom out on every device
npm run users -- rename sam "Samuel"
npm run users -- disable sam             # signs out everywhere; history is kept
npm run users -- enable sam
```

Roles are `mom` (makes requests) and `runner` (delivers them). Roles can only be set here, never from the app. You can add more people with either role: each requester only sees their own requests, and every runner sees all of them.

Passwords are typed without echoing. For scripts, set `MOMEXPRESS_PASSWORD`. On hosts without a shell, set the `INITIAL_*` variables in `.env.example` to create the first two accounts on first start.

## Deploying

MomExpress is one Node process and one SQLite file. Anything that can run a Docker container or Node 22 will do: a home server or Raspberry Pi, or a small cloud host such as Fly.io, Railway or Render (attach a persistent volume for the data folder).

```bash
docker compose up -d
docker compose exec momexpress npm run users -- add
```

**Use HTTPS.** Browsers only allow installing the app and sending push notifications on secure origins (localhost is the exception). Common options:

- **A hosting platform** — they provide HTTPS automatically.
- **Caddy** in front of the app — automatic certificates: `momexpress.example.com { reverse_proxy localhost:3000 }`.
- **Tailscale** (`tailscale serve 3000`) — HTTPS inside your private network, so the app isn't on the public internet at all.

Behind any proxy, set `TRUST_PROXY=1` so the server sees HTTPS and real client addresses (sign-in rate limiting depends on it). See `.env.example` for every setting.

**Backups:** everything lives in `DATA_DIR` (default `./data`). Back up `momexpress.db` (with its `-wal` file if present) while the server is stopped, or use `sqlite3 momexpress.db ".backup copy.db"` while it runs.

### Notifications

- Push keys (VAPID) are generated on first start and stored in the database, so nothing needs configuring. Set `VAPID_SUBJECT` to a real contact address.
- Each person turns notifications on per device from **Settings** (or the prompt on the home screen). If the browser blocks them, the app says so and keeps working; everything still appears in the notification centre.
- **iPhone and iPad:** web push needs iOS 16.4+ and the app added to the Home Screen (Share → Add to Home Screen). The app explains this when needed.
- Signing out removes that device's push subscription, so a shared tablet never shows the previous person's notifications.

### Updates

Deploy a new version and restart the server. Open apps notice within moments (or the next time they're opened) and show **“A new version of MomExpress is ready — Update”**. Pages are always fetched fresh when online, and only the hashed static files are cached, so an installed app can't get stuck on an old version. **Settings → Check for updates** does the same on demand.

## How it works

```
server/            Express API, SQLite storage, live updates, push
  requests.ts      the delivery workflow: every change is checked, saved with a history entry, then broadcast
  realtime.ts      Server-Sent Events hub (one stream per open app window)
  notifications.ts in-app notifications + push fan-out
  push.ts          Web Push with VAPID
  auth.ts          scrypt password hashing, sliding sessions, sign-in rate limiting
  db.ts            schema and migrations
  cli/users.ts     account management
shared/            types, lifecycle rules and validation used by both sides
web/               React app (Vite) and the service worker (web/sw.js)
  src/lib/sync.ts  sign-in, live connection, reconnection, offline outbox
tests/             API, lifecycle and push tests (Vitest)
```

**Request lifecycle.** The rules live in `shared/lifecycle.ts`; the server enforces them and the app uses the same code to decide which buttons to show.

| Status | Mom can | Runner can |
|---|---|---|
| Pending | edit, cancel | accept (with or without an ETA), decline with an optional reason |
| Accepted | edit, cancel | start delivery, set/update ETA, cancel with a reason (“can't complete”) |
| In progress | edit, cancel | update ETA, mark delivered, cancel with a reason |
| Delivered / Declined / Cancelled | request again | — |

Once a request is accepted, only the runner who accepted it can progress it. Finished requests can never change: the database itself rejects updates to them and deletions of any request.

**Live updates and conflicts.** Each change is broadcast to everyone allowed to see that request. Every request carries a version number; updates only apply to the version they were based on, and the app always keeps the newest copy, so a slow response can't undo a newer change. If two people act at once (say, Mom cancels just as the runner accepts), the second action is refused with a clear message and the latest state. After any reconnect, the app reloads everything, so nothing missed while offline is lost. The connection sends a ping every 20 seconds so phones that silently drop connections are detected and reconnected.

**No duplicates.** Each new request carries an id generated when the form opens. Resending it — a double tap, a retry after a timeout, or the offline outbox — returns the request that already exists instead of creating another. The form also warns if an identical request is already active.

**Privacy and security.** Accounts are created only from the command line. Sessions are random tokens stored hashed, in `HttpOnly`, `SameSite=Lax` cookies, and slide forward with use. State-changing requests must be JSON from the app's own origin (CSRF protection), every API response is `no-store`, and a strict Content Security Policy is applied. Requesters can't see each other's requests, notifications or devices; push subscriptions are tied to the session that created them; nothing is exposed without signing in. Sign-in attempts are rate limited.

## Testing

```bash
npm test             # API, lifecycle and web-push tests
npm run typecheck
```

`scripts/e2e-smoke.mjs` drives Mom (phone-sized) and the runner (desktop-sized) through full deliveries in a real browser — quick request, accept with ETA, ETA change, delivery, cancellation, decline, offline queueing and offline reload — against a running server with a fresh database. It needs Playwright with Chromium installed:

```bash
BASE_URL=http://localhost:3000 MOM_USER=mom MOM_PASS=... RUNNER_USER=sam RUNNER_PASS=... node scripts/e2e-smoke.mjs ./screenshots
```

## Room to grow

The data model and code are set up for the next steps without reworking anything: favourite templates and more shortcuts (`QUICK_REQUESTS` in `shared/constants.ts`), more household locations (`LOCATIONS`), more family members (already supported — add accounts), delivery comments and a shared timeline (the per-request history in `request_events` already records every step), simple statistics (`/api/stats`), custom sounds (`web/src/lib/sound.ts`) and image attachments.
