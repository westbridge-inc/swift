// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, type NextResponse } from 'next/server';
import { getRewrittenUrl, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [Item 7] The pre-launch front door: the switch and the middleware.
//
// The public site (swiftgy.com and www) must not take orders before launch,
// while staging.swiftgy.com — answered by the SAME web container once
// swiftgy.com points at that stack — keeps the full marketplace for testing.
// So there is ONE switch, and it governs the public hosts only. Unset, the
// public site is closed: the safe default. [S1 · owner ruling 6 Oct] It is read
// by the web SERVER while it runs (SWIFT_WEB_ORDERING), not baked into a build,
// so flipping it — open, or back to closed — needs no rebuild.
//
// This file runs in Node, not the browser double: a browser-style Request
// drops the Host header (a forbidden header name), and the middleware decides
// by exactly that header — the visitor's host, which Caddy passes through.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');

/** Loads a source module by its checked path, so a missing one fails as an assertion. */
async function load<T>(relativePath: string): Promise<T> {
  const path = join(SRC, relativePath);
  expect(existsSync(path), `${relativePath} does not exist`).toBe(true);
  return (await import(/* @vite-ignore */ path)) as T;
}

/** A web server running with the switch set to `webOrdering` (its own environment, read per request). */
async function deployedWith(webOrdering: string) {
  vi.resetModules();
  vi.stubEnv('SWIFT_WEB_ORDERING', webOrdering);
  const switchModule = await load<{ webOrderingState: () => string }>('lib/launch-switch.ts');
  const ordering = await load<{ webOrderingOpen: (_host: string | null | undefined, _state: string) => boolean }>('lib/web-ordering.ts');
  return {
    state: switchModule.webOrderingState,
    ordering: { webOrderingOpen: (host: string | null | undefined) => ordering.webOrderingOpen(host, switchModule.webOrderingState()) },
    middleware: await load<{ middleware: (_r: NextRequest) => NextResponse; config: { matcher: string[] } }>('middleware.ts'),
  };
}

afterEach(() => vi.unstubAllEnvs());

const PUBLIC_HOSTS = ['swiftgy.com', 'www.swiftgy.com', 'SwiftGY.com', 'swiftgy.com:443', 'swiftgy.com.'];
const OTHER_HOSTS = ['staging.swiftgy.com', 'localhost:3002', '127.0.0.1:3108', 'swift-web-git-main.vercel.app'];

/** Every way into ordering on the web: the home feed, store pages, cart, checkout and the customer's account. */
const ORDERING_PATHS = [
  '/', '/order', '/order/browse', '/order/search', '/order/vendor/v1', '/explore', '/market', '/cart', '/orders',
  '/orders/o1', '/courier', '/taxi', '/account', '/account/profile', '/account/addresses', '/store/shanta-kitchen',
  '/store/shanta-kitchen?src=qr&c=AB12', '/stores', '/stores/shanta-kitchen',
  // [WEB-LAUNCH-CHECK F1 · S2] The checkout itself (and the selfie step it sends a
  // first-time buyer to) were real on swiftgy.com before launch.
  '/checkout', '/checkout?fulfilment=PICKUP', '/selfie', '/selfie?next=%2Fcart',
];

/** What the bank, the app stores and partners need, whatever the switch says. */
const ALWAYS_OPEN_PATHS = [
  '/welcome', '/about', '/contact', '/pricing', '/how-it-works', '/vendors', '/drivers', '/faq', '/legal/terms',
  '/legal/privacy', '/legal/refunds', '/legal/delivery', '/legal/child-safety', '/account/delete', '/login', '/signup',
  '/dashboard', '/portal', '/weekly-fee', '/track/t1', '/launching-soon',
];

function requestAt(host: string, path: string) {
  return new NextRequest(`https://${host.replace(/\.$/, '')}${path}`, { headers: { host } });
}

describe('[Item 7 · S1] one switch, read by the server while it runs, failing closed', () => {
  it.each(['', 'soon', 'waitlist', 'LIVE', 'true', '1'])('SWIFT_WEB_ORDERING=%j keeps the public site closed', async (value) => {
    const { state } = await deployedWith(value);
    expect(state()).toBe('soon');
  });

  it('SWIFT_WEB_ORDERING=live opens it', async () => {
    const { state } = await deployedWith('live');
    expect(state()).toBe('live');
  });

  it('flips without a rebuild: the same running middleware follows the setting, open and back to closed', async () => {
    const { middleware } = await deployedWith('');
    const cart = () => getRewrittenUrl(middleware.middleware(requestAt('swiftgy.com', '/cart')));
    expect(new URL(cart()!).pathname).toBe('/launching-soon');
    vi.stubEnv('SWIFT_WEB_ORDERING', 'live');
    expect(cart()).toBeNull();
    vi.stubEnv('SWIFT_WEB_ORDERING', '');
    expect(new URL(cart()!).pathname).toBe('/launching-soon');
  });

  // The retired build-time name, spelled out of parts: it is no longer an
  // allowlisted public variable (security/public-env-allowlist.txt), and the
  // public-env gate reads tests too. It appears here only to prove it is dead.
  const RETIRED = ['NEXT', 'PUBLIC', 'WEB', 'ORDERING'].join('_');

  it('the old build-time setting opens nothing any more, and no source reads it', async () => {
    vi.stubEnv(RETIRED, 'live');
    const { middleware } = await deployedWith('');
    expect(new URL(getRewrittenUrl(middleware.middleware(requestAt('swiftgy.com', '/cart')))!).pathname).toBe('/launching-soon');
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && readFileSync(path, 'utf8').includes(RETIRED)) offenders.push(path);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('the browser asks the server, which answers from its own setting and never lets the answer be cached', async () => {
    await deployedWith('');
    const { GET } = await load<{ GET: () => Response }>('app/api/launch-state/route.ts');
    let response = GET();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ webOrdering: 'soon' });
    vi.stubEnv('SWIFT_WEB_ORDERING', 'live');
    response = GET();
    expect(await response.json()).toEqual({ webOrdering: 'live' });
  });

  it('governs the public hosts only: staging, previews and local runs keep the full marketplace', async () => {
    const { ordering } = await deployedWith('');
    for (const host of PUBLIC_HOSTS) expect(ordering.webOrderingOpen(host), host).toBe(false);
    for (const host of OTHER_HOSTS) expect(ordering.webOrderingOpen(host), host).toBe(true);
    expect(ordering.webOrderingOpen(''), 'a request with no host is treated as the public site').toBe(false);
    expect(ordering.webOrderingOpen(null)).toBe(false);
    const live = await deployedWith('live');
    for (const host of [...PUBLIC_HOSTS, ...OTHER_HOSTS]) expect(live.ordering.webOrderingOpen(host), host).toBe(true);
  });
});

