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
// point, no referrer (W-47, M053).
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

  it('every tile and link goes with no referrer, and a failed tile says so and keeps the link', () => {
    const { container } = render(<TileMap point={coarsen(PRECISE)} label="Courier location, approximate" linkHref={mapLinkUrl(PRECISE)} linkLabel="Open approximate map ↗" />);
    const map = screen.getByRole('img', { name: 'Courier location, approximate' });
    const tiles = map.querySelectorAll('img');
    expect(tiles.length).toBeGreaterThan(4);
    for (const element of Array.from(container.querySelectorAll('img, a'))) expect(element.getAttribute('referrerpolicy')).toBe('no-referrer');
    fireEvent.error(tiles[0]!);
    expect(within(map).getByText(/The map couldn’t load/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open approximate map ↗' }).getAttribute('href')).toBe(mapLinkUrl(PRECISE));
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
    expect(container.querySelector('iframe')).toBeNull();
  });
});
