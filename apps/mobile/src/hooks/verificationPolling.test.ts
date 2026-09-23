import { describe, expect, it } from 'vitest';
import { serviceProviderProfileRefetchInterval, verificationRefetchInterval } from './verificationPolling';

describe('verification status polling', () => {
  it('stops when a category is unavailable, rather than polling for approval that cannot happen', () => {
    expect(verificationRefetchInterval({ roleVerified: false, categoryUnavailable: true })).toBe(false);
  });

  it('polls incomplete checklists and stops when verified', () => {
    expect(verificationRefetchInterval(undefined)).toBe(15_000);
    expect(verificationRefetchInterval({ roleVerified: false })).toBe(15_000);
    expect(verificationRefetchInterval({ roleVerified: true })).toBe(false);
  });
});

describe('service provider profile polling', () => {
  it('stops for a held category even while its profile remains unverified', () => {
    expect(serviceProviderProfileRefetchInterval({ isVerified: false, categoryUnavailable: true })).toBe(false);
    expect(serviceProviderProfileRefetchInterval({ isVerified: true, categoryUnavailable: true })).toBe(false);
  });

  it('polls an eligible pending profile and stops for missing or verified profiles', () => {
    expect(serviceProviderProfileRefetchInterval({ isVerified: false, categoryUnavailable: false })).toBe(15_000);
    expect(serviceProviderProfileRefetchInterval({ isVerified: true, categoryUnavailable: false })).toBe(false);
    expect(serviceProviderProfileRefetchInterval(null)).toBe(false);
    expect(serviceProviderProfileRefetchInterval(undefined)).toBe(false);
  });
});
