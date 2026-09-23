import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SITE_DOMAIN, SITE_ORIGIN } from '../site.domain';
import {
  buildBrowserContentSecurityPolicy,
  DEVELOPMENT_BROWSER_API_ORIGIN,
  RELEASE_BROWSER_API_ORIGIN,
  RELEASE_UPSTREAM_API_ORIGIN,
  resolveBrowserApiOrigin,
  resolveServerUpstreamApiOrigin,
  resolveUpstreamApiOrigin,
} from './browser-api-origin';

// ---------------------------------------------------------------------------
// [SWX-DEV-WEB-076 · integrated] The browser API origin has ONE authority.
// The source contract below runs against the real tree: every consumer
// imports the authority and none reads the variable itself; the config
// derives its CSP from the same authority; the only static public-env read
// lives in the authority. The resolver cases pin the release law.
// ---------------------------------------------------------------------------

const browserConsumerFiles = [
  'src/lib/api.ts',
  'src/lib/auth.ts',
  'src/lib/customer.ts',
  'src/app/track/[token]/track-client.tsx',
  'src/app/trip/[token]/trip-share-client.tsx',
  'src/app/dashboard/inventory/import/page.tsx',
] as const;

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('public-web browser API origin source contract', () => {
  it('routes every browser consumer through one authority', () => {
    for (const relativePath of browserConsumerFiles) {
      const contents = source(relativePath);
      expect(contents, relativePath).not.toContain('NEXT_PUBLIC_API_URL');
      expect(contents, relativePath).not.toContain(DEVELOPMENT_BROWSER_API_ORIGIN);
      expect(contents, relativePath).not.toContain(RELEASE_BROWSER_API_ORIGIN);
      expect(contents.match(/from '@\/lib\/browser-api-origin'/g), relativePath).toHaveLength(1);
    }
  });

  it('keeps the client document-consent page out of the server upstream module', () => {
    const clientPage = source('src/app/portal/documents/page.tsx');
    const serverFetchers = source('src/lib/api.ts');
    expect(clientPage).toContain("'use client'");
    expect(clientPage).not.toContain("from '@/lib/api'");
    expect(clientPage).toContain("PRIVACY_NOTICE_HREF = '/legal/privacy'");
    expect(clientPage).toContain('href={PRIVACY_NOTICE_HREF}');
    expect(serverFetchers).not.toContain('LEGAL_URL');
  });

  it('the config derives its mode from the Next phase and its CSP from the authority, never from a scheme wildcard', () => {
    const contents = source('next.config.ts');
    expect(contents).not.toContain("connect-src 'self' https: wss:");
    expect(contents).toContain('buildBrowserContentSecurityPolicy');
    expect(contents).toContain("phase === PHASE_DEVELOPMENT_SERVER || linting ? 'development' : 'production'");
    expect(contents).toContain("const linting = process.argv.includes('lint');");
    expect(contents).not.toContain('process.env.NODE_ENV');
    expect(contents).not.toContain("process.env['NEXT_PUBLIC_API_URL']");
  });

  it('has exactly one static public-env read, in the authority', () => {
    const authority = source('src/lib/browser-api-origin.ts');
    expect(authority.match(/process\.env\.NEXT_PUBLIC_API_URL/g)).toHaveLength(1);
    expect(source('next.config.ts')).not.toContain('process.env.NEXT_PUBLIC_API_URL');
  });

  it('keeps browser transport same-site while retaining a distinct server-only upstream', () => {
    expect(SITE_DOMAIN).toBe('swiftgy.com');
    expect(RELEASE_BROWSER_API_ORIGIN).toBe(SITE_ORIGIN);
    expect(RELEASE_UPSTREAM_API_ORIGIN).toBe('https://api.swift.gy');
    expect(RELEASE_UPSTREAM_API_ORIGIN).not.toBe(RELEASE_BROWSER_API_ORIGIN);
  });

  it('binds the executable CI build inputs to the same-site browser transport and the distinct upstream', () => {
    const ci = source('../../.github/workflows/ci.yml');
    expect(ci).toContain('NEXT_PUBLIC_API_URL: https://swiftgy.com');
    expect(ci).toContain('API_URL: https://api.swift.gy');
  });
});

describe('resolveUpstreamApiOrigin', () => {
  it('production requires the exact server-only upstream and has no fallback', () => {
    expect(() => resolveUpstreamApiOrigin('production', undefined)).toThrow(/API_URL is required/);
    expect(resolveUpstreamApiOrigin('production', RELEASE_UPSTREAM_API_ORIGIN)).toBe(RELEASE_UPSTREAM_API_ORIGIN);
    for (const wrong of [
      RELEASE_BROWSER_API_ORIGIN,
      `${RELEASE_UPSTREAM_API_ORIGIN}/`,
      `${RELEASE_UPSTREAM_API_ORIGIN}/v1`,
      `${RELEASE_UPSTREAM_API_ORIGIN}?x=1`,
      'http://api.swift.gy',
      'https://api.swiftgy.com',
      'https://attacker.example',
    ]) {
      expect(() => resolveUpstreamApiOrigin('production', wrong), wrong).toThrow();
    }
  });

  it('development defaults to the local API and rejects a release upstream', () => {
    expect(resolveUpstreamApiOrigin('development', undefined)).toBe(DEVELOPMENT_BROWSER_API_ORIGIN);
    expect(() => resolveUpstreamApiOrigin('development', RELEASE_UPSTREAM_API_ORIGIN)).toThrow(/API_URL must be exactly/);
  });
});

