import { PRIORITY_LABELS, SIGNIFICANT_ETA_CHANGE_MS } from '../shared/constants.js';
import { ACTION_TARGET, ACTIVE_STATUSES, checkAction, FINAL_STATUSES, type RequestAction } from '../shared/lifecycle.js';
import type {
  DeliveryRequest,
  MutationResponse,
  Priority,
  QuickType,
  RequestEvent,
  RequestEventType,
  RequestStatus,
  StatsResponse,
} from '../shared/types.js';
import { transaction, type DB } from './db.js';
import { HttpError, notFound } from './http.js';
import type { Notifier } from './notifications.js';
import type { LiveHub } from './realtime.js';
import type { UserRow, UserStore } from './users.js';

interface RequestRow {
  id: number;
  requester_id: number;
  runner_id: number | null;
  client_request_id: string;
  title: string;
  description: string;
  location: string;
  priority: Priority;
  notes: string;
  quick_type: QuickType | null;
  status: RequestStatus;
  created_at: number;
  updated_at: number;
  accepted_at: number | null;
  started_at: number | null;
  delivered_at: number | null;
  declined_at: number | null;
  cancelled_at: number | null;
  eta_at: number | null;
  eta_set_at: number | null;
  decline_reason: string | null;
  cancel_reason: string | null;
  cancelled_by: number | null;
  details_updated_at: number | null;
  version: number;
  requester_name: string;
  runner_name: string | null;
  cancelled_by_name: string | null;
}

interface EventRow {
  id: number;
  request_id: number;
  request_title: string;
  actor_id: number | null;
  actor_name: string | null;
  type: RequestEventType;
  data: string;
  created_at: number;
}

const SELECT_REQUEST = `
  SELECT r.*, rq.display_name AS requester_name, rn.display_name AS runner_name, cb.display_name AS cancelled_by_name
  FROM requests r
  JOIN users rq ON rq.id = r.requester_id
  LEFT JOIN users rn ON rn.id = r.runner_id
  LEFT JOIN users cb ON cb.id = r.cancelled_by`;

const SELECT_EVENT = `
  SELECT e.id, e.request_id, r.title AS request_title, e.actor_id, u.display_name AS actor_name, e.type, e.data, e.created_at
  FROM request_events e
  JOIN requests r ON r.id = e.request_id
  LEFT JOIN users u ON u.id = e.actor_id`;

function toRequest(row: RequestRow): DeliveryRequest {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    priority: row.priority,
    notes: row.notes,
    quickType: row.quick_type,
    status: row.status,
    requester: { id: row.requester_id, displayName: row.requester_name },
    runner: row.runner_id ? { id: row.runner_id, displayName: row.runner_name ?? 'Runner' } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    deliveredAt: row.delivered_at,
    declinedAt: row.declined_at,
    cancelledAt: row.cancelled_at,
    etaAt: row.eta_at,
    etaSetAt: row.eta_set_at,
    declineReason: row.decline_reason,
    cancelReason: row.cancel_reason,
    cancelledBy: row.cancelled_by ? { id: row.cancelled_by, displayName: row.cancelled_by_name ?? '' } : null,
    detailsUpdatedAt: row.details_updated_at,
    version: row.version,
  };
}

