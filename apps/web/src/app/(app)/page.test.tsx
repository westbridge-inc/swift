import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest, type ApiReply } from '@/test/test-utils';
import AppLayout from './layout';
import HomePage from './page';

const state = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), coords: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: state.push, back: state.back, replace: state.replace }) }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: state.coords }));
// The real config refuses to load while company details are placeholders.
vi.mock('@/site.config', () => ({
  site: { legalEntityName: 'Swift Test Company Ltd', supportEmail: 'support@swiftgy.com' },
  launch: { markets: ['Georgetown, Guyana'], webOrdering: 'live' },
  showAppStoreBadges: false,
  SITE_ORIGIN: 'https://swiftgy.com',
}));

const VENDOR = {
  id: 'v1', name: 'Shanta Kitchen', slug: 'shanta-kitchen', vendorType: 'RESTAURANT', cuisineTypes: [],
  displayRating: 4.6, ratingBucket: 'Great', ratingCount: 40, topRated: true, estimatedPrepTime: 20,
  isCurrentlyOpen: true, acceptingOrders: true, coverImageUrl: null,
};
const NEARBY = { ...VENDOR, id: 'v2', name: 'Pepperpot Corner', slug: 'pepperpot', distanceKm: 1.2 };
const CLOSED = { ...VENDOR, id: 'v3', name: 'Late Night Roti', slug: 'late-roti', isCurrentlyOpen: false };

function feed(overrides: Record<string, unknown> = {}) {
  return {
    activeOrder: null,
    popularItems: [{ id: 'i1', name: 'Pepperpot bowl', imageUrl: null, price: 1800, vendorId: 'v1', vendorName: 'Shanta Kitchen', vendorType: 'RESTAURANT', etaMin: 25 }],
    featured: [], nearby: [], orderAgain: [], categories: [],
    openVendors: [VENDOR], closedVendors: [CLOSED],
    ...overrides,
  };
}

let api: (_request: ApiRequest) => ApiReply | Promise<ApiReply>;
const homeRequests = () => fetchMock.mock.calls
  .map(([url]) => new URL(String(url)))
  .filter((url) => url.pathname === '/api/v1/customer/home');
let fetchMock: ReturnType<typeof mockApi>;

async function freshAuth() {
  // The session module keeps who it last saw; every test starts from nobody.
  const auth = await import('@/lib/auth');
  auth.clearSession();
}

beforeEach(async () => {
  await freshAuth();
  state.coords.mockReset();
  api = ({ url }) => {
    if (url.pathname === '/api/v1/auth/me') return { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/auth/refresh') return { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/market/depth') return { body: { success: true, data: { visible: false, items: 0, vendors: 0 } } };
    if (url.pathname === '/api/v1/customer/home') return { body: { success: true, data: feed() } };
    return { status: 404, body: { success: false } };
  };
  fetchMock = mockApi((request) => api(request));
});

function renderHome() {
  return render(<AppLayout><HomePage /></AppLayout>);
}

// ---------------------------------------------------------------------------
// [Q7b] swiftgy.com opens straight into ordering. `/` is the customer app's
// Home — location, search, the services, what's popular, the stores open near
// you — inside the app shell, open to guests. The marketing introduction moved
// to /welcome; the legal duties `/` carried stay on it, in the site footer.
// ---------------------------------------------------------------------------