describe('resolveServerUpstreamApiOrigin', () => {
  it('defaults server-rendered development fetches to the local API, but production is exact and fail-closed', () => {
    expect(resolveServerUpstreamApiOrigin({ NODE_ENV: 'development', API_URL: undefined })).toBe(DEVELOPMENT_BROWSER_API_ORIGIN);
    expect(resolveServerUpstreamApiOrigin({ NODE_ENV: 'test', API_URL: undefined })).toBe(DEVELOPMENT_BROWSER_API_ORIGIN);
    expect(resolveServerUpstreamApiOrigin({ NODE_ENV: 'production', API_URL: RELEASE_UPSTREAM_API_ORIGIN })).toBe(RELEASE_UPSTREAM_API_ORIGIN);
    expect(() => resolveServerUpstreamApiOrigin({ NODE_ENV: 'production', API_URL: undefined })).toThrow(/API_URL is required/);
    expect(() => resolveServerUpstreamApiOrigin({ NODE_ENV: 'production', API_URL: RELEASE_BROWSER_API_ORIGIN })).toThrow(/API_URL must be exactly/);
  });
});

describe('resolveBrowserApiOrigin', () => {
  it('development with nothing configured is exactly localhost', () => {
    expect(resolveBrowserApiOrigin('development', undefined)).toBe(DEVELOPMENT_BROWSER_API_ORIGIN);
  });

  it('a production build with nothing configured refuses — never a silent localhost in a release', () => {
    expect(() => resolveBrowserApiOrigin('production', undefined)).toThrow(/required for a production web build/);
  });

  it('a production build accepts exactly the canonical release origin and nothing else', () => {
    expect(resolveBrowserApiOrigin('production', RELEASE_BROWSER_API_ORIGIN)).toBe(RELEASE_BROWSER_API_ORIGIN);
    for (const wrong of [
      `${RELEASE_BROWSER_API_ORIGIN}/`,
      `${RELEASE_BROWSER_API_ORIGIN}/v1`,
      `${RELEASE_BROWSER_API_ORIGIN}?x=1`,
      `${RELEASE_BROWSER_API_ORIGIN}#f`,
      `${RELEASE_BROWSER_API_ORIGIN}:443`,
      RELEASE_BROWSER_API_ORIGIN.replace('https://', 'http://'),
      RELEASE_BROWSER_API_ORIGIN.replace('https://', 'https://user:pw@'),
      'https://api.example.com',
      ' https://api.example.com',
      '',
      'not a url',
    ]) {
      expect(() => resolveBrowserApiOrigin('production', wrong), wrong).toThrow();
    }
  });

  it('development with a configured value accepts exactly localhost and refuses the release origin', () => {
    expect(resolveBrowserApiOrigin('development', DEVELOPMENT_BROWSER_API_ORIGIN)).toBe(DEVELOPMENT_BROWSER_API_ORIGIN);
    expect(() => resolveBrowserApiOrigin('development', RELEASE_BROWSER_API_ORIGIN)).toThrow(/must be exactly/);
  });
});

describe('buildBrowserContentSecurityPolicy', () => {
  it('production connect-src is same-origin only; the upstream is server-side', () => {
    const csp = buildBrowserContentSecurityPolicy('production');
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src '))!;
    expect(connect).toBe("connect-src 'self'");
    expect(connect).not.toContain(RELEASE_UPSTREAM_API_ORIGIN);
    expect(connect.split(' ')).not.toContain('https:'); // no scheme wildcard in connect-src (img-src may still allow https: images)
    expect(connect.split(' ')).not.toContain('wss:');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('development connect-src is localhost only', () => {
    const connect = buildBrowserContentSecurityPolicy('development').split('; ').find((d) => d.startsWith('connect-src '))!;
    expect(connect).toContain(DEVELOPMENT_BROWSER_API_ORIGIN);
    expect(connect).not.toContain(RELEASE_BROWSER_API_ORIGIN);
  });
});

describe('Strict-cookie production transport contract', () => {
  it('routes browser session endpoints through the same public origin and a server-only rewrite', () => {
    const browserSession = source('../api/src/modules/auth/browser-session.ts');
    const nextConfig = source('next.config.ts');
    const sessionPaths = [
      '/api/v1/auth/register',
      '/api/v1/auth/verify-otp',
      '/api/v1/auth/me',
      '/api/v1/customer/home',
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
    ];

    expect(RELEASE_BROWSER_API_ORIGIN).toBe(SITE_ORIGIN);
    expect(browserSession).toContain("'SameSite=Strict'");
    for (const path of sessionPaths) {
      expect(new URL(`${RELEASE_BROWSER_API_ORIGIN}${path}`).origin).toBe(SITE_ORIGIN);
      expect(new URL(`${RELEASE_BROWSER_API_ORIGIN}${path}`).origin).not.toBe(RELEASE_UPSTREAM_API_ORIGIN);
    }
    expect(nextConfig).toContain("source: '/api/v1/:path*', destination: `${upstreamApiOrigin}/api/v1/:path*`");
    expect(nextConfig).toContain('resolveConfiguredUpstreamApiOrigin');
  });
});
