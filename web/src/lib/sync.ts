import type {
  DeliveryRequest,
  LiveEvent,
  MeResponse,
  MutationResponse,
  NotificationListResponse,
  RequestDetailResponse,
  RequestEvent,
  RequestListResponse,
  StatsResponse,
} from '../../../shared/types.js';
import { api, ApiError, setUnauthenticatedHandler } from '../api/client';
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
import { forgetPushOnThisDevice, syncPushSubscription } from './push';
import { playChime, vibrate } from './sound';
import { keys, readJson, removeKey, writeJson } from './storage';
import { applyTheme } from './theme';

// The sync engine: signs in, loads data, keeps a live connection to the
// server, and resends requests that were made while offline. The server is
// always the source of truth; nothing is shown as saved until it confirms.

let source: EventSource | null = null;
let everConnected = false;
let lastMessageAt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 1000;
let watchdog: ReturnType<typeof setInterval> | undefined;
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
let listenersInstalled = false;
/** Set while showing saved data because the server couldn't be reached at startup. */
let bootRetry: ReturnType<typeof setTimeout> | undefined;
let bootRetryDelay = 5000;

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
  try {
    startSession(await api.get<MeResponse>('/api/me'));
    bootRetryDelay = 5000;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setState({ session: 'signed_out', connection: 'connecting' });
      return;
    }
    // Keep trying in the background until the server answers.
    bootRetry = setTimeout(() => void boot(), bootRetryDelay);
    bootRetryDelay = Math.min(bootRetryDelay * 2, 60_000);
    // Server unreachable: show the last synced data, clearly marked as offline.
    const lastUser = readJson<number>(keys.lastUser);
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
}

export function startSession(me: MeResponse): void {
  installListeners();
  clearTimeout(bootRetry);
  bootRetry = undefined;
  const previous = getState().me;
  if (previous && previous.id !== me.user.id) teardown();
  if (!previous || previous.id !== me.user.id) {
    const snapshot = readJson<Snapshot>(keys.snapshot(me.user.id));
    if (snapshot) restoreSnapshot(snapshot);
  }
  setState({
    session: 'signed_in',
    signedOutReason: null,
    me: me.user,
    vapidKey: me.push.publicKey,
    serverBuildId: me.buildId,
    clockOffset: me.serverTime - Date.now(),
    updateAvailable: getState().updateAvailable || isNewBuild(me.buildId),
    outbox: loadOutbox(me.user.id),
  });
  writeJson(keys.lastUser, me.user.id);
  applyTheme(me.user.prefs.theme);
  void refreshAll().catch(() => {});
  connect();
  void flushOutbox();
  if (me.push.publicKey) void syncPushSubscription(me.push.publicKey);
  watchdog ??= setInterval(checkConnection, 10_000);
}

export async function signIn(username: string, password: string): Promise<void> {
  startSession(await api.post<MeResponse>('/api/auth/login', { username, password }));
}

/** Signs out on the server (so this device stops getting notifications), then clears local data. */
export async function signOut(): Promise<void> {
  await api.post('/api/auth/logout');
  const me = getState().me;
  await forgetPushOnThisDevice();
  if (me) {
    removeKey(keys.snapshot(me.id));
    removeKey(keys.outbox(me.id));
  }
  removeKey(keys.lastUser);
  teardown();
  setState({ ...initialState, session: 'signed_out' });
}

function handleSessionEnded(): void {
  if (getState().session !== 'signed_in') return;
  // Unsent requests stay saved on this device and go out after signing back in.
  teardown();
  setState({ ...initialState, session: 'signed_out', signedOutReason: 'expired' });
}

