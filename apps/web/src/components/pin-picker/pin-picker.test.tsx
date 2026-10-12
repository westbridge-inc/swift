import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';
import { STORE_MAP_START } from '@/lib/store-pin';
import { PinPicker, PIN_CITY_CENTRE, type ChosenPin } from './pin-picker';

// ---------------------------------------------------------------------------
// [WEB-PIN] The shared customer pin picker, on its own: what it hands its
// caller, and when. The checkout's whole path is in cart/pin-checkout.test.tsx.
// Places, addresses and the reverse lookup answer in the API's real shapes.
// ---------------------------------------------------------------------------

const ok = (data: unknown) => ({ body: { success: true, data } });
/** Made-up Georgetown points — no real person's address. */
const SEARCHED = { placeId: 'zone:z1', primary: 'Sample Market', secondary: 'Georgetown' };
const SEARCHED_POINT = { placeId: 'zone:z1', label: 'Sample Market', lat: 6.8065, lng: -58.1602 };
const SAVED = { id: 'a1', label: 'Work', addressLine1: '3 Example Avenue', latitude: 6.8122, longitude: -58.1489 };

let fetchMock: ReturnType<typeof mockApi>;
const calls = (pathname: string) => fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === pathname);
const loadMap = () => screen.getByRole('application').querySelectorAll('img').forEach((tile) => fireEvent.load(tile));
const last = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls.at(-1)?.[0] as ChosenPin | null | undefined;

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  fetchMock = mockApi(({ url }) => {
    if (url.pathname === '/api/v1/places/autocomplete') return ok([SEARCHED]);
    if (url.pathname === '/api/v1/places/details') return ok(SEARCHED_POINT);
    if (url.pathname === '/api/v1/places/reverse') return ok({ address: null });
    return { status: 404, body: { success: false, error: { message: `unmocked ${url.pathname}` } } };
  });
});

describe('[WEB-PIN] the pin picker', () => {
  it('hands over no pin while the map still sits on the town centre it opened on', async () => {
    const onChange = vi.fn();
    render(<PinPicker mapLabel="Test pin map" onChange={onChange} />);
    loadMap();
    expect(screen.getByText(PIN_CITY_CENTRE)).toBeTruthy();
    expect(last(onChange)).toBeNull();
    // An unnamed spot says so, rather than inventing a street.
    expect(await screen.findByText('No street name found at this pin.')).toBeTruthy();
    expect(last(onChange)).toBeNull();
  });

  it('a search result is a real starting pin, named by the result the customer chose', async () => {
    const onChange = vi.fn();
    render(<PinPicker mapLabel="Test pin map" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search for a street or place' }), { target: { value: 'Sample' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sample Market, Georgetown' }));
    await waitFor(() => expect(calls('/api/v1/places/details')).toHaveLength(1));
    // The autocomplete was biased to where the map is, through Swift's API only.
    const asked = new URL(String(calls('/api/v1/places/autocomplete')[0]![0]));
    expect(Number(asked.searchParams.get('lat'))).toBeCloseTo(STORE_MAP_START.latitude, 6);
    loadMap();
    await waitFor(() => expect(last(onChange)).toEqual({ latitude: 6.8065, longitude: -58.1602, address: 'Sample Market, Georgetown' }));
    // The chosen result already names this exact point: no second guess from the reverse lookup.
    expect(calls('/api/v1/places/reverse')).toHaveLength(0);
  });

  it('offers saved addresses as starting points', async () => {
    const onChange = vi.fn();
    render(<PinPicker mapLabel="Test pin map" saved={[SAVED]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Work — 3 Example Avenue' }));
    loadMap();
    await waitFor(() => expect(last(onChange)).toEqual({ latitude: 6.8122, longitude: -58.1489, address: '3 Example Avenue' }));
  });

  it('says why when location is refused, and the map still works by keyboard', async () => {
    const getCurrentPosition = vi.fn((_ok: PositionCallback, fail?: PositionErrorCallback | null) => fail?.({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError));
    vi.spyOn(navigator, 'geolocation', 'get').mockReturnValue({ getCurrentPosition } as unknown as Geolocation);
    const onChange = vi.fn();
    render(<PinPicker mapLabel="Test pin map" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(await screen.findByText(/allow location access and try again/)).toBeTruthy();
    const map = screen.getByRole('application', { name: 'Test pin map' });
    fireEvent.keyDown(map, { key: '+' });
    fireEvent.keyDown(map, { key: 'ArrowUp' });
    loadMap();
    await waitFor(() => expect(last(onChange)).toMatchObject({ address: null }));
    expect(last(onChange)!.latitude).toBeGreaterThan(STORE_MAP_START.latitude);
  });

  it('a map that failed to load gives no pin until it is retried and seen', async () => {
    const onChange = vi.fn();
    render(<PinPicker mapLabel="Test pin map" start={{ latitude: 6.8, longitude: -58.15 }} onChange={onChange} />);
    fireEvent.error(screen.getByRole('application').querySelector('img')!);
    expect(await screen.findByText(/The map couldn’t load/)).toBeTruthy();
    loadMap();
    expect(last(onChange)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry map' }));
    loadMap();
    await waitFor(() => expect(last(onChange)).toMatchObject({ latitude: 6.8, longitude: -58.15 }));
  });
});
