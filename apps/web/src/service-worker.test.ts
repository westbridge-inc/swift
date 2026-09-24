import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [PWA-1] The service worker, run for real. public/sw.js — the shipped file, not
// a copy — is loaded into an isolated context the way a browser runs a worker,
// with fakes standing in for the network and Cache Storage, and its event
// handlers are driven the way a browser drives them.
//
// The rule that matters most: nothing personal is ever written to the cache.
// Every /api/ request, every authorised request, every write and every page is
// left alone or fetched fresh; only hashed build files and the offline page
// (fetched as no one) are ever stored.
// ---------------------------------------------------------------------------

const ORIGIN = 'https://swiftgy.com';
const API = 'https://api.swiftgy.com';
const SOURCE = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');
const MAX_STATIC_ENTRIES = Number(SOURCE.match(/const MAX_STATIC_ENTRIES = (\d+);/)?.[1]);
const OFFLINE_COPY = 'You’re offline. Swift needs a connection to order.';

type FakeRequest = { url: string; method: string; mode: string; headers: Headers };
type Reply = { status: number; type: string; headers: Headers; clone: () => Reply; text: () => Promise<string> };
type Listener = (_event: unknown) => void;

function request(
  path: string,
  init: { method?: string; mode?: string; headers?: Record<string, string> } = {},
): FakeRequest {
  return {
    url: new URL(path, ORIGIN).href,
    method: init.method ?? 'GET',
    mode: init.mode ?? 'cors',
    headers: new Headers(init.headers),
  };
}
const page = (path: string, headers?: Record<string, string>) => request(path, { mode: 'navigate', headers });

/** What a same-origin fetch hands a worker. Only the fields the worker reads. */
function served(body: string, init: { status?: number; type?: string; headers?: Record<string, string> } = {}): Reply {
  return {
    status: init.status ?? 200,
    type: init.type ?? 'basic',
    headers: new Headers(init.headers),
    clone: () => served(body, init),
    text: async () => body,
  };
}

const keyOf = (input: string | { url: string }) => new URL(typeof input === 'string' ? input : input.url, ORIGIN).href;

class FakeCache {
  readonly entries = new Map<string, Reply>();
  readonly writes: string[] = [];
  async match(input: string | { url: string }) {
    return this.entries.get(keyOf(input))?.clone();
  }
  async put(input: string | { url: string }, reply: Reply) {
    this.writes.push(keyOf(input));
    this.entries.set(keyOf(input), reply);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(input: string | { url: string }) {
    return this.entries.delete(keyOf(input));
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string) {
    const existing = this.stores.get(name);
    if (existing) return existing;
    const created = new FakeCache();
    this.stores.set(name, created);
    return created;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  /** Every URL ever written, to any cache. */
  get writes() {
    return [...this.stores.values()].flatMap((cache) => cache.writes);
  }
}

function loadWorker(network: (_input: unknown) => Promise<Reply>) {
  const listeners = new Map<string, Listener>();
  const caches = new FakeCacheStorage();
  const fetch = vi.fn(network);
  const skipWaiting = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const enablePreload = vi.fn(async () => undefined);
  // In a worker a relative URL resolves against the worker script's address.
  class WorkerRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, `${ORIGIN}/sw.js`).href : input, init);
    }
  }
  const scope: Record<string, unknown> = {
    URL,
    Headers,
    Response,
    Request: WorkerRequest,
    fetch,
    caches,
    clients: { claim },
    registration: { navigationPreload: { enable: enablePreload } },
    skipWaiting,
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  };
  scope['self'] = scope;
  runInContext(SOURCE, createContext(scope), { filename: 'public/sw.js' });

  const on = (type: string) => {
    const listener = listeners.get(type);
    if (!listener) throw new Error(`sw.js registers no ${type} listener`);
    return listener;
  };
  const lifecycle = async (type: 'install' | 'activate') => {
    const lifetime: Promise<unknown>[] = [];
    on(type)({ waitUntil: (promise: Promise<unknown>) => lifetime.push(promise) });
    await Promise.all(lifetime);
  };
  const dispatchFetch = async (req: FakeRequest, preloadResponse: Promise<Reply | undefined> = Promise.resolve(undefined)) => {
    const lifetime: Promise<unknown>[] = [];
    const event = {
      request: req,
      preloadResponse,
      respondWith: vi.fn(),
      waitUntil: vi.fn((promise: Promise<unknown>) => lifetime.push(promise)),
    };
    on('fetch')(event);
    const answer = event.respondWith.mock.calls[0]?.[0] as Promise<Reply> | undefined;
    const response = answer ? await answer : undefined;
    await Promise.all(lifetime);
    return { intercepted: event.respondWith.mock.calls.length > 0, response };
  };

  return {
    caches,
    fetch,
    skipWaiting,
    claim,
    enablePreload,
    routeFor: scope['routeFor'] as (_request: FakeRequest, _origin: string) => string,
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    message: (data: unknown) => on('message')({ data }),
    dispatchFetch,
  };
}

