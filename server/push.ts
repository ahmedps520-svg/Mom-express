import webpush, { type PushSubscription, type RequestOptions, type SendResult } from 'web-push';
import type { NotificationType, Priority } from '../shared/types.js';
import { getKv, setKv, type DB } from './db.js';

export interface PushPayload {
  title: string;
  body: string;
  /** Where the app should open when the notification is clicked. */
  url: string;
  tag: string;
  type: NotificationType;
  requestId: number | null;
  notificationId: number | null;
  priority: Priority | null;
  badgeCount: number;
}

export type PushSender = (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<SendResult>;

interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOutcome {
  attempted: number;
  delivered: number;
}

/**
 * Sends Web Push notifications with VAPID. Keys come from the environment, or
 * are generated once and stored in the database so subscriptions stay valid
 * across restarts.
 */
export class PushService {
  readonly publicKey: string;
  private readonly privateKey: string;

  constructor(
    private db: DB,
    private subject: string,
    keys: { publicKey?: string; privateKey?: string },
    private sender: PushSender = webpush.sendNotification.bind(webpush),
  ) {
    if (keys.publicKey && keys.privateKey) {
      this.publicKey = keys.publicKey;
      this.privateKey = keys.privateKey;
    } else {
      const stored = getKv(db, 'vapid_keys');
      if (stored) {
        ({ publicKey: this.publicKey, privateKey: this.privateKey } = JSON.parse(stored) as { publicKey: string; privateKey: string });
      } else {
        const generated = webpush.generateVAPIDKeys();
        setKv(db, 'vapid_keys', JSON.stringify(generated));
        this.publicKey = generated.publicKey;
        this.privateKey = generated.privateKey;
      }
    }
  }

  saveSubscription(input: {
    userId: number;
    sessionId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string;
  }): void {
    // The endpoint is unique per browser install; re-subscribing (or a different
    // person signing in on the same device) moves it to the current session.
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id, session_id = excluded.session_id, p256dh = excluded.p256dh,
           auth = excluded.auth, user_agent = excluded.user_agent, failure_count = 0`,
      )
      .run(input.userId, input.sessionId, input.endpoint, input.p256dh, input.auth, input.userAgent?.slice(0, 300) ?? null, Date.now());
  }

  removeSubscription(userId: number, endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
  }

  hasSubscription(userId: number, endpoint: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').get(userId, endpoint);
  }

  async sendToUser(userId: number, payload: PushPayload): Promise<PushOutcome> {
    const subscriptions = this.db
      .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
      .all(userId) as unknown as SubscriptionRow[];
    if (subscriptions.length === 0) return { attempted: 0, delivered: 0 };

    const urgent = payload.priority === 'urgent' || payload.type === 'new_request';
    const options: RequestOptions = {
      vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
      // Household requests are only useful for a while; don't deliver stale ones days later.
      TTL: 60 * 60,
      urgency: urgent ? 'high' : 'normal',
      // Collapses repeated updates about the same request into the latest one
      // while a device is offline (topics allow only URL-safe characters).
      topic: payload.requestId ? `request-${payload.requestId}` : undefined,
      timeout: 10_000,
    };
    const body = JSON.stringify(payload);

    const results = await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await this.sender({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, options);
          this.db.prepare('UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?').run(Date.now(), sub.id);
          return true;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // The browser dropped this subscription; it will never work again.
            this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
          } else {
            this.db.prepare('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?').run(sub.id);
            console.warn(`[push] delivery failed (${status ?? (err as Error).message})`);
          }
          return false;
        }
      }),
    );
    return { attempted: subscriptions.length, delivered: results.filter(Boolean).length };
  }
}
