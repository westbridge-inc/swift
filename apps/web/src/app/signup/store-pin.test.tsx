import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';

const fx = vi.hoisted(() => ({
  send: vi.fn(), verify: vi.fn(), register: vi.fn(), become: vi.fn(),
  replace: vi.fn(), coords: vi.fn(), search: vi.fn(), details: vi.fn(), api: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: fx.send, apiFetch: fx.api }));
vi.mock('@/lib/customer', () => ({
  verifyOtp: fx.verify, registerAccount: fx.register, becomePartner: fx.become,
  placesAutocomplete: fx.search, placeDetails: fx.details,
}));
vi.mock('@/lib/geolocate', () => ({ currentCoords: fx.coords }));

const DOOR = { placeId: 'door', primary: '12 Regent Street', secondary: 'Georgetown', lat: 6.812, lng: -58.163 };
const DEVICE = { lat: 6.79, lng: -58.12 };
const OUTSIDE = 'That pin is outside Guyana, where Swift works today. Move it to the entrance of your store.';
const disabled = (name: string) => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;
const loadMap = () => screen.getByRole('application').querySelectorAll('img').forEach((tile) => fireEvent.load(tile));

beforeEach(() => {
  vi.resetAllMocks();
  fx.send.mockResolvedValue(undefined);
  fx.verify.mockResolvedValue({ signedIn: false, isNewUser: true });
  fx.register.mockResolvedValue({});
  fx.become.mockResolvedValue({});
  fx.coords.mockResolvedValue(DEVICE);
  fx.search.mockResolvedValue([DOOR]);
  fx.api.mockResolvedValue({ data: { address: 'Store entrance, Georgetown' } });
});