describe('[Item 7] the public site, before launch: every ordering entry point shows the front door', () => {
  it.each(ORDERING_PATHS)('%s on swiftgy.com is answered by the front door', async (path) => {
    const { middleware } = await deployedWith('');
    const url = `https://swiftgy.com${path}`;
    expect(unstable_doesMiddlewareMatch({ config: middleware.config, url }), `middleware must run on ${path}`).toBe(true);
    for (const host of ['swiftgy.com', 'www.swiftgy.com']) {
      const rewritten = getRewrittenUrl(middleware.middleware(requestAt(host, path)));
      expect(rewritten && new URL(rewritten).pathname, `${host}${path}`).toBe('/launching-soon');
    }
  });

  it.each(ALWAYS_OPEN_PATHS)('%s stays fully visible on swiftgy.com', async (path) => {
    const { middleware } = await deployedWith('');
    const url = `https://swiftgy.com${path}`;
    const runs = unstable_doesMiddlewareMatch({ config: middleware.config, url });
    if (runs) expect(getRewrittenUrl(middleware.middleware(requestAt('swiftgy.com', path))), path).toBeNull();
  });

  it('staging keeps the full marketplace from the same build', async () => {
    const { middleware } = await deployedWith('');
    for (const path of ORDERING_PATHS) {
      expect(getRewrittenUrl(middleware.middleware(requestAt('staging.swiftgy.com', path))), path).toBeNull();
    }
  });

  it('once the switch is live, the public site takes orders', async () => {
    const { middleware } = await deployedWith('live');
    for (const path of ORDERING_PATHS) expect(getRewrittenUrl(middleware.middleware(requestAt('swiftgy.com', path))), path).toBeNull();
  });
});

