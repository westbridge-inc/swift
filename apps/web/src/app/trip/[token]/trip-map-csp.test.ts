import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBrowserContentSecurityPolicy,
  RELEASE_BROWSER_API_ORIGIN,
  STAGING_BROWSER_API_ORIGIN,
} from '@/lib/browser-api-origin';
import { mapEmbedUrl } from '@/lib/live-tracking';

// ---------------------------------------------------------------------------
// [WEB-GUARDS] The public trip-share page embeds an approximate map of the
// ride in an iframe. The site's own Content-Security-Policy had no frame
// source, so the browser fell back to default-src 'self' and blocked the map:
// the person a rider shared their trip with saw an empty box. The policy must
// allow exactly the map page the trip view embeds, and nothing broader.
// ---------------------------------------------------------------------------

type Header = { key: string; value: string };

/** The sources the browser applies to an iframe, walking the CSP fallback chain. */
function frameSources(csp: string): string[] {
  const directives = new Map(
    csp.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
  for (const name of ['frame-src', 'child-src', 'default-src']) {
    const sources = directives.get(name);
    if (sources) return sources;
  }
  return [];
}

const embedOrigin = new URL(mapEmbedUrl({ lat: 6.8013, lng: -58.1551 })).origin;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('[WEB-GUARDS] the trip-share map is allowed by the site policy', () => {
  it('the site-wide production header lets the trip page frame its map', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', RELEASE_BROWSER_API_ORIGIN);
    vi.resetModules();
    const { default: createNextConfig } = await import('../../../../next.config');
    const rules = await createNextConfig(PHASE_PRODUCTION_BUILD).headers!();
    const siteWide = rules.find((rule: { source: string }) => rule.source === '/(.*)');
    const csp = (siteWide!.headers as Header[]).find((header) => header.key === 'Content-Security-Policy')!.value;

    expect(frameSources(csp)).toContain(embedOrigin);
  });

  it.each([
    ['production', 'production'],
    ['production', 'staging'],
    ['development', 'production'],
  ] as const)('%s build, %s channel: exactly the map origin, never a wildcard', (mode, channel) => {
    const sources = frameSources(buildBrowserContentSecurityPolicy(mode, channel));
    expect(sources).toEqual([embedOrigin]);
  });

  it('opening the frame does not loosen who may frame Swift, or anything else', () => {
    const csp = buildBrowserContentSecurityPolicy('production');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain(STAGING_BROWSER_API_ORIGIN);
  });
});
