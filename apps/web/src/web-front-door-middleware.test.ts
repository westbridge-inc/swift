// @vitest-environment node
import { existsSync } from 'node:fs';
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