describe('[Item 7] the host is the one the visitor asked for', () => {
  it('decides by the Host header Caddy passes through, never by the server\'s own address', async () => {
    const { middleware } = await deployedWith('');
    // Behind the proxy, a self-hosted Next server may see its own address in the URL.
    const publicVisit = new NextRequest('http://localhost:3000/cart', { headers: { host: 'swiftgy.com' } });
    expect(new URL(getRewrittenUrl(middleware.middleware(publicVisit))!).pathname).toBe('/launching-soon');
    const stagingVisit = new NextRequest('http://localhost:3000/cart', { headers: { host: 'staging.swiftgy.com' } });
    expect(getRewrittenUrl(middleware.middleware(stagingVisit))).toBeNull();
    const noHost = new NextRequest('http://localhost:3000/cart');
    expect(new URL(getRewrittenUrl(middleware.middleware(noHost))!).pathname, 'no Host header is treated as the public site').toBe('/launching-soon');
  });
});

// ---------------------------------------------------------------------------
// [WEB-LAUNCH-CHECK F1 · S2] /checkout slipped past the switch because nothing
// tied the matcher to the pages on disk. Now every page the web serves is named
// here as ordering (behind the switch) or open (bank, stores, partners, the
// links a recipient is sent), so a new page cannot go live unclassified; and
// every route the sign-in page treats as the customer's is behind the switch.
// ---------------------------------------------------------------------------
const ROUTE_CLASS: Record<string, 'ordering' | 'open'> = {
  '/': 'ordering', '/order': 'ordering', '/order/browse': 'ordering', '/order/location': 'ordering', '/order/search': 'ordering',
  '/explore': 'ordering', '/market': 'ordering', '/cart': 'ordering', '/checkout': 'ordering', '/selfie': 'ordering',
  '/orders': 'ordering', '/orders/[id]': 'ordering', '/courier': 'ordering', '/taxi': 'ordering',
  '/account': 'ordering', '/account/addresses': 'ordering', '/account/favourites': 'ordering', '/account/help': 'ordering',
  '/account/profile': 'ordering', '/account/safety': 'ordering',
  '/store/[slug]': 'ordering', '/stores': 'ordering', '/stores/[slug]': 'ordering',
  // Public by policy, for the bank and the app stores.
  '/about': 'open', '/contact': 'open', '/faq': 'open', '/how-it-works': 'open', '/pricing': 'open', '/welcome': 'open',
  '/vendors': 'open', '/drivers': 'open', '/legal/child-safety': 'open', '/legal/delivery': 'open', '/legal/privacy': 'open',
  '/legal/refunds': 'open', '/legal/terms': 'open', '/account/delete': 'open', '/launching-soon': 'open', '/offline': 'open',
  '/login': 'open', '/signup': 'open',
  // Partner consoles (stores, riders, drivers, advertisers) work before launch.
  '/dashboard': 'open', '/dashboard/inventory': 'open', '/dashboard/inventory/import': 'open', '/dashboard/notifications': 'open',
  '/dashboard/orders': 'open', '/dashboard/insights': 'open', '/dashboard/schedule': 'open', '/dashboard/settings': 'open', '/dashboard/settings/vat-report': 'open', '/dashboard/weekly-fee': 'open', '/weekly-fee': 'open',
  '/portal': 'open', '/portal/account': 'open', '/portal/documents': 'open', '/portal/history': 'open',
  '/portal/notifications': 'open', '/portal/weekly-fee': 'open',
  '/advertiser': 'open', '/advertiser/account': 'open', '/advertiser/notifications': 'open',
  '/advertiser/campaigns/[advertiserId]/[campaignId]': 'open',
  // A link someone was sent (a parcel or trip to follow) and the QR fallback pages: no ordering on them.
  '/track/[token]': 'open', '/trip/[token]': 'open', '/safety-check': 'open', '/qr/not-found': 'open', '/qr/retired': 'open', '/qr/unavailable': 'open',
};

