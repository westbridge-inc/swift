import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBrowserContentSecurityPolicy } from '@/lib/browser-api-origin';
import { coarsen, mapLinkUrl } from '@/lib/live-tracking';
import { mapPixel } from '@/lib/store-pin';
import { TILE_SIZE, TRACKING_ZOOM, TileMap, tilesAround } from './tile-map';
import { TrackClient } from '@/app/track/[token]/track-client';
import { TripShareClient } from '@/app/trip/[token]/trip-share-client';

// ---------------------------------------------------------------------------
// [W7] The shared tracking links (a parcel, a ride) promised a map and drew
// none: the map was an embedded OpenStreetMap page, a frame, and the site's
// content-security policy has no frame source, so `default-src 'self'` blocks
// it. The map is now drawn from map tiles, which are images (`img-src https:`).
// What may leave for the tile host is unchanged or less: a ~1 km square, no
// point, and never the page's address (W-47, M053).
//
// [Tile policy] OpenStreetMap's tile usage policy requires browsers to send a
// Referer and may block referer-stripped traffic without notice. So tiles
// send the site's ORIGIN only (strict-origin-when-cross-origin) — never the
// path, where the trip and parcel pages carry their token. Links still go
// with no referrer at all.
// ---------------------------------------------------------------------------

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const PRECISE = { lat: 6.801347, lng: -58.155198 };

describe('[W7] the production security policy', () => {
  const directives = Object.fromEntries(buildBrowserContentSecurityPolicy('production').split(';').map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name!, values];
  }));

  it('blocks frames from other sites (which is why the embed never drew) and allows https images (which tiles are)', () => {
    expect(directives['frame-src']).toBeUndefined();
    expect(directives['child-src']).toBeUndefined();
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['img-src']).toContain('https:');
  });
});

describe('[W7] the tile map', () => {
  it('covers the card around the point, with the point at the centre', () => {
    const point = coarsen(PRECISE);
    const tiles = tilesAround(point, TRACKING_ZOOM);
    const pixel = mapPixel({ latitude: point.lat, longitude: point.lng }, TRACKING_ZOOM);
    const own = tiles.find((tile) => tile.left <= 0 && tile.left > -TILE_SIZE && tile.top <= 0 && tile.top > -TILE_SIZE)!;
    expect(own.src).toBe(`https://tile.openstreetmap.org/15/${Math.floor(pixel.x / TILE_SIZE)}/${Math.floor(pixel.y / TILE_SIZE)}.png`);
    expect(Math.min(...tiles.map((tile) => tile.left))).toBeLessThanOrEqual(-512);
    expect(Math.max(...tiles.map((tile) => tile.left + TILE_SIZE))).toBeGreaterThanOrEqual(512);
    expect(Math.min(...tiles.map((tile) => tile.top))).toBeLessThanOrEqual(-128);
    expect(Math.max(...tiles.map((tile) => tile.top + TILE_SIZE))).toBeGreaterThanOrEqual(128);
  });

  it('tiles tell the tile host the site but never the page, links go with no referrer, and a failed tile says so and keeps the link', () => {
    const { container } = render(<TileMap point={coarsen(PRECISE)} label="Courier location, approximate" linkHref={mapLinkUrl(PRECISE)} linkLabel="Open approximate map ↗" />);
    const map = screen.getByRole('img', { name: 'Courier location, approximate' });
    const tiles = map.querySelectorAll('img');
    expect(tiles.length).toBeGreaterThan(4);
    for (const tile of Array.from(tiles)) {
      expect(tile.getAttribute('src')).toMatch(/^https:\/\/tile\.openstreetmap\.org\//);
      expect(tile.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    }
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.length).toBe(2);
    for (const link of links) expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    // [Row 108] A tile gets one retry; the map says it could not load only when the retry fails too.
    const src = tiles[0]!.getAttribute('src');
    fireEvent.error(tiles[0]!);
    const retried = Array.from(map.querySelectorAll('img')).find((tile) => tile.getAttribute('src') === src)!;
    fireEvent.error(retried);
    expect(within(map).getByText(/The map couldn’t load/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open approximate map ↗' }).getAttribute('href')).toBe(mapLinkUrl(PRECISE));
  });

  it('[row 108] one failed tile is fetched again once, and the map stays up while it is retried', () => {
    render(<TileMap point={coarsen(PRECISE)} label="Courier location, approximate" linkHref={mapLinkUrl(PRECISE)} linkLabel="Open approximate map ↗" />);
    const map = screen.getByRole('img', { name: 'Courier location, approximate' });
    const before = Array.from(map.querySelectorAll('img'));
    const failing = before[0]!;
    const src = failing.getAttribute('src');
    fireEvent.error(failing);
    expect(within(map).queryByText(/The map couldn’t load/)).toBeNull();
    const after = Array.from(map.querySelectorAll('img'));
    expect(after).toHaveLength(before.length);
    const again = after.find((tile) => tile.getAttribute('src') === src)!;
    expect(again).not.toBe(failing); // a fresh element: the browser requests the tile again
    expect(after.filter((tile) => tile !== again).every((tile) => before.includes(tile))).toBe(true); // the others are untouched
  });
});

describe('[W7] both shared pages draw it', () => {
  it('a parcel link shows the courier on the tile map — no frame', async () => {
    const view = {
      orderNumber: 'SW-1001', status: 'PICKED_UP', courierRecipientName: null, estimatedDeliveryTime: 12,
      rider: { currentLat: PRECISE.lat, currentLng: PRECISE.lng, lastLocationUpdate: new Date().toISOString(), user: { firstName: 'Ravi' } },
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ success: true, data: view }) })));
    const { container } = render(<TrackClient token="synthetic-parcel" />);
    const map = await screen.findByRole('img', { name: 'Courier location, approximate' });
    expect(map.querySelectorAll('img[src^="https://tile.openstreetmap.org/15/"]').length).toBeGreaterThan(4);
    // The page itself is served with Referrer-Policy: no-referrer; each tile overrides it to the origin only.
    for (const tile of Array.from(map.querySelectorAll('img'))) expect(tile.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('a trip link shows the car on the tile map — no frame', async () => {
    const view = {
      status: 'Trip in progress', ended: false, passengerFirstName: 'Asha',
      driver: { firstName: 'Deo', photoUrl: null, vehiclePhotoUrl: null, vehicle: 'Silver Toyota Allion', plate: 'PAB 1234' },
      location: { lat: PRECISE.lat, lng: PRECISE.lng, at: new Date().toISOString() }, emergencyNote: 'note',
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ success: true, data: view }) })));
    const { container } = render(<TripShareClient token="synthetic-trip" />);
    const map = await screen.findByRole('img', { name: 'Trip location, approximate' });
    expect(map.querySelectorAll('img[src^="https://tile.openstreetmap.org/15/"]').length).toBeGreaterThan(4);
    for (const tile of Array.from(map.querySelectorAll('img'))) expect(tile.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(container.querySelector('iframe')).toBeNull();
  });
});
