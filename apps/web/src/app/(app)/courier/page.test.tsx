import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';
import { mapPixel, pixelPoint } from '@/lib/store-pin';
import CourierPage from './page';

const state = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push, replace: vi.fn(), back: vi.fn() }) }));

// ---------------------------------------------------------------------------
// [WEB-PIN] Send a parcel: the owner, 11 Oct — "can't pin where to". Pickup
// and drop-off were text search only, and on the test server the places
// provider knows delivery zones and saved addresses, so most streets could
// never be chosen. The phone app pins either end on a map and sends the pin
// INLINE ({lat,lng} + a label) to /courier/estimate and /courier/order —
// exactly what is asserted here, in the API's real shapes.
//
// And the request itself: the server REQUIRES the recipient's name and phone
// (courier.routes.ts orderSchema), while this form called them optional and
// sent `notes`, a field the server does not have. A parcel without a recipient
// was a 400 the sender could not explain.
// ---------------------------------------------------------------------------

const ok = (data: unknown, status = 200) => ({ status, body: { success: true, data } });
/** Made-up Georgetown points — no real person's address. */
const DEVICE = { latitude: 6.8031, longitude: -58.1622, accuracy: 12 };
const SAVED = { id: 'a1', userId: 'c1', label: 'Work', addressLine1: '3 Example Avenue', addressLine2: null, city: 'Georgetown', region: '', country: 'GY', latitude: 6.8122, longitude: -58.1489, instructions: null, isDefault: true };
const ESTIMATE = { baseFee: 800, distanceFee: 360, sizeSurcharge: 0, speedMultiplier: 1, totalFee: 1160, estimatedMinutes: 18, currency: 'GYD', distanceKm: 3 };
let reverseLabel: string | null;
let fetchMock: ReturnType<typeof mockApi>;
const calls = (method: string, pathname: string) => fetchMock.mock.calls.filter(([url, init]) =>
  new URL(String(url)).pathname === pathname && (init?.method ?? 'GET').toUpperCase() === method);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const loadMap = () => screen.getByRole('application').querySelectorAll('img').forEach((tile) => fireEvent.load(tile));
/** [owner #67] The sender's tick: "This parcel has no prohibited items". */
const declare = () => fireEvent.click(screen.getByRole('checkbox', { name: 'This parcel has no prohibited items' }));

function device(fix: 'ok' | 'denied' | 'rough') {
  const getCurrentPosition = vi.fn((success: PositionCallback, fail?: PositionErrorCallback | null) => {
    if (fix === 'denied') fail?.({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError);
    else success({ coords: (fix === 'rough' ? { ...DEVICE, accuracy: 4800 } : DEVICE) as unknown as GeolocationCoordinates, timestamp: Date.now() } as GeolocationPosition);
  });
  vi.spyOn(navigator, 'geolocation', 'get').mockReturnValue({ getCurrentPosition } as unknown as Geolocation);
}

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  reverseLabel = 'Lot 3 Sample Road, Georgetown';
  fetchMock = mockApi(({ url, method }) => {
    if (url.pathname === '/api/v1/customer/addresses' && method === 'GET') return ok([SAVED]);
    if (url.pathname === '/api/v1/places/reverse') return ok({ address: reverseLabel });
    if (url.pathname === '/api/v1/places/autocomplete') return ok([]);
    if (url.pathname === '/api/v1/courier/estimate' && method === 'POST') return ok(ESTIMATE);
    if (url.pathname === '/api/v1/courier/order' && method === 'POST') {
      return ok({ orderId: 'co-1', orderNumber: 'SW-3001', fee: 1160, distanceKm: 3, trackingToken: 't', trackingUrl: 'https://example.test/t', expiresAt: null }, 201);
    }
    return { status: 404, body: { success: false, error: { message: `unmocked ${method} ${url.pathname}` } } };
  });
});

