import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';

// React's `cache` only remembers inside a real server render. Give it that
// meaning here — one memo per test, like one memo per request — so the test
// can count what one visit to a store page costs.
const memo = vi.hoisted(() => ({ maps: [] as Array<Map<string, unknown>> }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    cache: <A extends unknown[], R>(fn: (..._args: A) => R) => {
      const own = new Map<string, unknown>();
      memo.maps.push(own);
      return (...args: A): R => {
        const key = JSON.stringify(args);
        if (!own.has(key)) own.set(key, fn(...args));
        return own.get(key) as R;
      };
    },
  };
});
vi.mock('@/site.config', () => ({
  site: { legalEntityName: 'Swift Test Company Ltd', supportEmail: 'support@swiftgy.com' },
  launch: { markets: ['Georgetown, Guyana'], webOrdering: 'live' },
  showAppStoreBadges: false,
  SITE_ORIGIN: 'https://swiftgy.com',
}));

const STORE = {
  id: 's1', slug: 'oasis', name: 'Oasis Cafe', description: null, vendorType: 'RESTAURANT', logoUrl: null, coverImageUrl: null,
  city: 'Georgetown', region: 'Demerara', cuisineTypes: [], tags: [], displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false,
  isCurrentlyOpen: true, acceptingOrders: true, estimatedPrepTime: 20, minOrderAmount: 0, isFeatured: false,
  addressLine1: '1 Main St', operatingHours: [], categories: [],
};

let fetchMock: ReturnType<typeof mockApi>;
beforeEach(() => {
  for (const map of memo.maps) map.clear();
  fetchMock = mockApi(({ url }) => (url.pathname === '/api/v1/public/storefronts/oasis'
    ? { body: { success: true, data: STORE } }
    : { status: 404, body: { success: false } }));
});

describe('[W2] a store page costs one read of the store, not two', () => {
  it('its title and its page share one read, kept 30 seconds by the server, with no person on it', async () => {
    const { generateStorefrontMetadata } = await import('@/components/storefront/storefront-page');
    const params = Promise.resolve({ slug: 'oasis' });
    const metadata = await generateStorefrontMetadata({ params });
    const { StorefrontPage } = await import('@/components/storefront/storefront-page');
    await StorefrontPage({ params, searchParams: Promise.resolve({}) });
    expect(metadata.title).toBe('Oasis Cafe — order on Swift');
    const reads = fetchMock.mock.calls.filter(([url]) => String(url).includes('/public/storefronts/'));
    expect(reads).toHaveLength(1);
    const init = reads[0]![1] as RequestInit & { next?: { revalidate?: number; tags?: string[] } };
    expect(init.cache).toBeUndefined();
    expect(init.next).toEqual({ revalidate: 30, tags: ['storefront:oasis'] });
    expect(init.credentials).toBeUndefined();
  });
});

describe('[W2] the two first-paint faces start loading with the page', () => {
  it('the root layout asks for Hanken 400 and Bricolage 700, self-hosted, as fonts', async () => {
    const { default: RootLayout } = await import('@/app/layout');
    const html = renderToString(<RootLayout><main>page</main></RootLayout>);
    for (const href of ['/fonts/hanken-grotesk-400.woff2', '/fonts/bricolage-grotesque-700.woff2']) {
      const link = html.match(new RegExp(`<link[^>]*href="${href.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[^>]*>`))?.[0];
      expect(link, href).toBeDefined();
      expect(link).toMatch(/rel="preload"/);
      expect(link).toMatch(/as="font"/);
      expect(link).toMatch(/type="font\/woff2"/);
      expect(link).toMatch(/crossorigin=""/i);
    }
  });
});
