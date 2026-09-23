import { describe, expect, it } from 'vitest';
import { desiredPlatformConfig } from '../ops/platform-config';
import {
  PUBLIC_LAUNCH_COUNTRY_CODES,
  isPublicLaunchCountry,
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
