import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest, type ApiReply } from '@/test/test-utils';
import AppLayout from '@/app/(app)/layout';
import CheckoutPage from '@/app/(app)/checkout/page';
import { StorefrontPage } from '@/components/storefront/storefront-page';
import { storefrontFixture } from '@/test/storefront-fixture';
import { getCart, pickupChoices } from '@/lib/customer';
import { cartPricingChoices } from '../../../../mobile/src/modules/cart/cartQuote';
// The item sheet's code is split from the page; load it up front.
import '@/components/storefront/item-options-panel';

// ---------------------------------------------------------------------------
// [W5] Delivery or Pickup, chosen by the customer on the one checkout (and in
// the store's order panel). Pickup is priced by the server for every store in
// the basket: no delivery fee, no rider tip, the store's own address and
// today's hours, and no delivery address needed. The server already accepts
// pickup orders. Synthetic store, items and people only.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string>, push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useParams: () => state.params,
  useRouter: () => ({ push: state.push, back: state.back, replace: state.replace, refresh: vi.fn() }),
}));

const ITEM = { id: 'i1', name: 'Bake and saltfish', description: 'Fixture', basePrice: 900, customerPrice: 900, imageUrl: null, isAvailable: true, fulfillment: 'DELIVERY', optionGroups: [] };
// Every day 07:00–19:00 except Sunday, so the "today" line is predictable whatever day the suite runs.
const HOURS = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, openTime: '07:00', closeTime: '19:00', isClosed: false }));
const STORE = {
  id: 'v1', name: 'Fixture Bakery', slug: 'fixture-bakery', vendorType: 'RESTAURANT', cuisineTypes: [], coverImageUrl: null,
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, estimatedPrepTime: 20,
  isCurrentlyOpen: true, acceptingOrders: true, categories: [{ id: 'c1', name: 'Breakfast', items: [ITEM] }],
};
const caps = (mmg: boolean) => ({ scope: mmg ? 'mmg' : 'cash', cash: { available: true, fundsFlow: 'DIRECT_AT_HANDOVER' }, mmg: { available: mmg, provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR', unavailableReason: mmg ? null : 'VENDOR_NOT_CONFIGURED' } });
const line = { id: 'l1', itemId: 'i1', name: 'Bake and saltfish', quantity: 2, customerPrice: 900, lineTotal: 1800, fulfillment: 'DELIVERY', isAvailable: true, vendorId: 'v1' };
const vendorRow = (fulfillment: string, deliveryFee: number) => ({ vendorId: 'v1', name: 'Fixture Bakery', fulfillment, subtotal: 1800, deliveryFee, standardDeliveryFee: deliveryFee, expressSurcharge: 0, discount: 0, tipAmount: 0, totalAmount: 1800 + deliveryFee, minOrderAmount: 0, meetsMinimum: true, amountToMinimum: 0 });
const deliveryCart = (mmg = false) => ({
  items: [line], subtotalCustomer: 1800, deliveryFee: 300, discount: 0, tipAmount: 0, totalAmount: 2100, deliveryDistanceKm: 1,
  deliveryAddress: { id: 'a1', label: 'Home', addressLine1: 'Fixture street', city: 'Georgetown' },
  vendor: { id: 'v1', name: 'Fixture Bakery', slug: 'fixture-bakery', deliveryRadius: 8, distanceKm: 1, isCurrentlyOpen: true, acceptingOrders: true },
  vendors: [vendorRow('DELIVERY', 300)], meetsMinimum: true, minimumOrderAmount: 0, paymentCapabilities: caps(mmg),
});
const pickupCart = (mmg = false) => ({ ...deliveryCart(mmg), deliveryFee: 0, totalAmount: 1800, vendors: [vendorRow('PICKUP', 0)] });

let mmg = false;
let pickupQuote: () => unknown = () => pickupCart(mmg);
let checkoutReply: ApiReply | null = null;
let fetchMock: ReturnType<typeof mockApi>;
const ok = (data: unknown) => ({ body: { success: true, data } });
const calls = (method: string, pathname: string) => fetchMock.mock.calls.filter(([url, init]) =>
  new URL(String(url)).pathname === pathname && (init?.method ?? 'GET').toUpperCase() === method);
const cartReads = () => calls('GET', '/api/v1/customer/cart').map(([url]) => new URL(String(url)).searchParams);

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  sessionStorage.clear(); localStorage.clear();
  window.history.replaceState({}, '', '/');
  state.push.mockReset();
  mmg = false;
  pickupQuote = () => pickupCart(mmg);
  checkoutReply = null;
  fetchMock = mockApi(({ url, method }: ApiRequest) => {
    if (url.pathname === '/api/v1/auth/me') return ok({ user: { id: 'c1' } });
    if (url.pathname === '/api/v1/market/depth') return ok({ visible: false, items: 0, vendors: 0 });
    if (url.pathname === '/api/v1/customer/vendors/v1') return ok(STORE);
    if (url.pathname === '/api/v1/public/storefronts/fixture-bakery') return ok(storefrontFixture({ ...STORE, addressLine1: '12 Fixture Road', city: 'Georgetown', operatingHours: HOURS }));
    if (url.pathname === '/api/v1/customer/cart' && method === 'GET') {
      const selections = url.searchParams.get('fulfillmentSelections');
      return ok(selections && JSON.parse(selections).v1 === 'PICKUP' ? pickupQuote() : deliveryCart(mmg));
    }
    if (url.pathname === '/api/v1/customer/addresses') return ok([{ id: 'a1', label: 'Home', addressLine1: 'Fixture street', city: 'Georgetown', isDefault: true }]);
    if (url.pathname === '/api/v1/customer/cart/address' && method === 'PUT') return ok({ cart: deliveryCart(mmg) });
    if (url.pathname === '/api/v1/customer/checkout' && method === 'POST') return checkoutReply ?? ok({ order: { id: 'o1' }, orders: [{ id: 'o1' }], paymentAction: null });
    return { status: 404, body: { success: false, error: { message: `unmocked ${method} ${url.pathname}` } } };
  });
});

function at(pathname: string, page: React.ReactNode) {
  state.pathname = pathname;
  window.history.replaceState({}, '', pathname);
  return render(<AppLayout>{page}</AppLayout>);
}
const choice = () => screen.findByRole('radiogroup', { name: 'How would you like your order?' });
async function choosePickup() {
  fireEvent.click(within(await choice()).getByRole('radio', { name: /^Pickup/ }));
}

describe('[W5] the pickup quote', () => {
  it('asks the server for a pickup quote for every store in the basket, with no rider tip — the phone app’s own choices', async () => {
    expect(pickupChoices(['v2', 'v1'])).toEqual(cartPricingChoices({ mode: 'PICKUP', express: false, storeIds: ['v2', 'v1'], bookingsOnly: false, selectedTip: null, promoCode: null }));
    await getCart({ choices: pickupChoices(['v1']) });
    const [query] = cartReads();
    expect(JSON.parse(query!.get('fulfillmentSelections')!)).toEqual({ v1: 'PICKUP' });
    expect(query!.get('tipAmount')).toBe('0');
  });
});

describe('[W5] Delivery or Pickup at checkout', () => {
  it('offers a clear choice, delivery first, and keeps the delivery address picker for delivery', async () => {
    at('/checkout', <CheckoutPage />);
    const group = await choice();
    expect(within(group).getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)).toEqual([expect.stringContaining('Delivery'), expect.stringContaining('Pickup')]);
    expect((within(group).getByRole('radio', { name: /^Delivery/ }) as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByLabelText('Saved delivery address')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Place cash order · $2,100' })).toBeTruthy();
  });

  it('pickup shows the store’s address and today’s hours, no delivery fee and no rider tip, at the server’s pickup total', async () => {
    at('/checkout', <CheckoutPage />);
    await choosePickup();
    const pickupPanel = await screen.findByRole('region', { name: 'Pick up from Fixture Bakery' });
    expect(pickupPanel.textContent).toContain('12 Fixture Road, Georgetown');
    expect(pickupPanel.textContent).toMatch(/Today 07:00 – 19:00/);
    expect(pickupPanel.textContent).toContain('No delivery fee');
    expect(screen.queryByLabelText('Saved delivery address')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tip your rider' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Place pickup order · $1,800' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Order total' })).getByText('No delivery fee')).toBeTruthy();
    expect(cartReads().some((query) => query.get('fulfillmentSelections') === JSON.stringify({ v1: 'PICKUP' }) && query.get('tipAmount') === '0')).toBe(true);
  });

  it('places a pickup order without a delivery address, with the pickup prices the customer saw, once', async () => {
    at('/checkout', <CheckoutPage />);
    await choosePickup();
    const place = await screen.findByRole('button', { name: 'Place pickup order · $1,800' });
    await waitFor(() => expect((place as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(place);
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/orders/o1'));
    expect(calls('PUT', '/api/v1/customer/cart/address')).toHaveLength(0);
    const checkouts = calls('POST', '/api/v1/customer/checkout') as Array<[unknown, RequestInit]>;
    expect(checkouts).toHaveLength(1);
    expect(JSON.parse(String(checkouts[0]![1].body))).toEqual({
      paymentMethod: 'CASH', tipAmount: 0, fulfillmentSelections: { v1: 'PICKUP' }, expectedTotal: 1800, expectedLines: [{ lineId: 'l1', unitPrice: 900 }],
    });
    expect((checkouts[0]![1].headers as Record<string, string>)['Idempotency-Key']).toMatch(/.{8,}/);
  });

  it('pays the store directly by MMG for pickup when the server offers it', async () => {
    mmg = true;
    at('/checkout', <CheckoutPage />);
    await choosePickup();
    const pay = await screen.findByRole('radiogroup', { name: 'Payment' });
    expect(within(pay).getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)).toEqual([expect.stringContaining('Pay at the counter'), expect.stringContaining('Pay with MMG')]);
    fireEvent.click(within(pay).getByRole('radio', { name: /Pay with MMG/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Place pickup order · $1,800 · pay by MMG' }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/orders/o1'));
    const [[, init]] = calls('POST', '/api/v1/customer/checkout') as [[unknown, RequestInit]];
    expect(JSON.parse(String(init.body))).toMatchObject({ paymentMethod: 'MOBILE_MONEY', tipAmount: 0, fulfillmentSelections: { v1: 'PICKUP' }, expectedTotal: 1800 });
  });

  it('locks checkout when the server does not confirm a pickup price — never a delivery total under a pickup label', async () => {
    pickupQuote = () => deliveryCart(false);
    at('/checkout', <CheckoutPage />);
    await choosePickup();
    expect(await screen.findByText(/could not confirm a pickup price/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Place pickup order/ })).toBeNull();
    expect(calls('POST', '/api/v1/customer/checkout')).toHaveLength(0);
  });

  it('keeps the choice made in the order context bar, and the bar follows the checkout', async () => {
    sessionStorage.setItem('swift_ordering_mode', 'PICKUP');
    at('/checkout', <CheckoutPage />);
    expect((within(await choice()).getByRole('radio', { name: /^Pickup/ }) as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByRole('button', { name: 'Place pickup order · $1,800' })).toBeTruthy();
    fireEvent.click(within(await choice()).getByRole('radio', { name: /^Delivery/ }));
    expect(await screen.findByRole('button', { name: 'Place cash order · $2,100' })).toBeTruthy();
    expect(sessionStorage.getItem('swift_ordering_mode')).toBe('DELIVERY');
  });

  it('when no riders are online, offers pickup instead — it switches the choice and places nothing', async () => {
    checkoutReply = { status: 409, body: { success: false, error: { code: 'NO_RIDERS', message: 'No delivery riders are online right now.' } } };
    at('/checkout', <CheckoutPage />);
    const place = await screen.findByRole('button', { name: 'Place cash order · $2,100' });
    await waitFor(() => expect((place as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(place);
    fireEvent.click(await screen.findByRole('button', { name: 'Order for pickup instead' }));
    expect((within(await choice()).getByRole('radio', { name: /^Pickup/ }) as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByRole('button', { name: 'Place pickup order · $1,800' })).toBeTruthy();
    expect(calls('POST', '/api/v1/customer/checkout')).toHaveLength(1);
  });

  it('does not change delivery or pickup while an earlier order’s outcome is unknown', async () => {
    at('/checkout', <CheckoutPage />);
    await screen.findByRole('button', { name: 'Place cash order · $2,100' });
    sessionStorage.setItem('swift_web_checkout_attempt:c1', JSON.stringify({ signature: 'earlier-order', key: 'earlier-key' }));
    await choosePickup();
    expect(await screen.findByText(/unresolved server outcome/)).toBeTruthy();
    expect((within(await choice()).getByRole('radio', { name: /^Delivery/ }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('[W5] the store’s order panel', () => {
  it('shows the same Delivery · Pickup choice; pickup names the store’s address and no delivery fee', async () => {
    at('/store/fixture-bakery', await StorefrontPage({ params: Promise.resolve({ slug: 'fixture-bakery' }), searchParams: Promise.resolve({}) }));
    const rail = await screen.findByRole('complementary', { name: 'Your order and checkout' });
    const group = await within(rail).findByRole('radiogroup', { name: 'How would you like your order?' });
    fireEvent.click(within(group).getByRole('radio', { name: /^Pickup/ }));
    await waitFor(() => expect(rail.textContent).toContain('Pickup from 12 Fixture Road, Georgetown'));
    expect(rail.textContent).toContain('No delivery fee');
    expect(sessionStorage.getItem('swift_ordering_mode')).toBe('PICKUP');
  });
});
