// ClockInProof Service Worker v2.0
const CACHE_NAME = 'clockinproof-v2';

// Core files to cache for offline use
const STATIC_ASSETS = [
  '/app',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/static/icon-180.png',
  '/static/manifest-worker.json',
];

// Install — cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch — network first, fallback to cache
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and API calls (always network)
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;

  // App, invite, join, and static — network first then cache
  if (
    url.pathname === '/app' ||
    url.pathname.startsWith('/app') ||
    url.pathname.startsWith('/invite/') ||
    url.pathname.startsWith('/join/') ||
    url.pathname.startsWith('/static/')
  ) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then((cached) => {
            if (cached) return cached;
            // Offline fallback page
            return new Response(
              `<!DOCTYPE html>
              <html>
              <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>ClockInProof — Offline</title>
                <style>
                  body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #1e1b4b; color: white; text-align: center; padding: 20px; }
                  img { width: 80px; border-radius: 16px; margin-bottom: 20px; }
                  h1 { font-size: 1.5rem; margin-bottom: 10px; }
                  p { color: #a5b4fc; margin-bottom: 20px; }
                  button { background: #4f46e5; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 1rem; cursor: pointer; }
                </style>
              </head>
              <body>
                <img src="/static/icon-192.png" alt="ClockInProof"/>
                <h1>You're Offline</h1>
                <p>Please check your internet connection and try again.</p>
                <button onclick="window.location.reload()">Try Again</button>
              </body>
              </html>`,
              { headers: { 'Content-Type': 'text/html' } }
            );
          });
        })
    );
  }
});
