/// <reference types="vite/client" />
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Metadata } from 'next';
import { describe, expect, it, vi } from 'vitest';
import { customerRoute } from './lib/customer-routes';
import robots from './app/robots';
import sitemap from './app/sitemap';

// This is an explicit review ledger, not a prefix allowlist: adding ANY page
// (even below an already-private layout) requires a classification here.
// "private" also includes identity and utility screens excluded from search.
const PUBLIC_PAGES = [
  '(app)/page.tsx',
  '(app)/explore/page.tsx',
  '(app)/market/page.tsx',
  '(app)/order/page.tsx', // legacy Home redirect
  '(app)/order/browse/page.tsx',
  '(app)/order/search/page.tsx',
  '(app)/order/vendor/[id]/page.tsx',
  '(app)/taxi/page.tsx', // public app handoff, no web booking
  '(marketing)/about/page.tsx',
  '(marketing)/account/delete/page.tsx', // public deletion instructions
  '(marketing)/contact/page.tsx',
  '(marketing)/drivers/page.tsx',
  '(marketing)/faq/page.tsx',
  '(marketing)/how-it-works/page.tsx',
  '(marketing)/pricing/page.tsx',
  '(marketing)/stores/page.tsx',
  '(marketing)/stores/[slug]/page.tsx', // legacy storefront redirect
  '(marketing)/vendors/page.tsx',
  '(marketing)/welcome/page.tsx',
  'legal/child-safety/page.tsx',
  'legal/privacy/page.tsx',
  'legal/terms/page.tsx',
  'store/[slug]/page.tsx',
];

const PRIVATE_PAGES = [
  '(app)/account/page.tsx',
  '(app)/cart/page.tsx', // includes checkout/payment; no separate /checkout or /pay
  '(app)/courier/page.tsx',
  '(app)/order/location/page.tsx',
  '(app)/orders/page.tsx',
  '(app)/orders/[id]/page.tsx',
  'dashboard/page.tsx',
  'dashboard/inventory/page.tsx',
  'dashboard/inventory/import/page.tsx',
  'dashboard/orders/page.tsx',
  'dashboard/settings/page.tsx',
  'portal/page.tsx',
  'portal/account/page.tsx',
  'portal/documents/page.tsx',
  'portal/history/page.tsx',
  'selfie/page.tsx',
  'track/[token]/page.tsx', // bearer-link personal data, even without sign-in
  'trip/[token]/page.tsx',
  'login/page.tsx', // identity flows, not public search content
  'signup/page.tsx',
  'offline/page.tsx', // utility fallback, already intentionally noindex
  'qr/not-found/page.tsx', // QR lifecycle screens, not store content
  'qr/retired/page.tsx',
  'qr/unavailable/page.tsx',
];

// Public machine resources, not HTML pages. New handlers and metadata endpoints
// must be reviewed here too; they cannot silently evade the census.
const PUBLIC_RESOURCES = [
  'manifest.ts',
  'opengraph-image.tsx',
  'robots.ts',
  'sitemap.ts',
  'well-known/apple-app-site-association/route.ts',
  'well-known/assetlinks.json/route.ts',
];

const APP = join(process.cwd(), 'src', 'app');
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [relative(APP, path).split(sep).join('/')];
  });
}
const FILES = sourceFiles(APP);
const PAGE = /(^|\/)page\.(tsx?|jsx?|mdx)$/;
const LAYOUT = /(^|\/)layout\.(tsx?|jsx?)$/;
const RESOURCE = /(^|\/)(route\.(tsx?|jsx?)|(?:robots|sitemap|manifest)\.(?:tsx?|jsx?|xml|txt|json|webmanifest)|(?:opengraph-image|twitter-image|icon|apple-icon)\d*\.(?:tsx?|jsx?|png|jpe?g|gif|svg|ico)|favicon\.ico)$/;

type PageModule = {
  metadata?: Metadata;
  generateMetadata?: (_props: { params: Promise<{ slug: string }> }) => Promise<Metadata>;
};
const modules = import.meta.glob<PageModule>('./app/**/{page,layout}.{tsx,ts,jsx,js}');

// Only the storefront currently generates metadata from data. Import the REAL
// route export but supply synthetic data: this test never contacts an API.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./lib/api')>(),
  fetchStorefront: vi.fn(async () => ({
    slug: 'census-store', name: 'Census store', city: 'Georgetown', description: null,
  })),
}));
const { fetchStorefront } = await import('./lib/api');

function urlOf(page: string): string {
  return `/${page.split('/').slice(0, -1).filter((segment) => !/^\(.*\)$/.test(segment)).join('/')}`;
}

function ancestors(page: string): string[] {
  const layouts: string[] = [];
  let directory = dirname(page);
  while (true) {
    const layout = FILES.filter((file) => dirname(file) === directory && LAYOUT.test(file));
    layouts.unshift(...layout);
    if (directory === '.') break;
    directory = dirname(directory);
  }
  return [...layouts, page];
}

