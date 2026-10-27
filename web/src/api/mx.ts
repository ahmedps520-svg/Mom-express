import type {
  DeliveryRequest,
  MeResponse,
  MutationResponse,
  NotificationListResponse,
  PublicUser,
  RequestDetailResponse,
  RequestEvent,
  RequestListResponse,
  StatsResponse,
  UserPrefs,
} from '../../../shared/types.js';
import { rpc } from './client';

// One function per database call the app makes (see the public.mx_* functions
// in supabase/migrations). Each returns the JSON shape from shared/types.ts.

export interface NewRequest {
  clientRequestId: string;
  title: string;
  description: string;
  location: string;
  priority: DeliveryRequest['priority'];
  notes: string;
  quickType: DeliveryRequest['quickType'];
}

export type RequestChanges = Partial<Pick<DeliveryRequest, 'title' | 'description' | 'location' | 'priority' | 'notes'>>;

/** The version of a request's details the person last saw (see check_seen_details). */
const seen = (request: DeliveryRequest) => request.detailsUpdatedAt ?? 0;

export const mx = {
  me: () => rpc<MeResponse>('mx_me'),
  listActive: () => rpc<RequestListResponse>('mx_list_active'),
  listHistory: (opts: { status?: string | null; before?: number | null; limit?: number }) =>
    rpc<RequestListResponse>('mx_list_history', { p_status: opts.status ?? null, p_before: opts.before ?? null, p_limit: opts.limit ?? 30 }),
  getRequest: (id: number) => rpc<RequestDetailResponse>('mx_get_request', { p_id: id }),
  activity: (limit: number) => rpc<{ events: RequestEvent[] }>('mx_activity', { p_limit: limit }),
  stats: (since: number) => rpc<StatsResponse>('mx_stats', { p_since: since }),
  unreadCount: () => rpc<number>('mx_unread_count'),
  notifications: (opts: { before?: number | null; limit?: number }) =>
    rpc<NotificationListResponse>('mx_notifications', { p_before: opts.before ?? null, p_limit: opts.limit ?? 40 }),

  createRequest: (r: NewRequest) =>
    rpc<MutationResponse>('mx_create_request', {
      p_client_request_id: r.clientRequestId,
      p_title: r.title,
      p_location: r.location,
      p_priority: r.priority,
      p_description: r.description,
      p_notes: r.notes,
      p_quick_type: r.quickType,
    }),
  editRequest: (request: DeliveryRequest, changes: RequestChanges) =>
    rpc<MutationResponse>('mx_edit_request', {
      p_id: request.id,
      p_title: changes.title ?? null,
      p_description: changes.description ?? null,
      p_location: changes.location ?? null,
      p_priority: changes.priority ?? null,
      p_notes: changes.notes ?? null,
      p_seen_details_at: seen(request),
    }),
  accept: (request: DeliveryRequest, etaMinutes?: number) =>
    rpc<MutationResponse>('mx_accept', { p_id: request.id, p_eta_minutes: etaMinutes ?? null, p_seen_details_at: seen(request) }),
  decline: (request: DeliveryRequest, reason?: string) => rpc<MutationResponse>('mx_decline', { p_id: request.id, p_reason: reason ?? null }),
  start: (request: DeliveryRequest, etaMinutes?: number) =>
    rpc<MutationResponse>('mx_start', { p_id: request.id, p_eta_minutes: etaMinutes ?? null, p_seen_details_at: seen(request) }),
  setEta: (request: DeliveryRequest, etaMinutes: number) => rpc<MutationResponse>('mx_set_eta', { p_id: request.id, p_eta_minutes: etaMinutes }),
  deliver: (request: DeliveryRequest) => rpc<MutationResponse>('mx_deliver', { p_id: request.id, p_seen_details_at: seen(request) }),
  cancel: (request: DeliveryRequest, reason?: string) => rpc<MutationResponse>('mx_cancel', { p_id: request.id, p_reason: reason ?? null }),

  markRead: (target: { ids?: number[]; requestId?: number; all?: true }) =>
    rpc<{ ids: number[] | 'all'; unreadCount: number }>('mx_mark_read', {
      p_ids: target.ids ?? null,
      p_request_id: target.requestId ?? null,
      p_all: target.all ?? false,
    }),
  updateMe: (changes: { displayName?: string; prefs?: Partial<UserPrefs> }) =>
    rpc<{ user: PublicUser }>('mx_update_me', { p_display_name: changes.displayName ?? null, p_prefs: changes.prefs ?? null }),

  pushSubscribe: (sub: PushSubscriptionJSON) =>
    rpc<{ ok: true }>('mx_push_subscribe', {
      p_endpoint: sub.endpoint,
      p_p256dh: sub.keys?.p256dh,
      p_auth: sub.keys?.auth,
      p_user_agent: navigator.userAgent,
    }),
  pushUnsubscribe: (endpoint: string) => rpc<{ ok: true }>('mx_push_unsubscribe', { p_endpoint: endpoint }),
  pushStatus: (endpoint: string) => rpc<{ subscribed: boolean }>('mx_push_status', { p_endpoint: endpoint }),
};
