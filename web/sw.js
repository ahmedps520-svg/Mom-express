/* MomExpress service worker.
 *
 * - Keeps the app shell available offline.
 * - Pages always come from the network when it's reachable, so an installed
 *   app can never get stuck on an old version. A new version waits until the
 *   person taps "Update" (or every window is closed) before taking over.
 * - Shows push notifications and opens the right request when one is tapped.
 *
 * The build fills in BUILD_ID and PRECACHE (see vite.config.ts).
 */

const BUILD_ID = '__BUILD_ID__';
const PRECACHE = __PRECACHE__;
const CACHE = `momexpress-${BUILD_ID}`;
const SHELL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('momexpress-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Live data is never cached: it must always be the real, current state.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirstPage(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetchWithTimeout(request, 5000);
    if (response.ok) await cache.put(SHELL, response.clone());
    return response;
  } catch {
    const cached = (await cache.match(SHELL)) || (await caches.match(SHELL));
    if (cached) return cached;
    return new Response('<h1>MomExpress is offline</h1><p>Reconnect to the internet and try again.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ------------------------------------------------------------------ push

// Safari (and every browser on iPhone/iPad) may revoke push permission if a
// push doesn't show a notification, so there we always show one.
const ua = self.navigator.userAgent;
const MUST_SHOW = /iPhone|iPad|iPod/.test(ua) || (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'MomExpress', body: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    (async () => {
      if (typeof data.badgeCount === 'number' && 'setAppBadge' in self.navigator) {
        try {
          if (data.badgeCount > 0) await self.navigator.setAppBadge(data.badgeCount);
          else await self.navigator.clearAppBadge();
        } catch {
          /* badges are optional */
        }
      }

      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // If the app is open and in front of the person, it already shows the
      // update in-app; a system notification on top would be noise.
      const inFront = windows.some((w) => w.focused && w.visibilityState === 'visible');
      if (inFront && !MUST_SHOW) return;

      const urgent = data.priority === 'urgent';
      await self.registration.showNotification(data.title || 'MomExpress', {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        tag: data.tag || undefined,
        renotify: Boolean(data.tag),
        requireInteraction: urgent,
        vibrate: urgent ? [220, 90, 220, 90, 220] : [120, 60, 120],
        timestamp: Date.now(),
        data: { url: data.url || '/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const win of windows) {
        if (new URL(win.url).origin !== self.location.origin) continue;
        try {
          await win.focus();
        } catch {
          /* some platforms refuse focus; navigating still helps */
        }
        win.postMessage({ type: 'navigate', url: path });
        return;
      }
      await self.clients.openWindow(new URL(path, self.location.origin).href);
    })(),
  );
});

// Browsers occasionally rotate push subscriptions; re-register the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      let subscription = event.newSubscription;
      if (!subscription && event.oldSubscription && event.oldSubscription.options) {
        subscription = await self.registration.pushManager.subscribe(event.oldSubscription.options);
      }
      if (!subscription) return;
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
    })(),
  );
});
