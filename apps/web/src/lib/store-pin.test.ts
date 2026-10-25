import { describe, expect, it, vi } from 'vitest';
import { mapPixel, pixelPoint, storePinInMarket } from './store-pin';

vi.mock('./auth', () => ({ apiFetch: vi.fn() }));

describe('store pin launch bounds and map projection', () => {
  it.each([[1, -62], [9, -56], [6.8013, -58.1551]])('accepts the API launch box including its edges: %s, %s', (latitude, longitude) => {
    expect(storePinInMarket({ latitude, longitude })).toBe(true);
  });

  it.each([[0.999, -58], [9.001, -58], [6, -62.001], [6, -55.999], [NaN, -58], [6, Infinity], [0, 0]])('refuses an out-of-market or invalid point: %s, %s', (latitude, longitude) => {
    expect(storePinInMarket({ latitude, longitude })).toBe(false);
  });

  it.each([6, 14, 17, 19])('keeps the entrance at the same coordinate through the tile projection at zoom %s', (zoom) => {
    const point = { latitude: 6.812, longitude: -58.163 };
    const pixel = mapPixel(point, zoom);
    const roundtrip = pixelPoint(pixel.x, pixel.y, zoom);
    expect(roundtrip.latitude).toBeCloseTo(point.latitude, 10);
    expect(roundtrip.longitude).toBeCloseTo(point.longitude, 10);
    const northEast = pixelPoint(pixel.x + 12, pixel.y - 12, zoom);
    expect(northEast.latitude).toBeGreaterThan(point.latitude);
    expect(northEast.longitude).toBeGreaterThan(point.longitude);
  });
});
