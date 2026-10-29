import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORE_MAP_START, mapPixel, pixelPoint } from '@/lib/store-pin';
import { adoptSession } from '@/lib/auth';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import LocationPage from './page';

// ---------------------------------------------------------------------------
// [PINS · row 107] "Change delivery address" opens this page. A new address is
// the pin the person places on Swift's map (the shared form the account's Saved
// addresses uses), never a device fix taken wherever they happen to be standing
// (W-08). The page keeps its own rule: a new address is the default only when
// the list really loaded and was empty.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => '/order/location' }));

/** What Swift's reverse lookup calls any pin in these tests (a made-up street). */
const PIN_NAME = 'Lot 7 Example Street, Georgetown';
const home = { id: 'home', label: 'Home', addressLine1: 'Test Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1, isDefault: true };
let addresses: Array<Record<string, unknown>>;
let listFails: boolean;
let calls: ApiRequest[];

const ok = (data: unknown) => ({ body: { success: true, data } });
const saveButton = () => screen.getByRole('button', { name: 'Save address' }) as HTMLButtonElement;
/** happy-dom never loads images: tell the address map each visible tile has arrived. */
const loadMap = () => screen.getByRole('application', { name: 'Address pin map' }).querySelectorAll('img').forEach((tile) => fireEvent.load(tile));
function nudgedRight(from: { latitude: number; longitude: number }, zoom: number) {
  const start = mapPixel(from, zoom);
  return pixelPoint(start.x + 12, start.y, zoom);
}

function api() {
  return mockApi((request) => {
    calls.push(request);
    const { url, method, init } = request;
    if (url.pathname === '/api/v1/customer/addresses' && method === 'GET') {
      return listFails ? { status: 503, body: { error: { message: 'Please try again.' } } } : ok(addresses);
    }
    if (url.pathname === '/api/v1/customer/addresses' && method === 'POST') {
      const row = { ...JSON.parse(String(init?.body)), id: 'new-address' };
      addresses = [...addresses, row];
      return ok(row);
    }
    if (url.pathname === '/api/v1/places/reverse') return ok({ address: PIN_NAME });
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  });
}

/** Add an address by placing the pin: one nudge away from the map's start. */
async function addByPin(user: ReturnType<typeof renderWithQuery>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Add an address' }));
  const map = await screen.findByRole('application', { name: 'Address pin map' });
  loadMap();
  // The map's opening point is never a pin by itself.
  expect(screen.getByText('This is a city-centre starting point — move the map to your spot first.')).toBeTruthy();
  expect(saveButton().disabled).toBe(true);
  fireEvent.keyDown(map, { key: 'ArrowRight' });
  loadMap();
  await screen.findByDisplayValue(PIN_NAME);
  await waitFor(() => expect(saveButton().disabled).toBe(false));
  await user.click(saveButton());
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  return JSON.parse(String(calls.find((c) => c.method === 'POST')!.init?.body));
}

beforeEach(() => {
  adoptSession('test-customer');
  addresses = [{ ...home }]; listFails = false; calls = [];
});

describe('[PINS] the Delivery addresses page adds an address on the map', () => {
  it('the saved point is the pin the person placed, and no device fix is offered', async () => {
    api(); const { user } = renderWithQuery(<LocationPage />);
    await screen.findByText('Test Street, Georgetown');
    await user.click(screen.getByRole('button', { name: 'Add an address' }));
    // The old way to set a pin without seeing it is gone.
    expect(screen.queryByRole('button', { name: /I am at this address/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    const body = await addByPin(user);
    const pin = nudgedRight(STORE_MAP_START, 14);
    expect(body).toMatchObject({ label: 'Home', addressLine1: PIN_NAME, city: 'Georgetown' });
    expect(body.latitude).toBeCloseTo(pin.latitude, 9);
    expect(body.longitude).toBeCloseTo(pin.longitude, 9);
    // The page closes the form and shows the new row from the server.
    await waitFor(() => expect(screen.queryByRole('application', { name: 'Address pin map' })).toBeNull());
    expect(await screen.findByText(`${PIN_NAME}, Georgetown`)).toBeTruthy();
  });

  it('a new address is not made the default when the person already has one (and no checkbox overrides that)', async () => {
    api(); const { user } = renderWithQuery(<LocationPage />);
    await screen.findByText('Test Street, Georgetown');
    await user.click(screen.getByRole('button', { name: 'Add an address' }));
    expect(screen.queryByRole('checkbox', { name: 'Make this my default address' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((await addByPin(user)).isDefault).toBe(false);
  });

  it('the first address, on a list that loaded empty, is the default', async () => {
    addresses = [];
    api(); const { user } = renderWithQuery(<LocationPage />);
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.url.pathname === '/api/v1/customer/addresses')).toBe(true));
    expect((await addByPin(user)).isDefault).toBe(true);
  });

  it('a list that failed to load is not "no addresses": the new address is not made the default', async () => {
    addresses = []; listFails = true;
    api(); const { user } = renderWithQuery(<LocationPage />);
    expect(await screen.findByText(/your saved addresses/)).toBeTruthy();
    listFails = false;
    expect((await addByPin(user)).isDefault).toBe(false);
  });
});
