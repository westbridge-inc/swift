import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest, type ApiReply } from '@/test/test-utils';
import AppLayout from '@/app/(app)/layout';
import CheckoutPage from '@/app/(app)/checkout/page';
import { storefrontFixture } from '@/test/storefront-fixture';

// ---------------------------------------------------------------------------
// [PERF · WEB-LAUNCH-CHECK F6] /checkout on a slow phone line: every server
// round trip before the basket shows costs the person a visible wait. What may
// run together runs together; nothing is shown before it is known, and every
// safety check still runs before Place order unlocks. Synthetic store only.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ pathname: '/checkout', basketCodeLoaded: false }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
// Records when the browser-basket code is first asked for.
vi.mock('@/components/guest-basket', async (importOriginal) => {
  state.basketCodeLoaded = true;
  return importOriginal();
});

const ITEM = { id: 'i1', name: 'Bake and saltfish', description: 'Fixture', basePrice: 900, customerPrice: 900, imageUrl: null, isAvailable: true, fulfillment: 'DELIVERY', optionGroups: [] };
const STORE = {
  id: 'v1', name: 'Fixture Bakery', slug: 'fixture-bakery', vendorType: 'RESTAURANT', cuisineTypes: [], coverImageUrl: null,
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, estimatedPrepTime: 20,
  isCurrentlyOpen: true, acceptingOrders: true, categories: [{ id: 'c1', name: 'Breakfast', items: [ITEM] }],
};
const CART = {
  items: [{ id: 'l1', itemId: 'i1', name: 'Bake and saltfish', quantity: 2, customerPrice: 900, lineTotal: 1800, fulfillment: 'DELIVERY', isAvailable: true }],
  subtotalCustomer: 1800, deliveryFee: 300, discount: 0, tipAmount: 0, totalAmount: 2100, deliveryDistanceKm: 1,
  deliveryAddress: { id: 'a1', label: 'Home', addressLine1: 'Fixture street', city: 'Georgetown' },
  vendor: { id: 'v1', name: 'Fixture Bakery', slug: 'fixture-bakery', deliveryRadius: 8, distanceKm: 1, isCurrentlyOpen: true, acceptingOrders: true },
  meetsMinimum: true, minimumOrderAmount: 0,
  paymentCapabilities: { scope: 's', cash: { available: true, fundsFlow: 'DIRECT_AT_HANDOVER' }, mmg: { available: false, provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR', unavailableReason: 'VENDOR_NOT_CONFIGURED' } },
};

const ok = (data: unknown) => ({ body: { success: true, data } });
const never = () => new Promise<ApiReply>(() => undefined);
let signedIn: boolean | 'pending' = true;
let api: (_request: ApiRequest) => ApiReply | Promise<ApiReply> | null;
let fetchMock: ReturnType<typeof mockApi>;
const calls = (pathname: string, method = 'GET') => fetchMock.mock.calls.filter(([url, init]) =>
  new URL(String(url)).pathname === pathname && (init?.method ?? 'GET').toUpperCase() === method);
/** While the checks have not passed, Place order is not offered, and any tap on one sends nothing. */
async function tapPlaceSendsNothing() {
  for (const button of screen.queryAllByRole('button', { name: /^Place / })) fireEvent.click(button);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(calls('/api/v1/customer/checkout', 'POST')).toHaveLength(0);
}

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  sessionStorage.clear(); localStorage.clear();
  window.history.replaceState({}, '', '/checkout');
  signedIn = true;
  api = () => null;
  fetchMock = mockApi((request) => {
    const special = api(request);
    if (special) return special;
    const { url, method } = request;
    if (url.pathname === '/api/v1/auth/me') {
      if (signedIn === 'pending') return never();
      return signedIn ? ok({ user: { id: 'c1' } }) : { status: 401, body: { success: false } };
    }
    if (url.pathname === '/api/v1/auth/refresh') return { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/market/depth') return ok({ visible: false, items: 0, vendors: 0 });
    if (url.pathname === '/api/v1/customer/vendors/v1') return ok(STORE);
    if (url.pathname === '/api/v1/public/storefronts/fixture-bakery') return ok(storefrontFixture(STORE));
    if (url.pathname === '/api/v1/customer/cart' && method === 'GET') return ok(CART);
    if (url.pathname === '/api/v1/customer/addresses') return ok([{ id: 'a1', label: 'Home', addressLine1: 'Fixture street', city: 'Georgetown', isDefault: true }]);
    return { status: 404, body: { success: false, error: { message: `unmocked ${method} ${url.pathname}` } } };
  });
});

const openCheckout = () => render(<AppLayout><CheckoutPage /></AppLayout>);

describe('[PERF F6] the checkout shows what it knows without waiting on what it does not need', () => {
  it('an empty basket still waits for the session answer, but the basket code is fetched alongside it', async () => {
    // First in the file: the module registry keeps the basket code once any test loads it.
    expect(state.basketCodeLoaded).toBe(false);
    signedIn = 'pending';
    openCheckout();
    await waitFor(() => expect(state.basketCodeLoaded).toBe(true));
    // Not known yet whether a saved cart exists: the loading shape, never "empty".
    expect(screen.getByLabelText('Loading your cart')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your basket' })).toBeNull();
  });

  it('a browser basket shows at once: whoever is signed in, a basket with lines is what the checkout shows', async () => {
    const { addGuestLine } = await import('@/lib/basket');
    addGuestLine({ vendorId: 'v1', storeSlug: 'fixture-bakery', vendorName: 'Fixture Bakery', itemId: 'i1', name: 'Bake and saltfish', quantity: 1, unitPrice: 900, selectedOptions: {} });
    signedIn = 'pending'; // the session answer has not come back
    openCheckout();
    expect(await screen.findByRole('heading', { name: 'Your basket' })).toBeTruthy();
    expect(await screen.findByText('Bake and saltfish')).toBeTruthy();
    // Nothing of anyone's server cart is read or shown before the answer.
    expect(calls('/api/v1/customer/cart')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Place cash order/ })).toBeNull();
  });

  it('a signed-in checkout reads the live store and its menu together, not one after the other', async () => {
    api = ({ url }) => (url.pathname === '/api/v1/public/storefronts/fixture-bakery' ? never() : null);
    openCheckout();
    await waitFor(() => expect(calls('/api/v1/customer/vendors/v1')).toHaveLength(1));
    // The store's own answer is still owed, so the order stays locked.
    expect(await screen.findByText('Swift is checking this saved cart against the live store menu.')).toBeTruthy();
    await tapPlaceSendsNothing();
  });

  it('the live store still decides first: a closed store locks the order even when the menu read fails', async () => {
    api = ({ url }) => {
      if (url.pathname === '/api/v1/public/storefronts/fixture-bakery') return ok(storefrontFixture({ ...STORE, isCurrentlyOpen: false }));
      if (url.pathname === '/api/v1/customer/vendors/v1') return { status: 500, body: { success: false, error: { message: 'menu down' } } };
      return null;
    };
    openCheckout();
    expect(await screen.findByText('This store is closed right now. Checkout stays locked until the live store is open.')).toBeTruthy();
    await tapPlaceSendsNothing();
  });

  it('a menu that does not hold the cart’s lines still locks the order (both reads must pass)', async () => {
    api = ({ url }) => (url.pathname === '/api/v1/customer/vendors/v1' ? ok({ ...STORE, categories: [{ id: 'c1', name: 'Breakfast', items: [] }] }) : null);
    openCheckout();
    expect(await screen.findByText(/These saved lines do not all belong to the store behind the server quote/)).toBeTruthy();
    await tapPlaceSendsNothing();
  });
});
