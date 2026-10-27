# MomExpress

**Your personal family delivery service.** Mom asks for something — a glass of water, her charger, a hand with something — and her runner gets it instantly, accepts, sets an ETA and brings it over. Mom watches it happen live, like a delivery app, but for one household.

It's a private app for a small family: no public sign-up, no payments, no maps. Just fast requests, live tracking and notifications that work.

## Features

**For Mom** — her own very simple app, entirely in Arabic and right to left (`web/src/mom/`)
- A home screen of big picture buttons: ماء، شاي، أكل، دواء، تعال عندي، and شيء آخر to write anything.
- Sending takes two taps: the item, then *where she is* (her last place is already picked). **Urgent** and a **note** are optional.
- A tracking screen with one big, plain message (*“أحمد في الطريق إليك”*), four steps with times, and *“يصل خلال حوالي ٥ دقائق”*, counted down on the phone and always marked as approximate.
- Cancel before it's delivered, and **اطلبيه مرة أخرى** (request again) from anything in her history.
- Large text by default, with a text-size setting; Arabic digits; her notifications are in Arabic too.

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

## How it's hosted

- **The app** is a static site on **GitHub Pages**, published by `.github/workflows/pages.yml` on every push: https://ahmedps520-svg.github.io/Mom-express/
- **The data** lives in **Supabase**: Postgres for storage and the delivery rules, Supabase Auth for sign-in, Realtime for live updates, and one Edge Function (`mx-push`) that sends push notifications.

Nothing runs on your own machine.

## Setting it up

1. **Database.** In the Supabase dashboard, open the **SQL Editor** and run each file in `supabase/migrations/`, oldest first (paste it all and click **Run**). Then tell the database where the push function lives, replacing `<project-ref>`:
   ```sql
   insert into momexpress.settings (key, value)
   values ('push_function_url', 'https://<project-ref>.supabase.co/functions/v1/mx-push')
   on conflict (key) do update set value = excluded.value;
   ```
2. **Accounts.** There is no public sign-up. Create each person in the SQL Editor (the role is `mom` or `runner`):
   ```sql
   select momexpress.create_member('mom', 'a-long-password', 'Mom', 'mom');
   select momexpress.create_member('ahmed', 'another-long-password', 'Ahmed', 'runner');
   ```
   People sign in with the username. Later: `select momexpress.set_password('mom', 'new-password');` and `select momexpress.set_disabled('ahmed', true);` (or `false` to re-enable).
3. **Push notifications.** **Edge Functions → Deploy a new function → Via Editor**, name it `mx-push`, paste `supabase/functions/mx-push/index.ts`, and turn **off** “Verify JWT” (the function checks callers itself). It creates its VAPID keys the first time it's used and stores them in the database. With the Supabase CLI instead: `supabase functions deploy mx-push --no-verify-jwt`.
4. **The app.** Put the project's URL and publishable key in `vite.config.ts` (or set the repository variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`). Both are meant to be public. In GitHub, **Settings → Pages → Source: GitHub Actions**, then push.

To work on the app locally: `npm install`, then `npm run dev` (http://localhost:5173, using the same Supabase project).

### Notifications

Push works in Chrome, Edge and Firefox on computers and Android, and on iPhone/iPad (iOS 16.4+) once MomExpress is added to the Home Screen. Each person turns it on per device in **Settings**, where they can also send a test notification and choose which kinds they get. Notifications open straight to the request when tapped. Signing out stops a device's notifications.

### Updates

Push to the branch and the workflow publishes the new version. Open apps notice within moments (or the next time they're opened) and show **“A new version of MomExpress is ready — Update”**. Pages are always fetched fresh when online, and only the hashed static files are cached, so an installed app can't get stuck on an old version. **Settings → Check for updates** does the same on demand.

## How it works

```
supabase/
  migrations/      the whole backend: tables, delivery rules, the app's API (public.mx_* functions),
                   row-level security for live updates, and the trigger that sends pushes
  functions/mx-push  Edge Function that sends Web Push notifications
shared/            types, lifecycle rules and validation used by the app (and mirrored in SQL)
web/               React app (Vite) and the service worker (web/sw.js)
  src/api/         Supabase client and one typed wrapper per database function
  src/lib/sync.ts  sign-in, live connection, reconnection, offline outbox
  src/mom/         Mom's app (Arabic, simplified); src/pages is the runner's app
tests/             database tests (the real migration, run in PGlite) and lifecycle tests
```

**Request lifecycle.** The database enforces the rules (`momexpress.check_action`); the app uses the same rules from `shared/lifecycle.ts` to decide which buttons to show.

| Status | Mom can | Runner can |
|---|---|---|
| Pending | edit, cancel | accept (with or without an ETA), decline with an optional reason |
| Accepted | edit, cancel | start delivery, set/update ETA, cancel with a reason (“can't complete”) |
| In progress | edit, cancel | update ETA, mark delivered, cancel with a reason |
| Delivered / Declined / Cancelled | request again | — |

Once a request is accepted, only the runner who accepted it can progress it. Finished requests can never change: the database itself rejects updates to them and deletions of any request.

**Live updates and conflicts.** Every change adds a row to the request's history; the app listens for those (and for its own notifications) through Supabase Realtime, limited by row-level security to what each person may see. Each action locks the request, so two people acting at once take turns: the second is refused with a clear message and the latest state. If Mom changes a request while the runner is about to act on it, the runner's action is refused until they've seen the change. Every request carries a version number and the app always keeps the newest copy, so a slow response can't undo a newer change. After any reconnect the app reloads everything, so nothing missed while offline is lost.

**No duplicates.** Each new request carries an id generated when the form opens. Resending it — a double tap, a retry after a timeout, or the offline outbox — returns the request that already exists instead of creating another. The form also warns if an identical request is already active.

**Privacy and security.** Accounts are created only in the SQL Editor. The app's tables live in their own `momexpress` schema, which the Supabase API doesn't expose; the app can only call the `public.mx_*` functions, which check who is signing in and what they may do. Requesters can't see each other's requests, notifications or devices; push subscriptions are tied to the sign-in session that created them, so signing out (or changing the password, which signs out other devices) stops them. Sign-in is rate limited by Supabase Auth, and the site ships a strict Content Security Policy.

## Testing

```bash
npm test             # database tests (the real migration in PGlite) and lifecycle tests
npm run typecheck
```

`scripts/e2e-smoke.mjs` drives Mom (phone-sized) and the runner (desktop-sized) through full deliveries in a real browser — quick request, accept with ETA, ETA change, delivery, cancellation, decline, offline queueing and offline reload. It needs Playwright with Chromium installed:

```bash
BASE_URL=https://ahmedps520-svg.github.io/Mom-express/ MOM_USER=mom MOM_PASS=... RUNNER_USER=ahmed RUNNER_PASS=... node scripts/e2e-smoke.mjs ./screenshots
```

## Room to grow

The data model and code are set up for the next steps without reworking anything: favourite templates and more shortcuts (`QUICK_REQUESTS` in `shared/constants.ts`), more household locations (`LOCATIONS`), more family members (already supported — add accounts), delivery comments and a shared timeline (the per-request history in `request_events` already records every step), simple statistics (`mx_stats`), custom sounds (`web/src/lib/sound.ts`) and image attachments.
