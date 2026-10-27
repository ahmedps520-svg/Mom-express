import { FunctionsHttpError } from '@supabase/supabase-js';
import { ApiError, networkError, supabase } from '../api/client';
import { mx } from '../api/mx';
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

/** Whether this device has notifications allowed and not switched off in the app. */
export function pushAllowedHere(): boolean {
  return pushSupported() && Notification.permission === 'granted' && readJson<boolean>(keys.pushWanted) !== false;
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
    const { subscribed } = await mx.pushStatus(sub.endpoint);
    return subscribed ? { kind: 'on' } : { kind: 'off' };
  } catch (err) {
    return { kind: 'unknown', message: (err as Error).message };
  }
}

/**
 * Asks for permission and registers this device. Must run from a tap, and the
 * permission request comes first: Safari ignores it after any other waiting.
 */
export async function enablePush(getKey: () => Promise<string>): Promise<PushState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? { kind: 'needs-install' } : { kind: 'unsupported' };
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return { kind: 'denied' };
  if (permission !== 'granted') return { kind: 'off' };
  const vapidKey = await getKey();
  const reg = await readyRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, vapidKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });
  await mx.pushSubscribe(sub.toJSON());
  writeJson(keys.pushWanted, true);
  return { kind: 'on' };
}

export async function disablePush(): Promise<PushState> {
  writeJson(keys.pushWanted, false);
  const reg = await readyRegistration();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await mx.pushUnsubscribe(sub.endpoint);
    await sub.unsubscribe().catch(() => false);
  }
  return { kind: 'off' };
}

/**
 * On every sign-in, makes sure the server knows this device's subscription
 * (it is tied to the session, so a new sign-in needs it registered again).
 */
export async function syncPushSubscription(vapidKey: string): Promise<void> {
  if (!pushAllowedHere()) return;
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
    if (sub) await mx.pushSubscribe(sub.toJSON());
  } catch (err) {
    console.warn('Could not refresh push subscription', err);
  }
}

/** Before signing out, tells the server to stop sending to this device. */
export async function unregisterPushOnServer(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await readyRegistration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) await mx.pushUnsubscribe(sub.endpoint);
  } catch {
    /* the server also stops once the session has ended */
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

/** Calls the push function (supabase/functions/mx-push) as the signed-in person. */
async function invokePush<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>('mx-push', { body });
  if (!error) return data as T;
  if (error instanceof FunctionsHttpError) {
    const details = (await error.context.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(error.context.status, 'push_failed', details?.error ?? 'Push notifications aren’t available right now.');
  }
  throw networkError();
}

/** The public key push subscriptions are made with (created on first use). */
export async function fetchVapidKey(): Promise<string | null> {
  const { publicKey } = await invokePush<{ publicKey: string | null }>({ action: 'vapid' });
  return publicKey;
}

export async function sendTestPush(): Promise<{ attempted: number; delivered: number }> {
  return invokePush({ action: 'test' });
}
