import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_BROWSER_API_ORIGIN } from './lib/browser-api-origin';
import { PRELOADED_FONTS } from './lib/fonts';

// ---------------------------------------------------------------------------
// [PERF #7] The self-hosted fonts went out with Next's default for public
// files (max-age=0): every full page load, every QR scan, asked the server
// again about each face before drawing text in it. They are now kept for 30
// days. Read from the real next.config, built for production.
// ---------------------------------------------------------------------------

type Header = { key: string; value: string };
type Rule = { source: string; headers: Header[] };

async function productionHeaders(): Promise<Rule[]> {
  vi.stubEnv('NEXT_PUBLIC_API_URL', RELEASE_BROWSER_API_ORIGIN);
  vi.resetModules();
  const { default: createNextConfig } = await import('../next.config');
  return createNextConfig(PHASE_PRODUCTION_BUILD).headers!() as Promise<Rule[]>;
}

/** Next matches `source` with path-to-regexp: `:file` is exactly one path segment. */
function matches(source: string, path: string): boolean {
  const pattern = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-z]+/gi, '[^/]+');
  return new RegExp(`^${pattern}$`).test(path);
}
const cacheControlFor = (rules: Rule[], path: string) => rules
  .filter((rule) => matches(rule.source, path))
  .flatMap((rule) => rule.headers)
  .filter((header) => header.key.toLowerCase() === 'cache-control')
  .map((header) => header.value)
  .at(-1);

const WEB = join(__dirname, '..');
const css = readFileSync(join(WEB, 'src', 'app', 'globals.css'), 'utf8');
const fontUrls = [...new Set([...css.matchAll(/url\('(\/fonts\/[^']+)'\)/g)].map((match) => match[1]!))];

afterEach(() => vi.unstubAllEnvs());

describe('[PERF #7] the font files are kept by the browser', () => {
  it('every font the site declares or preloads is served with a 30-day cache', async () => {
    const rules = await productionHeaders();
    expect(fontUrls.length).toBeGreaterThanOrEqual(6);
    for (const url of [...fontUrls, ...PRELOADED_FONTS]) {
      const value = cacheControlFor(rules, url);
      expect(value, `${url} has no Cache-Control rule`).toBeDefined();
      expect(value).toMatch(/^public,/);
      expect(Number(/max-age=(\d+)/.exec(value!)?.[1])).toBe(30 * 24 * 3600);
      // Names carry no version, so never "immutable": a stale copy is re-checked.
      expect(value).not.toMatch(/immutable/);
      expect(value).toMatch(/stale-while-revalidate=\d+/);
    }
  });

  it('every file in public/fonts is one the rule covers, and the rule covers nothing else', async () => {
    const rules = await productionHeaders();
    for (const file of readdirSync(join(WEB, 'public', 'fonts')).filter((name) => name.endsWith('.woff2'))) {
      expect(cacheControlFor(rules, `/fonts/${file}`)).toMatch(/max-age=2592000/);
    }
    for (const path of ['/', '/sw.js', '/store/sample', '/fonts', '/fonts/sub/dir.woff2', '/manifest.webmanifest']) {
      expect(cacheControlFor(rules, path) ?? '').not.toMatch(/max-age=2592000/);
    }
  });
});
