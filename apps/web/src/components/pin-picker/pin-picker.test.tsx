import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';
import { STORE_MAP_START } from '@/lib/store-pin';
import { PinPicker, PIN_CITY_CENTRE, type ChosenPin } from './pin-picker';
import { MAP_TILES_UNAVAILABLE } from '@/lib/map-tiles';
import { TEST_MAPTILER_KEY } from '@/test/map-tiles-fixture';

// ---------------------------------------------------------------------------
// [WEB-PIN] The shared customer pin picker, on its own: what it hands its
// caller, and when. The pages' whole paths are in their own tests (the
// checkout's pin-checkout.test.tsx, the courier page's page.test.tsx).
// Places, addresses and the reverse lookup answer in the API's real shapes.
// ---------------------------------------------------------------------------

const ok = (data: unknown) => ({ body: { success: true, data } });
/** Made-up Georgetown points — no real person's address. */
const SEARCHED = { placeId: 'osm:6.8065,-58.1602:U2FtcGxl', primary: 'Sample Market', secondary: 'Georgetown' };
const SEARCHED_POINT = { placeId: 'osm:6.8065,-58.1602:U2FtcGxl', label: 'Sample Market', lat: 6.8065, lng: -58.1602 };
/** A delivery zone: the local places provider answers with the zone polygon's centre. */
const ZONE = { placeId: 'zone:z1', primary: 'Sample Ward', secondary: 'Delivery area' };
const ZONE_POINT = { placeId: 'zone:z1', label: 'Sample Ward', lat: 6.8201, lng: -58.1433 };
const SAVED = { id: 'a1', label: 'Work', addressLine1: '3 Example Avenue', latitude: 6.8122, longitude: -58.1489 };

let fetchMock: ReturnType<typeof mockApi>;
const calls = (pathname: string) => fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === pathname);
const loadMap = () => screen.getByRole('application').querySelectorAll('img').forEach((tile) => fireEvent.load(tile));
const last = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls.at(-1)?.[0] as ChosenPin | null | undefined;

