// Taski Progressive Web App (PWA) Service Worker — offline-first
//
// • The shell is precached so a cold launch is instant and fully offline.
// • Navigations are cache-first with a background refresh (stale-while-
//   revalidate), so a deploy is picked up on the next launch.
// • Static assets are cache-first with a background refresh.
// • /api/* is never cached: the sync engine owns offline durability.
const CACHE_NAME = 'taski-pwa-v24';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css?v=4',
  '/app.js?v=5',
  '/sync.js?v=2',
  '/manifest.webmanifest',
  '/manifest.json',
  '/favicon.ico',
  '/assets/favicon-32x32.png',
  '/assets/favicon-16x16.png',
  '/assets/favicon.ico',
  '/assets/icon-120.png',
  '/assets/icon-152.png',
  '/assets/icon-180.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-192-maskable.png',
  '/assets/icon-512-maskable.png',
  '/assets/banner-social.png',
  '/assets/fonts/comic-relief-400.woff2',
  '/assets/fonts/comic-relief-700.woff2',
  '/vendor/supabase-js-2.118.0.js'
];

// 1. Install: resilient caching. One missing optional asset must never
//    prevent the worker (and therefore offline support) from installing.
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        PRECACHE_ASSETS.map((assetUrl) =>
          fetch(assetUrl, { cache: 'reload' })
            .then((response) => {
              if (!response || !response.ok) throw new Error(`HTTP ${response && response.status}`);
              return cache.put(assetUrl, response);
            })
            .catch((err) => {
              console.warn('[Taski PWA] Precache skipped:', assetUrl, err && err.message);
            })
        )
      );
    })
  );
});

// 2. Activate: drop old versions, take control immediately.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// 3. Fetch: platform files stay network-only; the app shell is offline-first.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept cross-origin requests.
  if (url.origin !== self.location.origin) return;

  // Never intercept dynamic backend APIs or health probes.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ping') ||
    url.pathname.startsWith('/health')
  ) {
    return;
  }

  const isNavigation =
    req.mode === 'navigate' ||
    req.destination === 'document' ||
    (req.headers.get('accept') && req.headers.get('accept').includes('text/html'));

  if (isNavigation) {
    event.respondWith(navigationResponse(event, req));
    return;
  }

  event.respondWith(staticResponse(event, req));
});

async function navigationResponse(event, req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = (await cache.match('/index.html')) || (await cache.match('/'));

  const refresh = fetch(req)
    .then((response) => {
      if (response && response.ok) {
        const copy = response.clone();
        cache.put('/index.html', copy).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Refresh in the background so the next launch gets the new build.
    event.waitUntil(refresh);
    return cached;
  }

  const fresh = await refresh;
  if (fresh) return fresh;

  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Taski is offline</title><body style="font-family:sans-serif;padding:2rem"><h1>Taski is offline</h1><p>Reconnect once to install the app shell.</p></body>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

async function staticResponse(event, req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);

  const refresh = fetch(req)
    .then((response) => {
      if (response && response.status === 200) {
        const copy = response.clone();
        cache.put(req, copy).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }

  const fresh = await refresh;
  if (fresh) return fresh;

  // Query-string cache busting may not be cached yet; retry the clean URL.
  const clean = await cache.match(req.url.split('?')[0]);
  if (clean) return clean;

  return new Response('', { status: 408, statusText: 'Request Timeout' });
}