describe('[Q7b] / is the ordering home', () => {
  it('opens on ordering, not on the marketing page', async () => {
    renderHome();
    expect(screen.getByRole('heading', { level: 1, name: 'Order food, groceries and more' })).toBeTruthy();
    expect(screen.queryByText(/Everything your day needs/)).toBeNull();
    expect(screen.queryByText(/Six things, one app/)).toBeNull();
    // The services, every one a real page; taxi says where rides are booked.
    const services = screen.getByRole('navigation', { name: 'Services' });
    expect(within(services).getByRole('link', { name: /^Food/ }).getAttribute('href')).toBe('/order/browse?type=RESTAURANT');
    expect(within(services).getByRole('link', { name: /^Groceries/ }).getAttribute('href')).toBe('/order/browse?type=SUPERMARKET');
    expect(within(services).getByRole('link', { name: /^Taxi/ }).textContent).toMatch(/Swift mobile app/);
    expect(screen.getByRole('link', { name: /Search stores, dishes and groceries/ }).getAttribute('href')).toBe('/order/search');
  });

  it('shows what is popular and the stores open now, from the same feed the phone app reads', async () => {
    renderHome();
    const popular = await screen.findByRole('region', { name: 'Popular on Swift' });
    const bowl = within(popular).getByRole('link', { name: /Pepperpot bowl/ });
    // An item opens at its own store, on that item.
    expect(bowl.getAttribute('href')).toBe('/order/vendor/v1?item=i1');
    expect(bowl.textContent).toMatch(/GY\$1,800/);
    const open = screen.getByRole('region', { name: 'Open now' });
    expect(within(open).getByRole('link', { name: /Shanta Kitchen/ }).getAttribute('href')).toBe('/order/vendor/v1');
    expect(within(screen.getByRole('region', { name: 'Closed now' })).getByText('Late Night Roti')).toBeTruthy();
    expect(homeRequests()).toHaveLength(1);
  });

  it('lets a guest browse — no sign-in wall, no refresh spent — and sort by where they are when they ask', async () => {
    state.coords.mockResolvedValue({ lat: 6.8, lng: -58.15 });
    api = ((base) => (request: ApiRequest) => (request.url.pathname === '/api/v1/customer/home' && request.url.searchParams.get('lat')
      ? { body: { success: true, data: feed({ nearby: [NEARBY], openVendors: [VENDOR, NEARBY] }) } }
      : base(request)))(api);
    renderHome();
    await screen.findByRole('region', { name: 'Open now' });
    expect(screen.queryByRole('region', { name: /Sign in/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Show stores near me' }));
    const near = await screen.findByRole('region', { name: 'Stores near you' });
    // Nearby first, then the rest, each store once.
    expect(within(near).getAllByRole('link').map((link) => link.textContent)).toEqual([
      expect.stringContaining('Pepperpot Corner'),
      expect.stringContaining('Shanta Kitchen'),
    ]);
    const sorted = homeRequests().at(-1)!;
    expect([sorted.searchParams.get('lat'), sorted.searchParams.get('lng')]).toEqual(['6.8', '-58.15']);
    const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).not.toContain('/api/v1/auth/refresh');
    expect(state.push).not.toHaveBeenCalled();
  });

  it('shows a signed-in customer where they deliver to, their live order, and stores sorted from that address', async () => {
    api = ((base) => (request: ApiRequest) => {
      if (request.url.pathname === '/api/v1/auth/me') return { body: { success: true, data: { user: { id: 'c1' } } } };
      if (request.url.pathname === '/api/v1/customer/addresses') {
        return { body: { success: true, data: [{ id: 'a1', label: 'Home', addressLine1: '12 Main St', isDefault: true, latitude: 6.81, longitude: -58.16 }] } };
      }
      if (request.url.pathname === '/api/v1/customer/home') {
        return { body: { success: true, data: feed({ activeOrder: { id: 'o1', orderNumber: 'SW-1001', status: 'PREPARING', vendor: { id: 'v1', name: 'Shanta Kitchen' } } }) } };
      }
      return base(request);
    })(api);
    renderHome();
    const deliverTo = await screen.findByRole('link', { name: /Deliver to Home · 12 Main St/ });
    expect(deliverTo.getAttribute('href')).toBe('/order/location');
    expect((await screen.findByRole('link', { name: /Your live order · SW-1001/ })).getAttribute('href')).toBe('/orders/o1');
    await waitFor(() => {
      const last = homeRequests().at(-1)!;
      expect([last.searchParams.get('lat'), last.searchParams.get('lng')]).toEqual(['6.81', '-58.16']);
    });
  });

  it('drops what one person loaded the moment they sign out — the next person never sees their live order, even for a moment', async () => {
    let session = true;
    api = ((base) => (request: ApiRequest) => {
      if (request.url.pathname === '/api/v1/auth/me') return session ? { body: { success: true, data: { user: { id: 'c1' } } } } : base(request);
      if (request.url.pathname === '/api/v1/customer/addresses') {
        return { body: { success: true, data: [{ id: 'a1', label: 'Home', addressLine1: '12 Main St', isDefault: true, latitude: 6.81, longitude: -58.16 }] } };
      }
      if (request.url.pathname === '/api/v1/customer/home') {
        // Signed out, the guest's Home is still on its way when it is needed.
        return session
          ? { body: { success: true, data: feed({ activeOrder: { id: 'o1', orderNumber: 'SW-1001', status: 'PREPARING', vendor: { id: 'v1', name: 'Shanta Kitchen' } } }) } }
          : new Promise<ApiReply>(() => undefined);
      }
      return base(request);
    })(api);
    renderHome();
    await screen.findByRole('link', { name: /Your live order · SW-1001/ });
    await waitFor(() => expect(homeRequests().some((url) => url.searchParams.get('lat') === '6.81')).toBe(true));
    await screen.findByRole('link', { name: /Deliver to Home/ });

    session = false;
    const auth = await import('@/lib/auth');
    act(() => { auth.clearSession(); });
    // At once — not after the guest's answer arrives.
    expect(screen.queryByRole('link', { name: /Your live order/ })).toBeNull();
    expect(screen.queryByText('Shanta Kitchen')).toBeNull();
    expect(screen.getByLabelText('Loading stores')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show stores near me' })).toBeTruthy();
  });

  it('says it could not load the stores — never "no stores" — and tries again on request', async () => {
    let failing = true;
    api = ((base) => (request: ApiRequest) => (request.url.pathname === '/api/v1/customer/home' && failing
      ? { status: 503, body: { success: false, error: { message: 'Swift is busy' } } }
      : base(request)))(api);
    renderHome();
    // One automatic retry comes first (the shell's query client), then the notice.
    expect(await screen.findByText(/Couldn.t load the stores/, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText(/No stores are taking orders/)).toBeNull();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Open now' })).toBeTruthy();
  });

  it('keeps the site’s legal duties: privacy, terms, child safety, account deletion and the operating company', async () => {
    renderHome();
    const legal = screen.getByRole('navigation', { name: 'Legal' });
    expect(within(legal).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(expect.arrayContaining([
      '/legal/privacy', '/legal/terms', '/legal/child-safety', '/account/delete', 'mailto:support@swiftgy.com',
    ]));
    expect(screen.getAllByText('Swift Test Company Ltd').length).toBeGreaterThan(0);
  });
});
