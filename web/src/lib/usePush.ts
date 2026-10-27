import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { setState as setAppState, useApp } from '../store/app';
import { toast } from '../store/toasts';
import { disablePush, enablePush, fetchVapidKey, getPushState, type PushState } from './push';

const TEXT = {
  en: {
    blockedSetup:
      'Your browser didn’t allow push notifications to be set up. Check that notifications are allowed for this site and that you’re not in a private window, then try again.',
    reload: 'Please reload MomExpress and try again.',
    tryAgain: 'Please try again.',
    notReady: 'Push notifications aren’t set up on the server yet.',
    on: ['Notifications are on', 'This device will get alerts even when the app is closed.'],
    blocked: ['Notifications are blocked', 'You can allow them in your browser or phone settings.'],
    failedOn: 'Couldn’t turn on notifications',
    off: ['Notifications are off on this device', 'You’ll still see updates inside the app.'],
    failedOff: 'Couldn’t turn off notifications',
  },
  ar: {
    blockedSetup: 'لم يسمح الهاتف بتشغيل الإشعارات. اسمحي بالإشعارات لهذا التطبيق من إعدادات الهاتف ثم حاولي مرة أخرى.',
    reload: 'أغلقي التطبيق وافتحيه مرة أخرى ثم حاولي.',
    tryAgain: 'حاولي مرة أخرى.',
    notReady: 'الإشعارات غير جاهزة بعد. حاولي لاحقاً.',
    on: ['الإشعارات تعمل', 'ستصلك التنبيهات حتى والتطبيق مغلق.'],
    blocked: ['الإشعارات ممنوعة', 'يمكنك السماح بها من إعدادات الهاتف.'],
    failedOn: 'لم نستطع تشغيل الإشعارات',
    off: ['أُوقفت الإشعارات على هذا الهاتف', 'ستظل التحديثات تظهر داخل التطبيق.'],
    failedOff: 'لم نستطع إيقاف الإشعارات',
  },
};

/** Push notification status for this device, with actions to turn it on or off. */
export function usePush(lang: 'en' | 'ar' = 'en') {
  const vapidKey = useApp((s) => s.vapidKey);
  const [state, setState] = useState<PushState>({ kind: 'checking' });
  const [busy, setBusy] = useState(false);
  const t = TEXT[lang];

  /** Turns browser push errors into something a person can act on. */
  const explain = useCallback(
    (err: unknown): string => {
      const name = (err as { name?: string }).name;
      if (name === 'NotAllowedError' || name === 'AbortError') return t.blockedSetup;
      if (name === 'InvalidStateError') return t.reload;
      if (lang === 'ar') return t.tryAgain;
      if (err instanceof ApiError) return err.message;
      return (err as Error).message || t.tryAgain;
    },
    [t, lang],
  );

  const refresh = useCallback(async () => setState(await getPushState()), []);

  useEffect(() => {
    void refresh();
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const next = await enablePush(async () => {
        if (vapidKey) return vapidKey;
        const key = await fetchVapidKey();
        if (!key) throw new Error(t.notReady);
        setAppState({ vapidKey: key });
        return key;
      });
      setState(next);
      if (next.kind === 'on') toast({ kind: 'success', title: t.on[0], body: t.on[1] });
      else if (next.kind === 'denied') toast({ kind: 'warning', title: t.blocked[0], body: t.blocked[1] });
    } catch (err) {
      toast({ kind: 'error', title: t.failedOn, body: explain(err), duration: 9000 });
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [vapidKey, refresh, t, explain]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      setState(await disablePush());
      toast({ kind: 'info', title: t.off[0], body: t.off[1] });
    } catch (err) {
      toast({ kind: 'error', title: t.failedOff, body: explain(err) });
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh, t, explain]);

  return { state, busy, enable, disable, refresh };
}
