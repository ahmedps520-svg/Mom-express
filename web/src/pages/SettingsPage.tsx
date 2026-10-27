import {
  BellRing,
  CircleCheck,
  Download,
  KeyRound,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  Smartphone,
  Sun,
  Volume2,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { LIMITS, NOTIFICATION_CATEGORIES } from '../../../shared/constants.js';
import type { PublicUser, ThemePreference, UserPrefs } from '../../../shared/types.js';
import { ApiError } from '../api/client';
import { mx } from '../api/mx';
import { ConfirmSheet } from '../components/ActionSheets';
import { Sheet } from '../components/Sheet';
import { initials } from '../lib/format';
import { useTitle } from '../lib/hooks';
import { installHelp, promptInstall, useInstall } from '../lib/install';
import { sendTestPush } from '../lib/push';
import { playChime } from '../lib/sound';
import { checkForUpdate, applyUpdate } from '../lib/sw';
import { changePassword, signOut } from '../lib/sync';
import { applyTheme } from '../lib/theme';
import { usePush } from '../lib/usePush';
import { setState, useApp } from '../store/app';
import { toast } from '../store/toasts';

function Switch({ checked, onChange, label, busy }: { checked: boolean; onChange: (v: boolean) => void; label: string; busy?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy}
      disabled={busy}
      onClick={() => onChange(!checked)}
    />
  );
}

async function savePrefs(prefs: Partial<UserPrefs>): Promise<boolean> {
  try {
    const { user } = await mx.updateMe({ prefs });
    setState({ me: user });
    return true;
  } catch (err) {
    toast({ kind: 'error', title: 'Setting not saved', body: err instanceof ApiError ? err.message : 'Please try again.' });
    return false;
  }
}