function teardown(): void {
  source?.close();
  source = null;
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

function isNewBuild(buildId: string): boolean {
  return buildId !== 'dev' && __BUILD_ID__ !== 'dev' && buildId !== __BUILD_ID__;
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
  const [active, recent, notes, activity, stats] = await Promise.all([
    api.get<RequestListResponse>('/api/requests?scope=active'),
    api.get<RequestListResponse>('/api/requests?scope=history&limit=20'),
    api.get<NotificationListResponse>('/api/notifications?limit=40'),
    api.get<{ events: RequestEvent[] }>('/api/activity?limit=30'),
    api.get<StatsResponse>(`/api/stats?since=${startOfDay(Date.now())}`),
  ]);

  // Anything we thought was active that isn't any more finished while we
  // weren't listening; fetch its final state so it isn't left looking stuck.
  const seen = new Set([...active.requests, ...recent.requests].map((r) => r.id));
  const missing = selectActive(getState().requests).filter((r) => !seen.has(r.id));
  const finals = await Promise.all(
    missing.map((r) => api.get<RequestDetailResponse>(`/api/requests/${r.id}`).then((d) => d.request).catch(() => null)),
  );

  upsertRequests([...active.requests, ...recent.requests, ...finals.filter((r): r is DeliveryRequest => r !== null)]);
  setState({
    notifications: notes.notifications,
    notificationsCursor: notes.nextCursor,
    notificationsLoaded: true,
    unreadCount: notes.unreadCount,
    activity: activity.events,
    stats,
    dataLoaded: true,
    lastSyncedAt: Date.now(),
    clockOffset: active.serverTime - Date.now(),
  });
  saveSnapshot();
}

export async function loadRequestDetail(id: number): Promise<RequestDetailResponse> {
  const detail = await api.get<RequestDetailResponse>(`/api/requests/${id}`);
  upsertRequests([detail.request]);
  setState((s) => ({ requestEvents: { ...s.requestEvents, [id]: detail.events } }));
  return detail;
}

export async function refreshStats(): Promise<void> {
  const stats = await api.get<StatsResponse>(`/api/stats?since=${startOfDay(Date.now())}`);
  setState({ stats });
}

// ------------------------------------------------------------------ live connection

function connect(): void {
  clearTimeout(reconnectTimer);
  source?.close();
  source = null;
  if (getState().session !== 'signed_in') return;
  setState({ connection: !navigator.onLine ? 'offline' : everConnected ? 'reconnecting' : 'connecting' });

  const es = new EventSource('/api/events');
  source = es;
  lastMessageAt = Date.now();

  const on = <T extends LiveEvent['type']>(type: T, fn: (event: Extract<LiveEvent, { type: T }>) => void) => {
    es.addEventListener(type, (e) => {
      if (source !== es) return;
      lastMessageAt = Date.now();
      fn(JSON.parse((e as MessageEvent<string>).data));
    });
  };

  on('hello', (hello) => {
    reconnectDelay = 1000;
    setState((s) => ({
      connection: 'live',
      clockOffset: hello.serverTime - Date.now(),
      serverBuildId: hello.buildId,
      updateAvailable: s.updateAvailable || isNewBuild(hello.buildId),
    }));
    // Catch up on anything that happened while this connection was being set up
    // or while we were disconnected.
    void refreshAll().catch(() => {});
    everConnected = true;
    void flushOutbox();
  });
  es.addEventListener('ping', () => {
    if (source === es) lastMessageAt = Date.now();
  });
  on('request', ({ request, event }) => handleRequestUpdate(request, event));
  on('notification', ({ notification, unreadCount }) => {
    setState((s) => ({
      notifications: s.notifications.some((n) => n.id === notification.id) ? s.notifications : [notification, ...s.notifications],
      unreadCount,
    }));
    announce(notification);
  });
  on('notifications_read', ({ ids, unreadCount }) => {
    const now = Date.now();
    setState((s) => ({
      notifications: s.notifications.map((n) => (!n.readAt && (ids === 'all' || ids.includes(n.id)) ? { ...n, readAt: now } : n)),
      unreadCount,
    }));
  });
  on('me', ({ user }) => {
    setState({ me: user });
    applyTheme(user.prefs.theme);
  });

  es.onerror = () => {
    if (source !== es) return;
    setState({ connection: navigator.onLine ? 'reconnecting' : 'offline' });
    // The browser retries by itself unless it has given up (e.g. the session ended).
    if (es.readyState === EventSource.CLOSED) scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (getState().session !== 'signed_in') return;
    try {
      await api.get<MeResponse>('/api/me'); // a 401 here signs out
      connect();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      scheduleReconnect();
    }
  }, reconnectDelay);
}