afterEach(() => { vi.unstubAllEnvs(); });

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
    await waitFor(() => expect(last(onChange)).toEqual({ latitude: 6.8065, longitude: -58.1602, address: 'Sample Market, Georgetown', named: true }));
    // The chosen result already names this exact point: no second guess from the reverse lookup.
    expect(calls('/api/v1/places/reverse')).toHaveLength(0);
  });

  it('typing a new search outdates a place still being looked up: the map does not jump to it', async () => {
    let release: () => void = () => undefined;
    fetchMock = mockApi(({ url }) => {
      if (url.pathname === '/api/v1/places/autocomplete') return ok([SEARCHED]);
      if (url.pathname === '/api/v1/places/details') return new Promise((resolve) => { release = () => resolve(ok(SEARCHED_POINT)); });
      if (url.pathname === '/api/v1/places/reverse') return ok({ address: null });
      return { status: 404, body: { success: false, error: { message: `unmocked ${url.pathname}` } } };
    });
    const onChange = vi.fn();
    render(<PinPicker mapLabel="Test pin map" onChange={onChange} />);
    const search = screen.getByRole('textbox', { name: 'Search for a street or place' });
    fireEvent.change(search, { target: { value: 'Sample' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sample Market, Georgetown' }));
    await waitFor(() => expect(calls('/api/v1/places/details')).toHaveLength(1));
    // The customer moves on before the lookup answers.
    fireEvent.change(search, { target: { value: 'Another place' } });
    await act(async () => { release(); await new Promise((settle) => setTimeout(settle, 30)); });
    loadMap();
    expect(screen.getByText('Latitude 6.80130, Longitude -58.15510')).toBeTruthy();
    expect(last(onChange)).toBeNull();
  });

  // [WEB-PIN · review S3] A zone is an area, not a door: its "point" is the
  // polygon's centre. Like the town centre and a rough device fix, it starts
  // the map but is never a pin until the customer moves it there themselves.
  it('a delivery-zone result only moves the map: the customer must place the pin', async () => {
    fetchMock = mockApi(({ url }) => {
      if (url.pathname === '/api/v1/places/autocomplete') return ok([ZONE]);
      if (url.pathname === '/api/v1/places/details') return ok(ZONE_POINT);
      if (url.pathname === '/api/v1/places/reverse') return ok({ address: null });
      return { status: 404, body: { success: false, error: { message: `unmocked ${url.pathname}` } } };
    });
    const onChange = vi.fn();
    render(<PinPicker mapLabel="Test pin map" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search for a street or place' }), { target: { value: 'Sample' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sample Ward, Delivery area' }));
    await waitFor(() => expect(screen.getByText('Latitude 6.82010, Longitude -58.14330')).toBeTruthy());
    loadMap();
    expect(screen.getByText('Sample Ward is an area, not a door. Move the map so the pin is on your spot.')).toBeTruthy();
    expect(last(onChange)).toBeNull();
    fireEvent.keyDown(screen.getByRole('application', { name: 'Test pin map' }), { key: 'ArrowLeft' });
    loadMap();
    await waitFor(() => expect(last(onChange)).toMatchObject({ named: true }));
    expect(last(onChange)!.longitude).toBeLessThan(ZONE_POINT.lng);
  });

  it('offers saved addresses as starting points', async () => {
    const onChange = vi.fn();
    render(<PinPicker mapLabel="Test pin map" saved={[SAVED]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Work — 3 Example Avenue' }));
    loadMap();
    await waitFor(() => expect(last(onChange)).toEqual({ latitude: 6.8122, longitude: -58.1489, address: '3 Example Avenue', named: true }));
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

  it('a real starting pin is handed over only once its map has been seen', async () => {
    const onChange = vi.fn();
    render(<PinPicker mapLabel="Test pin map" start={{ latitude: 6.8, longitude: -58.15 }} onChange={onChange} />);
    expect(screen.getByText('Loading map…')).toBeTruthy();
    expect(last(onChange)).toBeNull();
    loadMap();
    // Handed over at once (the coordinates are certain), and marked named once Swift's lookup answers.
    expect(last(onChange)).toMatchObject({ latitude: 6.8, longitude: -58.15, named: false });
    await waitFor(() => expect(last(onChange)).toMatchObject({ latitude: 6.8, longitude: -58.15, address: null, named: true }));
  });

  it('map tiles come from MapTiler, credited to MapTiler and OpenStreetMap, and tell MapTiler the site, never the page', () => {
    render(<PinPicker mapLabel="Test pin map" onChange={vi.fn()} />);
    const tiles = [...screen.getByRole('application').querySelectorAll('img')];
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.getAttribute('src')).toMatch(new RegExp(`^https://api\\.maptiler\\.com/maps/streets-v2/256/\\d+/\\d+/\\d+\\.png\\?key=${TEST_MAPTILER_KEY}$`));
      // The key is restricted to the site's origins: the Referer carries the origin, never the page's path.
      expect(tile.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    }
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '© MapTiler © OpenStreetMap contributors')).toBeTruthy();
  });

  it('a built site without the MapTiler key draws no tiles, says so, and never hands over a pin', async () => {
    vi.stubEnv('NEXT_PUBLIC_MAPTILER_KEY', '');
    const onChange = vi.fn();
    render(<PinPicker mapLabel="Test pin map" start={{ latitude: 6.8, longitude: -58.15 }} onChange={onChange} />);
    expect(screen.getByRole('application').querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText(new RegExp(MAP_TILES_UNAVAILABLE))).toBeTruthy();
    expect(screen.queryByText('Loading map…')).toBeNull();
    expect(screen.queryByText(/OpenStreetMap contributors/)).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(onChange.mock.calls.every(([pin]) => pin === null)).toBe(true);
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
