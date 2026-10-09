import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest, type ApiReply } from '@/test/test-utils';
import AppLayout from '@/app/(app)/layout';
import CartPage from '@/app/(app)/cart/page';
import CheckoutPage from '@/app/(app)/checkout/page';
import { StorefrontPage } from '@/components/storefront/storefront-page';
import { storefrontFixture } from '@/test/storefront-fixture';
import { customerRoute } from '@/lib/customer-routes';
// The item sheet's code is split from the page; load it up front.
import '@/components/storefront/item-options-panel';

// ---------------------------------------------------------------------------
// [W4] ONE checkout. Every web order is placed on one page (/checkout, which
// the cart shows too), through one module and one set of safety checks. The
// store page shows the basket and sends the customer there; it never places
// an order itself. Synthetic store, items and people only.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string>, push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useParams: () => state.params,
  useRouter: () => ({ push: state.push, back: state.back, replace: state.replace, refresh: vi.fn() }),
}));

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

let signedIn = true;
let api: (_request: ApiRequest) => ApiReply | null;
let fetchMock: ReturnType<typeof mockApi>;
const ok = (data: unknown) => ({ body: { success: true, data } });
const calls = (method: string, pathname: string) => fetchMock.mock.calls.filter(([url, init]) =>
  new URL(String(url)).pathname === pathname && (init?.method ?? 'GET').toUpperCase() === method);

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  sessionStorage.clear(); localStorage.clear();
  window.history.replaceState({}, '', '/');
  state.push.mockReset(); state.replace.mockReset();
  signedIn = true;
  api = () => null;
  fetchMock = mockApi((request) => {
    const special = api(request);
    if (special) return special;
    const { url, method } = request;
    if (url.pathname === '/api/v1/auth/me') return signedIn ? ok({ user: { id: 'c1' } }) : { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/auth/refresh') return { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/market/depth') return ok({ visible: false, items: 0, vendors: 0 });
    if (url.pathname === '/api/v1/customer/vendors/v1') return ok(STORE);
    if (url.pathname === '/api/v1/public/storefronts/fixture-bakery') return ok(storefrontFixture(STORE));
    if (url.pathname === '/api/v1/customer/cart' && method === 'GET') return ok(CART);
    if (url.pathname === '/api/v1/customer/cart/items' && method === 'POST') return { status: 201, body: { success: true, data: {} } };
    if (url.pathname === '/api/v1/customer/addresses') return ok([{ id: 'a1', label: 'Home', addressLine1: 'Fixture street', city: 'Georgetown', isDefault: true }]);
    if (url.pathname === '/api/v1/customer/cart/address' && method === 'PUT') return ok({ cart: CART });
    if (url.pathname === '/api/v1/customer/checkout' && method === 'POST') return ok({ order: { id: 'o1' }, orders: [{ id: 'o1' }], paymentAction: null });
    return { status: 404, body: { success: false, error: { message: `unmocked ${method} ${url.pathname}` } } };
  });
});

function at(pathname: string, page: React.ReactNode) {
  state.pathname = pathname;
  window.history.replaceState({}, '', pathname);
  return render(<AppLayout>{page}</AppLayout>);
}
const storePage = async () => StorefrontPage({ params: Promise.resolve({ slug: 'fixture-bakery' }), searchParams: Promise.resolve({}) });

