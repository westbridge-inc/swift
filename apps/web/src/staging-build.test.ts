import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import type { NextConfig } from 'next';
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SITE_DOMAIN } from './site.domain';
import {
  buildBrowserContentSecurityPolicy,
  RELEASE_BROWSER_API_ORIGIN,
  STAGING_BROWSER_API_ORIGIN,
} from './lib/browser-api-origin';

// ---------------------------------------------------------------------------
// [Q11] The staging website: the real next.config, built for production with
// the environment apps/web/Dockerfile hands it (deploy/docker-compose.yml,
// profile "web"). Vercel and CI set none of SWIFT_WEB_CHANNEL or
// SWIFT_WEB_IMAGE_BUILD, and the last case pins that their build is exactly
// the config it was before these existed.
// ---------------------------------------------------------------------------

type Header = { key: string; value: string };

async function productionConfig(env: Record<string, string | undefined>): Promise<NextConfig> {
  for (const name of ['NEXT_PUBLIC_API_URL', 'SWIFT_WEB_CHANNEL', 'SWIFT_WEB_IMAGE_BUILD']) {
    vi.stubEnv(name, env[name]);
  }
  vi.resetModules();
  const { default: createNextConfig } = await import('../next.config');
  return createNextConfig(PHASE_PRODUCTION_BUILD);
}

async function siteWideHeaders(config: NextConfig): Promise<Header[]> {
  const rules = await config.headers!();
  return rules.find((rule) => rule.source === '/(.*)')!.headers;
}

const headerOf = (headers: Header[], key: string) => headers.find((header) => header.key === key)?.value;

/** The X-Robots-Tag a real request to this host and path gets, through Next's own header matching. */
async function robotsTagOf(config: NextConfig, host: string, path: string): Promise<string | null> {
  const url = `https://${host.replace(/:\d+$/, '').toLowerCase()}${path}`;
  const response = await unstable_getResponseFromNextConfig({ url, headers: { host }, nextConfig: config });
  return response.headers.get('x-robots-tag');
}

/** The staging stack's own website name (deploy/.env WEB_HOST), and pages of every kind. */
const STAGING_HOST = `staging.${SITE_DOMAIN}`;
const PAGES = ['/', '/about', '/pricing', '/legal/refunds', '/legal/delivery', '/launching-soon', '/store/census-store', '/cart'];