async function load(file: string): Promise<PageModule> {
  const loader = modules[`./app/${file}`];
  expect(loader, `${file} must be evaluated, not skipped`).toBeDefined();
  return loader!();
}

async function effectiveRobots(page: string): Promise<Metadata['robots']> {
  let robots: Metadata['robots'];
  for (const file of ancestors(page)) {
    const routeModule = await load(file);
    // New dynamic metadata needs explicit fixtures, rather than guessing what
    // it will emit. This also catches re-exports and child overrides.
    if (routeModule.generateMetadata) expect(file).toBe('store/[slug]/page.tsx');
    const metadata = routeModule.generateMetadata
      ? await routeModule.generateMetadata({ params: Promise.resolve({ slug: 'census-store' }) })
      : routeModule.metadata;
    // Next replaces the whole robots field at the nearest exporting segment;
    // a child `{ index: true }` must not be hidden by an ancestor's noindex.
    // Even an explicit `robots: undefined` clears the parent's field in Next.
    if (metadata && 'robots' in metadata) robots = metadata.robots;
  }
  return robots;
}

function expectRobots(value: Metadata['robots'], index: boolean, context: string) {
  expect(value, context).toMatchObject({ index, follow: index });
  if (value && typeof value === 'object' && value.googleBot !== undefined) {
    expect(value.googleBot, `${context}: Googlebot must agree`).toMatchObject({ index, follow: index });
  }
}

describe('[DS288] every route has a reviewed search classification', () => {
  it('classifies every page exactly once, including new descendants of known segments', () => {
    const classified = [...PUBLIC_PAGES, ...PRIVATE_PAGES];
    expect(new Set(classified).size).toBe(classified.length);
    expect(FILES.filter((file) => PAGE.test(file)).sort()).toEqual(classified.sort());
    expect(new Set(classified.map(urlOf)).size).toBe(classified.length);
  });

  it('classifies every route handler and metadata resource', () => {
    expect(FILES.filter((file) => RESOURCE.test(file)).sort()).toEqual([...PUBLIC_RESOURCES].sort());
  });

  it('evaluates every real page and ancestor layout, including route groups', () => {
    expect(Object.keys(modules).map((file) => file.replace('./app/', '')).sort())
      .toEqual(FILES.filter((file) => PAGE.test(file) || LAYOUT.test(file)).sort());
  });

  it.each(PRIVATE_PAGES)('%s resolves to noindex, nofollow regardless of robots.txt', async (page) => {
    expectRobots(await effectiveRobots(page), false, `${urlOf(page)} via ${ancestors(page).join(' -> ')}`);
  });

  it.each(PUBLIC_PAGES)('%s stays indexable through all ancestor layouts', async (page) => {
    expectRobots(await effectiveRobots(page), true, `${urlOf(page)} via ${ancestors(page).join(' -> ')}`);
  });

  it('checks the storefront missing-data metadata branch without network access', async () => {
    vi.mocked(fetchStorefront).mockResolvedValueOnce(null);
    expectRobots(await effectiveRobots('store/[slug]/page.tsx'), true, 'missing storefront metadata');
  });

  it('agrees with the customer shell about which routes require sign-in', () => {
    for (const [pages, isPublic] of [[PUBLIC_PAGES, true], [PRIVATE_PAGES, false]] as const) {
      for (const page of pages.filter((file) => file.startsWith('(app)/'))) {
        expect(customerRoute(urlOf(page)).public, page).toBe(isPublic);
      }
    }
  });

  it('keeps every public page crawlable, including the catalogue under /order/', () => {
    const rules = robots().rules;
    const general = [rules].flat().filter((rule) => [rule.userAgent].flat().includes('*'));
    expect(general).toHaveLength(1);
    const rule = general[0]!;
    const allow = [rule.allow ?? []].flat();
    const disallow = [rule.disallow ?? []].flat();
    // The current policy uses literal prefixes. Fail closed if it starts
    // using wildcard/end-anchor syntax until this matcher supports it.
    for (const prefix of [...allow, ...disallow]) expect(prefix).not.toMatch(/[*$]/);
    for (const page of PUBLIC_PAGES) {
      const path = urlOf(page);
      const allowLength = Math.max(-1, ...allow.filter((prefix) => path.startsWith(prefix)).map((prefix) => prefix.length));
      const disallowLength = Math.max(-1, ...disallow.filter((prefix) => path.startsWith(prefix)).map((prefix) => prefix.length));
      expect(allowLength >= disallowLength, `${path} is crawlable`).toBe(true);
    }
  });

  it('advertises only classified public pages in the sitemap', () => {
    const publicUrls = PUBLIC_PAGES.map(urlOf);
    for (const entry of sitemap()) expect(publicUrls, entry.url).toContain(new URL(entry.url).pathname);
  });
});
