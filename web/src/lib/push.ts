import { api } from '../api/client';
import { keys, readJson, removeKey, writeJson } from './storage';
import { getRegistration } from './sw';

export type PushState =
  | { kind: 'checking' }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'denied' }
  /** iPhone/iPad only support web push once the app is added to the Home Screen. */
  | { kind: 'needs-install' }
  | { kind: 'unsupported' }
  | { kind: 'unknown'; message: string };

export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function pushSupported(): boolean {
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(sub: PushSubscription, vapidKey: string): boolean {
  const current = sub.options?.applicationServerKey;
  if (!current) return true;
  const a = new Uint8Array(current);
  const b = urlBase64ToUint8Array(vapidKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const reg = await Promise.race([
    getRegistration(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
  ]);
  if (!reg) throw new Error('The app’s background service isn’t ready yet. Reload the app and try again.');
  return reg;
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? { kind: 'needs-install' } : { kind: 'unsupported' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  if (Notification.permission !== 'granted') return { kind: 'off' };
  try {
    const reg = await readyRegistration();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return { kind: 'off' };
    const { subscribed } = await api.post<{ subscribed: boolean }>('/api/push/status', { endpoint: sub.endpoint });
    return subscribed ? { kind: 'on' } : { kind: 'off' };
  } catch (err) {
    return { kind: 'unknown', message: (err as Error).message };
  }
}

/** Asks for permission (must run from a tap) and registers this device. */
export async function enablePush(vapidKey: string): Promise<PushState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? { kind: 'needs-install' } : { kind: 'unsupported' };
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return { kind: 'denied' };
  if (permission !== 'granted') return { kind: 'off' };
  const reg = await readyRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, vapidKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });
  await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
  writeJson(keys.pushWanted, true);
  return { kind: 'on' };
}

export async function disablePush(): Promise<PushState> {
  writeJson(keys.pushWanted, false);
  const reg = await readyRegistration();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe().catch(() => false);
  }
  return { kind: 'off' };
}

/**
 * On every sign-in, makes sure the server knows this device's subscription
 * (it is tied to the session, so a new sign-in needs it registered again).
 */
export async function syncPushSubscription(vapidKey: string): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  if (readJson<boolean>(keys.pushWanted) === false) return;
  try {
    const reg = await readyRegistration();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, vapidKey)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub && readJson<boolean>(keys.pushWanted) === true) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });
    }
    if (sub) await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
  } catch (err) {
    console.warn('Could not refresh push subscription', err);
  }
}

/** On sign-out, stop this device receiving the previous person's notifications. */
export async function forgetPushOnThisDevice(): Promise<void> {
  removeKey(keys.pushWanted);
  try {
    const reg = await readyRegistration();
    const sub = await reg.pushManager.getSubscription();
    await sub?.unsubscribe();
    if ('clearAppBadge' in navigator) await navigator.clearAppBadge();
  } catch {
    /* best effort */
  }
}

export async function sendTestPush(): Promise<{ attempted: number; delivered: number }> {
  return api.post('/api/push/test');
}
