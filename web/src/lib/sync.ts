import { isAuthRetryableFetchError, type AuthError, type RealtimeChannel } from '@supabase/supabase-js';
import type {
  AppNotification,
  DeliveryRequest,
  MeResponse,
  MutationResponse,
  NotificationListResponse,
  RequestDetailResponse,
  RequestEvent,
  StatsResponse,
} from '../../../shared/types.js';
import { ApiError, networkError, setUnauthenticatedHandler, supabase } from '../api/client';
import { mx, type NewRequest } from '../api/mx';
import { usernameEmail, withBase } from '../config';
import {
  addEvents,
  getState,
  initialState,
  markFresh,
  selectActive,
  selectFinished,
  setState,
  upsertRequests,
  type AppState,
  type OutboxItem,
} from '../store/app';
import { toast } from '../store/toasts';
import { startOfDay } from './format';
import { go } from './nav';
import { fetchVapidKey, forgetPushOnThisDevice, pushAllowedHere, syncPushSubscription, unregisterPushOnServer } from './push';
import { playChime, vibrate } from './sound';
import { keys, readJson, removeKey, writeJson } from './storage';
import { onPushSubscriptionChange } from './sw';
import { applyTheme } from './theme';

// The sync engine: signs in, loads data, listens for live changes from the
// database, and resends requests that were made while offline. The server is
// always the source of truth; nothing is shown as saved until it confirms.

let channel: RealtimeChannel | null = null;
let everConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 2000;
let lastConnectAt = 0;
let watchdog: ReturnType<typeof setInterval> | undefined;
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
let listenersInstalled = false;
/** True while this app is signing out on purpose, so it isn't reported as an expired session. */
let signingOut = false;
/** Set while showing saved data because the server couldn't be reached at startup. */
let bootRetry: ReturnType<typeof setTimeout> | undefined;
let bootRetryDelay = 5000;
/**
 * Goes up whenever the signed-in session starts or ends. Slow responses that
 * belong to an earlier session are thrown away instead of being shown.
 */
let generation = 0;
/** Goes up with every unread-count request, so only the latest answer is used. */
let unreadTicket = 0;

interface Snapshot {
  me: AppState['me'];
  requests: DeliveryRequest[];
  notifications: AppState['notifications'];
  unreadCount: number;
  activity: RequestEvent[];
  stats: StatsResponse | null;
  savedAt: number;
}

// ------------------------------------------------------------------ session

export async function boot(): Promise<void> {
  installListeners();
  clearTimeout(bootRetry);
  bootRetry = undefined;
  const gen = generation;
  let offline = false;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (!data.session) {
      // A session that couldn't be refreshed for lack of a connection is kept for later.
      if (error && isAuthRetryableFetchError(error)) offline = true;
      else {
        setState({ session: 'signed_out', connection: 'connecting' });
        return;
      }
    } else {
      const me = await mx.me();
      if (gen !== generation) return;
      startSession(me);
      bootRetryDelay = 5000;
      return;
    }
  } catch (err) {
    if (err instanceof ApiError && !err.isNetwork) {
      if (err.status !== 401) await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      setState({ session: 'signed_out', connection: 'connecting' });
      return;
    }
    offline = true;
  }
  if (!offline || gen !== generation) return;

  // Keep trying in the background until the server answers.
  bootRetry = setTimeout(() => void boot(), bootRetryDelay);
  bootRetryDelay = Math.min(bootRetryDelay * 2, 60_000);
  // Server unreachable: show the last synced data, clearly marked as offline.
  const lastUser = readJson<string>(keys.lastUser);
  const snapshot = lastUser ? readJson<Snapshot>(keys.snapshot(lastUser)) : null;
  if (snapshot?.me) {
    restoreSnapshot(snapshot);
    setState({
      session: 'signed_in',
      connection: 'offline',
      outbox: loadOutbox(snapshot.me.id),
    });
  } else {
    setState({ session: 'signed_out', connection: 'offline' });
  }
}