describe('[W4] one checkout', () => {
  it('/checkout is the same checkout the cart shows: it prices on the server quote and places the order once', async () => {
    at('/checkout', <CheckoutPage />);
    const place = await screen.findByRole('button', { name: 'Place cash order · $2,100' });
    fireEvent.click(place);
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/orders/o1'));
    const checkouts = calls('POST', '/api/v1/customer/checkout') as Array<[unknown, RequestInit]>;
    expect(checkouts).toHaveLength(1);
    expect(JSON.parse(String(checkouts[0]![1].body))).toEqual({ paymentMethod: 'CASH', tipAmount: 0, expectedTotal: 2100, expectedLines: [{ lineId: 'l1', unitPrice: 900 }] });
    expect((checkouts[0]![1].headers as Record<string, string>)['Idempotency-Key']).toMatch(/.{8,}/);
  });

  it('both addresses render the one checkout module — there is no second place an order can be placed', () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
    for (const page of ['src/app/(app)/cart/page.tsx', 'src/app/(app)/checkout/page.tsx']) {
      expect(read(page), page).toMatch(/import \{ Checkout \} from '@\/components\/checkout\/checkout';/);
      expect(read(page), page).not.toMatch(/checkout\(|setCartAddress|Idempotency/);
    }
    const store = read('src/components/storefront/storefront-experience.tsx');
    expect(store).not.toMatch(/\bcheckout\(/);
    expect(store).not.toMatch(/setCartAddress|persistCheckoutAttempt|pricesAsSeen/);
  });

  it('a guest at /checkout sees their browser basket and no one’s server cart', async () => {
    signedIn = false;
    at('/checkout', <CheckoutPage />);
    expect(await screen.findByRole('heading', { name: 'Your basket' })).toBeTruthy();
    expect(calls('GET', '/api/v1/customer/cart')).toHaveLength(0);
    expect(customerRoute('/checkout').public).toBe(true);
  });

  it('a customer who just signed in with a browser basket sees that basket until it is uploaded, not a checkout without it', async () => {
    const { addGuestLine } = await import('@/lib/basket');
    addGuestLine({ vendorId: 'v1', storeSlug: 'fixture-bakery', vendorName: 'Fixture Bakery', itemId: 'i1', name: 'Bake and saltfish', quantity: 1, unitPrice: 900, selectedOptions: {} });
    api = ({ url }) => (url.pathname === '/api/v1/customer/cart/merge' ? new Promise<ApiReply>(() => undefined) as unknown as ApiReply : null);
    at('/checkout', <CheckoutPage />);
    expect(await screen.findByRole('heading', { name: 'Your basket' })).toBeTruthy();
    await waitFor(() => expect(calls('POST', '/api/v1/customer/cart/merge')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: /Place cash order/ })).toBeNull();
  });

  it('the cart page is the same checkout', async () => {
    at('/cart', <CartPage />);
    expect(await screen.findByRole('button', { name: 'Place cash order · $2,100' })).toBeTruthy();
  });
});

describe('[W4] the store page sends the customer to the one checkout', () => {
  it('shows the basket and a Checkout button; it never places an order or prices delivery itself', async () => {
    at('/store/fixture-bakery', await storePage());
    const rail = await screen.findByRole('complementary', { name: 'Your order and checkout' });
    const next = await within(rail).findByRole('button', { name: 'Checkout · $1,800' });
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
    expect(within(rail).queryByRole('button', { name: /Place cash order/ })).toBeNull();
    expect(within(rail).queryByLabelText('Delivery address')).toBeNull();
    fireEvent.click(next);
    expect(state.push).toHaveBeenCalledWith('/checkout');
    expect(calls('POST', '/api/v1/customer/checkout')).toHaveLength(0);
    expect(calls('PUT', '/api/v1/customer/cart/address')).toHaveLength(0);
    expect(calls('GET', '/api/v1/customer/addresses')).toHaveLength(0);
  });

  it('the floating basket button on a phone is one tap to the checkout, never a jump to a panel behind the bars', async () => {
    at('/store/fixture-bakery', await storePage());
    const dock = await screen.findByRole('link', { name: /^Checkout · 2 items/ });
    expect(dock.getAttribute('href')).toBe('/checkout');
  });

  it('keeps the cart frozen while an earlier order’s outcome is unknown — no add from the menu', async () => {
    at('/store/fixture-bakery', await storePage());
    const add = await screen.findByRole('button', { name: 'Add another Bake and saltfish' });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    sessionStorage.setItem('swift_web_checkout_attempt:c1', JSON.stringify({ signature: 'earlier-order', key: 'earlier-key' }));
    fireEvent.click(add);
    expect((await screen.findAllByText(/unresolved server outcome/)).length).toBeGreaterThan(0);
    expect(calls('POST', '/api/v1/customer/cart/items')).toHaveLength(0);
  });
});