function pageRoutesOnDisk(dir = join(SRC, 'app'), prefix = ''): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /^page\.(tsx|ts|jsx|js)$/.test(entry.name)) routes.push(prefix || '/');
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('@')) continue;
    const segment = /^\(.+\)$/.test(entry.name) ? '' : `/${entry.name}`;
    routes.push(...pageRoutesOnDisk(join(dir, entry.name), prefix + segment));
  }
  return routes;
}

describe('[WEB-LAUNCH-CHECK F1] every page the web serves is classified, and every ordering page is behind the switch', () => {
  it('no page is unclassified, and no classified page is missing', () => {
    const onDisk = [...new Set(pageRoutesOnDisk())].sort();
    expect(onDisk.filter((r) => !(r in ROUTE_CLASS)), 'new page: classify it as ordering or open').toEqual([]);
    expect(Object.keys(ROUTE_CLASS).filter((r) => !onDisk.includes(r)).sort(), 'classified page no longer on disk').toEqual([]);
  });

  it.each(Object.entries(ROUTE_CLASS).filter(([, c]) => c === 'ordering').map(([r]) => r))('%s is answered by the front door on swiftgy.com', async (route) => {
    const { middleware } = await deployedWith('');
    const path = route.replace(/\[[^\]]+\]/g, 'x1');
    expect(unstable_doesMiddlewareMatch({ config: middleware.config, url: `https://swiftgy.com${path}` }), `middleware must run on ${path}`).toBe(true);
    const rewritten = getRewrittenUrl(middleware.middleware(requestAt('swiftgy.com', path)));
    expect(rewritten && new URL(rewritten).pathname, path).toBe('/launching-soon');
  });

  it.each(Object.entries(ROUTE_CLASS).filter(([, c]) => c === 'open').map(([r]) => r))('%s stays open on swiftgy.com', async (route) => {
    const { middleware } = await deployedWith('');
    const path = route.replace(/\[[^\]]+\]/g, 'x1');
    if (unstable_doesMiddlewareMatch({ config: middleware.config, url: `https://swiftgy.com${path}` })) {
      expect(getRewrittenUrl(middleware.middleware(requestAt('swiftgy.com', path))), path).toBeNull();
    }
  });

  it('every route the sign-in page sends a customer back to is behind the switch', async () => {
    const login = readFileSync(join(SRC, 'app/login/page.tsx'), 'utf8');
    const list = login.match(/const CUSTOMER_ROUTES = \[([^\]]+)\]/)?.[1];
    expect(list, 'login CUSTOMER_ROUTES').toBeTruthy();
    const routes = [...list!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(routes).toContain('/checkout');
    const { middleware } = await deployedWith('');
    for (const route of routes) {
      // /account/delete is the one page under a customer route that is public by policy (Google Play).
      const pages = Object.keys(ROUTE_CLASS).filter((r) => (r === route || r.startsWith(`${route}/`)) && r !== '/account/delete');
      expect(pages.length, `${route} has pages`).toBeGreaterThan(0);
      for (const page of pages) expect(ROUTE_CLASS[page], `${page} is a customer route, so it is an ordering page`).toBe('ordering');
      expect(unstable_doesMiddlewareMatch({ config: middleware.config, url: `https://swiftgy.com${route}` }), route).toBe(true);
      const rewritten = getRewrittenUrl(middleware.middleware(requestAt('swiftgy.com', route)));
      expect(rewritten && new URL(rewritten).pathname, route).toBe('/launching-soon');
    }
  });
});
