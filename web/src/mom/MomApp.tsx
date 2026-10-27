import '@fontsource-variable/cairo/wght.css';
import { CloudOff, History, House, RefreshCw, Settings, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router';
import type { PublicUser } from '../../../shared/types.js';
import { BrandMark } from '../components/BrandMark';
import { applyUpdate } from '../lib/sw';
import { markNotificationsRead } from '../lib/sync';
import { useApp } from '../store/app';
import { MomHistory } from './MomHistory';
import { MomHome } from './MomHome';
import { MomSettings } from './MomSettings';
import { SendPage } from './SendPage';
import { TrackPage } from './TrackPage';
import { useTextSize } from './textSize';
import './mom.css';

/** Connection problems and new versions, said simply. */
function Banners() {
  const connection = useApp((s) => s.connection);
  const updateAvailable = useApp((s) => s.updateAvailable);
  const [slow, setSlow] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (connection !== 'reconnecting') {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(t);
  }, [connection]);

  return (
    <>
      {connection === 'offline' && (
        <div className="m-banner m-banner-off" role="status">
          <CloudOff aria-hidden="true" />
          <span>لا يوجد إنترنت الآن. ما تطلبينه سيُرسل عندما يعود الاتصال.</span>
        </div>
      )}
      {connection === 'reconnecting' && slow && (
        <div className="m-banner" role="status">
          <RefreshCw className="spin" aria-hidden="true" />
          <span>جارٍ الاتصال…</span>
        </div>
      )}
      {updateAvailable && (
        <div className="m-banner m-banner-new" role="status">
          <Sparkles aria-hidden="true" />
          <span>يوجد تحديث جديد للتطبيق.</span>
          <button
            type="button"
            className="m-btn m-btn-small"
            disabled={updating}
            onClick={() => {
              setUpdating(true);
              void applyUpdate();
            }}
          >
            {updating ? 'جارٍ التحديث…' : 'تحديث'}
          </button>
        </div>
      )}
    </>
  );
}

function Shell() {
  const unread = useApp((s) => s.unreadCount);
  const textSize = useTextSize();

  // The app reads right to left, in Arabic, while Mom is signed in.
  useEffect(() => {
    const html = document.documentElement;
    html.lang = 'ar';
    html.dir = 'rtl';
    return () => {
      html.lang = 'en';
      html.dir = 'ltr';
    };
  }, []);

  // Everything she needs to know is on screen, so there's no separate inbox:
  // once the app is open, her notifications count as seen (and the badge clears).
  useEffect(() => {
    const clear = () => {
      if (document.visibilityState === 'visible' && useApp.getState().unreadCount > 0) {
        void markNotificationsRead({ all: true }).catch(() => {});
      }
    };
    clear();
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, [unread]);

  return (
    <div className={`mom size-${textSize}`}>
      <header className="m-top">
        <BrandMark size={34} />
        <span className="m-brand">ماما إكسبريس</span>
      </header>
      <Banners />
      <main className="m-main">
        <Outlet />
      </main>
      <nav className="m-tabs" aria-label="القائمة">
        <NavLink to="/" end className="m-tab">
          <House aria-hidden="true" />
          <span>الرئيسية</span>
        </NavLink>
        <NavLink to="/history" className="m-tab">
          <History aria-hidden="true" />
          <span>طلباتي</span>
        </NavLink>
        <NavLink to="/settings" className="m-tab">
          <Settings aria-hidden="true" />
          <span>الإعدادات</span>
        </NavLink>
      </nav>
    </div>
  );
}

/** Mom's app: big buttons, few choices, all in Arabic. */
export function MomApp({ me }: { me: PublicUser }) {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<MomHome />} />
        <Route path="send/:item" element={<SendPage me={me} />} />
        <Route path="requests/:id" element={<TrackPage />} />
        <Route path="history" element={<MomHistory />} />
        <Route path="settings" element={<MomSettings me={me} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
