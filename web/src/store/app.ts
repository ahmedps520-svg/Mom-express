import { create } from 'zustand';
import { isActive } from '../../../shared/lifecycle.js';
import type {
  AppNotification,
  DeliveryRequest,
  PublicUser,
  RequestEvent,
  StatsResponse,
} from '../../../shared/types.js';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** A request Mom created that hasn't reached the server yet. */
export interface OutboxItem {
  clientRequestId: string;
  payload: {
    clientRequestId: string;
    title: string;
    description: string;
    location: string;
    priority: DeliveryRequest['priority'];
    notes: string;
    quickType: DeliveryRequest['quickType'];
  };
  createdAt: number;
  state: 'waiting' | 'sending' | 'failed';
  error?: string;
}

export interface AppState {
  session: 'booting' | 'signed_out' | 'signed_in';
  signedOutReason: 'expired' | null;
  me: PublicUser | null;
  vapidKey: string | null;
  serverBuildId: string | null;
  /** Server time minus device time, so countdowns are right even if the device clock is off. */
  clockOffset: number;

  requests: Record<number, DeliveryRequest>;
  /** History entries per request, for the detail timeline. */
  requestEvents: Record<number, RequestEvent[]>;
  /** Request ids that just arrived, for a short highlight animation. */
  fresh: Record<number, number>;
  dataLoaded: boolean;
  activity: RequestEvent[];
  stats: StatsResponse | null;

  notifications: AppNotification[];
  notificationsCursor: number | null;
  notificationsLoaded: boolean;
  unreadCount: number;

  connection: Connection;
  lastSyncedAt: number | null;
  outbox: OutboxItem[];
  updateAvailable: boolean;
}

export const initialState: AppState = {
  session: 'booting',
  signedOutReason: null,
  me: null,
  vapidKey: null,
  serverBuildId: null,
  clockOffset: 0,
  requests: {},
  requestEvents: {},
  fresh: {},
  dataLoaded: false,
  activity: [],
  stats: null,
  notifications: [],
  notificationsCursor: null,
  notificationsLoaded: false,
  unreadCount: 0,
  connection: 'connecting',
  lastSyncedAt: null,
  outbox: [],
  updateAvailable: false,
};

export const useApp = create<AppState>()(() => initialState);

export const getState = useApp.getState;
export const setState = useApp.setState;

export function serverNow(): number {
  return Date.now() + getState().clockOffset;
}

/** Keeps whichever copy of a request is newer, so late responses never undo live updates. */
function isNewer(incoming: DeliveryRequest, existing: DeliveryRequest | undefined): boolean {
  if (!existing) return true;
  if (incoming.version !== existing.version) return incoming.version > existing.version;
  return incoming.updatedAt >= existing.updatedAt;
}

export function upsertRequests(list: DeliveryRequest[]): void {
  if (list.length === 0) return;
  setState((s) => {
    let changed = false;
    const requests = { ...s.requests };
    for (const r of list) {
      if (isNewer(r, requests[r.id])) {
        requests[r.id] = r;
        changed = true;
      }
    }
    return changed ? { requests } : s;
  });
}

export function addEvents(events: RequestEvent[]): void {
  if (events.length === 0) return;
  setState((s) => {
    const requestEvents = { ...s.requestEvents };
    let activity = s.activity;
    for (const e of events) {
      const existing = requestEvents[e.requestId];
      if (existing && !existing.some((x) => x.id === e.id)) {
        requestEvents[e.requestId] = [...existing, e].sort((a, b) => a.id - b.id);
      }
      if (!activity.some((x) => x.id === e.id)) {
        activity = [e, ...activity].sort((a, b) => b.id - a.id).slice(0, 40);
      }
    }
    return { requestEvents, activity };
  });
}

export function markFresh(id: number): void {
  setState((s) => ({ fresh: { ...s.fresh, [id]: Date.now() } }));
  setTimeout(() => {
    setState((s) => {
      const fresh = { ...s.fresh };
      delete fresh[id];
      return { fresh };
    });
  }, 8000);
}

// ------------------------------------------------------------ selectors

const priorityRank = { urgent: 0, high: 1, normal: 2 } as const;

/** Most urgent first, then oldest first: the order a runner should handle them. */
export function byUrgency(a: DeliveryRequest, b: DeliveryRequest): number {
  return priorityRank[a.priority] - priorityRank[b.priority] || a.createdAt - b.createdAt;
}

export function finishedAt(r: DeliveryRequest): number {
  return r.deliveredAt ?? r.cancelledAt ?? r.declinedAt ?? r.updatedAt;
}

export function selectActive(requests: Record<number, DeliveryRequest>): DeliveryRequest[] {
  return Object.values(requests).filter((r) => isActive(r.status));
}

export function selectFinished(requests: Record<number, DeliveryRequest>): DeliveryRequest[] {
  return Object.values(requests)
    .filter((r) => !isActive(r.status))
    .sort((a, b) => b.id - a.id);
}
