/**
 * Minimal offline service worker for the oh-my-gravastar PWA.
 *
 * Strategy: network-first with cache fallback for same-origin GETs.
 * Hashed Vite assets are cached on first fetch, so after the first visit
 * the app shell works fully offline. WebHID itself still needs the device
 * and a secure context, obviously.
 */
const CACHE = 'omg-web-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || Response.error())),
  );
});
