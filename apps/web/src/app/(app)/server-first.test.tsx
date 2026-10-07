import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest, type ApiReply } from '@/test/test-utils';
import AppLayout from './layout';
import HomePage from './page';
import StorePage from './store/[slug]/page';
import LegacyStorePage from './order/vendor/[id]/page';
import { storefrontFixture } from '@/test/storefront-fixture';
import BrowsePage from './order/browse/page';
import MarketPage from './market/page';

const state = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string>, query: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useParams: () => state.params,
  useSearchParams: () => new URLSearchParams(state.query),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  permanentRedirect: (path: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { path }); },
}));
// The real config refuses to load while company details are placeholders.
vi.mock('@/site.config', () => ({
  site: { legalEntityName: 'Swift Test Company Ltd', supportEmail: 'support@swiftgy.com' },
  launch: { markets: ['Georgetown, Guyana'], webOrdering: 'live' },
  showAppStoreBadges: false,
  SITE_ORIGIN: 'https://swiftgy.com',
}));

// ---------------------------------------------------------------------------
// [W2] SERVER FIRST. On a weak signal a page that arrives as a skeleton and
// fills in after its scripts run is a blank page for seconds. Home, a store,
// a category and the Market now arrive with their content in them: the server
// reads it as a GUEST and hands it to the page under the key the page reads.
// What must never change: the server's read carries no person (no cookie, no
// token), so nothing personal is ever rendered into a shared page or cache.
// ---------------------------------------------------------------------------

const VENDOR = {
  id: 'v1', name: 'Shanta Kitchen', slug: 'shanta-kitchen', vendorType: 'RESTAURANT', cuisineTypes: [],
  displayRating: 4.6, ratingBucket: 'Great', ratingCount: 40, topRated: true, estimatedPrepTime: 20,
  isCurrentlyOpen: true, acceptingOrders: true, coverImageUrl: null,
};
const CLOSED = { ...VENDOR, id: 'v3', name: 'Late Night Roti', slug: 'late-roti', isCurrentlyOpen: false };
const FEED = {
  activeOrder: null,
  popularItems: [{ id: 'i1', name: 'Pepperpot bowl', imageUrl: null, price: 1800, vendorId: 'v1', vendorName: 'Shanta Kitchen', vendorType: 'RESTAURANT', etaMin: 25 }],
  featured: [], nearby: [], orderAgain: [], categories: [],
  openVendors: [VENDOR], closedVendors: [CLOSED],
};
const MENU = {
  ...VENDOR,
  categories: [{ id: 'c1', name: 'Mains', items: [{ id: 'm1', name: 'Curry chicken plate', basePrice: 1500, customerPrice: 1500, isAvailable: true, fulfillment: 'DELIVERY', imageUrl: null }] }],
};
const LIVE_ORDER = { id: 'o1', orderNumber: 'SW-1001', status: 'PREPARING', vendor: { id: 'v1', name: 'Shanta Kitchen' } };

let signedIn = false;
let homeFails = false;
let api: (_request: ApiRequest) => ApiReply | Promise<ApiReply>;
let fetchMock: ReturnType<typeof mockApi>;
const calls = (pathname: string) => fetchMock.mock.calls
  .map(([url, init]) => ({ url: new URL(String(url)), init: init as RequestInit | undefined }))
  .filter(({ url }) => url.pathname === pathname);

/** True when a request could name a person: browser credentials, or a cookie/token header. */
function carriesAPerson(init: RequestInit | undefined): boolean {
  if (!init) return false;
  if (init.credentials === 'include' || init.credentials === 'same-origin') return true;
  const headers = new Headers(init.headers);
  return headers.has('cookie') || headers.has('authorization');
}

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  signedIn = false;
  homeFails = false;
  state.pathname = '/';
  state.params = {};
  state.query = '';
  api = ({ url, init }) => {
    if (url.pathname === '/api/v1/auth/me') return signedIn ? { body: { success: true, data: { user: { id: 'c1' } } } } : { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/auth/refresh') return { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/market/depth') return { body: { success: true, data: { visible: true, items: 400, vendors: 9 } } };
    if (url.pathname === '/api/v1/customer/addresses') return { body: { success: true, data: [] } };
    if (url.pathname === '/api/v1/customer/home') {
      if (homeFails) return { status: 503, body: { success: false, error: { message: 'Swift is busy' } } };
      // Only a request made WITH a session gets the person's own feed.
      return { body: { success: true, data: carriesAPerson(init) ? { ...FEED, activeOrder: LIVE_ORDER } : FEED } };
    }
    if (url.pathname === '/api/v1/customer/vendors/v1') return { body: { success: true, data: MENU } };
    if (url.pathname === '/api/v1/public/storefronts/shanta-kitchen') return { body: { success: true, data: storefrontFixture(MENU) } };
    if (url.pathname === '/api/v1/customer/vendors') return { body: { success: true, data: [VENDOR] } };
    if (url.pathname === '/api/v1/discovery/categories') return { body: { success: true, data: { categories: [{ slug: 'tools', name: 'Tools', vertical: 'RETAIL' }, { slug: 'meals', name: 'Meals', vertical: 'FOOD' }] } } };
    if (url.pathname === '/api/v1/market/items') return { body: { success: true, data: { items: [{ id: 'g1', name: 'Claw hammer', basePrice: 2500, imageUrl: null, vendorId: 'v9', vendorName: 'Regent Hardware', categoryName: 'Tools', isNew: false }], nextCursor: null } } };
    return { status: 404, body: { success: false } };
  };
  fetchMock = mockApi((request) => api(request));
});

