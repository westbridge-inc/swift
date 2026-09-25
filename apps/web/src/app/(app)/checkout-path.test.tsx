import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest, type ApiReply } from '@/test/test-utils';
import AppLayout from './layout';
import VendorPage from './order/vendor/[id]/page';
import CartPage from './cart/page';
import OrderDetailPage from './orders/[id]/page';

const state = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string>, push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useParams: () => state.params,
  useRouter: () => ({ push: state.push, back: state.back, replace: state.replace }),
}));

// ---------------------------------------------------------------------------
// [Q7b] "You can actually order": the whole web ordering path, each step
// against the real API contract — a store, the item added to the one cart
// (a guest signs in first and comes back to the same item), the cart and its
// checkout (cash, or the business's own MMG when the server offers it), then
// the order's tracking page.
// ---------------------------------------------------------------------------

const ITEM = {
  id: 'i1', name: 'Pepperpot bowl', description: 'Slow-cooked', basePrice: 1800, customerPrice: 1800, imageUrl: null,
  isAvailable: true, fulfillment: 'DELIVERY',
  optionGroups: [{
    id: 'g1', name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1,
    options: [
      { id: 'small', name: 'Small', additionalPrice: '0', isDefault: true, isAvailable: true },
      { id: 'large', name: 'Large', additionalPrice: '400', isDefault: false, isAvailable: true },
    ],
  }],
};
const STORE = {
  id: 'v1', name: 'Shanta Kitchen', slug: 'shanta-kitchen', vendorType: 'RESTAURANT', cuisineTypes: [], coverImageUrl: null,
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, estimatedPrepTime: 20,
  isCurrentlyOpen: true, acceptingOrders: true, deliveryFee: 350,
  categories: [{ id: 'c1', name: 'Mains', items: [ITEM] }],
};
const ADDRESS = { id: 'a1', label: 'Home', addressLine1: '12 Main St', city: 'Georgetown', isDefault: true, latitude: 6.81, longitude: -58.16 };

function cart(mmg: { available: boolean; scope: string } = { available: false, scope: 'cash-scope' }) {
  return {
    items: [{ id: 'l1', itemId: 'i1', name: 'Pepperpot bowl', quantity: 1, customerPrice: 1800, lineTotal: 1800, fulfillment: 'DELIVERY', isAvailable: true, selectedOptionNames: ['Small'] }],
    subtotalCustomer: 1800, deliveryFee: 350, discount: 0, tipAmount: 0, totalAmount: 2150, deliveryDistanceKm: 1.1,
    deliveryAddress: { id: 'a1', label: 'Home', addressLine1: '12 Main St', city: 'Georgetown' },
    vendor: { id: 'v1', name: 'Shanta Kitchen', slug: 'shanta-kitchen', deliveryRadius: 8, distanceKm: 1.1, isCurrentlyOpen: true, acceptingOrders: true },
    meetsMinimum: true, minimumOrderAmount: 0,
    paymentCapabilities: {
      scope: mmg.scope,
      cash: { available: true, fundsFlow: 'DIRECT_AT_HANDOVER' },
      mmg: { available: mmg.available, provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR', unavailableReason: mmg.available ? null : 'VENDOR_NOT_CONFIGURED' },
    },
  };
}

let signedIn = true;
let liveCart = cart();
let api: (_request: ApiRequest) => ApiReply | null;
let fetchMock: ReturnType<typeof mockApi>;
const ok = (data: unknown) => ({ body: { success: true, data } });
const calls = (method: string, pathname: string) => fetchMock.mock.calls.filter(([url, init]) =>
  new URL(String(url)).pathname === pathname && (init?.method ?? 'GET').toUpperCase() === method);

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  window.history.replaceState({}, '', '/');
  signedIn = true;
  liveCart = cart();
  api = () => null;
  fetchMock = mockApi((request) => {
    const special = api(request);
    if (special) return special;
    const { url, method } = request;
    if (url.pathname === '/api/v1/auth/me') return signedIn ? ok({ user: { id: 'c1' } }) : { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/auth/refresh') return { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/market/depth') return ok({ visible: false, items: 0, vendors: 0 });
    if (url.pathname === '/api/v1/customer/vendors/v1') return ok(STORE);
    if (url.pathname === '/api/v1/customer/cart/items' && method === 'POST') return { status: 201, body: { success: true, data: {} } };
    if (url.pathname === '/api/v1/customer/cart' && method === 'GET') return ok(liveCart);
    if (url.pathname === '/api/v1/customer/addresses') return ok([ADDRESS]);
    if (url.pathname === '/api/v1/public/storefronts/shanta-kitchen') return ok({ ...STORE, categories: [] });
    if (url.pathname === '/api/v1/customer/cart/address' && method === 'PUT') return ok({ cart: liveCart });
    if (url.pathname === '/api/v1/customer/checkout' && method === 'POST') return ok({ order: { id: 'o9' }, orders: [{ id: 'o9' }], paymentAction: null });
    if (url.pathname === '/api/v1/customer/orders/o9') {
      return ok({ id: 'o9', orderNumber: 'SW-2001', status: 'PENDING', fulfillment: 'DELIVERY', paymentMethod: 'CASH', paymentStatus: 'PENDING', items: [{ name: 'Pepperpot bowl', quantity: 1, lineTotal: 1800 }], totalAmount: 2150, timeline: [] });
    }
    return { status: 404, body: { success: false, error: { message: `unmocked ${method} ${url.pathname}` } } };
  });
});

