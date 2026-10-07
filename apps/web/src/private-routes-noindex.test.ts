/// <reference types="vite/client" />
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Metadata, NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { getRedirectUrl, getRewrittenUrl, unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { customerRoute } from './lib/customer-routes';
import { RELEASE_BROWSER_API_ORIGIN } from './lib/browser-api-origin';
import { SITE_DOMAIN } from './site.domain';
import robots from './app/robots';
import sitemap from './app/sitemap';

// This is an explicit review ledger, not a prefix allowlist: adding ANY page
// (even below an already-private layout) requires a classification here.
// "private" also includes identity and utility screens excluded from search.
// Secret-token/GET-side-effect pages are a separate class: crawling them stays
// forbidden even though they also carry noindex. Ordinary noindex pages MUST
// be crawlable so robots.txt does not hide their metadata from search engines.
const PUBLIC_PAGES = [
  '(app)/page.tsx',
  '(app)/explore/page.tsx',
  '(app)/market/page.tsx',
  '(app)/order/page.tsx', // legacy Home redirect
  '(app)/order/browse/page.tsx',
  '(app)/order/search/page.tsx',
  '(app)/order/vendor/[id]/page.tsx', // [W6] legacy store address, a permanent redirect to /store/<slug>
  '(app)/taxi/page.tsx', // public app handoff, no web booking
  '(marketing)/about/page.tsx',
  '(marketing)/account/delete/page.tsx', // public deletion instructions
  '(marketing)/contact/page.tsx',
  '(marketing)/drivers/page.tsx',
  '(marketing)/faq/page.tsx',
  '(marketing)/how-it-works/page.tsx',
  '(marketing)/launching-soon/page.tsx', // [Item 7] the public site's front door before launch, canonical at /
  '(marketing)/pricing/page.tsx',
  '(marketing)/stores/page.tsx',
  '(marketing)/stores/[slug]/page.tsx', // legacy storefront redirect
  '(marketing)/vendors/page.tsx',
  '(marketing)/welcome/page.tsx',
  'legal/child-safety/page.tsx',
  'legal/delivery/page.tsx', // [Q36] the card bank's delivery policy
  'legal/privacy/page.tsx',
  'legal/refunds/page.tsx', // [Q36] the card bank's refund and cancellation policy
  'legal/terms/page.tsx',
  'signup/page.tsx', // public business acquisition door [AX295 F1]
  '(app)/store/[slug]/page.tsx', // [W6] a store's one page, inside the customer app's frame
];

const PRIVATE_PAGES = [
  '(app)/account/page.tsx',
  '(app)/account/addresses/page.tsx',
  '(app)/account/favourites/page.tsx',
  '(app)/account/help/page.tsx',
  '(app)/account/profile/page.tsx',
  '(app)/account/safety/page.tsx',
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
  'dashboard/weekly-fee/page.tsx',
  'portal/page.tsx',
  'portal/account/page.tsx',
  'portal/documents/page.tsx',
  'portal/history/page.tsx',
  'portal/weekly-fee/page.tsx',
  'weekly-fee/page.tsx',
  'selfie/page.tsx',
  'login/page.tsx', // identity flows, not public search content
  'offline/page.tsx', // utility fallback, already intentionally noindex
  'qr/not-found/page.tsx', // QR lifecycle screens, not store content
  'qr/retired/page.tsx',
  'qr/unavailable/page.tsx',
];

// Bearer links reveal personal data without sign-in, including secrets in queries.
const TOKEN_DISALLOWED_PAGES = [
  'track/[token]/page.tsx',
  'trip/[token]/page.tsx',
];

// Token-bearing HTML route handlers carry response headers instead of metadata.
const TOKEN_DISALLOWED_HANDLERS = ['pay/mmg/[...path]/route.ts'];

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

// Configured routes are entry points too, even without an App Router file.
// Pin the full rules (including order/conditions), so a new alias, destination
// or host/query condition cannot silently bypass classification.
const PUBLIC_REWRITES = [
  { source: '/.well-known/apple-app-site-association', destination: '/well-known/apple-app-site-association' },
  { source: '/.well-known/assetlinks.json', destination: '/well-known/assetlinks.json' },
];
const SCAN_DISALLOWED_REWRITES = [
  { source: '/s/:code', destination: `${RELEASE_BROWSER_API_ORIGIN}/s/:code` },
];
const PUBLIC_REDIRECTS = [
  { source: '/for-vendors', destination: '/vendors', permanent: true },
  { source: '/for-drivers', destination: '/drivers', permanent: true },
  { source: '/delete-account', destination: '/account/delete', permanent: true },
];
// This rule spans public AND private paths. It preserves the destination's
// classification; /s/ must keep its header even on this earlier redirect.
const CANONICAL_HOST_REDIRECT = {
  source: '/:path((?!\\.well-known/).*)',
  has: [{ type: 'host', value: `www.${SITE_DOMAIN}` }],
  destination: `https://${SITE_DOMAIN}/:path*`,
  permanent: true,
};

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
    if (routeModule.generateMetadata) expect(file).toBe('(app)/store/[slug]/page.tsx');
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

function crawlable(path: string): boolean {
  const rules = [robots().rules].flat();
  // Fail closed on agent-specific groups or wildcard patterns until the
  // matcher models them; otherwise a Googlebot-only ban could evade the test.
  expect(rules).toHaveLength(1);
  const rule = rules[0]!;
  expect([rule.userAgent].flat()).toEqual(['*']);
  const allow = [rule.allow ?? []].flat();
  const disallow = [rule.disallow ?? []].flat();
  for (const prefix of [...allow, ...disallow]) {
    expect(prefix).toMatch(/^\//);
    expect(prefix).not.toMatch(/[*$]/);
  }
  const matchLength = (prefixes: string[]) => Math.max(-1, ...prefixes
    .filter((prefix) => path.startsWith(prefix)).map((prefix) => prefix.length));
  return matchLength(allow) >= matchLength(disallow);
}

describe('[DS288] every route has a reviewed search classification', () => {
  it('classifies every page exactly once, including new descendants of known segments', () => {
    const classified = [...PUBLIC_PAGES, ...PRIVATE_PAGES, ...TOKEN_DISALLOWED_PAGES];
    expect(new Set(classified).size).toBe(classified.length);
    expect(FILES.filter((file) => PAGE.test(file)).sort()).toEqual(classified.sort());
    expect(new Set(classified.map(urlOf)).size).toBe(classified.length);
  });

  it('classifies every route handler and metadata resource', () => {
    expect(FILES.filter((file) => RESOURCE.test(file)).sort()).toEqual([...PUBLIC_RESOURCES, ...TOKEN_DISALLOWED_HANDLERS].sort());
  });

  it('evaluates every real page and ancestor layout, including route groups', () => {
    expect(Object.keys(modules).map((file) => file.replace('./app/', '')).sort())
      .toEqual(FILES.filter((file) => PAGE.test(file) || LAYOUT.test(file)).sort());
  });

  it.each(PRIVATE_PAGES)('%s is crawlable so its noindex, nofollow is visible', async (page) => {
    expect(crawlable(urlOf(page)), `${urlOf(page)} must let crawlers read noindex`).toBe(true);
    expectRobots(await effectiveRobots(page), false, `${urlOf(page)} via ${ancestors(page).join(' -> ')}`);
  });

  it.each(TOKEN_DISALLOWED_PAGES)('%s stays disallowed AND noindex, nofollow', async (page) => {
    expect(crawlable(urlOf(page)), `${urlOf(page)} must not invite token crawling`).toBe(false);
    expectRobots(await effectiveRobots(page), false, `${urlOf(page)} via ${ancestors(page).join(' -> ')}`);
  });

  it.each(TOKEN_DISALLOWED_HANDLERS)('%s stays disallowed AND sends noindex for GET and POST', async (handler) => {
    expect(crawlable(urlOf(handler))).toBe(false);
    const { GET, POST } = await import('./app/pay/mmg/[...path]/route');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    try {
      for (const method of ['GET', 'POST'] as const) {
        const request = new Request('https://example.test/pay/mmg/success', { method });
        const response = await (method === 'GET' ? GET : POST)(request, { params: Promise.resolve({ path: ['success'] }) });
        expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
        expect(await response.text()).toContain('<meta name="robots" content="noindex">');
      }
    } finally { fetch.mockRestore(); }
  });

  it.each(PUBLIC_PAGES)('%s stays crawlable and indexable through all ancestor layouts', async (page) => {
    expect(crawlable(urlOf(page)), `${urlOf(page)} is public and crawlable`).toBe(true);
    expectRobots(await effectiveRobots(page), true, `${urlOf(page)} via ${ancestors(page).join(' -> ')}`);
  });

  it('pins signup as a public, crawlable and indexable business acquisition door [AX295 F1]', async () => {
    expect(PUBLIC_PAGES).toContain('signup/page.tsx');
    expect(crawlable('/signup')).toBe(true);
    expectRobots(await effectiveRobots('signup/page.tsx'), true, '/signup must stay indexable');
  });

  it('checks the storefront missing-data metadata branch without network access', async () => {
    vi.mocked(fetchStorefront).mockResolvedValueOnce(null);
    expectRobots(await effectiveRobots('(app)/store/[slug]/page.tsx'), true, 'missing storefront metadata');
  });

  it('agrees with the customer shell about which routes require sign-in', () => {
    for (const [pages, isPublic] of [[PUBLIC_PAGES, true], [PRIVATE_PAGES, false]] as const) {
      for (const page of pages.filter((file) => file.startsWith('(app)/'))) {
        expect(customerRoute(urlOf(page)).public, page).toBe(isPublic);
      }
    }
  });

  it('keeps public machine resources crawlable, including both association-file aliases', () => {
    for (const path of [
      '/robots.txt', '/sitemap.xml', '/manifest.webmanifest', '/opengraph-image',
      '/well-known/apple-app-site-association', '/well-known/assetlinks.json',
      '/.well-known/apple-app-site-association', '/.well-known/assetlinks.json',
    ]) {
      expect(crawlable(path), path).toBe(true);
    }
  });

  it('advertises only classified public pages in the sitemap', () => {
    const publicUrls = PUBLIC_PAGES.map(urlOf);
    for (const entry of sitemap()) expect(publicUrls, entry.url).toContain(new URL(entry.url).pathname);
  });

  describe('configured rewrites and redirects [AX303 F3]', () => {
    let config: NextConfig;

    beforeAll(async () => {
      // Evaluate the real public-release config, not the staging-wide header
      // (which could mask a missing /s/ rule). No API request is made.
      vi.stubEnv('NEXT_PUBLIC_API_URL', RELEASE_BROWSER_API_ORIGIN);
      vi.stubEnv('SWIFT_WEB_CHANNEL', 'production');
      vi.stubEnv('SWIFT_WEB_IMAGE_BUILD', '0');
      vi.resetModules();
      const { default: createNextConfig } = await import('../next.config');
      config = createNextConfig(PHASE_PRODUCTION_BUILD);
    });

    afterAll(() => vi.unstubAllEnvs());

    it('classifies every configured rewrite, including the GET-side-effect resolver', async () => {
      expect(await config.rewrites!()).toEqual([...PUBLIC_REWRITES, ...SCAN_DISALLOWED_REWRITES]);
    });

    it('classifies every configured redirect, including the mixed public/private host alias', async () => {
      expect(await config.redirects!()).toEqual([...PUBLIC_REDIRECTS, CANONICAL_HOST_REDIRECT]);
    });

    it('disallows QR scan crawling and declares an unconditional noindex/nofollow header', async () => {
      for (const path of ['/s/', '/s/census-code', '/s/census-code/child']) {
        expect(crawlable(path), `${path} must not invite scan-count inflation`).toBe(false);
      }
      const rules = await config.headers!();
      expect(rules.find((rule) => rule.source === '/s/:path*')).toEqual({
        source: '/s/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      });
    });

    it('carries noindex/nofollow through Next header matching and the external QR rewrite', async () => {
      for (const path of ['/s/census-code', '/s/census-code?source=census']) {
        const response = await unstable_getResponseFromNextConfig({ url: `https://${SITE_DOMAIN}${path}`, nextConfig: config });
        expect(getRewrittenUrl(response)).toBe(`${RELEASE_BROWSER_API_ORIGIN}${path}`);
        expect(response.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
      }
    });

    it('covers /s/ descendants and the www redirect without changing its destination', async () => {
      for (const path of ['/s/', '/s/census-code/child']) {
        const response = await unstable_getResponseFromNextConfig({ url: `https://${SITE_DOMAIN}${path}`, nextConfig: config });
        expect(response.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
      }
      const response = await unstable_getResponseFromNextConfig({
        url: `https://www.${SITE_DOMAIN}/s/census-code`,
        headers: { host: `www.${SITE_DOMAIN}` },
        nextConfig: config,
      });
      expect(getRedirectUrl(response)).toBe(`https://${SITE_DOMAIN}/s/census-code`);
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    });

    it('keeps public pages and configured public aliases crawlable without a noindex header', async () => {
      for (const path of [...PUBLIC_PAGES.map(urlOf), ...PUBLIC_REDIRECTS.map((rule) => rule.source), ...PUBLIC_REWRITES.map((rule) => rule.source)]) {
        expect(crawlable(path), path).toBe(true);
        const response = await unstable_getResponseFromNextConfig({ url: `https://${SITE_DOMAIN}${path}`, nextConfig: config });
        expect(response.headers.get('x-robots-tag'), path).toBeNull();
      }
    });
  });
});
