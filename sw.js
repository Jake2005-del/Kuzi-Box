const CACHE_NAME = 'kuzibox-cache-v76';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  const isStaticAsset = STATIC_ASSETS.some((asset) => new URL(asset, self.location.origin).pathname === requestUrl.pathname);
  const isNavigation = event.request.mode === 'navigate';
  if (!isStaticAsset && !isNavigation) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response.ok || response.type !== 'basic') return response;
        return caches.open(CACHE_NAME).then((cache) => {
          if (isStaticAsset) cache.put(event.request, response.clone());
          return response;
        });
      }).catch(() => isNavigation ? caches.match('./index.html') : Response.error());
    })
  );
});
