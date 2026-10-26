import { BellRing, Share, X } from 'lucide-react';
import { useState } from 'react';
import { keys, readJson, writeJson } from '../lib/storage';
import { usePush } from '../lib/usePush';

/** A friendly nudge to turn on notifications, shown until it's done or dismissed. */
export function PushPrompt({ role }: { role: 'mom' | 'runner' }) {
  const { state, busy, enable } = usePush();
  const [dismissed, setDismissed] = useState(() => readJson<boolean>(keys.dismissedPushCard) === true);

  if (dismissed || (state.kind !== 'off' && state.kind !== 'needs-install')) return null;

  const dismiss = () => {
    writeJson(keys.dismissedPushCard, true);
    setDismissed(true);
  };

  return (
    <div className="card push-card">
      <span className="push-card-icon" aria-hidden="true">
        {state.kind === 'needs-install' ? <Share /> : <BellRing />}
      </span>
      <div className="grow stack gap-4">
        <strong>{state.kind === 'needs-install' ? 'Add MomExpress to your Home Screen' : 'Never miss an update'}</strong>
        <span className="muted">
          {state.kind === 'needs-install'
            ? 'On iPhone and iPad, notifications work once MomExpress is on your Home Screen: tap Share, then “Add to Home Screen”.'
            : role === 'runner'
              ? 'Get an alert the moment a new request comes in, even when the app is closed.'
              : 'Get an alert when your request is accepted, on the way and delivered.'}
        </span>
        {state.kind === 'off' && (
          <div className="row gap-8" style={{ marginTop: 6 }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void enable()} disabled={busy}>
              {busy ? 'Turning on…' : 'Turn on notifications'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>
              Not now
            </button>
          </div>
        )}
      </div>
      <button type="button" className="icon-btn" onClick={dismiss} aria-label="Dismiss">
        <X />
      </button>
    </div>
  );
}