async function business() {
  const user = userEvent.setup();
  render(<SignupPage />);
  await user.click(screen.getByRole('button', { name: /Put my business on Swift/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001003' } });
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Merchant' } });
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  fireEvent.change(await screen.findByLabelText('Business name'), { target: { value: 'Test shop' } });
  for (const [label, value] of [['Street address', '12 Regent Street'], ['City or town', 'Georgetown'], ['Region', 'Demerara-Mahaica']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  // The partner agreement (its own cases live in partner-agreement.test.tsx).
  fireEvent.click(screen.getByRole('checkbox', { name: /I agree to the Vendor Partner Agreement/ }));
  return user;
}

async function picker(user: Awaited<ReturnType<typeof business>>) {
  await user.click(screen.getByRole('button', { name: 'Place your store on the map' }));
  await screen.findByRole('button', { name: /12 Regent Street.*Georgetown/ });
  loadMap();
}

async function chooseDoor(user: Awaited<ReturnType<typeof business>>) {
  await user.click(screen.getByRole('button', { name: /12 Regent Street.*Georgetown/ }));
  loadMap();
}

describe('Q8 website store pin', () => {
  it('cannot create a business until the owner explicitly confirms a pin', async () => {
    const user = await business();
    expect(disabled('Create business')).toBe(true);
    await picker(user);
    expect(fx.coords).not.toHaveBeenCalled();
    expect(disabled('Confirm store location')).toBe(true);
    await chooseDoor(user);
    expect(disabled('Create business')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    expect(disabled('Create business')).toBe(false);
  });

  it('submits the confirmed pin, not the device location', async () => {
    const user = await business();
    await picker(user);
    await user.click(screen.getByRole('button', { name: 'Use my location as a starting point' }));
    await waitFor(() => expect(fx.coords).toHaveBeenCalledTimes(1));
    await chooseDoor(user);
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become).toHaveBeenCalledExactlyOnceWith({
      role: 'VENDOR', acceptAgreement: true, business: {
        name: 'Test shop', vendorType: 'RESTAURANT', phone: '+5926001003',
        addressLine1: '12 Regent Street', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: DOOR.lat, longitude: DOOR.lng,
      },
    });
    expect(fx.coords).toHaveBeenCalledTimes(1);
    expect(fx.replace).toHaveBeenCalledWith('/dashboard');
  });

  it('geolocation denied still allows keyboard placement and confirmation', async () => {
    fx.coords.mockRejectedValue(new Error('Permission denied'));
    const user = await business();
    await picker(user);
    await user.click(screen.getByRole('button', { name: 'Use my location as a starting point' }));
    await screen.findByText(/Location access is unavailable/);
    const map = screen.getByRole('application', { name: 'Store location map' });
    map.focus();
    await user.keyboard('{ArrowRight}{ArrowUp}');
    loadMap();
    expect(disabled('Confirm store location')).toBe(false);
    expect(screen.getByLabelText('Chosen store location').textContent).toMatch(/Latitude.*Longitude/);
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become).toHaveBeenCalledTimes(1);
    const pin = fx.become.mock.calls[0]![0].business;
    expect(pin.latitude).toBeGreaterThan(6.8013);
    expect(pin.longitude).toBeGreaterThan(-58.1551);
  });

  it('refuses an out-of-market pin and lets the owner move it back', async () => {
    fx.search.mockResolvedValue([{ ...DOOR, lat: 10, lng: -58 }]);
    const user = await business();
    await picker(user);
    await chooseDoor(user);
    expect(screen.getByRole('alert').textContent).toBe(OUTSIDE);
    expect(disabled('Confirm store location')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    expect(disabled('Create business')).toBe(true);
    expect(fx.become).not.toHaveBeenCalled();
    fx.search.mockResolvedValue([DOOR]);
    await user.click(screen.getByRole('button', { name: 'Find address' }));
    await chooseDoor(user);
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    expect(disabled('Create business')).toBe(false);
  });

  it('ignores an overseas device fix and still lets the owner search', async () => {
    fx.coords.mockResolvedValue({ lat: 51.5, lng: -0.12 });
    const user = await business();
    await picker(user);
    await user.click(screen.getByRole('button', { name: 'Use my location as a starting point' }));
    await screen.findByText(/Your location is outside Guyana/);
    expect(disabled('Confirm store location')).toBe(true);
    await chooseDoor(user);
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    expect(disabled('Create business')).toBe(false);
  });

  it('invalidates confirmation when the business address changes', async () => {
    const user = await business();
    await picker(user);
    await chooseDoor(user);
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '99 Other Street' } });
    expect(disabled('Create business')).toBe(true);
    expect(screen.getByRole('button', { name: 'Place your store on the map' })).toBeTruthy();
  });

  it('surfaces the API refusal and keeps the pin editable', async () => {
    fx.become.mockRejectedValue(new Error(OUTSIDE));
    const user = await business();
    await picker(user);
    await chooseDoor(user);
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect((await screen.findByRole('alert')).textContent).toBe(OUTSIDE);
    await user.click(screen.getByRole('button', { name: 'Move the store pin' }));
    expect(screen.getByRole('application', { name: 'Store location map' })).toBeTruthy();
    expect(fx.replace).not.toHaveBeenCalled();
  });

  it('does not let a late device fix overwrite a pin the owner has moved', async () => {
    let resolve!: (_value: typeof DEVICE) => void;
    fx.coords.mockReturnValue(new Promise((r) => { resolve = r; }));
    const user = await business();
    await picker(user);
    await user.click(screen.getByRole('button', { name: 'Use my location as a starting point' }));
    await chooseDoor(user);
    await act(async () => resolve(DEVICE));
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become.mock.calls[0]![0].business).toMatchObject({ latitude: DOOR.lat, longitude: DOOR.lng });
  });

  it('search failure still permits deliberate map placement, never the untouched market centre', async () => {
    fx.search.mockRejectedValue(new Error('Offline'));
    const user = await business();
    await user.click(screen.getByRole('button', { name: 'Place your store on the map' }));
    await screen.findByText(/Address search is unavailable/);
    expect(disabled('Confirm store location')).toBe(true);
    fireEvent.keyDown(screen.getByRole('application'), { key: 'ArrowLeft' });
    loadMap();
    expect(disabled('Confirm store location')).toBe(false);
  });

  it('dragging the map moves the chosen coordinates under the entrance pin', async () => {
    const user = await business();
    await picker(user);
    await chooseDoor(user);
    const map = screen.getByRole('application');
    fireEvent.pointerDown(map, { pointerId: 1, clientX: 150, clientY: 150, button: 0 });
    fireEvent.pointerMove(map, { pointerId: 1, clientX: 190, clientY: 180 });
    fireEvent.pointerUp(map, { pointerId: 1, clientX: 190, clientY: 180 });
    loadMap();
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    const pin = fx.become.mock.calls[0]![0].business;
    expect(pin.latitude).toBeGreaterThan(DOOR.lat);
    expect(pin.longitude).toBeLessThan(DOOR.lng);
  });

  it('waits for map tiles and refuses a blank failed map until retry has loaded', async () => {
    const user = await business();
    await picker(user);
    await user.click(screen.getByRole('button', { name: /12 Regent Street.*Georgetown/ }));
    expect(disabled('Confirm store location')).toBe(true);
    const tile = screen.getByRole('application').querySelector('img')!;
    fireEvent.error(tile);
    expect(screen.getByRole('alert').textContent).toContain('The map couldn’t load');
    expect(disabled('Confirm store location')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Retry map' }));
    expect(disabled('Confirm store location')).toBe(true);
    loadMap();
    expect(disabled('Confirm store location')).toBe(false);
  });

  it('closing the picker without confirming does not save the draft', async () => {
    const user = await business();
    await picker(user);
    await chooseDoor(user);
    await user.click(screen.getByRole('button', { name: 'Close without placing the pin' }));
    expect(disabled('Create business')).toBe(true);
    expect(fx.become).not.toHaveBeenCalled();
  });

  it('zoom changes the map scale without changing the confirmed coordinates', async () => {
    const user = await business();
    await picker(user);
    await chooseDoor(user);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('application').querySelector('img')?.src).toContain('/18/');
    loadMap();
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become.mock.calls[0]![0].business).toMatchObject({ latitude: DOOR.lat, longitude: DOOR.lng });
  });

  it('resolves a coordinate-free search result and ignores it if the owner moves first', async () => {
    fx.search.mockResolvedValue([{ placeId: 'door', primary: DOOR.primary, secondary: DOOR.secondary }]);
    let resolve!: (_value: typeof DEVICE) => void;
    fx.details.mockReturnValue(new Promise((r) => { resolve = r; }));
    const user = await business();
    await picker(user);
    await chooseDoor(user);
    expect(fx.details).toHaveBeenCalledWith('door');
    fireEvent.keyDown(screen.getByRole('application'), { key: 'ArrowRight' });
    loadMap();
    await act(async () => resolve(DEVICE));
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    const pin = fx.become.mock.calls[0]![0].business;
    expect(pin.latitude).toBeCloseTo(6.8013, 6);
    expect(pin.longitude).toBeGreaterThan(-58.1551);
  });

  it('keeps a selected address label if reverse lookup is unavailable and restores keyboard focus', async () => {
    fx.api.mockRejectedValue(new Error('Reverse lookup unavailable'));
    const user = await business();
    await picker(user);
    expect((screen.getByLabelText('Street address') as HTMLInputElement).disabled).toBe(true);
    await chooseDoor(user);
    expect(document.activeElement).toBe(screen.getByRole('application'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    const readout = screen.getByRole('group', { name: 'Chosen store location' });
    expect(readout.getAttribute('aria-live')).toBeNull();
    expect(readout.textContent).toContain('12 Regent Street, Georgetown');
    expect(readout.textContent).not.toContain('No street name found');
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move the store pin' }));
    expect(screen.getByRole('status').textContent).toContain('Store location confirmed: 12 Regent Street, Georgetown.');
    expect(screen.getByRole('status').textContent).not.toContain('Latitude');
    await user.click(screen.getByRole('button', { name: 'Move the store pin' }));
    await user.click(screen.getByRole('button', { name: 'Close without placing the pin' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move the store pin' }));
  });

  it('announces the settled pin rather than each keyboard nudge', async () => {
    const user = await business();
    await picker(user);
    await chooseDoor(user);
    const announcement = screen.getByRole('status');
    const previous = announcement.textContent;
    await user.keyboard('{ArrowUp}{ArrowRight}{ArrowUp}');
    expect(announcement.textContent).toBe(previous);
    await waitFor(() => expect(announcement.textContent).toContain('Store entrance, Georgetown'));
    expect(announcement.textContent).toContain('Latitude');
  });

  it('keeps a newer search busy when an older response arrives first', async () => {
    let first!: (_value: typeof DOOR[]) => void;
    let second!: (_value: typeof DOOR[]) => void;
    fx.search.mockReturnValueOnce(new Promise((r) => { first = r; })).mockReturnValueOnce(new Promise((r) => { second = r; }));
    const user = await business();
    await user.click(screen.getByRole('button', { name: 'Place your store on the map' }));
    fireEvent.change(screen.getByLabelText('Search for your store’s address'), { target: { value: 'New address' } });
    fireEvent.keyDown(screen.getByLabelText('Search for your store’s address'), { key: 'Enter' });
    expect(fx.search).toHaveBeenCalledTimes(2);
    await act(async () => first([]));
    expect(disabled('Finding the address…')).toBe(true);
    await act(async () => second([DOOR]));
    expect(disabled('Find address')).toBe(false);
    expect(screen.getByRole('button', { name: /12 Regent Street.*Georgetown/ })).toBeTruthy();
  });

  it('recovers the search button after Enter on a short query cancels a pending search', async () => {
    let resolve!: (_value: typeof DOOR[]) => void;
    fx.search.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const user = await business();
    await user.click(screen.getByRole('button', { name: 'Place your store on the map' }));
    const input = screen.getByLabelText('Search for your store’s address');
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => resolve([DOOR]));
    fireEvent.change(input, { target: { value: 'New address' } });
    expect(disabled('Find address')).toBe(false);
    expect(screen.queryByRole('button', { name: /12 Regent Street.*Georgetown/ })).toBeNull();
  });
});
