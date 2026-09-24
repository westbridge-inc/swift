/* eslint-env serviceworker */
/**
 * [PWA-1] Swift's service worker — deliberately small.
 *
 * It does three things and nothing else:
 *
 *   1. Pages (navigations): network first, always. When the network cannot be
 *      reached, the offline page answers instead. A page is NEVER written to a
 *      cache — pages are where signed-in content lives.
 *   2. Build files under /_next/static/: cache first. Their names carry a
 *      content hash, so a stored copy can never be stale, and they are the same
 *      bytes for every visitor.
 *   3. Everything else is not intercepted at all: the browser fetches it exactly
 *      as it would with no worker installed. That includes every /api/ request,
 *      every request to another origin (the Swift API is one), every request
 *      that carries an Authorization header, and every write.
 *
 * WHAT IS NEVER STORED, AND WHY THAT HOLDS. Only two kinds of response are ever
 * written: the offline page, fetched with credentials omitted, and hashed build
 * files. Personal data cannot reach either. isStorable() adds checks on top of
 * that allowlist — it is not the guarantee: browsers hide Set-Cookie (and the
 * request's Cookie header) from a service worker, so no header check alone
 * could promise it.
 *
 * UPDATING: bump VERSION whenever this file or the offline page
 * (src/app/offline/page.tsx) changes, or phones keep the old copy. A new worker
 * waits until a page asks it to take over — ServiceWorkerRegistrar asks when
 * the tab is hidden, so the switch happens while nobody is looking and nothing
 * reloads — and its activation deletes the previous version's caches.
 */

const VERSION = 'v1';
const CACHE_PREFIX = 'swift-';
const OFFLINE_CACHE = `${CACHE_PREFIX}offline-${VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}static-${VERSION}`;
const OFFLINE_URL = '/offline';
// Enough for the build files of every customer page, twice over. Older entries
// go first, so files from past deploys age out instead of piling up.
const MAX_STATIC_ENTRIES = 120;
// The last resort, if the offline page itself was never stored.
const OFFLINE_TEXT = 'You’re offline. Swift needs a connection to order.';

/**
 * 'page' | 'static' | 'network' — the whole routing policy, in the order it is
 * enforced. The refusals come first, so no later rule can reach /api/, another
 * origin, an authorised request, a partial request or a write.
 */
function routeFor(request, origin) {
  if (request.method !== 'GET') return 'network';
  const url = new URL(request.url);
  if (url.origin !== origin) return 'network';
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'network';
  if (request.headers.has('Authorization')) return 'network';
  if (request.headers.has('Range')) return 'network';
  if (request.mode === 'navigate') return 'page';
  if (url.pathname.startsWith('/_next/static/')) return 'static';
  return 'network';
}

/** Only a plain, complete, same-origin, publicly cacheable response is stored. */
function isStorable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  const cacheControl = (response.headers.get('Cache-Control') || '').toLowerCase();
  if (/\b(no-store|private)\b/.test(cacheControl)) return false;
  // A browser never shows a worker this header (see the note at the top), so on
  // a real network response this line cannot fire; it keeps the rule whole.
  if (response.headers.has('Set-Cookie')) return false;
  const vary = (response.headers.get('Vary') || '').toLowerCase();
  if (vary.includes('*') || /\b(cookie|authorization)\b/.test(vary)) return false;
  return true;
}

function offlineText() {
  return new Response(OFFLINE_TEXT, {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function precacheOfflinePage() {
  // The offline page is the same for everyone, so it is fetched as no one: no
  // cookie leaves the browser for it, and nothing personal can come back.
  const response = await fetch(new Request(OFFLINE_URL, { credentials: 'omit', cache: 'reload' }));
  if (!isStorable(response)) throw new Error(`offline page not cacheable (${response.status})`);
  const cache = await caches.open(OFFLINE_CACHE);
  await cache.put(OFFLINE_URL, response);
}

async function pageResponse(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch {
    const cache = await caches.open(OFFLINE_CACHE);
    return (await cache.match(OFFLINE_URL)) || offlineText();
  }
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  if (excess > 0) await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
}

async function staticResponse(event) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (isStorable(response)) {
    event.waitUntil(
      cache.put(event.request, response.clone()).then(() => trimCache(cache, MAX_STATIC_ENTRIES)),
    );
  }
  return response;
}

self.addEventListener('install', (event) => {
  // No skipWaiting() here: an update waits for the page to ask (see 'message').
  event.waitUntil(precacheOfflinePage());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const current = [OFFLINE_CACHE, STATIC_CACHE];
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && !current.includes(name))
          .map((name) => caches.delete(name)),
      );
      // Start the page request while the worker boots, so network-first costs
      // no extra wait on a slow phone.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const route = routeFor(event.request, self.location.origin);
  if (route === 'page') event.respondWith(pageResponse(event));
  else if (route === 'static') event.respondWith(staticResponse(event));
  // 'network': not intercepted — no respondWith, so the browser handles it.
});
