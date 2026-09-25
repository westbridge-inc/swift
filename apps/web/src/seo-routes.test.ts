import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The real config refuses to load while company details are placeholders.
vi.mock('@/site.config', () => ({
  SITE_ORIGIN: 'https://swiftgy.com',
  site: { legalEntityName: 'Swift Test Company Ltd', supportEmail: 'support@swiftgy.com' },
  launch: { markets: ['Georgetown, Guyana'], webOrdering: 'live', verticals: {} },
  showAppStoreBadges: false,
}));

const { default: sitemap } = await import('./app/sitemap');
const { default: robots } = await import('./app/robots');
const { metadata: rootMetadata } = await import('./app/layout');
const { metadata: welcomeMetadata } = await import('./app/(marketing)/welcome/page');
const home = await import('./app/(app)/page');

const SITE = 'https://swiftgy.com';
const APP = join(process.cwd(), 'src', 'app');

/** Every page file in the app, by the URL it serves: route groups — `(app)`,
 *  `(marketing)` — are folders only, and never part of the address. */
function pagesByUrl(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) {
        const segments = relative(APP, directory).split(sep).filter((segment) => segment && !/^\(.*\)$/.test(segment));
        const url = `/${segments.join('/')}`;
        found.set(url, [...(found.get(url) ?? []), relative(APP, path).split(sep).join('/')]);
      }
    }
  };
  walk(APP);
  return found;
}

// ---------------------------------------------------------------------------
// [Q7b] `/` became the ordering Home. Every duty the old landing page carried
// for search engines has to survive the move: the sitemap still lists only
// real public pages and still leads with `/`, robots still let crawlers read
// `/` and keep them out of accounts, and `/` still carries the site's
// canonical address and card. The introduction moved to /welcome, which says
// so in its own canonical.
// ---------------------------------------------------------------------------

describe('[Q7b] the site’s search duties survive the move', () => {
  const entries = sitemap();
  const paths = entries.map((entry) => new URL(entry.url).pathname);

  it('the sitemap lists absolute apex URLs, leads with the ordering Home, and includes the moved introduction', () => {
    for (const entry of entries) expect(entry.url.startsWith(`${SITE}/`) || entry.url === SITE, entry.url).toBe(true);
    expect(paths[0]).toBe('/');
    expect(entries[0]!.priority).toBe(1);
    expect(paths).toContain('/welcome');
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('every sitemap address is served by exactly one real page — `/` by the ordering Home', () => {
    const pages = pagesByUrl();
    for (const path of paths) expect(pages.get(path)?.length, `${path} → ${pages.get(path)}`).toBe(1);
    expect(pages.get('/')).toEqual(['(app)/page.tsx']);
    expect(pages.get('/welcome')).toEqual(['(marketing)/welcome/page.tsx']);
  });

  it('robots lets crawlers read Home and the company pages, and keeps them out of accounts', () => {
    const rules = robots();
    const rule = Array.isArray(rules.rules) ? rules.rules[0]! : rules.rules;
    const allow = [rule.allow ?? []].flat();
    const disallow = [rule.disallow ?? []].flat();
    expect(allow).toContain('/');
    for (const privatePath of ['/cart', '/account', '/orders/', '/order/', '/login', '/dashboard/', '/portal/', '/track/', '/trip/']) {
      expect(disallow, privatePath).toContain(privatePath);
    }
    // No listed page is one robots turns away (the longer Allow wins).
    const blocked = (path: string) => {
      const allowMatch = Math.max(-1, ...allow.filter((prefix) => path.startsWith(prefix)).map((prefix) => prefix.length));
      const disallowMatch = Math.max(-1, ...disallow.filter((prefix) => path.startsWith(prefix)).map((prefix) => prefix.length));
      return disallowMatch > allowMatch;
    };
    for (const path of paths) expect(blocked(path), path).toBe(false);
    expect(rules.sitemap).toBe(`${SITE}/sitemap.xml`);
    expect(rules.host).toBe(SITE);
  });

  it('`/` keeps the site’s canonical address, title and card — the Home adds no override of its own', () => {
    expect(rootMetadata.metadataBase?.toString()).toBe(`${SITE}/`);
    expect(rootMetadata.alternates?.canonical).toBe(SITE);
    expect(rootMetadata.openGraph).toMatchObject({ url: SITE, siteName: 'Swift' });
    expect(rootMetadata.title).toMatchObject({ default: expect.stringContaining('Swift') });
    expect(rootMetadata.robots).toMatchObject({ index: true, follow: true });
    expect('metadata' in home).toBe(false);
    expect('generateMetadata' in home).toBe(false);
  });

  it('the introduction at /welcome is canonical at its own address', () => {
    expect(welcomeMetadata.alternates?.canonical).toBe(`${SITE}/welcome`);
    expect(welcomeMetadata.title).toBe('Why Swift');
  });
});
