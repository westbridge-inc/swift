import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import type { NextConfig } from 'next';
import { getRewrittenUrl, unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SITE_DOMAIN } from './site.domain';
import {
  buildBrowserContentSecurityPolicy,
  PRELAUNCH_BROWSER_API_ORIGIN,
  RELEASE_BROWSER_API_ORIGIN,
  STAGING_BROWSER_API_ORIGIN,
} from './lib/browser-api-origin';

// ---------------------------------------------------------------------------
// [OPEN-EARLY] The real next.config, built for the public site with each of
// the two production API origins. Everything that talks to the API, from the
// browser or from the website's own server, follows the ONE origin the build
// resolved: the injected browser origin, the CSP, the printed-QR /s/ proxy and
// the photo optimiser's allowed host. A wrong origin still fails the build.
// ---------------------------------------------------------------------------

type Header = { key: string; value: string };

async function publicSiteConfig(origin: string | undefined, channel?: string): Promise<NextConfig> {
  vi.stubEnv('NEXT_PUBLIC_API_URL', origin);
  vi.stubEnv('SWIFT_WEB_CHANNEL', channel);
  vi.stubEnv('SWIFT_WEB_IMAGE_BUILD', undefined);
  vi.resetModules();
  const { default: createNextConfig } = await import('../next.config');
  return createNextConfig(PHASE_PRODUCTION_BUILD);
}

async function cspOf(config: NextConfig): Promise<string> {
  const rules = await config.headers!();
  const headers: Header[] = rules.find((rule) => rule.source === '/(.*)')!.headers;
  return headers.find((header) => header.key === 'Content-Security-Policy')!.value;
}

const connectOf = (csp: string) => csp.split('; ').find((d) => d.startsWith('connect-src '))!.split(' ');
const wss = (origin: string) => origin.replace('https://', 'wss://');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('[OPEN-EARLY] a public-site build on the pre-launch API origin', () => {
  it('injects that origin into the browser bundle and the CSP names only it (https and wss)', async () => {
    const config = await publicSiteConfig(PRELAUNCH_BROWSER_API_ORIGIN);
    expect(config.env).toEqual({ NEXT_PUBLIC_API_URL: PRELAUNCH_BROWSER_API_ORIGIN });
    const csp = await cspOf(config);
    expect(connectOf(csp)).toEqual(['connect-src', "'self'", PRELAUNCH_BROWSER_API_ORIGIN, wss(PRELAUNCH_BROWSER_API_ORIGIN)]);
    expect(csp).toBe(buildBrowserContentSecurityPolicy('production', 'production', { apiOrigin: PRELAUNCH_BROWSER_API_ORIGIN }));
    expect(connectOf(csp)).not.toContain(RELEASE_BROWSER_API_ORIGIN);
  });

  it('forwards printed QR codes (/s/) to that origin, through Next’s own rewrite matching', async () => {
    const config = await publicSiteConfig(PRELAUNCH_BROWSER_API_ORIGIN);
    const rewrites = await config.rewrites!();
    expect(Array.isArray(rewrites) ? rewrites : []).toContainEqual({
      source: '/s/:code',
      destination: `${PRELAUNCH_BROWSER_API_ORIGIN}/s/:code`,
    });
    const response = await unstable_getResponseFromNextConfig({ url: `https://${SITE_DOMAIN}/s/census-code`, nextConfig: config });
    expect(getRewrittenUrl(response)).toBe(`${PRELAUNCH_BROWSER_API_ORIGIN}/s/census-code`);
  });

  it('lets the photo optimiser fetch only from that origin', async () => {
    const config = await publicSiteConfig(PRELAUNCH_BROWSER_API_ORIGIN);
    const hosts = (config.images?.remotePatterns ?? []).map((pattern) => (pattern as { hostname: string }).hostname);
    expect(hosts).toEqual(Array(2).fill(new URL(PRELAUNCH_BROWSER_API_ORIGIN).hostname));
  });

  it('the release origin build is unchanged: it calls, permits and forwards to the release origin only', async () => {
    const config = await publicSiteConfig(RELEASE_BROWSER_API_ORIGIN);
    expect(config.env).toEqual({ NEXT_PUBLIC_API_URL: RELEASE_BROWSER_API_ORIGIN });
    const csp = await cspOf(config);
    expect(csp).toBe(buildBrowserContentSecurityPolicy('production'));
    expect(connectOf(csp)).toEqual(['connect-src', "'self'", RELEASE_BROWSER_API_ORIGIN, wss(RELEASE_BROWSER_API_ORIGIN)]);
    const response = await unstable_getResponseFromNextConfig({ url: `https://${SITE_DOMAIN}/s/census-code`, nextConfig: config });
    expect(getRewrittenUrl(response)).toBe(`${RELEASE_BROWSER_API_ORIGIN}/s/census-code`);
  });

  it('any other origin still fails the build, and the staging build refuses the pre-launch origin', async () => {
    for (const wrong of [
      STAGING_BROWSER_API_ORIGIN,
      `https://api-live2.${SITE_DOMAIN}`,
      `${PRELAUNCH_BROWSER_API_ORIGIN}/`,
      'https://api.example.com',
      undefined,
    ]) {
      await expect(publicSiteConfig(wrong), String(wrong)).rejects.toThrow(/NEXT_PUBLIC_API_URL/);
    }
    await expect(publicSiteConfig(PRELAUNCH_BROWSER_API_ORIGIN, 'staging')).rejects.toThrow(/must be exactly/);
  });
});

describe('[OPEN-EARLY] the website server’s own photo fetches follow the build’s origin', () => {
  it('a store photo is fetched from the pre-launch origin in a pre-launch build', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', PRELAUNCH_BROWSER_API_ORIGIN);
    vi.resetModules();
    const fetchMock = vi.fn(async () => new Response('gone', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const { serveStorePhoto } = await import('./lib/store-photo-server');
    const path = '/items/store/AbCdEfGh_jKlMn-p.jpg';
    const response = await serveStorePhoto(
      new Request(`https://${SITE_DOMAIN}/media${path}?w=640`),
      { params: Promise.resolve({ path: path.slice(1).split('/') }) },
    );
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${PRELAUNCH_BROWSER_API_ORIGIN}${path}`);
  });
});
