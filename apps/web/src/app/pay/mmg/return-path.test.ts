/// <reference types="vite/client" />
import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { getRouteMatcher } from 'next/dist/shared/lib/router/utils/route-matcher';
import { getRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex';
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RELEASE_BROWSER_API_ORIGIN, STAGING_BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import { SITE_DOMAIN } from '@/site.domain';
import robots from '@/app/robots';

// ---------------------------------------------------------------------------
// [MMG-RETURN-PATH] MMG's UAT sent the partner back with its reply in the
// PATH of the registered Response URL (…/payment/token=<reply>), not in the
// query. These tests serve each request the way Next does: the route handler
// is found on disk under /pay/mmg, its directory name is the dynamic segment
// Next routes by, and the params come from Next's own route matcher (each
// segment decoded once). A URL no route matches is Next's 404, so the routing
// is graded too, not only the handler.
// ---------------------------------------------------------------------------

type Handler = (_request: Request, _context: { params: Promise<Record<string, string | string[] | undefined>> }) => Promise<Response>;
type RouteModule = { GET: Handler; POST: Handler };

const ROUTES = Object.entries(import.meta.glob<RouteModule>('./*/route.ts')).map(([file, load]) => {
  const page = `/pay/mmg/${file.split('/')[1]}`;
  return { page, match: getRouteMatcher(getRouteRegex(page)), load };
});

async function serve(url: string, init: RequestInit = {}): Promise<Response> {
  expect(ROUTES, 'exactly one route handler serves /pay/mmg').toHaveLength(1);
  const { match, load } = ROUTES[0]!;
  let params: ReturnType<typeof match>;
  try {
    params = match(new URL(url).pathname);
  } catch {
    return new Response('Bad Request', { status: 400 }); // Next refuses a malformed encoding before any route runs
  }
  if (!params) return new Response('This page could not be found.', { status: 404 });
  const route = await load();
  return (init.method === 'POST' ? route.POST : route.GET)(new Request(url, init), { params: Promise.resolve(params) });
}

const WORDS = {
  CONFIRMED: 'Payment received. Your Swift weekly fee is paid.',
  CONFIRMING: "We're confirming your payment with MMG. Don't pay again. You can close this page.",
  UNKNOWN: 'Open the Swift app to see your weekly fee.',
};

// Shaped like MMG's reply: one RSA-4096 block (512 bytes) as padded base64url, 684 characters.
const TOKEN = `${Buffer.from(Uint8Array.from({ length: 512 }, (_, i) => (i * 167 + 13) % 256)).toString('base64url')}=`;
const ENCODED = TOKEN.replace(/=/g, '%3D');
const SITE = 'https://web.test';

afterEach(() => vi.unstubAllGlobals());

function stubApi(state = 'CONFIRMING') {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ success: true, data: { state } }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function forwarded(fetcher: ReturnType<typeof stubApi>): { outcome: unknown; params: Record<string, unknown> } {
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toMatch(/\/api\/v1\/billing\/mmg-checkout\/return$/);
  expect(init?.method).toBe('POST');
  return JSON.parse(init?.body as string);
}

async function expectPrivatePage(response: Response, words: string) {
  expect(response.status).toBe(200);
  expect(response.headers.get('x-robots-tag')).toBe('noindex');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const html = await response.text();
  expect(html).toContain(words);
  expect(html).not.toContain(TOKEN.slice(0, 24));
  expect(html).not.toContain(TOKEN.slice(-24));
}

describe('[MMG-RETURN-PATH] the reply in the path', () => {
  it('the fixture is a padded base64url reply of MMG length', () => {
    expect(TOKEN).toMatch(/^(?=.*-)(?=.*_)[A-Za-z0-9_-]{683}=$/);
  });

  it.each([
    ['/pay/mmg/success/token=', 'success', TOKEN],
    ['/pay/mmg/successtoken=', 'success', TOKEN],
    ['/pay/mmg/token=', 'response', TOKEN],
    ['/pay/mmg/error/token=', 'error', TOKEN],
    ['/pay/mmg/errortoken=', 'error', TOKEN],
    ['/pay/mmg/response/token=', 'response', TOKEN],
    ['/pay/mmg/responsetoken=', 'response', TOKEN],
    ['/pay/mmg/success/token%3D', 'success', ENCODED],
    ['/pay/mmg/successtoken%3D', 'success', ENCODED],
    ['/pay/mmg/token%3D', 'response', ENCODED],
    ['/pay/mmg/success/%74oken%3D', 'success', ENCODED],
  ])('%s<reply> reaches the API as params.token with the outcome %s', async (prefix, outcome, reply) => {
    const fetcher = stubApi('CONFIRMING');
    const response = await serve(`${SITE}${prefix}${reply}`);
    await expectPrivatePage(response, WORDS.CONFIRMING);
    const body = forwarded(fetcher);
    expect(body).toEqual({ outcome, params: { token: TOKEN } });
    expect(['success', 'error', 'response']).toContain(body.outcome);
    expect(JSON.stringify(body.outcome)).not.toContain(TOKEN.slice(0, 24));
  });

  it('a form POST to a path that carries the reply forwards the reply and the fields', async () => {
    const fetcher = stubApi('CONFIRMED');
    const response = await serve(`${SITE}/pay/mmg/success/token=${TOKEN}`, { method: 'POST', body: new URLSearchParams({ extra: 'x&y' }) });
    await expectPrivatePage(response, WORDS.CONFIRMED);
    expect(forwarded(fetcher)).toEqual({ outcome: 'success', params: { token: TOKEN, extra: 'x&y' } });
  });

  it('the query ?token= still works', async () => {
    const fetcher = stubApi('CONFIRMING');
    await expectPrivatePage(await serve(`${SITE}/pay/mmg/success?token=${TOKEN}`), WORDS.CONFIRMING);
    expect(forwarded(fetcher)).toEqual({ outcome: 'success', params: { token: TOKEN } });
  });

  it.each(['application/x-www-form-urlencoded', 'multipart/form-data'])('a form POST field token still works (%s)', async (type) => {
    const fetcher = stubApi('CONFIRMING');
    const body = type === 'multipart/form-data' ? new FormData() : new URLSearchParams();
    body.append('token', TOKEN);
    await expectPrivatePage(await serve(`${SITE}/pay/mmg/error`, { method: 'POST', body }), WORDS.CONFIRMING);
    expect(forwarded(fetcher)).toEqual({ outcome: 'error', params: { token: TOKEN } });
  });

  it('accepts a path reply of exactly 4096 characters, and up to 15 other fields beside it', async () => {
    const fetcher = stubApi('CONFIRMING');
    const long = 'A'.repeat(4096);
    const fields = new URLSearchParams(Array.from({ length: 15 }, (_, i) => [`f${i}`, 'x']));
    await expectPrivatePage(await serve(`${SITE}/pay/mmg/success/token=${long}?${fields}`), WORDS.CONFIRMING);
    const body = forwarded(fetcher);
    expect(body.outcome).toBe('success');
    expect(body.params['token']).toBe(long);
    expect(Object.keys(body.params)).toHaveLength(16);
  });

  it.each([
    ['in the path and the query', `/pay/mmg/success/token=${TOKEN}?token=${TOKEN}`, undefined],
    ['in a joined path and the query', `/pay/mmg/successtoken=${TOKEN}?token=another`, undefined],
    ['in the path and the query, in another letter case', `/pay/mmg/success/token=${TOKEN}?TOKEN=${TOKEN}`, undefined],
    ['in the path and a form field', `/pay/mmg/success/token=${TOKEN}`, 'token'],
    ['twice in the path', `/pay/mmg/successtoken=${TOKEN}/token=${TOKEN}`, undefined],
    ['twice in the path, bare', `/pay/mmg/token=${TOKEN}/token=${TOKEN}`, undefined],
  ])('a reply that arrives twice (%s) is refused and nothing is forwarded', async (_case, path, formField) => {
    const fetcher = stubApi('CONFIRMED');
    const init: RequestInit = formField ? { method: 'POST', body: new URLSearchParams({ [formField]: TOKEN }) } : {};
    const response = await serve(`${SITE}${path}`, init);
    expect(fetcher).not.toHaveBeenCalled();
    await expectPrivatePage(response, WORDS.UNKNOWN);
  });

  it.each([
    ['4097 characters after a slash', `/pay/mmg/success/token=${'A'.repeat(4097)}`],
    ['4097 characters joined', `/pay/mmg/successtoken=${'A'.repeat(4097)}`],
    ['4097 characters bare', `/pay/mmg/token=${'A'.repeat(4097)}`],
    ['empty after a slash', '/pay/mmg/success/token='],
    ['empty and bare', '/pay/mmg/token='],
    ['a character outside base64', '/pay/mmg/success/token=abc%24def'],
    ['a space', '/pay/mmg/success/token=abc%20def'],
    ['padding in the middle', '/pay/mmg/success/token=ab=cd'],
    ['three padding characters', '/pay/mmg/success/token=abcd==='],
    ['more fields joined to the path', `/pay/mmg/success/token=${TOKEN}&merchantId=1`],
    ['16 other fields beside it', `/pay/mmg/success/token=${TOKEN}?${new URLSearchParams(Array.from({ length: 16 }, (_, i) => [`f${i}`, 'x']))}`],
  ])('a path reply that is oversized or malformed (%s) is refused and nothing is forwarded', async (_case, path) => {
    const fetcher = stubApi('CONFIRMED');
    const response = await serve(`${SITE}${path}`);
    expect(fetcher).not.toHaveBeenCalled();
    await expectPrivatePage(response, WORDS.UNKNOWN);
  });

  it.each([
    ['after the reply', `/pay/mmg/success/token=${TOKEN}/extra`],
    ['instead of the reply', '/pay/mmg/success/extra'],
    ['with the reply in the query', `/pay/mmg/success/extra?token=${TOKEN}`],
    ['before the outcome', `/pay/mmg/token=${TOKEN}/success`],
    ['naming the reply in another letter case', `/pay/mmg/success/Token=${TOKEN}`],
    ['encoding the reply twice', `/pay/mmg/success/token%253D${TOKEN}`],
    ['three deep', '/pay/mmg/success/error/response'],
    ['an empty first segment', `/pay/mmg//token=${TOKEN}`],
    ['an empty middle segment', `/pay/mmg/success//token=${TOKEN}`],
  ])('an unknown extra path segment (%s) is refused and nothing is forwarded', async (_case, path) => {
    const fetcher = stubApi('CONFIRMED');
    const response = await serve(`${SITE}${path}`);
    expect(fetcher).not.toHaveBeenCalled();
    await expectPrivatePage(response, WORDS.UNKNOWN);
  });

  it.each([
    ['after an unknown word', `/pay/mmg/paymenttoken=${TOKEN}`],
    ['in another letter case', `/pay/mmg/successToken=${TOKEN}`],
  ])('a first segment that names the reply in any other way (%s) is refused and nothing is forwarded', async (_case, path) => {
    const fetcher = stubApi('CONFIRMED');
    const response = await serve(`${SITE}${path}`);
    expect(fetcher).not.toHaveBeenCalled();
    await expectPrivatePage(response, WORDS.UNKNOWN);
  });

  it.each([
    ['an unknown word', '/pay/mmg/somewhere'],
    ['a known word in another letter case', '/pay/mmg/SUCCESS'],
  ])('any other first segment (%s) becomes the generic outcome response', async (_case, path) => {
    const fetcher = stubApi('CONFIRMING');
    await expectPrivatePage(await serve(`${SITE}${path}?token=${TOKEN}`), WORDS.CONFIRMING);
    expect(forwarded(fetcher)).toEqual({ outcome: 'response', params: { token: TOKEN } });
  });

  it('a bare reply with no token= label is never forwarded, in the outcome or anywhere else', async () => {
    const fetcher = stubApi('CONFIRMING');
    await expectPrivatePage(await serve(`${SITE}/pay/mmg/${ENCODED}`), WORDS.CONFIRMING);
    const [, init] = fetcher.mock.calls[0]!;
    expect(forwarded(fetcher)).toEqual({ outcome: 'response', params: {} });
    expect(init?.body as string).not.toContain(TOKEN.slice(0, 24));
  });

  it('a malformed encoding never reaches the handler or the API', async () => {
    const fetcher = stubApi('CONFIRMED');
    expect((await serve(`${SITE}/pay/mmg/success/token=%ZZ`)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never logs a path reply: not when it is forwarded, refused, or the API is unreachable', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    stubApi('CONFIRMED');
    await serve(`${SITE}/pay/mmg/success/token=${TOKEN}`);
    await serve(`${SITE}/pay/mmg/success/token=${TOKEN}?token=${TOKEN}`);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error(`private ${TOKEN}`)));
    await expectPrivatePage(await serve(`${SITE}/pay/mmg/successtoken=${TOKEN}`), WORDS.UNKNOWN);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('[MMG-RETURN-PATH] Next serves every /pay/mmg depth privately', () => {
  const PATHS: Array<[string, string]> = [
    ['/pay/mmg/success', '/pay/mmg/success'],
    ['/pay/mmg/error', '/pay/mmg/error'],
    ['/pay/mmg/success/token=<reply>', `/pay/mmg/success/token=${TOKEN}`],
    ['/pay/mmg/successtoken=<reply>', `/pay/mmg/successtoken=${TOKEN}`],
    ['/pay/mmg/token=<reply>', `/pay/mmg/token=${TOKEN}`],
    ['/pay/mmg/success/token%3D<reply>', `/pay/mmg/success/token%3D${ENCODED}`],
    ['/pay/mmg/success/token=<reply>?state=x', `/pay/mmg/success/token=${TOKEN}?state=x`],
  ];
  const configs: Array<[string, NextConfig]> = [];

  beforeAll(async () => {
    for (const [channel, env] of [
      ['public', { NEXT_PUBLIC_API_URL: RELEASE_BROWSER_API_ORIGIN, SWIFT_WEB_CHANNEL: 'production' }],
      ['staging', { NEXT_PUBLIC_API_URL: STAGING_BROWSER_API_ORIGIN, SWIFT_WEB_CHANNEL: 'staging' }],
    ] as const) {
      vi.stubEnv('NEXT_PUBLIC_API_URL', env.NEXT_PUBLIC_API_URL);
      vi.stubEnv('SWIFT_WEB_CHANNEL', env.SWIFT_WEB_CHANNEL);
      vi.stubEnv('SWIFT_WEB_IMAGE_BUILD', '0');
      vi.resetModules();
      const { default: createNextConfig } = await import('../../../../next.config');
      configs.push([channel, createNextConfig(PHASE_PRODUCTION_BUILD)]);
    }
  });

  afterAll(() => vi.unstubAllEnvs());

  it.each(PATHS)('%s gets noindex, no-store and no-referrer from the site config, on the public and staging builds', async (label, path) => {
    expect(configs).toHaveLength(2);
    for (const [channel, nextConfig] of configs) {
      const response = await unstable_getResponseFromNextConfig({ url: `https://${SITE_DOMAIN}${path}`, nextConfig });
      expect(response.headers.get('x-robots-tag'), `${channel} ${label}`).toBe('noindex');
      expect(response.headers.get('cache-control'), `${channel} ${label}`).toBe('no-store');
      expect(response.headers.get('referrer-policy'), `${channel} ${label}`).toBe('no-referrer');
    }
  });

  it.each(PATHS)('%s stays out of the request log and out of crawling', (label, path) => {
    expect(configs).toHaveLength(2);
    for (const [channel, nextConfig] of configs) {
      const ignore = (nextConfig.logging && nextConfig.logging.incomingRequests && typeof nextConfig.logging.incomingRequests === 'object')
        ? nextConfig.logging.incomingRequests.ignore ?? []
        : [];
      expect(ignore.some((pattern) => pattern.test(path)), `${channel} ${label}`).toBe(true);
    }
    const disallow = [[robots().rules].flat()[0]?.disallow ?? []].flat();
    expect(disallow.some((prefix) => path.startsWith(prefix) && prefix.startsWith('/pay/mmg'))).toBe(true);
  });
});
