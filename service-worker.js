const CACHE = "app-shell-v1";
const ASSETS = [
    "./",                 // scope root
    "index.html",
    "manifest.json",
    "assets/icon-192.png",
    "assets/icon-512.png"
];

// Resolve a URL relative to the SW scope
const scopeURL = (path) => new URL(path, self.registration.scope).toString();

self.addEventListener("install", (e) => {
    e.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE);
            // Pre-cache the shell using URLs relative to scope
            await cache.addAll(ASSETS.map(scopeURL));
            self.skipWaiting();
        })()
    );
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => (k !== CACHE ? caches.delete(k) : null)));
            self.clients.claim();
        })()
    );
});

self.addEventListener("fetch", (e) => {
    const req = e.request;

    if (req.method !== "GET") return;

    // For SPA navigations, serve index.html from cache, try to refresh
    if (req.mode === "navigate") {
        e.respondWith(
            (async () => {
                const cache = await caches.open(CACHE);
                const indexURL = scopeURL("index.html");
                const cached = await cache.match(indexURL);
                try {
                    const fresh = await fetch(indexURL, { cache: "no-store" });
                    if (fresh.ok) cache.put(indexURL, fresh.clone());
                    return fresh.ok ? fresh : (cached || fresh);
                } catch {
                    return cached || new Response("Offline", { status: 503, statusText: "Offline" });
                }
            })()
        );
        return;
    }

    // Same-origin GETs → cache-first
    const url = new URL(req.url);
    if (url.origin === self.location.origin) {
        e.respondWith(
            (async () => {
                const cache = await caches.open(CACHE);
                const cached = await cache.match(req);
                if (cached) return cached;
                try {
                    const fresh = await fetch(req);
                    if (fresh && fresh.ok) cache.put(req, fresh.clone());
                    return fresh;
                } catch {
                    return cached || new Response("Offline", { status: 503 });
                }
            })()
        );
    }
});