function ProfileCard({ me }: { me: PublicUser }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a name.');
      return;
    }
    setBusy(true);
    try {
      const { user } = await mx.updateMe({ displayName: trimmed });
      setState({ me: user });
      setEditing(false);
      setError(null);
      toast({ kind: 'success', title: 'Name updated' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card card-pad profile-card" aria-labelledby="profile-title">
      <span className="avatar avatar-lg" aria-hidden="true">
        {initials(me.displayName)}
      </span>
      <div className="grow stack gap-4">
        {editing ? (
          <form className="stack gap-8" onSubmit={save}>
            <label className="sr-only" htmlFor="display-name">
              Your name
            </label>
            <input
              id="display-name"
              className="input"
              value={name}
              maxLength={LIMITS.displayName}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            {error && <span className="field-error">{error}</span>}
            <div className="row gap-8">
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setEditing(false);
                  setName(me.displayName);
                  setError(null);
                }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <h2 className="profile-name" id="profile-title">
              {me.displayName}
            </h2>
            <span className="muted">@{me.username}</span>
            <div className="row gap-8 wrap" style={{ marginTop: 6 }}>
              <span className="role-chip">{me.role === 'mom' ? 'Requester' : 'Runner'}</span>
              <button type="button" className="btn btn-soft btn-sm" onClick={() => setEditing(true)}>
                Edit name
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function NotificationSettings({ me }: { me: PublicUser }) {
  const { state, busy, enable, disable } = usePush();
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const categories = NOTIFICATION_CATEGORIES[me.role];

  const deviceStatus = (() => {
    switch (state.kind) {
      case 'checking':
        return { text: 'Checking…', action: null };
      case 'on':
        return {
          text: 'On for this device. You’ll get alerts even when MomExpress is closed.',
          action: (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void disable()} disabled={busy}>
              Turn off
            </button>
          ),
        };
      case 'off':
        return {
          text: 'Off for this device. You’ll still see updates while the app is open.',
          action: (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void enable()} disabled={busy}>
              {busy ? 'Turning on…' : 'Turn on'}
            </button>
          ),
        };
      case 'denied':
        return { text: 'Blocked in your browser or phone settings. Allow notifications for this site there, then come back.', action: null };
      case 'needs-install':
        return { text: 'On iPhone and iPad, add MomExpress to your Home Screen first (Share → Add to Home Screen), then open it from there.', action: null };
      case 'unsupported':
        return { text: 'This browser doesn’t support push notifications. Everything still updates live inside the app.', action: null };
      case 'unknown':
        return { text: `Couldn’t check right now: ${state.message}`, action: null };
    }
  })();

  return (
    <section className="settings-section" aria-labelledby="notif-title">
      <h2 className="settings-heading" id="notif-title">
        Notifications
      </h2>
      <div className="card list">
        <div className="list-row settings-row">
          <span className="bubble bubble-sm tone-default" aria-hidden="true">
            <BellRing />
          </span>
          <div className="grow stack">
            <span className="row-title">Push notifications</span>
            <span className="row-sub">{deviceStatus.text}</span>
          </div>
          {deviceStatus.action}
        </div>
        {categories.map((c) => (
          <div key={c.type} className="list-row settings-row">
            <div className="grow stack">
              <span className="row-title">{c.label}</span>
              <span className="row-sub">{c.description}</span>
            </div>
            <Switch
              label={c.label}
              checked={me.prefs.push[c.type] !== false}
              busy={saving === c.type}
              onChange={async (v) => {
                setSaving(c.type);
                await savePrefs({ push: { [c.type]: v } });
                setSaving(null);
              }}
            />
          </div>
        ))}
        {state.kind === 'on' && (
          <div className="list-row settings-row">
            <div className="grow stack">
              <span className="row-title">Test it</span>
              <span className="row-sub">Sends a real notification to your devices.</span>
            </div>
            <button
              type="button"
              className="btn btn-soft btn-sm"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                try {
                  const result = await sendTestPush();
                  if (result.delivered > 0) {
                    toast({ kind: 'success', title: 'Test sent', body: `Delivered to ${result.delivered} device${result.delivered === 1 ? '' : 's'}. It may take a few seconds to appear.` });
                  } else {
                    toast({ kind: 'warning', title: 'Not delivered', body: result.attempted ? 'The push service didn’t accept it. Try turning notifications off and on again.' : 'No devices are registered. Turn notifications on first.' });
                  }
                } catch (err) {
                  toast({ kind: 'error', title: 'Couldn’t send a test', body: (err as Error).message });
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? <LoaderCircle className="spin" aria-hidden="true" /> : null} Send test
            </button>
          </div>
        )}
      </div>
      <p className="settings-foot">Notifications are always kept in the app’s notification centre, whatever you choose here.</p>
    </section>
  );
}

function SoundAndLook({ me }: { me: PublicUser }) {
  const [savingSound, setSavingSound] = useState(false);
  const [savingTheme, setSavingTheme] = useState<ThemePreference | null>(null);
  const themes: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
    { value: 'system', label: 'Automatic', icon: Monitor },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ];
  return (
    <section className="settings-section" aria-labelledby="sound-title">
      <h2 className="settings-heading" id="sound-title">
        Sound & appearance
      </h2>
      <div className="card list">
        <div className="list-row settings-row">
          <span className="bubble bubble-sm tone-default" aria-hidden="true">
            <Volume2 />
          </span>
          <div className="grow stack">
            <span className="row-title">{me.role === 'runner' ? 'Chime for new requests' : 'Chime for delivery updates'}</span>
            <span className="row-sub">Plays while MomExpress is open on this device.</span>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                if (!playChime(me.role === 'runner' ? 'new' : 'delivered')) toast({ kind: 'info', title: 'Tap once more to allow sound', body: 'Browsers only play sound after you’ve interacted with the page.' });
              }}
            >
              Play a preview
            </button>
          </div>
          <Switch
            label="Sounds"
            checked={me.prefs.sound}
            busy={savingSound}
            onChange={async (v) => {
              setSavingSound(true);
              await savePrefs({ sound: v });
              setSavingSound(false);
            }}
          />
        </div>
        <div className="list-row settings-row column">
          <div className="stack">
            <span className="row-title">Theme</span>
            <span className="row-sub">Automatic follows your device’s light or dark setting.</span>
          </div>
          <div className="segmented theme-seg" role="group" aria-label="Theme">
            {themes.map((t) => (
              <button
                key={t.value}
                type="button"
                aria-pressed={me.prefs.theme === t.value}
                disabled={savingTheme !== null}
                onClick={async () => {
                  setSavingTheme(t.value);
                  const previous = me.prefs.theme;
                  applyTheme(t.value);
                  if (!(await savePrefs({ theme: t.value }))) applyTheme(previous);
                  setSavingTheme(null);
                }}
              >
                <t.icon aria-hidden="true" style={{ width: 18, height: 18 }} />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function AppSection() {
  const { installed, canPrompt } = useInstall();
  const updateAvailable = useApp((s) => s.updateAvailable);
  const [checking, setChecking] = useState(false);
  const built = new Date(__BUILT_AT__);

  return (
    <section className="settings-section" aria-labelledby="app-title">
      <h2 className="settings-heading" id="app-title">
        App
      </h2>
      <div className="card list">
        <div className="list-row settings-row">
          <span className="bubble bubble-sm tone-default" aria-hidden="true">
            <Smartphone />
          </span>
          <div className="grow stack">
            <span className="row-title">{installed ? 'Installed' : 'Install MomExpress'}</span>
            <span className="row-sub">
              {installed ? 'You’re using the installed app.' : canPrompt ? 'Add it to your home screen or desktop for one-tap access.' : installHelp()}
            </span>
          </div>
          {!installed && canPrompt && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={async () => {
                const outcome = await promptInstall();
                if (outcome === 'accepted') toast({ kind: 'success', title: 'Installing MomExpress' });
              }}
            >
              <Download aria-hidden="true" /> Install
            </button>
          )}
          {installed && <CircleCheck className="installed-check" aria-hidden="true" />}
        </div>
        <div className="list-row settings-row">
          <span className="bubble bubble-sm tone-default" aria-hidden="true">
            <RefreshCw />
          </span>
          <div className="grow stack">
            <span className="row-title">Version {__APP_VERSION__}</span>
            <span className="row-sub">
              {updateAvailable
                ? 'A newer version is ready to install.'
                : `Built ${built.toLocaleDateString()} ${built.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
            </span>
          </div>
          {updateAvailable ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void applyUpdate()}>
              Update now
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-soft btn-sm"
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                try {
                  const found = await checkForUpdate();
                  if (!found) toast({ kind: 'success', title: 'You’re up to date' });
                } catch {
                  toast({ kind: 'error', title: 'Couldn’t check for updates', body: 'Check your connection and try again.' });
                } finally {
                  setChecking(false);
                }
              }}
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function PasswordSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const close = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setErrors({});
    onClose();
  };

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!current) errs.currentPassword = 'Enter your current password.';
    if (next.length < LIMITS.passwordMin) errs.newPassword = `Use at least ${LIMITS.passwordMin} characters.`;
    else if (next !== confirm) errs.confirm = 'The passwords don’t match.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await changePassword(current, next);
      toast({ kind: 'success', title: 'Password changed', body: 'Other devices have been signed out.' });
      close();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setErrors({ form: err instanceof Error ? err.message : 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      busy={busy}
      title="Change password"
      description="You’ll stay signed in here; other devices will need the new password."
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </>
      }
    >
      <form
        className="stack gap-12"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {errors.form && <div className="banner banner-error">{errors.form}</div>}
        {(
          [
            ['currentPassword', 'Current password', current, setCurrent, 'current-password'],
            ['newPassword', 'New password', next, setNext, 'new-password'],
            ['confirm', 'Repeat new password', confirm, setConfirm, 'new-password'],
          ] as const
        ).map(([key, label, value, setter, auto]) => (
          <div key={key} className={`field${errors[key] ? ' invalid' : ''}`}>
            <label className="label" htmlFor={`pw-${key}`}>
              {label}
            </label>
            <input id={`pw-${key}`} className="input" type="password" autoComplete={auto} value={value} onChange={(e) => setter(e.target.value)} />
            {errors[key] && <span className="field-error">{errors[key]}</span>}
          </div>
        ))}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

function AccountSection() {
  const outbox = useApp((s) => s.outbox);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <section className="settings-section" aria-labelledby="account-title">
      <h2 className="settings-heading" id="account-title">
        Account
      </h2>
      <div className="card list">
        <button type="button" className="list-row settings-row" onClick={() => setChangingPassword(true)}>
          <span className="bubble bubble-sm tone-default" aria-hidden="true">
            <KeyRound />
          </span>
          <span className="grow row-title">Change password</span>
        </button>
        <button type="button" className="list-row settings-row danger-row" onClick={() => setConfirmSignOut(true)}>
          <span className="bubble bubble-sm danger-bubble" aria-hidden="true">
            <LogOut />
          </span>
          <span className="grow row-title">Sign out</span>
        </button>
      </div>
      <p className="settings-foot">Your role is set by whoever runs MomExpress and can’t be changed here.</p>

      <PasswordSheet open={changingPassword} onClose={() => setChangingPassword(false)} />
      <ConfirmSheet
        open={confirmSignOut}
        onClose={() => setConfirmSignOut(false)}
        busy={busy}
        danger
        title="Sign out of MomExpress?"
        description={
          outbox.length > 0
            ? `You have ${outbox.length} request${outbox.length === 1 ? '' : 's'} that haven’t been sent yet. Signing out will discard ${outbox.length === 1 ? 'it' : 'them'}.`
            : 'This device will stop getting notifications until you sign in again.'
        }
        cancelLabel="Stay signed in"
        confirmLabel="Sign out"
        onConfirm={async () => {
          setBusy(true);
          try {
            await signOut();
          } catch (err) {
            setBusy(false);
            toast({
              kind: 'error',
              title: 'Couldn’t sign out',
              body: err instanceof ApiError && err.isNetwork ? 'You need to be online to sign out, so this device stops getting notifications.' : (err as Error).message,
            });
          }
        }}
      />
    </section>
  );
}

export function SettingsPage({ me }: { me: PublicUser }) {
  useTitle('Settings');
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Just the essentials.</p>
        </div>
      </div>
      <ProfileCard me={me} />
      <NotificationSettings me={me} />
      <SoundAndLook me={me} />
      <AppSection />
      <AccountSection />
    </div>
  );
}
