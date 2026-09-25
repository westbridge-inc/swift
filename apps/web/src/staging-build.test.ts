import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import type { NextConfig } from 'next';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('asks every crawler not to index the staging copy; the public site never sends that', async () => {
    expect(headerOf(await siteWideHeaders(await productionConfig(STAGING)), 'X-Robots-Tag')).toBe('noindex, nofollow');
    const publicRules = await (await productionConfig(PUBLIC_SITE)).headers!();
    expect(publicRules.flatMap((rule) => rule.headers).map((header) => header.key)).not.toContain('X-Robots-Tag');
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
      ['env', 'headers', 'poweredByHeader', 'redirects', 'rewrites', 'transpilePackages'].sort(),
    );
    expect(config.env).toEqual({ NEXT_PUBLIC_API_URL: RELEASE_BROWSER_API_ORIGIN });
    expect(headerOf(await siteWideHeaders(config), 'Content-Security-Policy')).toBe(
      buildBrowserContentSecurityPolicy('production'),
    );
  });
});