export function startSession(me: MeResponse): void {
  installListeners();
  clearTimeout(bootRetry);
  bootRetry = undefined;
  const previous = getState().me;
  if (previous && previous.id !== me.user.id) teardown();
  if (!previous || previous.id !== me.user.id) {
    generation++;
    const snapshot = readJson<Snapshot>(keys.snapshot(me.user.id));
    if (snapshot) restoreSnapshot(snapshot);
  }
  setState((s) => ({
    session: 'signed_in',
    signedOutReason: null,
    me: me.user,
    vapidKey: me.push.publicKey ?? s.vapidKey,
    clockOffset: me.serverTime - Date.now(),
    outbox: loadOutbox(me.user.id),
  }));
  writeJson(keys.lastUser, me.user.id);
  applyTheme(me.user.prefs.theme);
  void refreshAll().catch(() => {});
  connect();
  void flushOutbox();
  void preparePush(me.push.publicKey);
  watchdog ??= setInterval(checkConnection, 10_000);
}

/** Makes sure this device's push subscription is registered for the current session. */
async function preparePush(publicKey: string | null): Promise<void> {
  if (!pushAllowedHere()) return;
  const gen = generation;
  // The key pair is created the first time anyone needs it.
  const key = publicKey ?? (await fetchVapidKey().catch(() => null));
  if (!key || gen !== generation) return;
  setState({ vapidKey: key });
  await syncPushSubscription(key);
}

function authError(error: AuthError): ApiError {
  if (isAuthRetryableFetchError(error) || !error.status) return networkError();
  if (error.code === 'invalid_credentials' || error.status === 400) {
    return new ApiError(401, 'invalid_credentials', 'That username and password don’t match.');
  }
  if (error.status === 429) return new ApiError(429, 'rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  return new ApiError(error.status, error.code ?? 'error', error.message || 'Couldn’t sign in. Please try again.');
}

export async function signIn(username: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email: usernameEmail(username), password });
  if (error) throw authError(error);
  try {
    startSession(await mx.me());
  } catch (err) {
    // Signed in, but not as a MomExpress member: don't leave half a session behind.
    if (err instanceof ApiError && !err.isNetwork) await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    throw err;
  }
}

/** Signs out on the server (so this device stops getting notifications), then clears local data. */
export async function signOut(): Promise<void> {
  const me = getState().me;
  signingOut = true;
  try {
    // Stop this device getting notifications while still allowed to say so.
    await unregisterPushOnServer();
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) {
      void preparePush(getState().vapidKey);
      throw isAuthRetryableFetchError(error) ? networkError() : new ApiError(error.status ?? 500, 'error', error.message);
    }
    generation++;
    await forgetPushOnThisDevice();
    if (me) {
      removeKey(keys.snapshot(me.id));
      removeKey(keys.outbox(me.id));
    }
    removeKey(keys.lastUser);
    teardown();
    setState({ ...initialState, session: 'signed_out' });
  } finally {
    signingOut = false;
  }
  go('/');
}

/** Changes the password after checking the current one, then signs out every other device. */
export async function changePassword(current: string, next: string): Promise<void> {
  const me = getState().me;
  if (!me) throw new ApiError(401, 'unauthenticated', 'Please sign in to continue.');
  const check = await supabase.auth.signInWithPassword({ email: usernameEmail(me.username), password: current });
  if (check.error) {
    const err = authError(check.error);
    if (err.code === 'invalid_credentials') {
      throw new ApiError(400, 'validation_failed', err.message, { currentPassword: 'That isn’t your current password.' });
    }
    throw err;
  }
  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) {
    if (isAuthRetryableFetchError(error)) throw networkError();
    const message =
      error.code === 'same_password'
        ? 'Choose a password you haven’t used here before.'
        : error.code === 'weak_password'
          ? 'Choose a longer, less common password.'
          : error.message;
    throw new ApiError(error.status ?? 400, 'validation_failed', message, { newPassword: message });
  }
  await supabase.auth.signOut({ scope: 'others' });
  // Checking the password started a new session here; move this device's notifications to it.
  const key = getState().vapidKey;
  if (key) await syncPushSubscription(key);
}

function handleSessionEnded(): void {
  if (getState().session !== 'signed_in' || signingOut) return;
  // Unsent requests stay saved on this device and go out after signing back in.
  generation++;
  teardown();
  setState({ ...initialState, session: 'signed_out', signedOutReason: 'expired' });
}

function teardown(): void {
  if (channel) void supabase.removeChannel(channel);
  channel = null;
  everConnected = false;
  clearTimeout(reconnectTimer);
  clearInterval(watchdog);
  watchdog = undefined;
  setState({
    requests: {},
    requestEvents: {},
    fresh: {},
    activity: [],
    stats: null,
    notifications: [],
    notificationsCursor: null,
    notificationsLoaded: false,
    unreadCount: 0,
    dataLoaded: false,
    outbox: [],
  });
}

