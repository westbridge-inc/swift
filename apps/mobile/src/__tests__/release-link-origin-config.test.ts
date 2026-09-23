import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Native entitlements, the JavaScript router, server-generated QR/trip links,
// and the web-domain declaration compile in separate packages.  This contract
// prevents a superficially green package test from letting those packages drift
// back to different public hosts.
const ROOT = join(process.cwd(), '../..');
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

const mobileConfig = read('apps/mobile/app.config.ts');
const eas = JSON.parse(read('apps/mobile/eas.json')) as {
  build: { production: { env: Record<string, string> }; preview: { env: Record<string, string> } };
};
const mobileOrigin = read('apps/mobile/src/lib/publicOrigin.ts');
const mobileRuntime = read('apps/mobile/src/lib/deepLinkParse.ts');
const mobileApi = read('apps/mobile/src/services/api.ts');
const apiOrigin = read('apps/api/src/lib/public-origin.ts');
const apiQr = read('apps/api/src/modules/qr/qr-codes.ts');
const apiTripShare = read('apps/api/src/modules/safety/trip-share.service.ts');
const webDomain = read('apps/web/src/site.domain.ts');

describe('release public-link origin contract', () => {
  it('keeps native, JavaScript, server output, and the public website on swiftgy.com', () => {
    expect(webDomain).toContain("SITE_DOMAIN = 'swiftgy.com'");
    expect(webDomain).toContain('SITE_ORIGIN = `https://${SITE_DOMAIN}`');
    expect(mobileOrigin).toContain("CANONICAL_PUBLIC_SITE_ORIGIN = 'https://swiftgy.com'");
    expect(mobileConfig).toContain("CANONICAL_LINK_DOMAIN = 'swiftgy.com'");
    expect(mobileApi).toContain('CANONICAL_PUBLIC_SITE_ORIGIN');
    expect(mobileApi).not.toContain("process.env['EXPO_PUBLIC_WEB_URL']");
    expect(apiOrigin).toContain("CANONICAL_PUBLIC_WEB_ORIGIN = 'https://swiftgy.com'");
    expect(apiQr).toContain('return publicWebOrigin();');
    expect(apiTripShare).toContain('`${publicWebOrigin()}/trip/${token}`');
  });

  it('makes production input explicit and rejects silent legacy fallbacks', () => {
    expect(eas.build.production.env).toMatchObject({
      EXPO_PUBLIC_LINK_ENV: 'production',
      EXPO_PUBLIC_WEB_URL: 'https://swiftgy.com',
      SWIFT_LINK_DOMAIN: 'swiftgy.com',
    });
    expect(mobileRuntime).not.toContain("'https://swift.gy'");
    expect(mobileConfig).not.toContain("?? 'swift.gy'");
  });

  it('keeps preview link behavior explicit and closed until a reviewed host is supplied', () => {
    expect(eas.build.preview.env).toMatchObject({
      EXPO_PUBLIC_LINK_ENV: 'preview',
      SWIFT_LINK_DOMAIN: 'swiftgy.com',
      EXPO_PUBLIC_LINK_PREVIEW_HOSTS: '',
    });
    expect(mobileRuntime).toContain("if (channel === 'preview')");
    expect(mobileRuntime).toContain('return restrictPolicy(candidate, candidate.previewHosts);');
  });

  it('keeps browser API calls same-site while retaining api.swift.gy as the server-only upstream', () => {
    const browserApiOrigin = read('apps/web/src/lib/browser-api-origin.ts');
    const nextConfig = read('apps/web/next.config.ts');
    expect(browserApiOrigin).toContain('RELEASE_BROWSER_API_ORIGIN = SITE_ORIGIN');
    expect(browserApiOrigin).toContain("RELEASE_UPSTREAM_API_ORIGIN = 'https://api.swift.gy'");
    expect(nextConfig).toContain("source: '/api/v1/:path*', destination: `${upstreamApiOrigin}/api/v1/:path*`");
  });
});
