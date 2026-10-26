import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { useApp } from '../store/app';
import { toast } from '../store/toasts';
import { disablePush, enablePush, getPushState, type PushState } from './push';

/** Turns browser push errors into something a person can act on. */
function explainPushError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const name = (err as { name?: string }).name;
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return 'Your browser didn’t allow push notifications to be set up. Check that notifications are allowed for this site and that you’re not in a private window, then try again.';
  }
  if (name === 'InvalidStateError') return 'Please reload MomExpress and try again.';
  return (err as Error).message || 'Please try again.';
}

/** Push notification status for this device, with actions to turn it on or off. */
export function usePush() {
  const vapidKey = useApp((s) => s.vapidKey);
  const [state, setState] = useState<PushState>({ kind: 'checking' });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setState(await getPushState()), []);

  useEffect(() => {
    void refresh();
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!vapidKey) {
      toast({ kind: 'error', title: 'Can’t turn on notifications yet', body: 'Connect to the internet and try again.' });
      return;
    }
    setBusy(true);
    try {
      const next = await enablePush(vapidKey);
      setState(next);
      if (next.kind === 'on') toast({ kind: 'success', title: 'Notifications are on', body: 'This device will get alerts even when the app is closed.' });
      else if (next.kind === 'denied') toast({ kind: 'warning', title: 'Notifications are blocked', body: 'You can allow them in your browser or phone settings.' });
    } catch (err) {
      toast({ kind: 'error', title: 'Couldn’t turn on notifications', body: explainPushError(err), duration: 9000 });
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [vapidKey, refresh]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      setState(await disablePush());
      toast({ kind: 'info', title: 'Notifications are off on this device', body: 'You’ll still see updates inside the app.' });
    } catch (err) {
      toast({ kind: 'error', title: 'Couldn’t turn off notifications', body: (err as Error).message });
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return { state, busy, enable, disable, refresh };
}