// ------------------------------------------------------------------ loading

/** Reloads everything from the server. Overlapping calls share one load, then run once more. */
export function refreshAll(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      do {
        refreshAgain = false;
        await loadEverything();
      } while (refreshAgain);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function loadEverything(): Promise<void> {
  const gen = generation;
  const ticket = ++unreadTicket;
  const [me, active, recent, notes, activity, stats] = await Promise.all([
    mx.me(),
    mx.listActive(),
    mx.listHistory({ limit: 20 }),
    mx.notifications({ limit: 40 }),
    mx.activity(30),
    mx.stats(startOfDay(Date.now())),
  ]);
  if (gen !== generation) return;

  // Anything we thought was active that isn't any more finished while we
  // weren't listening; fetch its final state so it isn't left looking stuck.
  const seen = new Set([...active.requests, ...recent.requests].map((r) => r.id));
  const missing = selectActive(getState().requests).filter((r) => !seen.has(r.id));
  const finals = await Promise.all(missing.map((r) => mx.getRequest(r.id).then((d) => d.request).catch(() => null)));
  if (gen !== generation) return;

  upsertRequests([...active.requests, ...recent.requests, ...finals.filter((r): r is DeliveryRequest => r !== null)]);
  setState((s) => ({
    me: me.user,
    vapidKey: me.push.publicKey ?? s.vapidKey,
    notifications: mergeNotifications(s.notifications, notes.notifications),
    // Keep the place in older pages if more were already loaded.
    notificationsCursor: s.notifications.length > notes.notifications.length ? s.notificationsCursor : notes.nextCursor,
    notificationsLoaded: true,
    activity: activity.events,
    stats,
    dataLoaded: true,
    lastSyncedAt: Date.now(),
    clockOffset: me.serverTime - Date.now(),
  }));
  if (ticket === unreadTicket) setState({ unreadCount: notes.unreadCount });
  applyTheme(me.user.prefs.theme);
  dropSentFromOutbox();
  saveSnapshot();
}

export async function loadRequestDetail(id: number): Promise<RequestDetailResponse> {
  const gen = generation;
  const detail = await mx.getRequest(id);
  if (gen !== generation) return detail;
  upsertRequests([detail.request]);
  mergeEvents(id, detail.events);
  return detail;
}

/** Fetches one request again, e.g. when it isn't clear whether a change went through. */
export async function refreshRequest(id: number): Promise<void> {
  await loadRequestDetail(id).catch(() => {});
}

/** Merges rather than replaces, so a live event that arrived while loading isn't dropped. */
function mergeEvents(requestId: number, events: RequestEvent[]): void {
  setState((s) => {
    const merged = new Map((s.requestEvents[requestId] ?? []).map((e) => [e.id, e]));
    for (const e of events) merged.set(e.id, e);
    return { requestEvents: { ...s.requestEvents, [requestId]: [...merged.values()].sort((a, b) => a.id - b.id) } };
  });
}

export async function refreshStats(): Promise<void> {
  const gen = generation;
  const stats = await mx.stats(startOfDay(Date.now()));
  if (gen === generation) setState({ stats });
}

async function refreshUnreadCount(): Promise<void> {
  const gen = generation;
  const ticket = ++unreadTicket;
  try {
    const count = await mx.unreadCount();
    if (gen === generation && ticket === unreadTicket) setState({ unreadCount: count });
  } catch {
    /* the next full refresh corrects it */
  }
}

/** Combines two lists of notifications. Once read, a notification stays read. */
function mergeNotifications(current: AppNotification[], incoming: AppNotification[]): AppNotification[] {
  const byId = new Map(current.map((n) => [n.id, n]));
  for (const n of incoming) {
    const existing = byId.get(n.id);
    byId.set(n.id, existing ? { ...n, readAt: n.readAt ?? existing.readAt } : n);
  }
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

// ------------------------------------------------------------------ live connection

/** Timestamps from the database arrive as text; some browsers are picky about the format. */
function parseTime(value: string | null): number | null {
  if (!value) return null;
  const iso = value
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

interface EventRow {
  id: number;
  request_id: number;
}

interface NotificationRow {
  id: number;
  type: AppNotification['type'];
  request_id: number | null;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

const toNotification = (row: NotificationRow): AppNotification => ({
  id: row.id,
  type: row.type,
  requestId: row.request_id,
  title: row.title,
  body: row.body,
  createdAt: parseTime(row.created_at) ?? Date.now(),
  readAt: parseTime(row.read_at),
});

function connect(): void {
  clearTimeout(reconnectTimer);
  lastConnectAt = Date.now();
  if (channel) void supabase.removeChannel(channel);
  channel = null;
  const me = getState().me;
  if (getState().session !== 'signed_in' || !me) return;
  setState({ connection: !navigator.onLine ? 'offline' : everConnected ? 'reconnecting' : 'connecting' });

  const mine = `user_id=eq.${me.id}`;
  const ch: RealtimeChannel = supabase
    .channel(`mx-${me.id}-${Date.now()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'momexpress', table: 'request_events' }, (payload) => {
      if (channel === ch) void onRequestEvent(payload.new as EventRow);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'momexpress', table: 'notifications', filter: mine }, (payload) => {
      if (channel === ch) onNotification(toNotification(payload.new as NotificationRow));
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'momexpress', table: 'notifications', filter: mine }, (payload) => {
      if (channel !== ch) return;
      const n = toNotification(payload.new as NotificationRow);
      setState((s) => ({ notifications: s.notifications.some((x) => x.id === n.id) ? mergeNotifications(s.notifications, [n]) : s.notifications }));
      void refreshUnreadCount();
    });
  channel = ch;

  ch.subscribe((status) => {
    if (channel !== ch) return;
    if (status === 'SUBSCRIBED') {
      reconnectDelay = 2000;
      setState({ connection: 'live' });
      // Catch up on anything that happened while connecting or disconnected.
      void refreshAll().catch(() => {});
      everConnected = true;
      void flushOutbox();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      setState({ connection: navigator.onLine ? 'reconnecting' : 'offline' });
      scheduleReconnect();
    }
  });
}

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (getState().session !== 'signed_in' || getState().connection === 'live') return;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    connect();
  }, reconnectDelay);
}

/** Restarts a connection that has dropped and isn't coming back by itself. */
function checkConnection(): void {
  if (getState().session !== 'signed_in' || !navigator.onLine) return;
  const state = channel?.state;
  if (!channel || ((state === 'closed' || state === 'errored') && Date.now() - lastConnectAt > 15_000)) connect();
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  setUnauthenticatedHandler(() => {
    handleSessionEnded();
    void supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  });
  onPushSubscriptionChange(() => {
    const key = getState().vapidKey;
    if (getState().session === 'signed_in' && key) void syncPushSubscription(key);
  });
  supabase.auth.onAuthStateChange((event) => {
    // The session was ended elsewhere (password changed, signed out remotely, expired).
    if (event === 'SIGNED_OUT') setTimeout(handleSessionEnded, 0);
  });
  window.addEventListener('online', () => {
    if (bootRetry) {
      void boot();
      return;
    }
    if (getState().session === 'signed_in' && getState().connection !== 'live') connect();
    void flushOutbox();
  });
  window.addEventListener('offline', () => {
    if (getState().session === 'signed_in') setState({ connection: 'offline' });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || getState().session !== 'signed_in') return;
    if (bootRetry) {
      void boot();
      return;
    }
    if (getState().connection !== 'live' || channel?.state !== 'joined') connect();
    // A phone may have slept through changes even though the connection looks fine.
    else void refreshAll().catch(() => {});
    void flushOutbox();
  });
}

// ------------------------------------------------------------------ reacting to live changes

async function onRequestEvent(row: EventRow): Promise<void> {
  const gen = generation;
  try {
    const detail = await mx.getRequest(row.request_id);
    if (gen !== generation) return;
    // Only fill in the timeline if it's already loaded; the detail screen loads it when opened.
    if (getState().requestEvents[row.request_id]) mergeEvents(row.request_id, detail.events);
    handleRequestUpdate(detail.request, detail.events.find((e) => e.id === row.id) ?? null);
  } catch {
    // Not visible to this person, or the connection dropped: the next refresh catches up.
  }
}

function handleRequestUpdate(request: DeliveryRequest, event: RequestEvent | null): void {
  const me = getState().me;
  upsertRequests([request]);
  if (event) addEvents([event]);
  scheduleSnapshot();
  if (!me || !event || event.actor?.id === me.id) return;

  const sound = me.prefs.sound;
  if (me.role === 'runner') {
    if (event.type === 'created') {
      markFresh(request.id);
      if (sound) playChime(request.priority === 'urgent' ? 'urgent' : 'new');
      vibrate(request.priority === 'urgent' ? [200, 80, 200, 80, 200] : [140, 60, 140]);
    } else if (event.type === 'cancelled' || event.type === 'edited') {
      if (sound) playChime('update');
    }
    if (event.type === 'delivered' || event.type === 'created') void refreshStats().catch(() => {});
  } else {
    if (['accepted', 'started', 'declined', 'cancelled', 'eta_updated'].includes(event.type)) {
      if (sound && event.type !== 'eta_updated') playChime('update');
    } else if (event.type === 'delivered') {
      if (sound) playChime('delivered');
      vibrate([100, 50, 100, 50, 250]);
    }
  }
}

function onNotification(notification: AppNotification): void {
  setState((s) => ({ notifications: mergeNotifications(s.notifications, [notification]) }));
  void refreshUnreadCount();
  announce(notification);
}

/** The app path being shown, without the base path the app is served from. */
function currentPath(): string {
  const base = withBase('');
  const path = window.location.pathname;
  return base && path.startsWith(base) ? path.slice(base.length) || '/' : path;
}

/** Shows an in-app toast for a new notification, unless the screen already shows it. */
function announce(notification: AppNotification): void {
  if (notification.type === 'submitted' || notification.type === 'test') return;
  if (document.visibilityState !== 'visible') return;
  const path = currentPath();
  if (notification.requestId && path === `/requests/${notification.requestId}`) return;
  // On the dashboard the new card already arrives with a chime and a highlight.
  if (notification.type === 'new_request' && path === '/') return;
  const kind = notification.type === 'declined' || notification.type === 'cancelled' ? 'warning' : notification.type === 'delivered' ? 'success' : 'info';
  toast({
    kind,
    title: notification.title,
    body: notification.body,
    action: notification.requestId ? { label: 'View', run: () => go(`/requests/${notification.requestId}`) } : undefined,
  });
}

// ------------------------------------------------------------------ mutations

/** Puts a request returned by the server into the store. */
export function applyMutation(result: MutationResponse): DeliveryRequest {
  upsertRequests([result.request]);
  if (result.event) addEvents([result.event]);
  scheduleSnapshot();
  return result.request;
}

/** Sends a new request. Mom's usual location is remembered for next time. */
export async function createRequest(payload: NewRequest): Promise<DeliveryRequest> {
  const request = applyMutation(await mx.createRequest(payload));
  setState((s) => (s.me ? { me: { ...s.me, prefs: { ...s.me.prefs, lastLocation: request.location } } } : s));
  return request;
}

export async function markNotificationsRead(target: { ids?: number[]; requestId?: number; all?: true }): Promise<void> {
  const ticket = ++unreadTicket;
  const result = await mx.markRead(target);
  const now = Date.now();
  setState((s) => ({
    notifications: s.notifications.map((n) =>
      !n.readAt && (result.ids === 'all' || result.ids.includes(n.id)) ? { ...n, readAt: now } : n,
    ),
  }));
  if (ticket === unreadTicket) setState({ unreadCount: result.unreadCount });
}

export async function loadMoreNotifications(): Promise<void> {
  const cursor = getState().notificationsCursor;
  if (!cursor) return;
  const gen = generation;
  const ticket = ++unreadTicket;
  const page: NotificationListResponse = await mx.notifications({ before: cursor, limit: 40 });
  if (gen !== generation) return;
  setState((s) => ({
    notifications: mergeNotifications(s.notifications, page.notifications),
    notificationsCursor: page.nextCursor,
  }));
  if (ticket === unreadTicket) setState({ unreadCount: page.unreadCount });
}

// ------------------------------------------------------------------ outbox (requests made offline)

function loadOutbox(userId: string): OutboxItem[] {
  // Anything that was mid-send when the app closed goes back to waiting.
  return (readJson<OutboxItem[]>(keys.outbox(userId)) ?? []).map((i) => (i.state === 'sending' ? { ...i, state: 'waiting' } : i));
}

function saveOutbox(): void {
  const me = getState().me;
  if (me) writeJson(keys.outbox(me.id), getState().outbox);
}

function setOutbox(update: (items: OutboxItem[]) => OutboxItem[]): void {
  if (!getState().me) {
    // The session just ended: keep it on this device for whoever was signed in.
    const owner = readJson<string>(keys.lastUser);
    if (owner) writeJson(keys.outbox(owner), update(loadOutbox(owner)));
    return;
  }
  setState((s) => ({ outbox: update(s.outbox) }));
  saveOutbox();
}

/** Removes queued requests the server already has (e.g. sent just before the connection dropped). */
function dropSentFromOutbox(): void {
  const sent = new Set(Object.values(getState().requests).map((r) => r.clientRequestId));
  if (getState().outbox.some((i) => sent.has(i.clientRequestId) && i.state !== 'sending')) {
    setOutbox((items) => items.filter((i) => i.state === 'sending' || !sent.has(i.clientRequestId)));
  }
}

/** Keeps a request on this device to send as soon as the server is reachable. */
export function queueRequest(payload: OutboxItem['payload']): void {
  setOutbox((items) => [
    ...items.filter((i) => i.clientRequestId !== payload.clientRequestId),
    { clientRequestId: payload.clientRequestId, payload, createdAt: Date.now(), state: 'waiting' },
  ]);
  // Try straight away: the connection may only have blipped.
  setTimeout(() => void flushOutbox(), 1500);
}

export function discardOutboxItem(clientRequestId: string): void {
  setOutbox((items) => items.filter((i) => i.clientRequestId !== clientRequestId));
}

export function retryOutboxItem(clientRequestId: string): void {
  setOutbox((items) => items.map((i) => (i.clientRequestId === clientRequestId ? { ...i, state: 'waiting', error: undefined } : i)));
  void flushOutbox();
}

let flushing = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

export async function flushOutbox(): Promise<void> {
  if (flushing || getState().session !== 'signed_in' || !navigator.onLine) return;
  flushing = true;
  clearTimeout(flushTimer);
  const gen = generation;
  try {
    for (const { clientRequestId } of getState().outbox.filter((i) => i.state === 'waiting')) {
      // Look again: it may have been discarded or sent while an earlier item was going out.
      const item = getState().outbox.find((i) => i.clientRequestId === clientRequestId && i.state === 'waiting');
      if (!item || gen !== generation) continue;
      setOutbox((items) => items.map((i) => (i.clientRequestId === clientRequestId ? { ...i, state: 'sending' } : i)));
      try {
        // The id makes this safe to resend: the server won't create it twice.
        const request = await createRequest(item.payload);
        discardOutboxItem(clientRequestId);
        toast({
          kind: 'success',
          title: 'Request sent',
          body: `“${request.title}” is with your runner now.`,
          action: { label: 'Track', run: () => go(`/requests/${request.id}`) },
        });
      } catch (err) {
        const retry = err instanceof ApiError && (err.isNetwork || err.status === 401);
        setOutbox((items) =>
          items.map((i) =>
            i.clientRequestId === clientRequestId
              ? { ...i, state: retry ? 'waiting' : 'failed', error: retry ? undefined : (err as Error).message }
              : i,
          ),
        );
        if (retry) break;
      }
    }
  } finally {
    flushing = false;
  }
  if (getState().outbox.some((i) => i.state === 'waiting')) flushTimer = setTimeout(() => void flushOutbox(), 20_000);
}

// ------------------------------------------------------------------ offline snapshot

function restoreSnapshot(snapshot: Snapshot): void {
  setState({
    me: snapshot.me,
    requests: Object.fromEntries(snapshot.requests.map((r) => [r.id, r])),
    notifications: snapshot.notifications,
    unreadCount: snapshot.unreadCount,
    activity: snapshot.activity,
    stats: snapshot.stats,
    dataLoaded: true,
    notificationsLoaded: true,
    lastSyncedAt: snapshot.savedAt,
  });
}

let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSnapshot(): void {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(saveSnapshot, 1000);
}

function saveSnapshot(): void {
  const s = getState();
  if (!s.me || s.session !== 'signed_in') return;
  const snapshot: Snapshot = {
    me: s.me,
    requests: [...selectActive(s.requests), ...selectFinished(s.requests).slice(0, 30)],
    notifications: s.notifications.slice(0, 40),
    unreadCount: s.unreadCount,
    activity: s.activity.slice(0, 30),
    stats: s.stats,
    savedAt: s.lastSyncedAt ?? Date.now(),
  };
  writeJson(keys.snapshot(s.me.id), snapshot);
}
