// Kamelikortti service worker: lets the app open without internet.
const SHELL_CACHE = "kk-shell-v1";
const PHOTO_CACHE = "kk-photos";
const LIB_CACHE = "kk-libs";
const SHELL = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("kk-shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve the cached app at once, and fetch a fresh copy for next time.
function staleWhileRevalidate(cacheName, key, request) {
  return caches.open(cacheName).then((cache) =>
    cache.match(key).then((cached) => {
      const fresh = fetch(request).then((res) => {
        if (res && res.ok) cache.put(key, res.clone());
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
}

function cacheFirst(cacheName, request) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => cached || fetch(request).then((res) => {
      if (res && (res.ok || res.type === "opaque")) cache.put(request, res.clone());
      return res;
    }))
  );
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    if (/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(url.hostname)) e.respondWith(cacheFirst(LIB_CACHE, req));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;                       // data goes through the app's own sync
  if (url.pathname.startsWith("/_blob/")) { e.respondWith(cacheFirst(PHOTO_CACHE, req)); return; }
  if (req.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html")) {
    e.respondWith(staleWhileRevalidate(SHELL_CACHE, "/", req));
    return;
  }
  if (SHELL.includes(url.pathname)) { e.respondWith(staleWhileRevalidate(SHELL_CACHE, url.pathname, req)); return; }
});
