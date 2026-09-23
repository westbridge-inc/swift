import { describe, expect, it } from 'vitest';
import { verificationRefetchInterval } from './verificationPolling';

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