const OFFLINE_HTML = '<html><h1>You’re offline.</h1><a href="">Try again</a></html>';
const offlinePage = () => served(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html' } });

describe('[PWA-1] what the worker may touch', () => {
  it('answers pages and hashed build files, and leaves everything else to the browser', () => {
    const { routeFor } = loadWorker(async () => offlinePage());
    const cases: Array<[FakeRequest, string]> = [
      [page('/order'), 'page'],
      [page('/orders/42'), 'page'],
      [request('/_next/static/chunks/app/layout-3f1c.js'), 'static'],
      [request('/_next/static/css/5e1a.css'), 'static'],
      // /api/ is never touched, whatever the request looks like.
      [request('/api/session'), 'network'],
      [request('/api'), 'network'],
      [page('/api/session'), 'network'],
      // An authorised request is never touched — not even a build file or a page.
      [request('/_next/static/chunks/main-9a1b.js', { headers: { Authorization: 'Bearer t' } }), 'network'],
      [page('/account', { Authorization: 'Bearer t' }), 'network'],
      // Writes and partial requests pass straight through.
      [request('/_next/static/chunks/main-9a1b.js', { method: 'POST' }), 'network'],
      [request('/_next/static/media/clip.mp4', { headers: { Range: 'bytes=0-99' } }), 'network'],
      // Another origin — the Swift API is one — is never touched.
      [request(`${API}/customer/home`), 'network'],
      [request(`${API}/_next/static/chunks/x.js`), 'network'],
      // A page's data (App Router RSC), images and the manifest go to the network.
      [request('/order?_rsc=1x2y'), 'network'],
      [request('/_next/image?url=%2Fx.png&w=64&q=75'), 'network'],
      [request('/manifest.webmanifest'), 'network'],
    ];
    for (const [req, route] of cases) {
      expect(routeFor(req, ORIGIN), `${req.method} ${req.mode} ${req.url}`).toBe(route);
    }
  });
});

describe('[PWA-1] nothing personal is ever cached', () => {
  it('never intercepts, fetches or stores an /api/ request, whatever its shape', async () => {
    const worker = loadWorker(async () => served('{"name":"a signed-in customer"}'));
    const shapes = [
      request('/api/session'),
      page('/api/session'),
      request('/api/orders', { headers: { Authorization: 'Bearer t' } }),
      request('/api/orders', { method: 'POST' }),
    ];
    for (const req of shapes) {
      const { intercepted } = await worker.dispatchFetch(req);
      expect(intercepted, `${req.method} ${req.mode} ${req.url}`).toBe(false);
    }
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(worker.caches.writes).toEqual([]);
  });

  it('never intercepts a request that carries Authorization, not even for a build file', async () => {
    const worker = loadWorker(async () => served('chunk'));
    const { intercepted } = await worker.dispatchFetch(
      request('/_next/static/chunks/main-9a1b.js', { headers: { Authorization: 'Bearer t' } }),
    );
    expect(intercepted).toBe(false);
    expect(worker.caches.writes).toEqual([]);
  });

  it('fetches every page fresh and never writes one down', async () => {
    let body = '<html>offline</html>';
    const worker = loadWorker(async () => served(body, { headers: { 'Content-Type': 'text/html' } }));
    await worker.install();
    body = '<html>your account, signed in</html>';

    const first = await worker.dispatchFetch(page('/account'));
    const second = await worker.dispatchFetch(page('/account'));

    expect(first.intercepted).toBe(true);
    expect(await first.response!.text()).toBe('<html>your account, signed in</html>');
    expect(await second.response!.text()).toBe('<html>your account, signed in</html>');
    // Install fetched the offline page; each visit to the page went to the network.
    expect(worker.fetch).toHaveBeenCalledTimes(3);
    // The only thing ever stored is the offline page from install.
    expect(worker.caches.writes).toEqual([`${ORIGIN}/offline`]);
  });

  it('stores a build file only when it is a plain, public, same-origin 200', async () => {
    const refusals: Array<[string, Reply]> = [
      ['a 404', served('missing', { status: 404 })],
      ['a partial response', served('part', { status: 206 })],
      ['an opaque response', served('', { type: 'opaque' })],
      ['a CORS response', served('x', { type: 'cors' })],
      ['Cache-Control: private', served('x', { headers: { 'Cache-Control': 'private, max-age=60' } })],
      ['Cache-Control: no-store', served('x', { headers: { 'Cache-Control': 'no-store' } })],
      ['Vary: Cookie', served('x', { headers: { Vary: 'Accept-Encoding, Cookie' } })],
      ['Vary: Authorization', served('x', { headers: { Vary: 'Authorization' } })],
      // A browser never shows a worker Set-Cookie; the rule is pinned regardless.
      ['Set-Cookie', served('x', { headers: { 'Set-Cookie': 'sid=1; HttpOnly' } })],
    ];
    for (const [label, reply] of refusals) {
      const worker = loadWorker(async () => reply);
      const { response } = await worker.dispatchFetch(request('/_next/static/chunks/app-1.js'));
      expect(response, label).toBe(reply);
      expect(worker.caches.writes, label).toEqual([]);
    }
  });
});

describe('[PWA-1] offline', () => {
  it('answers a page it cannot reach with the stored offline page', async () => {
    let online = true;
    const worker = loadWorker(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return offlinePage();
    });
    await worker.install();
    online = false;

    // The stored page itself — with its Try again link — not the bare-text last resort.
    const { response } = await worker.dispatchFetch(page('/orders/42'));
    expect(response!.status).toBe(200);
    expect(response!.headers.get('Content-Type')).toBe('text/html');
    expect(await response!.text()).toBe(OFFLINE_HTML);
  });

  it('still says so, honestly, when the offline page was never stored', async () => {
    const worker = loadWorker(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { response } = await worker.dispatchFetch(page('/order'));
    expect(response!.status).toBe(503);
    expect(await response!.text()).toBe(OFFLINE_COPY);
  });

  it('takes the navigation preload when the browser started one, instead of fetching twice', async () => {
    const worker = loadWorker(async () => served('from the worker'));
    const preloaded = served('from the preload');
    const { response } = await worker.dispatchFetch(page('/order'), Promise.resolve(preloaded));
    expect(response).toBe(preloaded);
    expect(worker.fetch).not.toHaveBeenCalled();
  });
});

describe('[PWA-1] build files', () => {
  it('serves a hashed build file from the cache after the first fetch', async () => {
    const worker = loadWorker(async () => served('chunk body'));
    const file = request('/_next/static/chunks/app/page-7c2d.js');

    const first = await worker.dispatchFetch(file);
    const second = await worker.dispatchFetch(file);

    expect(await first.response!.text()).toBe('chunk body');
    expect(await second.response!.text()).toBe('chunk body');
    expect(worker.fetch).toHaveBeenCalledTimes(1);
    expect(worker.caches.writes).toEqual([file.url]);
  });

  it('keeps the build-file cache bounded, dropping the oldest first', async () => {
    expect(Number.isInteger(MAX_STATIC_ENTRIES) && MAX_STATIC_ENTRIES > 0).toBe(true);
    const worker = loadWorker(async () => served('chunk'));
    for (let index = 0; index < MAX_STATIC_ENTRIES + 5; index += 1) {
      await worker.dispatchFetch(request(`/_next/static/chunks/c-${index}.js`));
    }
    const stores = [...worker.caches.stores.values()];
    expect(stores).toHaveLength(1);
    expect(stores[0]!.entries.size).toBe(MAX_STATIC_ENTRIES);
    expect(stores[0]!.entries.has(`${ORIGIN}/_next/static/chunks/c-0.js`)).toBe(false);
    expect(stores[0]!.entries.has(`${ORIGIN}/_next/static/chunks/c-${MAX_STATIC_ENTRIES + 4}.js`)).toBe(true);
  });
});

describe('[PWA-1] install, activate and the update path', () => {
  it('stores the offline page on install, fetched with no credentials, and waits', async () => {
    const worker = loadWorker(async () => offlinePage());
    await worker.install();

    const sent = worker.fetch.mock.calls[0]![0] as Request;
    expect(sent.url).toBe(`${ORIGIN}/offline`);
    expect(sent.credentials).toBe('omit');
    expect(worker.caches.writes).toEqual([`${ORIGIN}/offline`]);
    // No skipWaiting on install: an update waits for a page to ask.
    expect(worker.skipWaiting).not.toHaveBeenCalled();
  });

  it('refuses to install around an offline page it could not store', async () => {
    const worker = loadWorker(async () => served('down', { status: 500 }));
    await expect(worker.install()).rejects.toThrow(/offline page/);
    expect(worker.caches.writes).toEqual([]);
  });

  it('on activate, deletes only earlier Swift caches, turns on navigation preload and takes control', async () => {
    const worker = loadWorker(async () => offlinePage());
    await worker.install();
    await worker.dispatchFetch(request('/_next/static/chunks/a-1.js'));
    const current = await worker.caches.keys();
    expect(current).toHaveLength(2);
    await worker.caches.open('swift-static-legacy');
    await worker.caches.open('swift-offline-legacy');
    await worker.caches.open('another-app');

    await worker.activate();

    expect((await worker.caches.keys()).sort()).toEqual([...current, 'another-app'].sort());
    expect(worker.enablePreload).toHaveBeenCalledTimes(1);
    expect(worker.claim).toHaveBeenCalledTimes(1);
  });

  it('takes over early only when a page asks it to', () => {
    const worker = loadWorker(async () => offlinePage());
    worker.message(null);
    worker.message({ type: 'SOMETHING_ELSE' });
    expect(worker.skipWaiting).not.toHaveBeenCalled();

    worker.message({ type: 'SKIP_WAITING' });
    expect(worker.skipWaiting).toHaveBeenCalledTimes(1);
  });
});
