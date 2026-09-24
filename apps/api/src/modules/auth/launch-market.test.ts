import { describe, expect, it } from 'vitest';
import { desiredPlatformConfig } from '../ops/platform-config';
import {
  LAUNCH_MARKET_BOUNDS,
  PUBLIC_LAUNCH_COUNTRY_CODES,
  isPublicLaunchCountry,
  launchMarketAt,
  publicLaunchCountryFromPhone,
} from './launch-market';

describe('Guyana-only public launch authority', () => {
  it('publishes exactly Guyana for V1', () => {
    expect(PUBLIC_LAUNCH_COUNTRY_CODES).toEqual(['GY']);
    expect(isPublicLaunchCountry('GY')).toBe(true);
    expect(isPublicLaunchCountry('TT')).toBe(false);
    expect(isPublicLaunchCountry(undefined)).toBe(false);
  });

  it('accepts only a Guyana dial prefix for public signup', () => {
    expect(publicLaunchCountryFromPhone('+5926001234')).toBe('GY');
    expect(publicLaunchCountryFromPhone('+18685550123')).toBeNull();
    expect(publicLaunchCountryFromPhone('+447700900000')).toBeNull();
  });

  it('keeps future market records but seeds them inactive', () => {
    const countries = desiredPlatformConfig().countries;
    expect(countries.find((country) => country.code === 'GY')?.policy['isActive']).toBe(true);
    expect(countries.filter((country) => country.code !== 'GY')).not.toHaveLength(0);
    expect(countries.filter((country) => country.code !== 'GY').every((country) => country.policy['isActive'] === false)).toBe(true);
  });
});

// [Q8] A store pin is where riders and customers are sent, so it must lie in a
// market Swift serves. The box is the whole of Guyana: every town below is a
// place a real store can be, the border towns included.
describe('where a launch market is on the map', () => {
  it.each([
    ['Georgetown', 6.8013, -58.1551],
    ['Linden', 6.0081, -58.3067],
    ['New Amsterdam', 6.2487, -57.5167],
    ['Corriverton, on the Courantyne', 5.9, -57.1667],
    ['Lethem, on the Takutu', 3.3803, -59.7968],
    ['Mabaruma, in the far north-west', 8.2, -59.7833],
    ['Aishalton, in the deep south', 2.4833, -59.3167],
  ])('%s is in Guyana', (_town, latitude, longitude) => {
    expect(launchMarketAt(latitude, longitude)).toBe('GY');
  });

  it.each([
    ['null island, a 0,0 fix', 0, 0],
    ['Port of Spain', 10.6596, -61.5089],
    ['Paramaribo', 5.852, -55.2038],
    ['Caracas', 10.4806, -66.9036],
    ['New York', 40.7128, -74.006],
    ['a longitude sign dropped', 6.8013, 58.1551],
    ['a latitude sign flipped', -6.8013, -58.1551],
  ])('%s is in no launch market', (_place, latitude, longitude) => {
    expect(launchMarketAt(latitude, longitude)).toBeNull();
  });

  it('a coordinate that is not a number is in no market', () => {
    expect(launchMarketAt(Number.NaN, -58.1551)).toBeNull();
    expect(launchMarketAt(6.8013, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('every launch market has its box', () => {
    for (const code of PUBLIC_LAUNCH_COUNTRY_CODES) {
      const box = LAUNCH_MARKET_BOUNDS[code];
      expect(box.south).toBeLessThan(box.north);
      expect(box.west).toBeLessThan(box.east);
    }
  });
});
