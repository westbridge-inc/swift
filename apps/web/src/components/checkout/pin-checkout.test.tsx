import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest, type ApiReply } from '@/test/test-utils';
import { STORE_MAP_START, mapPixel, pixelPoint } from '@/lib/store-pin';
import AppLayout from '@/app/(app)/layout';
import CheckoutPage from '@/app/(app)/checkout/page';

const state = vi.hoisted(() => ({ pathname: '/checkout', push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useParams: () => ({}),
  useRouter: () => ({ push: state.push, back: state.back, replace: state.replace, refresh: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// [WEB-PIN] The owner, 11 Oct, on an iPhone: the store page said "Choose an
// address for a quote · Quote needed · Add a delivery address", and there was
// no way to put a pin on the map — the old form only searched the places
// provider, which on the test server knows delivery zones and the customer's
// own saved addresses. So a customer with no saved address could never get a
// quote, and Place order never enabled.
//
// [W4] Every web order is placed on the one checkout (/checkout; the cart
// shows the same page), so the pin lives there.
//
// The phone app's rule, followed here against the real API contract: the pin
// becomes a saved address (POST /customer/addresses, latitude/longitude), the
// cart is pointed at it (PUT /customer/cart/address — the server checks the
// store's delivery radius there), and the cart's quote prices that address.
// ---------------------------------------------------------------------------

const ok = (data: unknown, status = 200) => ({ status, body: { success: true, data } });

/** A made-up Georgetown store and customer — no real person or place. */
function cart(quoted: { id: string; label: string; addressLine1: string; city: string } | null, distanceKm = quoted ? 1.1 : 3) {
  return {
    id: 'cart-1',
    items: [{ id: 'l1', itemId: 'i1', name: 'Pepperpot bowl', quantity: 1, customerPrice: 1800, lineTotal: 1800, fulfillment: 'DELIVERY', isAvailable: true, selectedOptionNames: [] }],
    subtotalCustomer: 1800,
    // With no destination the server prices a 3 km fallback; that is not a quote for any door.
    deliveryFee: quoted ? 350 : 500,
    deliveryDistanceKm: distanceKm,
    discount: 0,
    tipAmount: 0,
    totalAmount: quoted ? 2150 : 2300,
    deliveryAddress: quoted,
    vendor: { id: 'v1', name: 'Test Kitchen', slug: 'test-kitchen', deliveryRadius: 8, distanceKm, isCurrentlyOpen: true, acceptingOrders: true },
    meetsMinimum: true,
    minimumOrderAmount: 0,
    paymentCapabilities: {
      scope: 'cash-scope',
      cash: { available: true, fundsFlow: 'DIRECT_AT_HANDOVER' },
      mmg: { available: false, provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR', unavailableReason: 'VENDOR_NOT_CONFIGURED' },
    },
  };
}
const STOREFRONT = { id: 'v1', slug: 'test-kitchen', name: 'Test Kitchen', isCurrentlyOpen: true, acceptingOrders: true };
const VENDOR = { id: 'v1', name: 'Test Kitchen', categories: [{ id: 'c1', name: 'Mains', items: [{ id: 'i1', name: 'Pepperpot bowl', basePrice: 1800, isAvailable: true }] }] };
const REVERSE_LABEL = 'Lot 7 Example Street, Georgetown';

type AddressRow = { id: string; label: string; addressLine1: string; city: string; isDefault: boolean; latitude: number; longitude: number; [field: string]: unknown };
let addresses: AddressRow[];
let liveCart: ReturnType<typeof cart>;
let api: (_request: ApiRequest) => ApiReply | null;
let fetchMock: ReturnType<typeof mockApi>;
const calls = (method: string, pathname: string) => fetchMock.mock.calls.filter(([url, init]) =>
  new URL(String(url)).pathname === pathname && (init?.method ?? 'GET').toUpperCase() === method);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const order = (method: string, pathname: string) => fetchMock.mock.calls.findIndex(([url, init]) =>
  new URL(String(url)).pathname === pathname && (init?.method ?? 'GET').toUpperCase() === method);

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  sessionStorage.clear(); localStorage.clear();
  state.pathname = '/checkout';
  window.history.replaceState({}, '', '/checkout');
  addresses = [];
  liveCart = cart(null);
  api = () => null;
  fetchMock = mockApi((request) => {
    const special = api(request);
    if (special) return special;
    const { url, method, init } = request;
    if (url.pathname === '/api/v1/auth/me') return ok({ user: { id: 'c1' } });
    if (url.pathname === '/api/v1/market/depth') return ok({ visible: false, items: 0, vendors: 0 });
    if (url.pathname === '/api/v1/customer/cart' && method === 'GET') return ok(liveCart);
    if (url.pathname === '/api/v1/customer/addresses' && method === 'GET') return ok(addresses);
    if (url.pathname === '/api/v1/customer/addresses' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      const row = { id: 'a-new', userId: 'c1', addressLine2: null, region: '', country: 'GY', instructions: null, ...body, isDefault: addresses.length === 0 };
      addresses = [...addresses, row];
      return ok(row, 201);
    }
    if (url.pathname === '/api/v1/customer/cart/address' && method === 'PUT') {
      const { addressId } = JSON.parse(String(init?.body));
      const row = addresses.find((address) => address.id === addressId)!;
      liveCart = cart({ id: row.id, label: row.label, addressLine1: row.addressLine1, city: row.city });
      return ok({ cart: liveCart, message: 'Delivery address set' });
    }
    if (url.pathname === '/api/v1/places/reverse') return ok({ address: REVERSE_LABEL });
    if (url.pathname === '/api/v1/places/autocomplete') return ok([]);
    if (url.pathname === '/api/v1/public/storefronts/test-kitchen') return ok(STOREFRONT);
    if (url.pathname === '/api/v1/customer/vendors/v1') return ok(VENDOR);
    return { status: 404, body: { success: false, error: { message: `unmocked ${method} ${url.pathname}` } } };
  });
});

function renderCart() {
  return render(<AppLayout><CheckoutPage /></AppLayout>);
}

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
/** happy-dom never loads images: tell the map each visible tile has arrived. */
const loadMap = () => screen.getByRole('application').querySelectorAll('img').forEach((tile) => fireEvent.load(tile));

async function openPicker(name = 'Add a delivery address') {
  fireEvent.click(await screen.findByRole('button', { name }));
  const map = await screen.findByRole('application', { name: 'Delivery pin map' });
  loadMap();
  return map;
}

/** Where the map is after one ArrowRight nudge (12 px) from Georgetown at the opening zoom. */
function nudgedRight(zoom = 14) {
  const start = mapPixel(STORE_MAP_START, zoom);
  return pixelPoint(start.x + 12, start.y, zoom);
}

describe('[WEB-PIN] checkout: pin a delivery address on the map', () => {
  it('a customer with no saved address pins one: the address carries the pin, the cart is priced for it, and Place order enables', async () => {
    renderCart();
    // Before: exactly the owner's screen — no quote, and no way to order.
    await screen.findByRole('button', { name: 'Add a delivery address' });
    await waitFor(() => expect(button('Add a delivery address to order').disabled).toBe(true));
    expect(screen.getByText('Choose an address for a quote')).toBeTruthy();

    const map = await openPicker();
    // The city centre is only where the map starts, never a pin by itself.
    expect(screen.getByText('This is a city-centre starting point — move the map to your spot first.')).toBeTruthy();
    expect(button('Place the pin on the map').disabled).toBe(true);

    // Keyboard: the map takes focus and the arrow keys move it under the pin.
    map.focus();
    fireEvent.keyDown(map, { key: 'ArrowRight' });
    loadMap();
    // The pin is named by Swift's own reverse lookup, and that name fills the street.
    const street = await screen.findByDisplayValue(REVERSE_LABEL) as HTMLInputElement;
    expect(street).toBe(screen.getByRole('textbox', { name: 'Street address' }));
    await waitFor(() => expect(calls('GET', '/api/v1/places/reverse').length).toBeGreaterThan(0));
    const reverse = new URL(String(calls('GET', '/api/v1/places/reverse').at(-1)![0]));
    const pin = nudgedRight();
    expect(Number(reverse.searchParams.get('lat'))).toBeCloseTo(pin.latitude, 9);
    expect(Number(reverse.searchParams.get('lng'))).toBeCloseTo(pin.longitude, 9);

    await waitFor(() => expect(button('Save address').disabled).toBe(false));
    fireEvent.click(button('Save address'));

    // 1. The saved address IS the pin (the phone app's field names).
    await waitFor(() => expect(calls('POST', '/api/v1/customer/addresses')).toHaveLength(1));
    const saved = bodyOf(calls('POST', '/api/v1/customer/addresses')[0]!);
    expect(saved).toMatchObject({ label: 'Home', addressLine1: REVERSE_LABEL, city: 'Georgetown', isDefault: true });
    expect(saved.latitude).toBeCloseTo(pin.latitude, 9);
    expect(saved.longitude).toBeCloseTo(pin.longitude, 9);
    expect(saved.latitude).not.toBe(STORE_MAP_START.latitude);
    // 2. Then the quote is asked for THAT address — after it exists, never before.
    await waitFor(() => expect(calls('PUT', '/api/v1/customer/cart/address')).toHaveLength(1));
    expect(bodyOf(calls('PUT', '/api/v1/customer/cart/address')[0]!)).toEqual({ addressId: 'a-new' });
    expect(order('PUT', '/api/v1/customer/cart/address')).toBeGreaterThan(order('POST', '/api/v1/customer/addresses'));

    // 3. The server's quote is on screen and Place order is live.
    const summary = await screen.findByRole('region', { name: 'Order total' });
    await waitFor(() => expect(within(summary).getByText('$350')).toBeTruthy());
    await waitFor(() => expect(button('Place cash order · $2,150').disabled).toBe(false));
    expect(screen.queryByRole('application', { name: 'Delivery pin map' })).toBeNull();
  });

  it('keeps Save off until the pin is placed and the address fields are filled, naming what is missing', async () => {
    renderCart();
    const map = await openPicker();
    map.focus();
    fireEvent.keyDown(map, { key: 'ArrowDown', shiftKey: true });
    loadMap();
    await screen.findByDisplayValue(REVERSE_LABEL);
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: '' } });
    expect(button('Give it a label').disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Work' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Street address' }), { target: { value: 'x' } });
    expect(button('Add the street address').disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Street address' }), { target: { value: 'Lot 9 Sample Road' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'City / Town' }), { target: { value: '' } });
    expect(button('Add the city').disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'City / Town' }), { target: { value: 'Georgetown' } });
    // A street the customer typed is theirs: moving the pin again does not overwrite it.
    const lookups = calls('GET', '/api/v1/places/reverse').length;
    fireEvent.keyDown(map, { key: 'ArrowLeft' });
    loadMap();
    // Wait until the NEW pin has been named, so an overwrite would have happened by now.
    await waitFor(() => expect(calls('GET', '/api/v1/places/reverse').length).toBeGreaterThan(lookups));
    await waitFor(() => expect(screen.queryByText('Finding the address…')).toBeNull());
    await waitFor(() => expect(button('Save address').disabled).toBe(false));
    expect((screen.getByRole('textbox', { name: 'Street address' }) as HTMLInputElement).value).toBe('Lot 9 Sample Road');
    expect(calls('POST', '/api/v1/customer/addresses')).toHaveLength(0);
  });

  // [WEB-PIN · review S2] The street Swift fills in belongs to ONE pin. When the
  // pin moves, the old name must not stay in the box: the next spot may have no
  // name, or its lookup may time out — and a saved address whose words name a
  // place ~330 m from its pin is the W-08 defect (lib/place.ts) all over again.
  it('moving the pin to a spot with no street name clears the old name: Save waits for the customer to type one', async () => {
    let unnamed = false;
    api = ({ url }) => (url.pathname === '/api/v1/places/reverse' && unnamed ? ok({ address: null }) : null);
    renderCart();
    const map = await openPicker();
    map.focus();
    fireEvent.keyDown(map, { key: 'ArrowRight' });
    loadMap();
    const street = await screen.findByDisplayValue(REVERSE_LABEL) as HTMLInputElement;
    unnamed = true;
    fireEvent.keyDown(map, { key: 'ArrowUp', shiftKey: true });
    loadMap();
    await screen.findByText('No street name found at this pin.');
    expect(street.value).toBe('');
    expect(button('Add the street address').disabled).toBe(true);
    fireEvent.change(street, { target: { value: 'Lot 12 Sample Dam' } });
    await waitFor(() => expect(button('Save address').disabled).toBe(false));
    fireEvent.click(button('Save address'));
    await waitFor(() => expect(calls('POST', '/api/v1/customer/addresses')).toHaveLength(1));
    expect(bodyOf(calls('POST', '/api/v1/customer/addresses')[0]!)).toMatchObject({ addressLine1: 'Lot 12 Sample Dam' });
  });

  it('until the moved pin is named, the old name is gone and Save waits — even when the lookup times out', async () => {
    let hang = false;
    api = ({ url }) => (url.pathname === '/api/v1/places/reverse' && hang ? new Promise<ApiReply>(() => undefined) as unknown as ApiReply : null);
    renderCart();
    const map = await openPicker();
    map.focus();
    fireEvent.keyDown(map, { key: 'ArrowRight' });
    loadMap();
    const street = await screen.findByDisplayValue(REVERSE_LABEL) as HTMLInputElement;
    hang = true;
    fireEvent.keyDown(map, { key: 'ArrowDown', shiftKey: true });
    loadMap();
    // While Swift is still naming the new spot: no old words, and no Save.
    expect(within(screen.getByRole('group', { name: 'Chosen pin' })).getByText('Finding the address…')).toBeTruthy();
    expect(street.value).toBe('');
    expect(button('Finding the address…').disabled).toBe(true);
    // The lookup gives up after 4 s: the spot is unnamed, and the customer types the street.
    await waitFor(() => expect(screen.getByText('No street name found at this pin.')).toBeTruthy(), { timeout: 6000 });
    expect(street.value).toBe('');
    expect(button('Add the street address').disabled).toBe(true);
    expect(calls('POST', '/api/v1/customer/addresses')).toHaveLength(0);
  }, 10_000);

  it('refuses a pin outside Guyana in plain words and never saves it', async () => {
    renderCart();
    const map = await openPicker();
    for (let i = 0; i < 8; i += 1) fireEvent.click(button('Zoom out'));
    map.focus();
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(map, { key: 'ArrowLeft', shiftKey: true });
    loadMap();
    const refusal = await screen.findByText('That pin is outside Guyana, where Swift works today. Move it to a place in Guyana.');
    expect(refusal.getAttribute('role')).toBe('alert');
    expect(button('Place the pin on the map').disabled).toBe(true);
    expect(calls('POST', '/api/v1/customer/addresses')).toHaveLength(0);
  });

  it('shows the store’s own refusal when the pin is past its delivery radius, and Place order stays off', async () => {
    api = ({ url, method }) => {
      if (url.pathname !== '/api/v1/customer/cart/address' || method !== 'PUT') return null;
      // The saved address is the customer's first, so the server now prices it as the default.
      liveCart = cart({ id: 'a-new', label: 'Home', addressLine1: REVERSE_LABEL, city: 'Georgetown' }, 12.4);
      return { status: 400, body: { success: false, error: { code: 'OUT_OF_RANGE', message: 'Test Kitchen only delivers within 8 km. This address is 12.4 km away.' } } };
    };
    renderCart();
    const map = await openPicker();
    map.focus();
    fireEvent.keyDown(map, { key: 'ArrowUp' });
    loadMap();
    await screen.findByDisplayValue(REVERSE_LABEL);
    await waitFor(() => expect(button('Save address').disabled).toBe(false));
    fireEvent.click(button('Save address'));
    expect(await screen.findByText('Test Kitchen only delivers within 8 km. This address is 12.4 km away.')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/outside its 8\.0 km delivery radius/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Place cash order/ })).toBeNull();
    expect(calls('POST', '/api/v1/customer/checkout')).toHaveLength(0);
  });

  it('starts from the device only when asked, and a rough fix must still be moved by hand', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { latitude: 6.81, longitude: -58.14, accuracy: 1800 } as GeolocationCoordinates,
      timestamp: Date.now(),
    } as GeolocationPosition));
    vi.spyOn(navigator, 'geolocation', 'get').mockReturnValue({ getCurrentPosition } as unknown as Geolocation);
    renderCart();
    await openPicker();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    fireEvent.click(button('Use my location'));
    await waitFor(() => expect(getCurrentPosition).toHaveBeenCalledTimes(1));
    loadMap();
    expect(await screen.findByText(/only within about 1800 m/)).toBeTruthy();
    expect(button('Place the pin on the map').disabled).toBe(true);
  });

  it('an accurate device fix is a real starting pin, saved as the device reported it', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { latitude: 6.8102, longitude: -58.1405, accuracy: 15 } as GeolocationCoordinates,
      timestamp: Date.now(),
    } as GeolocationPosition));
    vi.spyOn(navigator, 'geolocation', 'get').mockReturnValue({ getCurrentPosition } as unknown as Geolocation);
    renderCart();
    await openPicker();
    fireEvent.click(button('Use my location'));
    await waitFor(() => expect(getCurrentPosition).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    loadMap();
    await screen.findByDisplayValue(REVERSE_LABEL);
    await waitFor(() => expect(button('Save address').disabled).toBe(false));
    fireEvent.click(button('Save address'));
    await waitFor(() => expect(calls('POST', '/api/v1/customer/addresses')).toHaveLength(1));
    expect(bodyOf(calls('POST', '/api/v1/customer/addresses')[0]!)).toMatchObject({ latitude: 6.8102, longitude: -58.1405 });
  });

  it('a customer with saved addresses can still pin a new one, and the checkout prices that one', async () => {
    addresses = [{ id: 'a1', userId: 'c1', label: 'Home', addressLine1: '12 Sample Street', city: 'Georgetown', isDefault: true, latitude: 6.81, longitude: -58.16 }];
    liveCart = cart({ id: 'a1', label: 'Home', addressLine1: '12 Sample Street', city: 'Georgetown' });
    renderCart();
    await screen.findByRole('combobox', { name: 'Saved delivery address' });
    // Cancel closes the map and leaves the saved address as it was.
    await openPicker('Pin a new address on the map');
    fireEvent.click(button('Cancel'));
    expect(screen.queryByRole('application', { name: 'Delivery pin map' })).toBeNull();
    // Focus goes back to where the map was opened from.
    await waitFor(() => expect(document.activeElement).toBe(button('Pin a new address on the map')));
    expect(calls('POST', '/api/v1/customer/addresses')).toHaveLength(0);

    const map = await openPicker('Pin a new address on the map');
    map.focus();
    fireEvent.keyDown(map, { key: 'ArrowRight' });
    loadMap();
    await screen.findByDisplayValue(REVERSE_LABEL);
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Work' } });
    await waitFor(() => expect(button('Save address').disabled).toBe(false));
    fireEvent.click(button('Save address'));
    await waitFor(() => expect(calls('PUT', '/api/v1/customer/cart/address')).toHaveLength(1));
    // Not the default: a second address is only this order's choice, priced at once.
    expect(bodyOf(calls('POST', '/api/v1/customer/addresses')[0]!)).toMatchObject({ label: 'Work', isDefault: false });
    expect(bodyOf(calls('PUT', '/api/v1/customer/cart/address')[0]!)).toEqual({ addressId: 'a-new' });
    const select = await screen.findByRole('combobox', { name: 'Saved delivery address' }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('a-new'));
    await waitFor(() => expect(button('Place cash order · $2,150').disabled).toBe(false));
  });
});