/** Where the map is after one ArrowRight nudge (12 px) from `from` at the near zoom. */
function nudgedRight(from: { latitude: number; longitude: number }, zoom = 17) {
  const start = mapPixel(from, zoom);
  return pixelPoint(start.x + 12, start.y, zoom);
}

async function pinDropoff() {
  fireEvent.click(await screen.findByRole('button', { name: 'Pin drop-off on the map' }));
  const map = await screen.findByRole('application', { name: 'Drop-off pin map' });
  loadMap();
  return map;
}

describe('[WEB-PIN] send a parcel: pin either end on the map', () => {
  // [review S3-1] Location is asked for only when the sender taps for it, as
  // in the pin picker: a prompt on page load is a surprise, and an early
  // "Block" would also refuse every later "Use my location".
  it('opening the page never asks for the device location; a tap does', async () => {
    device('ok');
    const geolocation = navigator.geolocation as unknown as { getCurrentPosition: ReturnType<typeof vi.fn> };
    render(<CourierPage />);
    expect(await screen.findByRole('button', { name: 'Use my location as the pickup' })).toBeTruthy();
    await new Promise((settle) => setTimeout(settle, 30));
    expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(button('Use my location as the pickup'));
    expect(await screen.findByDisplayValue('Current location')).toBeTruthy();
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('a location that arrives after the sender chose another pickup does not replace it', async () => {
    let answer: PositionCallback = () => undefined;
    vi.spyOn(navigator, 'geolocation', 'get').mockReturnValue({ getCurrentPosition: vi.fn((success: PositionCallback) => { answer = success; }) } as unknown as Geolocation);
    render(<CourierPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use my location as the pickup' }));
    // While the device is still answering, the sender types the pickup themselves.
    const pickupBox = screen.getAllByPlaceholderText('Search address…')[0]!;
    fireEvent.change(pickupBox, { target: { value: 'Sample Market' } });
    await act(async () => { answer({ coords: DEVICE as unknown as GeolocationCoordinates, timestamp: Date.now() } as GeolocationPosition); });
    expect((pickupBox as HTMLInputElement).value).toBe('Sample Market');
    expect(screen.queryByDisplayValue('Current location')).toBeNull();
    expect(button('Use my location as the pickup').disabled).toBe(false);
  });

  it('a location refusal that arrives after the sender chose another pickup neither wipes it nor shows an error', async () => {
    let refuse: PositionErrorCallback = () => undefined;
    vi.spyOn(navigator, 'geolocation', 'get').mockReturnValue({ getCurrentPosition: vi.fn((_ok: PositionCallback, fail?: PositionErrorCallback | null) => { refuse = fail!; }) } as unknown as Geolocation);
    render(<CourierPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use my location as the pickup' }));
    const pickupBox = screen.getAllByPlaceholderText('Search address…')[0]!;
    fireEvent.change(pickupBox, { target: { value: 'Sample Market' } });
    await act(async () => { refuse({ code: 3, PERMISSION_DENIED: 1, TIMEOUT: 3 } as GeolocationPositionError); });
    expect((pickupBox as HTMLInputElement).value).toBe('Sample Market');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('pins the drop-off: the estimate and the order carry the pinned point and its name', async () => {
    device('ok');
    render(<CourierPage />);
    fireEvent.click(button('Use my location as the pickup'));
    await screen.findByDisplayValue('Current location');
    // Start the drop-off from a saved address, then nudge it by keyboard to the door.
    await pinDropoff();
    fireEvent.click(await screen.findByRole('button', { name: 'Work — 3 Example Avenue' }));
    loadMap();
    const map = screen.getByRole('application', { name: 'Drop-off pin map' });
    fireEvent.keyDown(map, { key: 'ArrowRight' });
    loadMap();
    await screen.findByText(`Near ${reverseLabel}`);
    fireEvent.click(button('Use this pin'));

    const pin = nudgedRight({ latitude: SAVED.latitude, longitude: SAVED.longitude });
    expect(screen.queryByRole('application')).toBeNull();
    expect(await screen.findByDisplayValue(reverseLabel!)).toBeTruthy();
    await waitFor(() => expect(calls('POST', '/api/v1/courier/estimate').length).toBeGreaterThan(0));
    const estimate = bodyOf(calls('POST', '/api/v1/courier/estimate').at(-1)!);
    expect(estimate.pickup).toMatchObject({ lat: DEVICE.latitude, lng: DEVICE.longitude });
    expect(estimate.dropoff.lat).toBeCloseTo(pin.latitude, 9);
    expect(estimate.dropoff.lng).toBeCloseTo(pin.longitude, 9);
    expect(estimate.packageSize).toBe('SMALL');
    expect(await screen.findByText('$1,160')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient name' }), { target: { value: 'Test Recipient' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient phone' }), { target: { value: '+592 600 0000' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'What’s inside? (optional)' }), { target: { value: 'A phone charger' } });
    declare();
    await waitFor(() => expect(button('Request courier · $1,160').disabled).toBe(false));
    fireEvent.click(button('Request courier · $1,160'));
    await waitFor(() => expect(calls('POST', '/api/v1/courier/order')).toHaveLength(1));
    const order = bodyOf(calls('POST', '/api/v1/courier/order')[0]!);
    expect(order).toMatchObject({
      pickup: { lat: DEVICE.latitude, lng: DEVICE.longitude },
      pickupAddress: 'Current location',
      dropoffAddress: reverseLabel,
      packageSize: 'SMALL',
      recipientName: 'Test Recipient',
      recipientPhone: '+592 600 0000',
      packageDescription: 'A phone charger',
      declaresNoProhibitedItems: true,
    });
    expect(order.dropoff.lat).toBeCloseTo(pin.latitude, 9);
    expect(order).not.toHaveProperty('notes');
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/orders/co-1'));
  });

  it('[PRICE-LOCK] the order carries the fee on the button; a fee that moved is quoted again and sent at the new fee', async () => {
    // Owner: the price shown is the price charged. The server creates the job
    // only at the fee the sender saw, and says so (409 PRICE_CHANGED) when it moved.
    let fee = 1160;
    let orders = 0;
    fetchMock = mockApi(({ url, method }) => {
      if (url.pathname === '/api/v1/customer/addresses' && method === 'GET') return ok([SAVED]);
      if (url.pathname === '/api/v1/places/reverse') return ok({ address: reverseLabel });
      if (url.pathname === '/api/v1/places/autocomplete') return ok([]);
      if (url.pathname === '/api/v1/courier/estimate' && method === 'POST') return ok({ ...ESTIMATE, totalFee: fee });
      if (url.pathname === '/api/v1/courier/order' && method === 'POST') {
        orders += 1;
        if (orders === 1) {
          return { status: 409, body: { success: false, error: { code: 'PRICE_CHANGED', message: 'The fee for this parcel has changed. Check the new fee, then send it again.', details: { expectedFee: 1160, fee: 1280, currencyCode: 'GYD' } } } };
        }
        return ok({ orderId: 'co-2', orderNumber: 'SW-3002', fee: 1280, distanceKm: 3, trackingToken: 't', trackingUrl: 'https://example.test/t', expiresAt: null }, 201);
      }
      return { status: 404, body: { success: false, error: { message: `unmocked ${method} ${url.pathname}` } } };
    });
    device('ok');
    render(<CourierPage />);
    // The pickup comes from the device only when the sender taps for it (row 413).
    fireEvent.click(await screen.findByRole('button', { name: 'Use my location as the pickup' }));
    await screen.findByDisplayValue('Current location');
    await pinDropoff();
    fireEvent.click(await screen.findByRole('button', { name: 'Work — 3 Example Avenue' }));
    loadMap();
    fireEvent.keyDown(screen.getByRole('application', { name: 'Drop-off pin map' }), { key: 'ArrowRight' });
    loadMap();
    await screen.findByText(`Near ${reverseLabel}`);
    fireEvent.click(button('Use this pin'));
    expect(await screen.findByText('$1,160')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient name' }), { target: { value: 'Test Recipient' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient phone' }), { target: { value: '+592 600 0000' } });
    declare();
    await waitFor(() => expect(button('Request courier · $1,160').disabled).toBe(false));
    fee = 1280;
    fireEvent.click(button('Request courier · $1,160'));
    expect(await screen.findByText(/The fee for this parcel has changed/)).toBeTruthy();
    await waitFor(() => expect(button('Request courier · $1,280').disabled).toBe(false));
    expect(state.push).not.toHaveBeenCalled();
    fireEvent.click(button('Request courier · $1,280'));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/orders/co-2'));
    expect(calls('POST', '/api/v1/courier/order').map((c) => bodyOf(c).expectedFee)).toEqual([1160, 1280]);
    // [UI-SWEEP U65] A parcel at a new fee is a new intent: a new request key.
    const keys = calls('POST', '/api/v1/courier/order').map((c) => new Headers((c[1] as RequestInit).headers).get('Idempotency-Key'));
    expect(keys.every((k) => typeof k === 'string' && /^[A-Za-z0-9._~-]{1,200}$/.test(k!))).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('pins the pickup when the device location is refused; an unnamed spot is sent as "Dropped pin"', async () => {
    device('denied');
    reverseLabel = null;
    render(<CourierPage />);
    fireEvent.click(button('Use my location as the pickup'));
    expect(await screen.findByText(/allow location access and try again/)).toBeTruthy();
    fireEvent.click(button('Pin pickup on the map'));
    const map = await screen.findByRole('application', { name: 'Pickup pin map' });
    loadMap();
    // Georgetown's centre is only where the map opens: it is not a pickup.
    expect(button('Use this pin').disabled).toBe(true);
    fireEvent.keyDown(map, { key: 'ArrowUp' });
    loadMap();
    await screen.findByText('No street name found at this pin.');
    await waitFor(() => expect(button('Use this pin').disabled).toBe(false));
    fireEvent.click(button('Use this pin'));
    expect(await screen.findByDisplayValue('Dropped pin')).toBeTruthy();
    expect(calls('POST', '/api/v1/courier/estimate')).toHaveLength(0);
  });

  it('will not request a courier without the recipient the server requires', async () => {
    device('ok');
    render(<CourierPage />);
    fireEvent.click(button('Use my location as the pickup'));
    await screen.findByDisplayValue('Current location');
    const map = await pinDropoff();
    fireEvent.keyDown(map, { key: 'ArrowDown' });
    loadMap();
    // Until Swift has named the pin, it cannot be used — the phone waits for
    // the name too — so a quick tap never sends "Dropped pin" for a named spot.
    expect(button('Finding the address…').disabled).toBe(true);
    await screen.findByText(`Near ${reverseLabel}`);
    fireEvent.click(button('Use this pin'));
    // Focus goes back to where the map was opened from.
    await waitFor(() => expect(document.activeElement).toBe(button('Pin drop-off on the map')));
    expect(await screen.findByText('$1,160')).toBeTruthy();
    expect(button('Add the recipient’s name').disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient name' }), { target: { value: 'Test Recipient' } });
    expect(button('Add the recipient’s phone').disabled).toBe(true);
    fireEvent.click(button('Add the recipient’s phone'));
    expect(calls('POST', '/api/v1/courier/order')).toHaveLength(0);
  });

  it('a rough device fix is not taken as the pickup: the sender pins or searches it', async () => {
    device('rough');
    render(<CourierPage />);
    fireEvent.click(button('Use my location as the pickup'));
    expect(await screen.findByText(/only within about 4800 m/)).toBeTruthy();
    expect(screen.queryByDisplayValue('Current location')).toBeNull();
    fireEvent.click(button('Pin pickup on the map'));
    await screen.findByRole('application', { name: 'Pickup pin map' });
    fireEvent.click(button('Cancel'));
    await waitFor(() => expect(document.activeElement).toBe(button('Pin pickup on the map')));
    expect(calls('POST', '/api/v1/courier/estimate')).toHaveLength(0);
  });

  it('a pin outside Guyana cannot be used', async () => {
    device('ok');
    render(<CourierPage />);
    fireEvent.click(button('Use my location as the pickup'));
    await screen.findByDisplayValue('Current location');
    const map = await pinDropoff();
    for (let i = 0; i < 12; i += 1) fireEvent.click(button('Zoom out'));
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(map, { key: 'ArrowLeft', shiftKey: true });
    loadMap();
    expect(await screen.findByText('That pin is outside Guyana, where Swift works today. Move it to a place in Guyana.')).toBeTruthy();
    expect(button('Use this pin').disabled).toBe(true);
    fireEvent.click(button('Cancel'));
    expect(screen.queryByRole('application')).toBeNull();
    expect(calls('POST', '/api/v1/courier/estimate')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// [GUARDRAILS §8 · owner #67] Swift never carries banned goods. The server
// screens the parcel description against the catalogue's ban list and refuses
// it in plain words (409 PROHIBITED_PARCEL); the sender also ticks "This parcel
// has no prohibited items" before a courier is requested, and the order says
// so (`declaresNoProhibitedItems`, recorded on the order's own trail).
// ---------------------------------------------------------------------------
describe('[owner #67] a parcel with no prohibited items', () => {
  async function readyParcel() {
    device('ok');
    render(<CourierPage />);
    // The pickup comes from the device only when the sender taps for it (row 413).
    fireEvent.click(await screen.findByRole('button', { name: 'Use my location as the pickup' }));
    await screen.findByDisplayValue('Current location');
    await pinDropoff();
    fireEvent.click(await screen.findByRole('button', { name: 'Work — 3 Example Avenue' }));
    loadMap();
    fireEvent.keyDown(screen.getByRole('application', { name: 'Drop-off pin map' }), { key: 'ArrowRight' });
    loadMap();
    await screen.findByText(`Near ${reverseLabel}`);
    fireEvent.click(button('Use this pin'));
    expect(await screen.findByText('$1,160')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient name' }), { target: { value: 'Test Recipient' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient phone' }), { target: { value: '+592 600 0000' } });
  }

  it('no courier is requested until the sender ticks the box; the order carries the tick', async () => {
    await readyParcel();
    // The list the tick refers to is on screen, in the server's own words.
    expect(screen.getByText(/Swift never carries alcohol, tobacco, vapes, medicines, cannabis or other drugs, cooking gas \(LPG\), fuel, 18\+ items, fireworks or explosives, pesticides or toxic chemicals, raw gold, diamonds or precious stones, firearms, ammunition or replicas, protected wildlife, counterfeit goods, currency and payment cards, or letters, documents and mail\./)).toBeTruthy();
    const box = screen.getByRole('checkbox', { name: 'This parcel has no prohibited items' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(button('Tick “no prohibited items” to send').disabled).toBe(true);
    fireEvent.click(button('Tick “no prohibited items” to send'));
    expect(calls('POST', '/api/v1/courier/order')).toHaveLength(0);

    declare();
    expect(box.checked).toBe(true);
    await waitFor(() => expect(button('Request courier · $1,160').disabled).toBe(false));
    // Unticking takes it back.
    declare();
    expect(button('Tick “no prohibited items” to send').disabled).toBe(true);
    declare();
    fireEvent.click(button('Request courier · $1,160'));
    await waitFor(() => expect(calls('POST', '/api/v1/courier/order')).toHaveLength(1));
    expect(bodyOf(calls('POST', '/api/v1/courier/order')[0]!)).toMatchObject({ declaresNoProhibitedItems: true });
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/orders/co-1'));
  });

  it('a parcel the server refuses says why in plain words, and the sender stays on the form', async () => {
    const refusal = "Swift can't carry this parcel: Swift never delivers alcohol. If it's something else, describe it in other words.";
    fetchMock = mockApi(({ url, method }) => {
      if (url.pathname === '/api/v1/customer/addresses' && method === 'GET') return ok([SAVED]);
      if (url.pathname === '/api/v1/places/reverse') return ok({ address: reverseLabel });
      if (url.pathname === '/api/v1/places/autocomplete') return ok([]);
      if (url.pathname === '/api/v1/courier/estimate' && method === 'POST') return ok(ESTIMATE);
      if (url.pathname === '/api/v1/courier/order' && method === 'POST') {
        return { status: 409, body: { success: false, error: { code: 'PROHIBITED_PARCEL', message: refusal, details: { prohibitedClass: 'ALCOHOL' } } } };
      }
      return { status: 404, body: { success: false, error: { message: `unmocked ${method} ${url.pathname}` } } };
    });
    await readyParcel();
    fireEvent.change(screen.getByRole('textbox', { name: 'What’s inside? (optional)' }), { target: { value: 'Rum 750ml' } });
    declare();
    fireEvent.click(button('Request courier · $1,160'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', refusal);
    expect(state.push).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U65] The web parcel send carried no Idempotency-Key: a lost answer
// and a second press booked a second parcel. One key per parcel intent, kept
// across retries; the server replays the first booking for the same key.
// ---------------------------------------------------------------------------
describe('[U65] pressing send again never books a second parcel', () => {
  it('a lost answer and a second press resend the SAME request key', async () => {
    let orders = 0;
    fetchMock = mockApi(({ url, method }) => {
      if (url.pathname === '/api/v1/customer/addresses' && method === 'GET') return ok([SAVED]);
      if (url.pathname === '/api/v1/places/reverse') return ok({ address: reverseLabel });
      if (url.pathname === '/api/v1/places/autocomplete') return ok([]);
      if (url.pathname === '/api/v1/courier/estimate' && method === 'POST') return ok(ESTIMATE);
      if (url.pathname === '/api/v1/courier/order' && method === 'POST') {
        orders += 1;
        if (orders === 1) return { status: 504, body: { success: false, error: { message: 'The answer was lost on the way back.' } } };
        return ok({ orderId: 'co-1', orderNumber: 'SW-3001', fee: 1160, distanceKm: 3, trackingToken: 't', trackingUrl: 'https://example.test/t', expiresAt: null }, 201);
      }
      return { status: 404, body: { success: false, error: { message: `unmocked ${method} ${url.pathname}` } } };
    });
    device('ok');
    render(<CourierPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use my location as the pickup' }));
    await screen.findByDisplayValue('Current location');
    await pinDropoff();
    fireEvent.click(await screen.findByRole('button', { name: 'Work — 3 Example Avenue' }));
    loadMap();
    fireEvent.keyDown(screen.getByRole('application', { name: 'Drop-off pin map' }), { key: 'ArrowRight' });
    loadMap();
    await screen.findByText(`Near ${reverseLabel}`);
    fireEvent.click(button('Use this pin'));
    expect(await screen.findByText('$1,160')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient name' }), { target: { value: 'Test Recipient' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient phone' }), { target: { value: '+592 600 0000' } });
    declare();
    await waitFor(() => expect(button('Request courier · $1,160').disabled).toBe(false));
    fireEvent.click(button('Request courier · $1,160'));
    expect(await screen.findByText(/The answer was lost on the way back/)).toBeTruthy();
    await waitFor(() => expect(button('Request courier · $1,160').disabled).toBe(false));
    fireEvent.click(button('Request courier · $1,160'));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/orders/co-1'));
    const keys = calls('POST', '/api/v1/courier/order').map((c) => new Headers((c[1] as RequestInit).headers).get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
});
