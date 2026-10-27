import { Compass } from 'lucide-react';
import { useEffect } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { AppShell } from './components/AppShell';
import { BrandMark } from './components/BrandMark';
import { EmptyState } from './components/EmptyState';
import { Toaster } from './components/Toaster';
import { BASE } from './config';
import { setNavigate } from './lib/nav';
import { onServiceWorkerNavigate } from './lib/sw';
import { HistoryPage } from './pages/HistoryPage';
import { LoginPage } from './pages/LoginPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { RequestDetailPage } from './pages/RequestDetailPage';
import { RunnerDashboard } from './pages/RunnerDashboard';
import { SettingsPage } from './pages/SettingsPage';
import { MomApp } from './mom/MomApp';
import { useApp } from './store/app';

/** Connects the router to code outside React (notification taps, toasts). */
function RouterBridge() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    setNavigate((to) => navigate(to));
    return onServiceWorkerNavigate((url) => navigate(url));
  }, [navigate]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  return null;
}

function Splash() {
  return (
    <div className="splash" role="status" aria-label="Loading MomExpress">
      <BrandMark size={72} className="splash-mark" />
    </div>
  );
}

function NotFound() {
  return (
    <div className="page narrow">
      <div className="card section">
        <EmptyState icon={Compass} title="Nothing here" action={<Link className="btn btn-primary" to="/">Go home</Link>}>
          That page doesn’t exist.
        </EmptyState>
      </div>
    </div>
  );
}

function SignedInRoutes() {
  const me = useApp((s) => s.me)!;
  // Mom has her own simple app, in Arabic.
  if (me.role === 'mom') return <MomApp me={me} />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<RunnerDashboard me={me} />} />
        <Route path="requests/:id" element={<RequestDetailPage me={me} />} />
        <Route path="history" element={<HistoryPage me={me} />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="settings" element={<SettingsPage me={me} />} />
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export function App() {
  const session = useApp((s) => s.session);
  // BASE keeps its trailing slash, so home is /Mom-express/ (inside the service
  // worker's scope, which matters offline) rather than /Mom-express.
  return (
    <BrowserRouter basename={BASE}>
      <RouterBridge />
      {session === 'booting' ? <Splash /> : session === 'signed_in' ? <SignedInRoutes /> : <LoginPage />}
      <Toaster />
    </BrowserRouter>
  );
}