function at(pathname: string, params: Record<string, string>, page: React.ReactNode) {
  state.pathname = pathname;
  state.params = params;
  return render(<AppLayout>{page}</AppLayout>);
}

describe('[Q7b] store → cart', () => {
  it('a guest can open the item, and is sent to sign in on the way to adding it — coming back to that same item', async () => {
    signedIn = false;
    at('/order/vendor/v1', { id: 'v1' }, <VendorPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Pepperpot bowl/ }));
    const sheet = screen.getByRole('dialog', { name: 'Pepperpot bowl' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Sign in to add · GY$1,800' }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/login?next=%2Forder%2Fvendor%2Fv1%3Fitem%3Di1'));
    expect(calls('POST', '/api/v1/customer/cart/items')).toHaveLength(0);
    // It tried the refresh cookie once first — a returning customer is not
    // sent to sign in for nothing.
    expect(calls('POST', '/api/v1/auth/refresh')).toHaveLength(1);
  });

  it('a signed-in customer back on the item adds it, options and all, to the server cart', async () => {
    window.history.replaceState({}, '', '/order/vendor/v1?item=i1');
    at('/order/vendor/v1', { id: 'v1' }, <VendorPage />);
    // The link's ?item= reopens the item it named.
    const sheet = await screen.findByRole('dialog', { name: 'Pepperpot bowl' });
    fireEvent.click(within(sheet).getByRole('radio', { name: /^Large/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add · GY$2,200' }));
    await screen.findByText('Added to your cart');
    const [[, init]] = calls('POST', '/api/v1/customer/cart/items') as [[unknown, RequestInit]];
    expect(JSON.parse(String(init.body))).toEqual({ vendorId: 'v1', itemId: 'i1', quantity: 1, selectedOptions: { g1: 'large' } });
    expect(screen.getByRole('link', { name: /View cart/ }).getAttribute('href')).toBe('/cart');
  });
});

describe('[Q7b] cart → checkout → tracking', () => {
  it('places a cash order against the server quote, once, and opens its tracking', async () => {
    at('/cart', {}, <CartPage />);
    const place = await screen.findByRole('button', { name: 'Place cash order · GY$2,150' });
    // No MMG on this cart, so no choice is offered — cash, stated plainly.
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByText('Cash at the door')).toBeTruthy();
    fireEvent.click(place);
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/orders/o9'));
    const [[, addressInit]] = calls('PUT', '/api/v1/customer/cart/address') as [[unknown, RequestInit]];
    expect(JSON.parse(String(addressInit.body))).toEqual({ addressId: 'a1' });
    const checkouts = calls('POST', '/api/v1/customer/checkout') as Array<[unknown, RequestInit]>;
    expect(checkouts).toHaveLength(1);
    const [, checkoutInit] = checkouts[0]!;
    expect(JSON.parse(String(checkoutInit.body))).toEqual({ paymentMethod: 'CASH', tipAmount: 0 });
    expect((checkoutInit.headers as Record<string, string>)['Idempotency-Key']).toMatch(/.{8,}/);
  });

  it('offers the business’s own MMG when the server says this cart can take it, and orders with it', async () => {
    liveCart = cart({ available: true, scope: 'mmg-scope' });
    at('/cart', {}, <CartPage />);
    const choices = await screen.findByRole('radiogroup', { name: 'Payment' });
    expect(within(choices).getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)).toEqual([
      expect.stringContaining('Cash on delivery'),
      expect.stringContaining('Pay with MMG'),
    ]);
    // Cash until the customer chooses otherwise.
    expect(screen.getByRole('button', { name: 'Place cash order · GY$2,150' })).toBeTruthy();
    fireEvent.click(within(choices).getByRole('radio', { name: /Pay with MMG/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Place order · GY$2,150 · pay by MMG' }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/orders/o9'));
    const [[, init]] = calls('POST', '/api/v1/customer/checkout') as [[unknown, RequestInit]];
    expect(JSON.parse(String(init.body))).toEqual({ paymentMethod: 'MOBILE_MONEY', tipAmount: 0 });
  });

  it('never turns an MMG choice into cash behind the customer’s back when the store’s MMG goes away', async () => {
    liveCart = cart({ available: true, scope: 'mmg-scope' });
    at('/cart', {}, <CartPage />);
    const choices = await screen.findByRole('radiogroup', { name: 'Payment' });
    fireEvent.click(within(choices).getByRole('radio', { name: /Pay with MMG/ }));
    liveCart = cart({ available: false, scope: 'cash-now' });
    fireEvent.click(screen.getByRole('button', { name: 'Place order · GY$2,150 · pay by MMG' }));
    expect(await screen.findByText(/MMG is no longer available for this order/)).toBeTruthy();
    expect(calls('POST', '/api/v1/customer/checkout')).toHaveLength(0);
    expect(state.push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Place cash order · GY$2,150' })).toBeTruthy();
  });

  it('sends a guest who opens the cart to sign in and back to the cart — never showing a cart', async () => {
    signedIn = false;
    at('/cart', {}, <CartPage />);
    const door = await screen.findByRole('region', { name: 'Sign in to start a cart' });
    expect(within(door).getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login?next=%2Fcart');
    expect(calls('GET', '/api/v1/customer/cart')).toHaveLength(0);
  });

  it('opens the placed order’s tracking, with the app’s own way back to the orders list', async () => {
    at('/orders/o9', { id: 'o9' }, <OrderDetailPage />);
    expect(await screen.findByRole('heading', { name: 'Order placed' })).toBeTruthy();
    expect(screen.getByText('Cash due at handover')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(state.push).toHaveBeenCalledWith('/orders');
  });
});
