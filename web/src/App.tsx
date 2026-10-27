import { Compass } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { AppShell } from './components/AppShell';
import { BrandMark } from './components/BrandMark';
import { EmptyState } from './components/EmptyState';
import { Toaster } from './components/Toaster';
import { withBase } from './config';
import { setNavigate } from './lib/nav';
import { onServiceWorkerNavigate } from './lib/sw';
import { HistoryPage } from './pages/HistoryPage';
import { LoginPage } from './pages/LoginPage';
import { MomHome } from './pages/MomHome';
import { NotificationsPage } from './pages/NotificationsPage';
import { RequestDetailPage } from './pages/RequestDetailPage';
import { RequestFormPage } from './pages/RequestFormPage';
import { RunnerDashboard } from './pages/RunnerDashboard';
import { SettingsPage } from './pages/SettingsPage';
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

/** Mom-only screens; the server enforces the same rule. */
function MomOnly({ children }: { children: ReactNode }) {
  const role = useApp((s) => s.me?.role);
  return role === 'mom' ? <>{children}</> : <Navigate to="/" replace />;
}

function SignedInRoutes() {
  const me = useApp((s) => s.me)!;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={me.role === 'mom' ? <MomHome me={me} /> : <RunnerDashboard me={me} />} />
        <Route
          path="new"
          element={
            <MomOnly>
              <RequestFormPage key="new" me={me} mode="new" />
            </MomOnly>
          }
        />
        <Route path="requests/:id" element={<RequestDetailPage me={me} />} />
        <Route
          path="requests/:id/edit"
          element={
            <MomOnly>
              <RequestFormPage key="edit" me={me} mode="edit" />
            </MomOnly>
          }
        />
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
  return (
    <BrowserRouter basename={withBase('') || undefined}>
      <RouterBridge />
      {session === 'booting' ? <Splash /> : session === 'signed_in' ? <SignedInRoutes /> : <LoginPage />}
      <Toaster />
    </BrowserRouter>
  );
}
