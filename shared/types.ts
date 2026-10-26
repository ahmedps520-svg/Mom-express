// Types shared by the server and the web app. These describe the JSON the API
// sends and receives, so both sides agree on a single shape.

export type Role = 'mom' | 'runner';

export type RequestStatus =
  | 'pending'
  | 'accepted'
  | 'in_progress'
  | 'delivered'
  | 'declined'
  | 'cancelled';

export type Priority = 'normal' | 'high' | 'urgent';

export type QuickType = 'water' | 'snack' | 'help' | 'medicine';

export type ThemePreference = 'system' | 'light' | 'dark';

export type NotificationType =
  | 'submitted'
  | 'new_request'
  | 'accepted'
  | 'started'
  | 'eta_updated'
  | 'delivered'
  | 'declined'
  | 'cancelled'
  | 'details_updated'
  | 'test';

export interface UserPrefs {
  /** Push notification categories the user wants on their devices. */
  push: Partial<Record<NotificationType, boolean>>;
  /** Play a sound in the app for incoming requests (runner) or updates (mom). */
  sound: boolean;
  theme: ThemePreference;
  /** Last delivery location Mom used, offered as the default next time. */
  lastLocation?: string;
}

export interface PublicUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  prefs: UserPrefs;
}

export interface PersonRef {
  id: number;
  displayName: string;
}

export interface DeliveryRequest {
  id: number;
  title: string;
  description: string;
  location: string;
  priority: Priority;
  notes: string;
  quickType: QuickType | null;
  status: RequestStatus;
  requester: PersonRef;
  runner: PersonRef | null;
  createdAt: number;
  updatedAt: number;
  acceptedAt: number | null;
  startedAt: number | null;
  deliveredAt: number | null;
  declinedAt: number | null;
  cancelledAt: number | null;
  /** Absolute time the runner estimates the delivery will arrive. */
  etaAt: number | null;
  /** When the current ETA was set, used to draw countdown progress. */
  etaSetAt: number | null;
  declineReason: string | null;
  cancelReason: string | null;
  cancelledBy: PersonRef | null;
  detailsUpdatedAt: number | null;
  version: number;
}

export type RequestEventType =
  | 'created'
  | 'accepted'
  | 'declined'
  | 'started'
  | 'eta_updated'
  | 'delivered'
  | 'cancelled'
  | 'edited';

export interface RequestEvent {
  id: number;
  requestId: number;
  requestTitle: string;
  type: RequestEventType;
  actor: PersonRef | null;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface AppNotification {
  id: number;
  type: NotificationType;
  requestId: number | null;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
}

export interface MeResponse {
  user: PublicUser;
  serverTime: number;
  buildId: string;
  push: { publicKey: string | null };
}

export interface RequestListResponse {
  requests: DeliveryRequest[];
  /** Cursor for the next page of history, or null when there is no more. */
  nextCursor: number | null;
  serverTime: number;
}

export interface RequestDetailResponse {
  request: DeliveryRequest;
  events: RequestEvent[];
  serverTime: number;
}

export interface MutationResponse {
  request: DeliveryRequest;
  event: RequestEvent | null;
  /** True when the action had already been applied (a safe retry). */
  alreadyApplied?: boolean;
  serverTime: number;
}

export interface NotificationListResponse {
  notifications: AppNotification[];
  unreadCount: number;
  nextCursor: number | null;
}

export interface StatsResponse {
  deliveredToday: number;
  averageMinutesToday: number | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
  /** Included on conflicts so the client can show the latest state. */
  request?: DeliveryRequest;
}

/** Events pushed to signed-in clients over the live connection. */
export type LiveEvent =
  | { type: 'hello'; serverTime: number; buildId: string }
  | { type: 'request'; request: DeliveryRequest; event: RequestEvent | null }
  | { type: 'notification'; notification: AppNotification; unreadCount: number }
  | { type: 'notifications_read'; ids: number[] | 'all'; unreadCount: number }
  | { type: 'me'; user: PublicUser };
