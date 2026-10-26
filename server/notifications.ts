import type { AppNotification, NotificationListResponse, NotificationType, Priority } from '../shared/types.js';
import type { DB } from './db.js';
import type { PushService } from './push.js';
import type { LiveHub } from './realtime.js';
import { readPrefs, type UserStore } from './users.js';

interface NotificationRow {
  id: number;
  user_id: number;
  request_id: number | null;
  type: NotificationType;
  title: string;
  body: string;
  created_at: number;
  read_at: number | null;
}

function toNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    type: row.type,
    requestId: row.request_id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export interface NotifyInput {
  type: NotificationType;
  requestId: number | null;
  title: string;
  body: string;
  priority?: Priority;
}

/**
 * Records in-app notifications and fans them out: instantly to open app
 * windows, and as a push notification to the person's devices when they've
 * enabled that kind of notification.
 */
export class Notifier {
  /** Pending push deliveries, so tests and shutdown can wait for them. */
  private inFlight = new Set<Promise<unknown>>();

  constructor(
    private db: DB,
    private users: UserStore,
    private hub: LiveHub,
    private push: PushService,
  ) {}

  notify(userId: number, input: NotifyInput): AppNotification {
    const now = Date.now();
    const result = this.db
      .prepare('INSERT INTO notifications (user_id, request_id, type, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, input.requestId, input.type, input.title, input.body, now);
    const notification: AppNotification = {
      id: Number(result.lastInsertRowid),
      type: input.type,
      requestId: input.requestId,
      title: input.title,
      body: input.body,
      createdAt: now,
      readAt: null,
    };
    const unreadCount = this.unreadCount(userId);
    this.hub.sendToUser(userId, { type: 'notification', notification, unreadCount });

    const user = this.users.byId(userId);
    if (user && (input.type === 'test' || readPrefs(user).push[input.type] !== false)) {
      this.track(
        this.push.sendToUser(userId, {
          title: input.title,
          body: input.body,
          url: input.requestId ? `/requests/${input.requestId}` : '/notifications',
          tag: input.requestId ? `request-${input.requestId}` : `notification-${notification.id}`,
          type: input.type,
          requestId: input.requestId,
          notificationId: notification.id,
          priority: input.priority ?? null,
          badgeCount: unreadCount,
        }),
      );
    }
    return notification;
  }

  unreadCount(userId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId) as { n: number }).n;
  }

  list(userId: number, opts: { limit: number; before?: number }): NotificationListResponse {
    const rows = this.db
      .prepare('SELECT * FROM notifications WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
      .all(userId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit + 1) as unknown as NotificationRow[];
    const page = rows.slice(0, opts.limit);
    return {
      notifications: page.map(toNotification),
      unreadCount: this.unreadCount(userId),
      nextCursor: rows.length > opts.limit ? page[page.length - 1].id : null,
    };
  }

  markRead(userId: number, target: { ids?: number[]; requestId?: number; all?: boolean }): { ids: number[] | 'all'; unreadCount: number } {
    const now = Date.now();
    let ids: number[] | 'all';
    if (target.all) {
      this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, userId);
      ids = 'all';
    } else {
      const candidates = target.requestId
        ? (this.db
            .prepare('SELECT id FROM notifications WHERE user_id = ? AND request_id = ? AND read_at IS NULL')
            .all(userId, target.requestId) as { id: number }[]).map((r) => r.id)
        : (target.ids ?? []);
      const update = this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL');
      ids = candidates.filter((id) => update.run(now, id, userId).changes > 0);
    }
    const unreadCount = this.unreadCount(userId);
    // Keep the person's other devices in step.
    if (ids === 'all' || ids.length > 0) this.hub.sendToUser(userId, { type: 'notifications_read', ids, unreadCount });
    return { ids, unreadCount };
  }

  /** Waits for push deliveries that are still being sent. */
  async settle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.catch((err) => console.warn('[push] unexpected error', err)).finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }
}