/** Restarts a connection that has gone quiet; phones often drop them silently. */
function checkConnection(): void {
  if (getState().session !== 'signed_in' || !navigator.onLine) return;
  const quiet = Date.now() - lastMessageAt > 50_000;
  if (!source || source.readyState === EventSource.CLOSED || (quiet && getState().connection === 'live')) connect();
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  setUnauthenticatedHandler(handleSessionEnded);
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
    if (!source || source.readyState === EventSource.CLOSED || Date.now() - lastMessageAt > 30_000) connect();
    else void refreshAll().catch(() => {});
    void flushOutbox();
  });
}

// ------------------------------------------------------------------ reacting to live changes

function handleRequestUpdate(request: DeliveryRequest, event: RequestEvent | null): void {
  const state = getState();
  const me = state.me;
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

/** Shows an in-app toast for a new notification, unless the screen already shows it. */
function announce(notification: AppState['notifications'][number]): void {
  if (notification.type === 'submitted' || notification.type === 'test') return;
  if (document.visibilityState !== 'visible') return;
  if (notification.requestId && window.location.pathname === `/requests/${notification.requestId}`) return;
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

export async function markNotificationsRead(target: { ids?: number[]; requestId?: number; all?: true }): Promise<void> {
  const result = await api.post<{ ids: number[] | 'all'; unreadCount: number }>('/api/notifications/read', target);
  const now = Date.now();
  setState((s) => ({
    notifications: s.notifications.map((n) =>
      !n.readAt && (result.ids === 'all' || result.ids.includes(n.id)) ? { ...n, readAt: now } : n,
    ),
    unreadCount: result.unreadCount,
  }));
}

export async function loadMoreNotifications(): Promise<void> {
  const cursor = getState().notificationsCursor;
  if (!cursor) return;
  const page = await api.get<NotificationListResponse>(`/api/notifications?limit=40&before=${cursor}`);
  setState((s) => ({
    notifications: [...s.notifications, ...page.notifications.filter((n) => !s.notifications.some((x) => x.id === n.id))],
    notificationsCursor: page.nextCursor,
    unreadCount: page.unreadCount,
  }));
}

// ------------------------------------------------------------------ outbox (requests made offline)

function loadOutbox(userId: number): OutboxItem[] {
  // Anything that was mid-send when the app closed goes back to waiting.
  return (readJson<OutboxItem[]>(keys.outbox(userId)) ?? []).map((i) => (i.state === 'sending' ? { ...i, state: 'waiting' } : i));
}

function setOutbox(update: (items: OutboxItem[]) => OutboxItem[]): void {
  const me = getState().me;
  setState((s) => ({ outbox: update(s.outbox) }));
  if (me) writeJson(keys.outbox(me.id), getState().outbox);
}

/** Keeps a request on this device to send as soon as the server is reachable. */
export function queueRequest(payload: OutboxItem['payload']): void {
  setOutbox((items) => [
    ...items.filter((i) => i.clientRequestId !== payload.clientRequestId),
    { clientRequestId: payload.clientRequestId, payload, createdAt: Date.now(), state: 'waiting' },
  ]);
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
  if (flushing || getState().session !== 'signed_in') return;
  flushing = true;
  clearTimeout(flushTimer);
  try {
    for (const item of getState().outbox.filter((i) => i.state === 'waiting')) {
      setOutbox((items) => items.map((i) => (i.clientRequestId === item.clientRequestId ? { ...i, state: 'sending' } : i)));
      try {
        // The id makes this safe to resend: the server won't create it twice.
        const result = await api.post<MutationResponse>('/api/requests', item.payload);
        discardOutboxItem(item.clientRequestId);
        const request = applyMutation(result);
        toast({
          kind: 'success',
          title: 'Request sent',
          body: `“${request.title}” is with your runner now.`,
          action: { label: 'Track', run: () => go(`/requests/${request.id}`) },
        });
      } catch (err) {
        const network = err instanceof ApiError && err.isNetwork;
        setOutbox((items) =>
          items.map((i) =>
            i.clientRequestId === item.clientRequestId
              ? { ...i, state: network ? 'waiting' : 'failed', error: network ? undefined : (err as Error).message }
              : i,
          ),
        );
        if (network) break;
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
