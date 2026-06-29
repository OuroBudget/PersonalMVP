/* OuroBudget PWA - service worker.
   Caches the whole app (shell + libraries + icons) so it loads and runs fully
   offline after the first visit. There is no backend: all data lives in the
   browser (IndexedDB). Relative URLs so it works whether hosted at a domain
   root or a sub-path. */
const CACHE = "ouro-pwa-v3";

const SHELL = [
  "./",
  "./index.html",
  "./app.jsx",
  "./lib.js",
  "./manifest.webmanifest",
  "./assets/vendor/react.production.min.js",
  "./assets/vendor/react-dom.production.min.js",
  "./assets/vendor/babel.min.js",
  "./assets/vendor/tailwind.js",
  "./assets/logo-light.svg",
  "./assets/logo-dark.svg",
  "./assets/icon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // ignore any single asset that 404s so install never fully fails
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
  );
});

// Activate immediately only when the page asks (user clicked "Refresh").
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && new URL(req.url).origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match("./index.html")); // offline navigation fallback
    })
  );
});