function toEvent(row: EventRow): RequestEvent {
  return {
    id: row.id,
    requestId: row.request_id,
    requestTitle: row.request_title,
    type: row.type,
    actor: row.actor_id ? { id: row.actor_id, displayName: row.actor_name ?? '' } : null,
    data: JSON.parse(row.data) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

const minutesUntil = (at: number, now: number) => Math.max(1, Math.round((at - now) / 60_000));
const quote = (s: string) => `“${s}”`;

export interface CreateInput {
  clientRequestId: string;
  title: string;
  description: string;
  location: string;
  priority: Priority;
  notes: string;
  quickType: QuickType | null;
}

export type DetailChanges = Partial<Pick<CreateInput, 'title' | 'description' | 'location' | 'priority' | 'notes'>>;

/**
 * The delivery workflow. Every change goes through here: it checks the action
 * is allowed for this person and this request's current state, saves it with
 * an entry in the request's history, then tells everyone involved.
 */
export class RequestService {
  constructor(
    private db: DB,
    private users: UserStore,
    private hub: LiveHub,
    private notifier: Notifier,
  ) {}

  // ---------------------------------------------------------------- reading

  /** Fetches a request the actor may see. Other people's requests look like they don't exist. */
  getVisible(actor: UserRow, id: number): DeliveryRequest {
    const row = this.db.prepare(`${SELECT_REQUEST} WHERE r.id = ?`).get(id) as RequestRow | undefined;
    if (!row || (actor.role === 'mom' && row.requester_id !== actor.id)) throw notFound('We couldn’t find that request.');
    return toRequest(row);
  }

  listActive(actor: UserRow): DeliveryRequest[] {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const rows = (
      actor.role === 'mom'
        ? this.db.prepare(`${SELECT_REQUEST} WHERE r.status IN (${placeholders}) AND r.requester_id = ? ORDER BY r.id`).all(...ACTIVE_STATUSES, actor.id)
        : this.db.prepare(`${SELECT_REQUEST} WHERE r.status IN (${placeholders}) ORDER BY r.id`).all(...ACTIVE_STATUSES)
    ) as unknown as RequestRow[];
    return rows.map(toRequest);
  }

  /** Finished requests, newest first, optionally filtered to one final status. */
  listHistory(actor: UserRow, opts: { status?: RequestStatus; before?: number; limit: number }): { requests: DeliveryRequest[]; nextCursor: number | null } {
    const statuses = opts.status ? [opts.status] : FINAL_STATUSES;
    const placeholders = statuses.map(() => '?').join(', ');
    const params: (string | number)[] = [...statuses, opts.before ?? Number.MAX_SAFE_INTEGER];
    let sql = `${SELECT_REQUEST} WHERE r.status IN (${placeholders}) AND r.id < ?`;
    if (actor.role === 'mom') {
      sql += ' AND r.requester_id = ?';
      params.push(actor.id);
    }
    sql += ' ORDER BY r.id DESC LIMIT ?';
    params.push(opts.limit + 1);
    const rows = this.db.prepare(sql).all(...params) as unknown as RequestRow[];
    const page = rows.slice(0, opts.limit);
    return { requests: page.map(toRequest), nextCursor: rows.length > opts.limit ? page[page.length - 1].id : null };
  }

  events(actor: UserRow, requestId: number): RequestEvent[] {
    this.getVisible(actor, requestId);
    const rows = this.db.prepare(`${SELECT_EVENT} WHERE e.request_id = ? ORDER BY e.id`).all(requestId) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /** Recent activity across the requests the actor can see. */
  recentActivity(actor: UserRow, limit: number): RequestEvent[] {
    const rows = (
      actor.role === 'mom'
        ? this.db.prepare(`${SELECT_EVENT} WHERE r.requester_id = ? ORDER BY e.id DESC LIMIT ?`).all(actor.id, limit)
        : this.db.prepare(`${SELECT_EVENT} ORDER BY e.id DESC LIMIT ?`).all(limit)
    ) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  stats(actor: UserRow, since: number): StatsResponse {
    const row = (
      actor.role === 'mom'
        ? this.db
            .prepare(
              `SELECT COUNT(*) AS n, AVG(delivered_at - created_at) AS avg FROM requests
               WHERE status = 'delivered' AND delivered_at >= ? AND requester_id = ?`,
            )
            .get(since, actor.id)
        : this.db
            .prepare(
              `SELECT COUNT(*) AS n, AVG(delivered_at - created_at) AS avg FROM requests
               WHERE status = 'delivered' AND delivered_at >= ? AND runner_id = ?`,
            )
            .get(since, actor.id)
    ) as { n: number; avg: number | null };
    return { deliveredToday: row.n, averageMinutesToday: row.avg == null ? null : Math.round(row.avg / 60_000) };
  }

  // ---------------------------------------------------------------- changes

  create(actor: UserRow, input: CreateInput): MutationResponse & { created: boolean } {
    if (actor.role !== 'mom') throw new HttpError(403, 'forbidden', 'Only Mom can send requests.');

    // The same submission arriving twice (a double tap, or a retry after a
    // dropped connection) returns the request that was already created.
    const existing = this.db
      .prepare(`${SELECT_REQUEST} WHERE r.requester_id = ? AND r.client_request_id = ?`)
      .get(actor.id, input.clientRequestId) as RequestRow | undefined;
    if (existing) return { request: toRequest(existing), event: null, alreadyApplied: true, created: false, serverTime: Date.now() };

    const now = Date.now();
    const { request, event } = transaction(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT INTO requests (requester_id, client_request_id, title, description, location, priority, notes, quick_type, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(actor.id, input.clientRequestId, input.title, input.description, input.location, input.priority, input.notes, input.quickType, now, now);
      const id = Number(result.lastInsertRowid);
      const event = this.addEvent(id, actor.id, 'created', { priority: input.priority, location: input.location }, now);
      return { request: this.load(id), event };
    });

    // Remember where Mom usually wants things, to pre-select it next time.
    this.users.update(actor.id, { prefs: { lastLocation: input.location } });

    this.broadcast(request, event);
    const runners = this.users.activeByRole('runner');
    for (const runner of runners) {
      this.notifier.notify(runner.id, {
        type: 'new_request',
        requestId: request.id,
        title:
          request.priority === 'urgent'
            ? `Urgent request from ${actor.display_name}`
            : request.priority === 'high'
              ? `High-priority request from ${actor.display_name}`
              : `New request from ${actor.display_name}`,
        body: `${request.title} · ${request.location}`,
        priority: request.priority,
      });
    }
    const who = runners.length === 1 ? runners[0].display_name : runners.length ? 'your runners' : null;
    this.notifier.notify(actor.id, {
      type: 'submitted',
      requestId: request.id,
      title: 'Request sent',
      body: who ? `${who} has been notified about ${quote(request.title)}.` : `${quote(request.title)} is saved, but no runner account has been set up yet.`,
    });

    return { request, event, created: true, serverTime: Date.now() };
  }

  edit(actor: UserRow, id: number, changes: DetailChanges): MutationResponse {
    const current = this.getVisible(actor, id);
    this.assertAllowed('edit', current, actor);

    const changed: Record<string, { from: string; to: string }> = {};
    for (const key of ['title', 'description', 'location', 'priority', 'notes'] as const) {
      const next = changes[key];
      if (next !== undefined && next !== current[key]) changed[key] = { from: current[key], to: next };
    }
    if (Object.keys(changed).length === 0) return { request: current, event: null, alreadyApplied: true, serverTime: Date.now() };

    const now = Date.now();
    const { request, event } = this.update(current, now, {
      title: changes.title ?? current.title,
      description: changes.description ?? current.description,
      location: changes.location ?? current.location,
      priority: changes.priority ?? current.priority,
      notes: changes.notes ?? current.notes,
      details_updated_at: now,
    }, { type: 'edited', actorId: actor.id, data: { changes: changed } });

    const summary = describeChanges(changed);
    const recipients = request.runner ? [request.runner.id] : this.users.activeByRole('runner').map((u) => u.id);
    for (const runnerId of recipients) {
      this.notifier.notify(runnerId, {
        type: 'details_updated',
        requestId: request.id,
        title: `${actor.display_name} updated a request`,
        body: `${quote(request.title)}: ${summary}`,
        priority: request.priority,
      });
    }
    return { request, event, serverTime: Date.now() };
  }

  accept(actor: UserRow, id: number, etaMinutes?: number): MutationResponse {
    return this.transition(actor, id, 'accept', (current, now) => {
      const eta = etaMinutes ? now + etaMinutes * 60_000 : null;
      return {
        sets: { status: 'accepted', runner_id: actor.id, accepted_at: now, eta_at: eta, eta_set_at: eta ? now : null },
        data: eta ? { etaAt: eta } : {},
        after: (request) => {
          this.notifier.notify(request.requester.id, {
            type: 'accepted',
            requestId: request.id,
            title: `${actor.display_name} accepted your request`,
            body: `${quote(request.title)} · ${eta ? `ETA about ${minutesUntil(eta, now)} min` : 'ETA coming soon'}`,
            priority: current.priority,
          });
        },
      };
    });
  }

  decline(actor: UserRow, id: number, reason?: string): MutationResponse {
    return this.transition(actor, id, 'decline', (current, now) => ({
      sets: { status: 'declined', runner_id: actor.id, declined_at: now, decline_reason: reason || null },
      data: reason ? { reason } : {},
      after: (request) => {
        this.notifier.notify(request.requester.id, {
          type: 'declined',
          requestId: request.id,
          title: 'Request declined',
          body: `${actor.display_name} can’t take ${quote(request.title)} right now${reason ? `: ${reason}` : '.'}`,
          priority: current.priority,
        });
      },
    }));
  }

  start(actor: UserRow, id: number, etaMinutes?: number): MutationResponse {
    return this.transition(actor, id, 'start', (current, now) => {
      const eta = etaMinutes ? now + etaMinutes * 60_000 : current.etaAt;
      return {
        sets: {
          status: 'in_progress',
          started_at: now,
          ...(etaMinutes ? { eta_at: eta, eta_set_at: now } : {}),
        },
        data: etaMinutes ? { etaAt: eta } : {},
        after: (request) => {
          const etaText = eta && eta > now ? ` · about ${minutesUntil(eta, now)} min` : '';
          this.notifier.notify(request.requester.id, {
            type: 'started',
            requestId: request.id,
            title: 'Your delivery is on the way',
            body: `${quote(request.title)} → ${request.location}${etaText}`,
            priority: current.priority,
          });
        },
      };
    });
  }

  setEta(actor: UserRow, id: number, etaMinutes: number): MutationResponse {
    const current = this.getVisible(actor, id);
    this.assertAllowed('set_eta', current, actor);
    const now = Date.now();
    const eta = now + etaMinutes * 60_000;
    const previous = current.etaAt;
    const { request, event } = this.update(current, now, { eta_at: eta, eta_set_at: now }, {
      type: 'eta_updated',
      actorId: actor.id,
      data: { etaAt: eta, previousEtaAt: previous },
    });
    // Small nudges aren't worth interrupting Mom for; the live view still updates.
    if (previous === null || Math.abs(eta - previous) >= SIGNIFICANT_ETA_CHANGE_MS) {
      this.notifier.notify(request.requester.id, {
        type: 'eta_updated',
        requestId: request.id,
        title: `New ETA: about ${etaMinutes} min`,
        body: `${actor.display_name} updated the estimate for ${quote(request.title)}.`,
        priority: request.priority,
      });
    }
    return { request, event, serverTime: Date.now() };
  }

  deliver(actor: UserRow, id: number): MutationResponse {
    return this.transition(actor, id, 'deliver', (current, now) => ({
      sets: { status: 'delivered', delivered_at: now },
      data: {},
      after: (request) => {
        this.notifier.notify(request.requester.id, {
          type: 'delivered',
          requestId: request.id,
          title: 'Delivered!',
          body: `${quote(request.title)} was delivered to ${request.location}. Enjoy!`,
          priority: current.priority,
        });
      },
    }));
  }

  cancel(actor: UserRow, id: number, reason?: string): MutationResponse {
    return this.transition(actor, id, 'cancel', (current, now) => ({
      sets: { status: 'cancelled', cancelled_at: now, cancelled_by: actor.id, cancel_reason: reason || null },
      data: { previousStatus: current.status, ...(reason ? { reason } : {}) },
      after: (request) => {
        if (actor.role === 'mom') {
          // Whoever might be working on it needs to know it's off.
          const recipients = current.runner ? [current.runner.id] : this.users.activeByRole('runner').map((u) => u.id);
          for (const runnerId of recipients) {
            this.notifier.notify(runnerId, {
              type: 'cancelled',
              requestId: request.id,
              title: `${actor.display_name} cancelled a request`,
              body: `${quote(request.title)} is no longer needed${reason ? `: ${reason}` : '.'}`,
              priority: current.priority,
            });
          }
        } else {
          this.notifier.notify(request.requester.id, {
            type: 'cancelled',
            requestId: request.id,
            title: 'Delivery cancelled',
            body: `${actor.display_name} couldn’t finish ${quote(request.title)}${reason ? `: ${reason}` : '.'}`,
            priority: current.priority,
          });
        }
      },
    }));
  }

  // ---------------------------------------------------------------- internals

  private load(id: number): DeliveryRequest {
    return toRequest(this.db.prepare(`${SELECT_REQUEST} WHERE r.id = ?`).get(id) as unknown as RequestRow);
  }

  private assertAllowed(action: RequestAction, request: DeliveryRequest, actor: UserRow): void {
    const check = checkAction(action, request, { id: actor.id, role: actor.role });
    if (!check.ok) {
      throw new HttpError(check.code === 'forbidden' ? 403 : 409, check.code, check.message, { request });
    }
  }

  /** True when a status action has already been applied by this same person (a retry). */
  private alreadyApplied(action: RequestAction, request: DeliveryRequest, actor: UserRow): boolean {
    if (request.status !== ACTION_TARGET[action]) return false;
    if (action === 'cancel') return request.cancelledBy?.id === actor.id;
    return request.runner?.id === actor.id;
  }

  private transition(
    actor: UserRow,
    id: number,
    action: RequestAction,
    plan: (
      current: DeliveryRequest,
      now: number,
    ) => { sets: Record<string, string | number | null>; data: Record<string, unknown>; after: (request: DeliveryRequest) => void },
  ): MutationResponse {
    const current = this.getVisible(actor, id);
    if (this.alreadyApplied(action, current, actor)) {
      return { request: current, event: null, alreadyApplied: true, serverTime: Date.now() };
    }
    this.assertAllowed(action, current, actor);
    const now = Date.now();
    const { sets, data, after } = plan(current, now);
    const eventType: RequestEventType = (
      { accept: 'accepted', decline: 'declined', start: 'started', deliver: 'delivered', cancel: 'cancelled' } as const
    )[action as 'accept'];
    const { request, event } = this.update(current, now, sets, { type: eventType, actorId: actor.id, data });
    after(request);
    return { request, event, serverTime: Date.now() };
  }

  /**
   * Applies changes only if nobody else changed the request since it was read
   * (its version still matches), records the history entry, and broadcasts.
   */
  private update(
    current: DeliveryRequest,
    now: number,
    sets: Record<string, string | number | null>,
    eventInput: { type: RequestEventType; actorId: number; data: Record<string, unknown> },
  ): { request: DeliveryRequest; event: RequestEvent } {
    const columns = Object.keys(sets);
    const result = transaction(this.db, () => {
      const changes = this.db
        .prepare(
          `UPDATE requests SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ?, version = version + 1
           WHERE id = ? AND version = ?`,
        )
        .run(...columns.map((c) => sets[c]), now, current.id, current.version).changes;
      if (changes === 0) return null;
      const event = this.addEvent(current.id, eventInput.actorId, eventInput.type, eventInput.data, now);
      return { request: this.load(current.id), event };
    });
    if (!result) {
      const latest = this.load(current.id);
      throw new HttpError(409, 'conflict', 'This request just changed. Here’s the latest.', { request: latest });
    }
    this.broadcast(result.request, result.event);
    return result;
  }

  private addEvent(requestId: number, actorId: number, type: RequestEventType, data: Record<string, unknown>, now: number): RequestEvent {
    const result = this.db
      .prepare('INSERT INTO request_events (request_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(requestId, actorId, type, JSON.stringify(data), now);
    return toEvent(this.db.prepare(`${SELECT_EVENT} WHERE e.id = ?`).get(Number(result.lastInsertRowid)) as unknown as EventRow);
  }

  /** Sends the latest version of a request to everyone allowed to see it. */
  private broadcast(request: DeliveryRequest, event: RequestEvent | null): void {
    const audience = new Set([request.requester.id, ...this.users.activeByRole('runner').map((u) => u.id)]);
    this.hub.sendToUsers(audience, { type: 'request', request, event });
  }
}

function describeChanges(changed: Record<string, { from: string; to: string }>): string {
  const parts: string[] = [];
  if (changed.title) parts.push(`now ${quote(changed.title.to)}`);
  if (changed.location) parts.push(`deliver to ${changed.location.to}`);
  if (changed.priority) parts.push(`priority ${PRIORITY_LABELS[changed.priority.to as Priority]}`);
  if (changed.description) parts.push('description changed');
  if (changed.notes) parts.push('notes changed');
  return parts.join(' · ');
}
