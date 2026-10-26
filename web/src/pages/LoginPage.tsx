import { CircleAlert, CloudOff, Eye, EyeOff, LoaderCircle, Lock, MapPinned, Radio, Zap } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { BrandMark } from '../components/BrandMark';
import { useTitle } from '../lib/hooks';
import { signIn } from '../lib/sync';
import { useApp } from '../store/app';

export function LoginPage() {
  useTitle('Sign in');
  const expired = useApp((s) => s.signedOutReason === 'expired');
  const offline = useApp((s) => s.connection === 'offline');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: Record<string, string> = {};
    if (!username.trim()) errs.username = 'Enter your username.';
    if (!password) errs.password = 'Enter your password.';
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login-hero" aria-hidden="true">
        <div className="login-hero-inner">
          <BrandMark size={72} />
          <h2>Anything you need, brought right to you.</h2>
          <ul>
            <li>
              <Zap /> Ask for something in seconds
            </li>
            <li>
              <MapPinned /> Follow every step until it arrives
            </li>
            <li>
              <Radio /> Live updates on every device
            </li>
          </ul>
        </div>
        <div className="login-blob one" />
        <div className="login-blob two" />
      </section>

      <main className="login-main">
        <div className="login-card">
          <div className="login-brand">
            <BrandMark size={60} />
            <h1>
              Mom<span className="gradient-text">Express</span>
            </h1>
            <p className="muted">Your personal family delivery service</p>
          </div>

          {expired && !error && (
            <div className="banner banner-info" role="status">
              <Lock aria-hidden="true" />
              <span>You’ve been signed out. Please sign in again.</span>
            </div>
          )}
          {offline && (
            <div className="banner banner-offline" role="status">
              <CloudOff aria-hidden="true" />
              <span>You’re offline. Connect to the internet to sign in.</span>
            </div>
          )}
          {error && (
            <div className="banner banner-error" role="alert">
              <CircleAlert aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <form className="stack gap-16" onSubmit={submit} noValidate>
            <div className={`field${fieldErrors.username ? ' invalid' : ''}`}>
              <label className="label" htmlFor="username">
                Username
              </label>
              <input
                id="username"
                className="input"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                aria-invalid={!!fieldErrors.username}
                aria-describedby={fieldErrors.username ? 'username-error' : undefined}
                autoFocus
              />
              {fieldErrors.username && (
                <span className="field-error" id="username-error">
                  <CircleAlert aria-hidden="true" /> {fieldErrors.username}
                </span>
              )}
            </div>
            <div className={`field${fieldErrors.password ? ' invalid' : ''}`}>
              <label className="label" htmlFor="password">
                Password
              </label>
              <div className="input-wrap">
                <input
                  id="password"
                  className="input"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!fieldErrors.password}
                  aria-describedby={fieldErrors.password ? 'password-error' : undefined}
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </button>
              </div>
              {fieldErrors.password && (
                <span className="field-error" id="password-error">
                  <CircleAlert aria-hidden="true" /> {fieldErrors.password}
                </span>
              )}
            </div>
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle className="spin" aria-hidden="true" /> Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          <p className="login-foot">
            <Lock aria-hidden="true" /> A private app for your family. Accounts are set up by whoever runs MomExpress.
          </p>
        </div>
      </main>
    </div>
  );
}
