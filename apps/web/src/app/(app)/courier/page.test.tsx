import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function device(fix: 'ok' | 'denied') {
  const getCurrentPosition = vi.fn((success: PositionCallback, fail?: PositionErrorCallback | null) => {
    if (fix === 'denied') fail?.({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError);
    else success({ coords: DEVICE as unknown as GeolocationCoordinates, timestamp: Date.now() } as GeolocationPosition);
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
  it('pins the drop-off: the estimate and the order carry the pinned point and its name', async () => {
    device('ok');
    render(<CourierPage />);
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
    fireEvent.change(screen.getByRole('textbox', { name: 'What’s inside? (optional)' }), { target: { value: 'Documents' } });
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
      packageDescription: 'Documents',
    });
    expect(order.dropoff.lat).toBeCloseTo(pin.latitude, 9);
    expect(order).not.toHaveProperty('notes');
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/orders/co-1'));
  });

  it('pins the pickup when the device location is refused; an unnamed spot is sent as "Dropped pin"', async () => {
    device('denied');
    reverseLabel = null;
    render(<CourierPage />);
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
    await screen.findByDisplayValue('Current location');
    const map = await pinDropoff();
    fireEvent.keyDown(map, { key: 'ArrowDown' });
    loadMap();
    await screen.findByText(`Near ${reverseLabel}`);
    fireEvent.click(button('Use this pin'));
    expect(await screen.findByText('$1,160')).toBeTruthy();
    expect(button('Add the recipient’s name').disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient name' }), { target: { value: 'Test Recipient' } });
    expect(button('Add the recipient’s phone').disabled).toBe(true);
    fireEvent.click(button('Add the recipient’s phone'));
    expect(calls('POST', '/api/v1/courier/order')).toHaveLength(0);
  });

  it('a pin outside Guyana cannot be used', async () => {
    device('ok');
    render(<CourierPage />);
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
