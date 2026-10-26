import { setState } from '../store/app';

// Registers the service worker and manages updates. A new version is
// downloaded in the background; the person sees an "Update" prompt and the
// app reloads into the new version when they tap it.

let registration: ServiceWorkerRegistration | null = null;
let reloading = false;
let userRequestedUpdate = false;
const navigateListeners = new Set<(url: string) => void>();

export function swSupported(): boolean {
  return 'serviceWorker' in navigator;
}

export function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!swSupported()) return Promise.resolve(null);
  if (registration) return Promise.resolve(registration);
  return navigator.serviceWorker.ready.then((r) => (registration = r));
}

export async function registerServiceWorker(): Promise<void> {
  if (!swSupported()) return;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  } catch (err) {
    console.warn('Service worker registration failed', err);
    return;
  }

  const watch = (worker: ServiceWorker | null) => {
    if (!worker) return;
    const check = () => {
      // "installed" with an existing controller means an update is waiting.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) setState({ updateAvailable: true });
    };
    check();
    worker.addEventListener('statechange', check);
  };
  watch(registration.waiting);
  registration.addEventListener('updatefound', () => watch(registration!.installing));

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only reload when the person asked for the update (not on first install).
    if (!userRequestedUpdate || reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type === 'navigate' && typeof data.url === 'string' && data.url.startsWith('/')) {
      for (const fn of navigateListeners) fn(data.url);
    }
  });

  // Look for new versions regularly and whenever the app comes back into view.
  let lastCheck = Date.now();
  const checkForUpdate = () => {
    lastCheck = Date.now();
    registration?.update().catch(() => {});
  };
  setInterval(checkForUpdate, 30 * 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > 5 * 60_000) checkForUpdate();
  });
}

/** Subscribes to "open this page" requests from notification taps. */
export function onServiceWorkerNavigate(fn: (url: string) => void): () => void {
  navigateListeners.add(fn);
  return () => navigateListeners.delete(fn);
}

/** Checks the server for a new version. Resolves to true if one is ready to install. */
export async function checkForUpdate(): Promise<boolean> {
  const reg = await getRegistration();
  if (!reg) return false;
  await reg.update();
  if (reg.waiting) {
    setState({ updateAvailable: true });
    return true;
  }
  const installing = reg.installing;
  if (!installing) return false;
  return new Promise((resolve) => {
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') {
        setState({ updateAvailable: true });
        resolve(true);
      } else if (installing.state === 'redundant') resolve(false);
    });
  });
}

/** Switches to the newest version, reloading the app. */
export async function applyUpdate(): Promise<void> {
  userRequestedUpdate = true;
  const reg = await getRegistration().catch(() => null);
  if (reg && !reg.waiting) await checkForUpdate().catch(() => false);
  if (reg?.waiting) {
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    // If the new worker doesn't take over promptly, reload anyway: pages are
    // always fetched fresh from the network, so this still gets the new version.
    setTimeout(() => {
      if (!reloading) {
        reloading = true;
        window.location.reload();
      }
    }, 4000);
  } else {
    reloading = true;
    window.location.reload();
  }
}
