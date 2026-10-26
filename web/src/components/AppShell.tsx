import { Bell, CloudOff, History, House, Inbox, Plus, RefreshCw, Settings, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { firstName, initials, relativeTime } from '../lib/format';
import { applyUpdate } from '../lib/sw';
import { useApp } from '../store/app';
import { BrandLockup } from './BrandMark';

function Count({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="count-badge" aria-label={`${n} unread`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

function ConnectionPill() {
  const connection = useApp((s) => s.connection);
  const label = { live: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting', offline: 'Offline' }[connection];
  return (
    <span className={`conn-dot ${connection}`} role="status" title={connection === 'live' ? 'Receiving live updates' : undefined}>
      {label}
    </span>
  );
}

/** Explains connection problems and pending updates at the top of every screen. */
function StatusBanners() {
  const connection = useApp((s) => s.connection);
  const lastSyncedAt = useApp((s) => s.lastSyncedAt);
  const updateAvailable = useApp((s) => s.updateAvailable);
  const [showReconnecting, setShowReconnecting] = useState(false);
  const [updating, setUpdating] = useState(false);

  // Brief blips are normal; only mention reconnecting if it takes a moment.
  useEffect(() => {
    if (connection !== 'reconnecting') {
      setShowReconnecting(false);
      return;
    }
    const t = setTimeout(() => setShowReconnecting(true), 4000);
    return () => clearTimeout(t);
  }, [connection]);

  if (!updateAvailable && connection !== 'offline' && !showReconnecting) return null;
  return (
    <div className="banner-stack">
      {updateAvailable && (
        <div className="banner banner-update" role="status">
          <Sparkles aria-hidden="true" />
          <span>A new version of MomExpress is ready.</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={updating}
            onClick={() => {
              setUpdating(true);
              void applyUpdate();
            }}
          >
            {updating ? 'Updating…' : 'Update'}
          </button>
        </div>
      )}
      {connection === 'offline' && (
        <div className="banner banner-offline" role="status">
          <CloudOff aria-hidden="true" />
          <span>
            You’re offline.{' '}
            {lastSyncedAt ? `Showing what was last synced ${relativeTime(lastSyncedAt)}. ` : ''}
            Changes can’t be saved until you reconnect.
          </span>
        </div>
      )}
      {connection === 'reconnecting' && showReconnecting && (
        <div className="banner banner-reconnecting" role="status">
          <RefreshCw className="spin" aria-hidden="true" />
          <span>Reconnecting… Live updates are paused for a moment.</span>
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const me = useApp((s) => s.me)!;
  const unread = useApp((s) => s.unreadCount);
  const pending = useApp((s) => Object.values(s.requests).filter((r) => r.status === 'pending').length);
  const [scrolled, setScrolled] = useState(false);
  const isMom = me.role === 'mom';

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const homeLabel = isMom ? 'Home' : 'Dashboard';
  const HomeIcon = isMom ? House : Inbox;

  return (
    <div className="app">
      <aside className="sidebar">
        <Link to="/" aria-label="MomExpress home">
          <BrandLockup />
        </Link>
        {isMom && (
          <Link to="/new" className="btn btn-primary btn-block">
            <Plus /> New request
          </Link>
        )}
        <nav className="stack gap-4" aria-label="Main">
          <NavLink to="/" end className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}>
            <HomeIcon /> {homeLabel}
            {!isMom && <Count n={pending} />}
          </NavLink>
          <NavLink to="/history" className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}>
            <History /> History
          </NavLink>
          <NavLink to="/notifications" className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}>
            <Bell /> Notifications
            <Count n={unread} />
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}>
            <Settings /> Settings
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <span className="avatar" aria-hidden="true">
            {initials(me.displayName)}
          </span>
          <div className="grow stack">
            <strong className="truncate">{firstName(me.displayName)}</strong>
            <span className="subtle" style={{ fontSize: 12.5 }}>
              {isMom ? 'Requester' : 'Runner'}
            </span>
          </div>
          <ConnectionPill />
        </div>
      </aside>

      <div className="main">
        <header className={`topbar mobile-only${scrolled ? ' scrolled' : ''}`}>
          <Link to="/" className="grow" aria-label="MomExpress home">
            <BrandLockup />
          </Link>
          <ConnectionPill />
          <Link to="/notifications" className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
            <Bell />
            <Count n={unread} />
          </Link>
        </header>
        <div className="banners-wrap">
          <StatusBanners />
        </div>
        <Outlet />
      </div>

      <nav className="tabbar" aria-label="Main">
        <NavLink to="/" end className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
          <HomeIcon />
          {homeLabel}
          {!isMom && <Count n={pending} />}
        </NavLink>
        <NavLink to="/history" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
          <History />
          History
        </NavLink>
        {isMom && (
          <div className="tab-fab">
            <Link to="/new" aria-label="New request">
              <Plus />
            </Link>
          </div>
        )}
        <NavLink to="/notifications" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
          <Bell />
          Alerts
          <Count n={unread} />
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
          <Settings />
          Settings
        </NavLink>
      </nav>
    </div>
  );
}