const STAGING = { NEXT_PUBLIC_API_URL: STAGING_BROWSER_API_ORIGIN, SWIFT_WEB_CHANNEL: 'staging' };
const PUBLIC_SITE = { NEXT_PUBLIC_API_URL: RELEASE_BROWSER_API_ORIGIN };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('[Q11] the staging website build', () => {
  it('calls the staging API, permits exactly it, and forwards printed /s/ codes to it', async () => {
    const config = await productionConfig(STAGING);
    expect(config.env?.['NEXT_PUBLIC_API_URL']).toBe(STAGING_BROWSER_API_ORIGIN);
    const csp = headerOf(await siteWideHeaders(config), 'Content-Security-Policy');
    expect(csp).toBe(buildBrowserContentSecurityPolicy('production', 'staging'));
    const rewrites = await config.rewrites!();
    expect(Array.isArray(rewrites) ? rewrites : []).toContainEqual({
      source: '/s/:code',
      destination: `${STAGING_BROWSER_API_ORIGIN}/s/:code`,
    });
  });

  it('asks crawlers not to index the whole staging copy; the public site limits that header to QR scan and MMG return links', async () => {
    // [DS628] Asserted on the staging HOST's responses rather than read off one
    // rule: the same image may also answer the public names (next case).
    const staging = await productionConfig(STAGING);
    for (const path of PAGES) expect(await robotsTagOf(staging, STAGING_HOST, path), path).toBe('noindex, nofollow');
    const publicRules = await (await productionConfig(PUBLIC_SITE)).headers!();
    // [AX303 F3] Public content stays indexable; /s/ needs a
    // response noindex because its external resolver returns a redirect.
    // Payment returns independently suppress indexing, caching and referrers.
    expect(publicRules.filter((rule) => rule.headers.some((header) => header.key === 'X-Robots-Tag')))
      .toEqual(expect.arrayContaining([
        { source: '/s/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
        { source: '/pay/mmg/:path*', headers: [
          { key: 'X-Robots-Tag', value: 'noindex' },
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ] },
      ]));
    expect(publicRules.filter((rule) => rule.headers.some((header) => header.key === 'X-Robots-Tag'))).toHaveLength(2);
  });

  it('[DS628] the same staging image never marks the public names noindex: swiftgy.com and www stay indexable', async () => {
    // The deploy stack can serve the public names from this image (WEB_ALIAS_HOSTS).
    const image = await productionConfig({ ...STAGING, SWIFT_WEB_IMAGE_BUILD: '1' });
    for (const path of PAGES) {
      expect(await robotsTagOf(image, STAGING_HOST, path), `${STAGING_HOST}${path}`).toBe('noindex, nofollow');
      for (const host of [SITE_DOMAIN, `www.${SITE_DOMAIN}`, SITE_DOMAIN.toUpperCase(), `${SITE_DOMAIN}:443`]) {
        expect(await robotsTagOf(image, host, path), `${host}${path}`).toBeNull();
      }
    }
    // Any other name this image answers is treated as staging: noindex is the safe default.
    expect(await robotsTagOf(image, 'preview.example.com', '/about')).toBe('noindex, nofollow');
    // A look-alike of a public name is not that name (the dots are literal, not "any character").
    for (const lookAlike of [`www-${SITE_DOMAIN}`, SITE_DOMAIN.replace('.', '-')]) {
      expect(await robotsTagOf(image, lookAlike, '/about'), lookAlike).toBe('noindex, nofollow');
    }
    // On the public names, the QR scan links keep their own noindex.
    expect(await robotsTagOf(image, SITE_DOMAIN, '/s/census-code')).toBe('noindex, nofollow');
  });

  it('keeps every security header the public site sends, unchanged but for the API it connects to', async () => {
    const staging = await siteWideHeaders(await productionConfig(STAGING));
    const publicSite = await siteWideHeaders(await productionConfig(PUBLIC_SITE));
    for (const { key, value } of publicSite) {
      if (key === 'Content-Security-Policy') continue;
      expect(headerOf(staging, key), key).toBe(value);
    }
  });

  it('refuses a staging build pointed at production, and a public build pointed at staging', async () => {
    await expect(productionConfig({ ...STAGING, NEXT_PUBLIC_API_URL: RELEASE_BROWSER_API_ORIGIN })).rejects.toThrow(
      /must be exactly/,
    );
    await expect(productionConfig({ NEXT_PUBLIC_API_URL: STAGING_BROWSER_API_ORIGIN })).rejects.toThrow(/must be exactly/);
    await expect(productionConfig({ ...STAGING, SWIFT_WEB_CHANNEL: 'stage' })).rejects.toThrow(/SWIFT_WEB_CHANNEL/);
  });

  it('only the self-hosted image build asks for the standalone server and leaves the source gates to CI', async () => {
    const image = await productionConfig({ ...STAGING, SWIFT_WEB_IMAGE_BUILD: '1' });
    expect(image.output).toBe('standalone');
    expect(image.typescript).toEqual({ ignoreBuildErrors: true });
    expect(image.eslint).toEqual({ ignoreDuringBuilds: true });
    for (const notTheImage of [undefined, '', '0', 'true']) {
      const config = await productionConfig({ ...STAGING, SWIFT_WEB_IMAGE_BUILD: notTheImage });
      expect(config.output, String(notTheImage)).toBeUndefined();
    }
  });

  it('Vercel and CI (no channel, no image switch) get exactly the config they had', async () => {
    const config = await productionConfig(PUBLIC_SITE);
    expect(Object.keys(config).sort()).toEqual(
      // `images` is the photo optimiser every build carries (W2b, owner ruling h4); the
      // image-build-only keys (output, typescript, eslint) must still be absent.
      // `webpack` adds one client chunk group for the customer app's shared code (size budget,
      // PERF 21 Oct); see the chunking test below.
      ['env', 'headers', 'images', 'logging', 'poweredByHeader', 'redirects', 'rewrites', 'transpilePackages', 'webpack'].sort(),
    );
    expect(config.env).toEqual({ NEXT_PUBLIC_API_URL: RELEASE_BROWSER_API_ORIGIN });
    expect(headerOf(await siteWideHeaders(config), 'Content-Security-Policy')).toBe(
      buildBrowserContentSecurityPolicy('production'),
    );
  });
});

describe('[Size budget] the customer app\u2019s shared code is one chunk', () => {
  type Group = { name: string; minChunks: number; minSize: number; chunks: (_c: { name?: string | null }) => boolean; test: (_m: { type?: string; nameForCondition?: () => string | null }) => boolean };
  const run = async (isServer: boolean) => {
    const config = await productionConfig(PUBLIC_SITE);
    const base = { optimization: { splitChunks: { cacheGroups: { framework: { name: 'framework' } } } } };
    const out = (config.webpack as (_c: unknown, _o: { isServer: boolean }) => typeof base)(structuredClone(base), { isServer });
    return out.optimization.splitChunks.cacheGroups as Record<string, unknown>;
  };

  it('the browser build gains two groups; Next\u2019s own groups stay; the server build is untouched', async () => {
    const client = await run(false);
    expect(Object.keys(client).sort()).toEqual(['customerAppLayoutShared', 'customerAppShared', 'framework']);
    expect(Object.keys(await run(true))).toEqual(['framework']);
  });

  it('customer pages only, the app\u2019s own JavaScript (and its icons), shared by at least 12 pages, one chunk', async () => {
    const group = (await run(false))['customerAppShared'] as Group;
    expect(group).toMatchObject({ name: 'customer-app-shared', minChunks: 12, minSize: 0 });
    expect(group.chunks({ name: 'app/(app)/checkout/page' })).toBe(true);
    expect(group.chunks({ name: 'app/(app)/layout' })).toBe(true);
    for (const name of ['app/dashboard/layout', 'app/portal/page', 'app/login/page', 'app/layout', null]) expect(group.chunks({ name })).toBe(false);
    const mod = (path: string, type = 'javascript/auto') => ({ type, nameForCondition: () => path });
    expect(group.test(mod('/w/apps/web/src/lib/basket-state.ts'))).toBe(true);
    expect(group.test(mod('/w/node_modules/.pnpm/lucide-react@0.475.0/node_modules/lucide-react/dist/esm/icons/x.js'))).toBe(true);
    expect(group.test(mod('/w/node_modules/.pnpm/react-dom@19/node_modules/react-dom/index.js'))).toBe(false);
    expect(group.test(mod('/w/apps/web/src/app/(app)/cart/cart.module.css', 'css/mini-extract'))).toBe(false);
  });

  // [CI perf #2222] What the customer layout loads AND a customer page loads too was copied into both chunks
  // (chunk-retry, shell data, basket state: ~1.5 kB twice on Home). The second group sends such a module to the
  // same customer-app-shared chunk the layout always loads; a module the layout does not load is left alone.
  it('the layout\u2019s shared code joins the same chunk: customer pages only, own JavaScript, loaded by the layout', async () => {
    type LayoutGroup = Omit<Group, 'test'> & { priority: number; test: (_m: { type?: string; nameForCondition?: () => string | null }, _c?: unknown) => boolean };
    const group = (await run(false))['customerAppLayoutShared'] as LayoutGroup;
    expect(group).toMatchObject({ name: 'customer-app-shared', minChunks: 2, minSize: 0 });
    expect(group.priority).toBeLessThan(((await run(false))['customerAppShared'] as { priority: number }).priority);
    expect(group.chunks({ name: 'app/(app)/page' })).toBe(true);
    for (const name of ['app/dashboard/layout', 'app/portal/page', 'app/login/page', 'app/layout', null]) expect(group.chunks({ name })).toBe(false);
    const mod = (path: string, type = 'javascript/auto') => ({ type, nameForCondition: () => path });
    const inChunks = (...names: string[]) => ({ chunkGraph: { getModuleChunksIterable: () => names.map((name) => ({ name })) } });
    const retry = mod('/w/apps/web/src/lib/chunk-retry.ts');
    expect(group.test(retry, inChunks('app/(app)/layout', 'app/(app)/page'))).toBe(true);
    expect(group.test(retry, inChunks('app/(app)/page', 'app/(app)/store/[slug]/page'))).toBe(false);
    expect(group.test(retry)).toBe(false);
    expect(group.test(mod('/w/node_modules/.pnpm/react-dom@19/node_modules/react-dom/index.js'), inChunks('app/(app)/layout', 'app/(app)/page'))).toBe(false);
    expect(group.test(mod('/w/apps/web/src/app/(app)/cart/cart.module.css', 'css/mini-extract'), inChunks('app/(app)/layout'))).toBe(false);
  });
});
