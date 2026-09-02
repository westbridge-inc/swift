import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SITE_DOMAIN } from '../site.domain';
import {
  buildBrowserContentSecurityPolicy,
  DEVELOPMENT_BROWSER_API_ORIGIN,
  RELEASE_BROWSER_API_ORIGIN,
  resolveBrowserApiOrigin,
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

  it('the release origin is derived from the one domain file, not a second hardcoded host', () => {
    expect(RELEASE_BROWSER_API_ORIGIN).toBe(`https://api.${SITE_DOMAIN}`);
    expect(source('src/lib/browser-api-origin.ts')).not.toMatch(/https:\/\/api\.[a-z]+\.[a-z]+/);
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
  it('production connect-src names the release origin (https and wss) and nothing broader', () => {
    const csp = buildBrowserContentSecurityPolicy('production');
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src '))!;
    expect(connect).toBe(`connect-src 'self' ${RELEASE_BROWSER_API_ORIGIN} ${RELEASE_BROWSER_API_ORIGIN.replace('https://', 'wss://')}`);
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
