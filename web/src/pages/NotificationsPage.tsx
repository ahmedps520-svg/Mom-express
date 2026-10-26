import {
  Ban,
  Bell,
  BellOff,
  BellRing,
  Bike,
  CheckCheck,
  CircleCheck,
  CircleX,
  Inbox,
  LoaderCircle,
  Pencil,
  Send,
  Share,
  ThumbsUp,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { AppNotification, NotificationType } from '../../../shared/types.js';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeletons';
import { relativeTime } from '../lib/format';
import { useServerNow, useTitle } from '../lib/hooks';
import { loadMoreNotifications, markNotificationsRead } from '../lib/sync';
import { usePush } from '../lib/usePush';
import { useApp } from '../store/app';
import { toast } from '../store/toasts';

const ICONS: Record<NotificationType, LucideIcon> = {
  submitted: Send,
  new_request: Inbox,
  accepted: ThumbsUp,
  started: Bike,
  eta_updated: Timer,
  delivered: CircleCheck,
  declined: CircleX,
  cancelled: Ban,
  details_updated: Pencil,
  test: Bell,
};

/** Explains whether this device gets push notifications, and how to change that. */
export function PushStatusBanner() {
  const { state, busy, enable } = usePush();
  switch (state.kind) {
    case 'off':
      return (
        <div className="banner banner-update">
          <BellRing aria-hidden="true" />
          <span>Turn on notifications to hear about updates even when MomExpress is closed.</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void enable()} disabled={busy}>
            {busy ? 'Turning on…' : 'Turn on'}
          </button>
        </div>
      );
    case 'denied':
      return (
        <div className="banner banner-warning">
          <BellOff aria-hidden="true" />
          <span>Notifications are blocked for MomExpress on this device. You’ll still see everything here; to get alerts, allow notifications in your browser or phone settings.</span>
        </div>
      );
    case 'needs-install':
      return (
        <div className="banner banner-info">
          <Share aria-hidden="true" />
          <span>To get alerts on iPhone or iPad, add MomExpress to your Home Screen (Share → Add to Home Screen) and open it from there.</span>
        </div>
      );
    case 'unsupported':
      return (
        <div className="banner banner-info">
          <BellOff aria-hidden="true" />
          <span>This browser can’t show push notifications. Updates still appear here and live in the app.</span>
        </div>
      );
    default:
      return null;
  }
}

export function NotificationsPage() {
  useTitle('Notifications');
  const navigate = useNavigate();
  const notifications = useApp((s) => s.notifications);
  const unread = useApp((s) => s.unreadCount);
  const loaded = useApp((s) => s.notificationsLoaded);
  const cursor = useApp((s) => s.notificationsCursor);
  const now = useServerNow(30_000);
  const [markingAll, setMarkingAll] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const open = (n: AppNotification) => {
    if (!n.readAt) void markNotificationsRead({ ids: [n.id] }).catch(() => {});
    if (n.requestId) navigate(`/requests/${n.requestId}`);
  };

  const markAll = async () => {
    setMarkingAll(true);
    try {
      await markNotificationsRead({ all: true });
    } catch (err) {
      toast({ kind: 'error', title: 'Couldn’t mark as read', body: (err as Error).message });
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="page-sub">{unread > 0 ? `${unread} unread` : 'You’re all caught up.'}</p>
        </div>
        {unread > 0 && (
          <button type="button" className="btn btn-soft btn-sm" onClick={() => void markAll()} disabled={markingAll}>
            {markingAll ? <LoaderCircle className="spin" aria-hidden="true" /> : <CheckCheck aria-hidden="true" />} Mark all as read
          </button>
        )}
      </div>

      <PushStatusBanner />

      {!loaded ? (
        <div className="card list section">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </div>
      ) : notifications.length === 0 ? (
        <div className="card section">
          <EmptyState icon={Bell} title="No notifications yet" compact>
            Updates about requests will appear here.
          </EmptyState>
        </div>
      ) : (
        <ul className="card list section notif-list">
          {notifications.map((n) => {
            const Icon = ICONS[n.type] ?? Bell;
            return (
              <li key={n.id}>
                <button type="button" className={`list-row notif${n.readAt ? '' : ' unread'}`} onClick={() => open(n)}>
                  <span className={`bubble bubble-sm notif-icon type-${n.type}`} aria-hidden="true">
                    <Icon />
                  </span>
                  <span className="grow stack gap-4">
                    <span className="row gap-8 between">
                      <span className="row-title">{n.title}</span>
                      <time className="subtle nowrap notif-time" dateTime={new Date(n.createdAt).toISOString()}>
                        {relativeTime(n.createdAt, now)}
                      </time>
                    </span>
                    <span className="row-sub">{n.body}</span>
                  </span>
                  {!n.readAt && <span className="unread-dot" aria-label="Unread" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {cursor && (
        <div className="load-more">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loadingMore}
            onClick={async () => {
              setLoadingMore(true);
              try {
                await loadMoreNotifications();
              } catch (err) {
                toast({ kind: 'error', title: 'Couldn’t load more', body: (err as Error).message });
              } finally {
                setLoadingMore(false);
              }
            }}
          >
            {loadingMore ? 'Loading…' : 'Show older'}
          </button>
        </div>
      )}
    </div>
  );
}
