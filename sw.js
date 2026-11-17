/* PreVizzy service worker: keeps the app working offline.
   The saved copy is used every time (instant, works with no signal or a weak one).
   A new version is downloaded in the background as a whole; the saved copy is only
   replaced once the download has fully succeeded. Bump CACHE together with APP_VER
   in app.js every release. */
const CACHE = 'previzzy-v36';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'engine.js', 'projects.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.searchParams.has('nocache')) return;            // the version check must reach the website
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(req)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match('index.html'));
    })
  );
});
