/**
 * Service worker — PWA installable + notifications push.
 * Stratégie de cache : network-first avec fallback cache pour la page Nouvelles.
 */

const CACHE_NAME = 'tableau-bord-v1';
const PRECACHE_URLS = [
  '/nouvelles',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && (request.destination === 'document' || request.destination === 'image')) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/nouvelles')))
  );
});

// ─── Notifications push ──────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Alerte', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Alerte';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'site-alerte',
    renotify: true,
    requireInteraction: !!data.urgent,
    data: { url: data.url || '/nouvelles' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/nouvelles';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        try {
          const u = new URL(win.url);
          if (u.pathname === targetUrl || win.url.endsWith(targetUrl)) {
            return win.focus();
          }
        } catch {}
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