afterEach(() => {
  delete process.env['NEXT_PHASE'];
});

describe('[W2] Home arrives with the stores in it', () => {
  it('the server reads the guest feed once, with no person on the request, and the page shows it before the browser asks for anything', async () => {
    const page = await HomePage();
    const server = calls('/api/v1/customer/home');
    expect(server).toHaveLength(1);
    expect(carriesAPerson(server[0]!.init)).toBe(false);
    expect([...server[0]!.url.searchParams.keys()]).toEqual([]);

    render(<AppLayout>{page}</AppLayout>);
    // At once — not after a round trip: the stores and the popular dish are already on screen.
    expect(within(screen.getByRole('region', { name: 'Open now' })).getByRole('link', { name: /Shanta Kitchen/ })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Popular on Swift' })).getByRole('link', { name: /Pepperpot bowl/ })).toBeTruthy();
    expect(screen.queryByLabelText('Loading home feed')).toBeNull();
    // Once the session check has answered (a guest), the browser still has not re-read Home.
    await waitFor(() => expect(calls('/api/v1/auth/me').length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls('/api/v1/customer/home')).toHaveLength(1);
  });

  it('the HTML itself carries the stores — no skeleton', async () => {
    const html = renderToString(<AppLayout>{await HomePage()}</AppLayout>);
    expect(html).toContain('Shanta Kitchen');
    expect(html).toContain('Pepperpot bowl');
    expect(html).toContain('Late Night Roti');
    expect(html).not.toContain('Loading home feed');
  });

  it('a signed-in person sees the public stores at once, then their own feed, read with their session under its own key', async () => {
    signedIn = true;
    render(<AppLayout>{await HomePage()}</AppLayout>);
    expect(within(screen.getByRole('region', { name: 'Open now' })).getByRole('link', { name: /Shanta Kitchen/ })).toBeTruthy();
    expect((await screen.findByRole('link', { name: /Track your live order SW-1001/ })).getAttribute('href')).toBe('/orders/o1');
    const reads = calls('/api/v1/customer/home');
    // The server's read carried no one; the person's own read carried their session.
    expect(carriesAPerson(reads[0]!.init)).toBe(false);
    expect(reads.slice(1).some(({ init }) => carriesAPerson(init))).toBe(true);
  });

  it('a person’s own feed never stands in for the public one: after sign-out the next visitor sees no live order, even for a moment', async () => {
    signedIn = true;
    render(<AppLayout>{await HomePage()}</AppLayout>);
    await screen.findByRole('link', { name: /Track your live order SW-1001/ });
    signedIn = false;
    api = ((base) => (request: ApiRequest) => (request.url.pathname === '/api/v1/customer/home' ? new Promise<ApiReply>(() => undefined) : base(request)))(api);
    const auth = await import('@/lib/auth');
    const { act } = await import('@testing-library/react');
    act(() => { auth.clearSession(); });
    expect(screen.queryByRole('link', { name: /Track your live order/ })).toBeNull();
    expect(screen.queryByText('Shanta Kitchen')).toBeNull();
    expect(screen.getByLabelText('Loading home feed')).toBeTruthy();
  });

  it('when the server cannot read Home, the page still loads it in the browser — never an empty "no stores"', async () => {
    homeFails = true;
    const page = await HomePage();
    homeFails = false;
    render(<AppLayout>{page}</AppLayout>);
    expect(screen.getByLabelText('Loading home feed')).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Open now' })).toBeTruthy();
  });

  it('`next build` never calls the API: the built page loads its stores on the first visit', async () => {
    process.env['NEXT_PHASE'] = 'phase-production-build';
    const page = await HomePage();
    expect(calls('/api/v1/customer/home')).toHaveLength(0);
    delete process.env['NEXT_PHASE'];
    render(<AppLayout>{page}</AppLayout>);
    expect(screen.getByLabelText('Loading home feed')).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Open now' })).toBeTruthy();
  });
});

describe('[W2] a store, a category and the Market arrive with their content in them', () => {
  it('a store’s menu is in the page; the server read it as a guest', async () => {
    // [W6] The store's one page, /store/<slug>.
    state.pathname = '/store/shanta-kitchen';
    const page = await StorePage({ params: Promise.resolve({ slug: 'shanta-kitchen' }), searchParams: Promise.resolve({}) });
    const reads = calls('/api/v1/public/storefronts/shanta-kitchen');
    expect(reads).toHaveLength(1);
    expect(carriesAPerson(reads[0]!.init)).toBe(false);
    // In the HTML itself, before any script runs.
    const html = renderToString(<AppLayout>{page}</AppLayout>);
    expect(html).toContain('Shanta Kitchen');
    expect(html).toContain('Curry chicken plate');
    render(<AppLayout>{page}</AppLayout>);
    expect(screen.getByRole('heading', { level: 1, name: 'Shanta Kitchen' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Curry chicken plate' })).toBeTruthy();
  });

  it('the old store address finds the store as a guest and sends it to that page', async () => {
    await expect(LegacyStorePage({ params: Promise.resolve({ id: 'v1' }), searchParams: Promise.resolve({ item: 'm1' }) }))
      .rejects.toMatchObject({ message: 'NEXT_REDIRECT', path: '/store/shanta-kitchen?item=m1' });
    const reads = calls('/api/v1/customer/vendors/v1');
    expect(reads).toHaveLength(1);
    expect(carriesAPerson(reads[0]!.init)).toBe(false);
  });

  it('a made-up store id is never read on the server', async () => {
    await expect(LegacyStorePage({ params: Promise.resolve({ id: '../../admin' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a category’s stores are in the page; an unknown kind is never read on the server', async () => {
    state.pathname = '/order/browse';
    state.query = 'type=RESTAURANT';
    const page = await BrowsePage({ searchParams: Promise.resolve({ type: 'RESTAURANT' }) });
    const reads = calls('/api/v1/customer/vendors');
    expect(reads.map(({ url }) => url.searchParams.get('type'))).toEqual(['RESTAURANT']);
    expect(carriesAPerson(reads[0]!.init)).toBe(false);
    render(<AppLayout>{page}</AppLayout>);
    expect(screen.getByRole('link', { name: /Shanta Kitchen/ })).toBeTruthy();

    fetchMock.mockClear();
    await BrowsePage({ searchParams: Promise.resolve({ type: 'ANYTHING_AT_ALL' }) });
    expect(calls('/api/v1/customer/vendors')).toHaveLength(0);
  });

  it('the Market’s first goods and chips are in the page; a category the server never listed is not read', async () => {
    state.pathname = '/market';
    const page = await MarketPage({ searchParams: Promise.resolve({}) });
    // Every read the server made for this page carried no one.
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname).sort())
      .toEqual(['/api/v1/discovery/categories', '/api/v1/market/depth', '/api/v1/market/items']);
    for (const read of fetchMock.mock.calls) expect(carriesAPerson(read[1] as RequestInit | undefined)).toBe(false);
    render(<AppLayout>{page}</AppLayout>);
    expect(screen.getByRole('link', { name: /Claw hammer/ })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Market categories' })).getAllByRole('link').map((link) => link.textContent)).toEqual(['All', 'Tools']);

    fetchMock.mockClear();
    await MarketPage({ searchParams: Promise.resolve({ category: 'not-a-listed-category' }) });
    expect(calls('/api/v1/market/items')).toHaveLength(0);
  });
});

describe('[W2] the server never reads who is visiting', () => {
  const WEB = join(__dirname, '..', '..');
  it.each([
    'lib/browse-server.ts',
    'app/(app)/page.tsx',
    'app/(app)/order/vendor/[id]/page.tsx',
    'app/(app)/store/[slug]/page.tsx',
    'components/storefront/storefront-page.tsx',
    'lib/api.ts',
    'app/(app)/order/browse/page.tsx',
    'app/(app)/market/page.tsx',
  ])('%s does not touch the visitor’s cookies or headers', (file) => {
    // The code, not its comments (which may name what it must not do).
    const source = readFileSync(join(WEB, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(source).not.toMatch(/next\/headers/);
    expect(source).not.toMatch(/\bcookies\(|\bheaders\(\)/);
    expect(source).not.toMatch(/credentials\s*:/);
  });
});
