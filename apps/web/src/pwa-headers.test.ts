import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBrowserContentSecurityPolicy, RELEASE_BROWSER_API_ORIGIN } from './lib/browser-api-origin';

// ---------------------------------------------------------------------------
// [PWA-1] What the production site sends with the service worker, and whether
// its Content-Security-Policy lets a page install that worker and read the
// manifest — read from the real next.config, built for production.
//
// The CSP is not widened for this: a same-origin worker falls back to
// script-src and the manifest to default-src, and both already say 'self'. The
// test keeps it that way — a future worker-src or manifest-src that leaves
// 'self' out would silently switch the installed app off.
// ---------------------------------------------------------------------------

type Header = { key: string; value: string };

async function productionHeaders() {
  vi.stubEnv('NEXT_PUBLIC_API_URL', RELEASE_BROWSER_API_ORIGIN);
  vi.resetModules();
  const { default: createNextConfig } = await import('../next.config');
  return createNextConfig(PHASE_PRODUCTION_BUILD).headers!();
}

const headerOf = (headers: Header[], key: string) => headers.find((header) => header.key === key)?.value;

/** The sources the browser applies for a fetch, walking the CSP fallback chain. */
function effectiveSources(csp: string, chain: string[]): string[] {
  const directives = new Map(
    csp.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
  for (const name of chain) {
    const sources = directives.get(name);
    if (sources) return sources;
  }
  return [];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('[PWA-1] headers for the installed app', () => {
  it('serves the worker as JavaScript and never from a cache', async () => {
    const rules = await productionHeaders();
    const worker = rules.find((rule) => rule.source === '/sw.js');
    expect(worker, 'next.config has no /sw.js header rule').toBeDefined();
    expect(headerOf(worker!.headers, 'Content-Type')).toMatch(/^application\/javascript/);
    expect(headerOf(worker!.headers, 'Cache-Control')).toMatch(/no-cache/);
    expect(headerOf(worker!.headers, 'Cache-Control')).toMatch(/no-store/);
  });

  it('lets a page install a same-origin worker and read the manifest, with the CSP unchanged', async () => {
    const rules = await productionHeaders();
    const siteWide = rules.find((rule) => rule.source === '/(.*)');
    const csp = headerOf(siteWide!.headers, 'Content-Security-Policy')!;

    expect(csp).toBe(buildBrowserContentSecurityPolicy('production'));
    expect(effectiveSources(csp, ['worker-src', 'child-src', 'script-src', 'default-src'])).toContain("'self'");
    expect(effectiveSources(csp, ['manifest-src', 'default-src'])).toContain("'self'");
    // The worker's own fetches (the offline page, build files) are same-origin.
    expect(effectiveSources(csp, ['connect-src', 'default-src'])).toContain("'self'");
    // The script sits at the root, so its scope is already the whole site.
    expect(rules.flatMap((rule) => rule.headers).some((header) => header.key === 'Service-Worker-Allowed')).toBe(false);
  });
});
