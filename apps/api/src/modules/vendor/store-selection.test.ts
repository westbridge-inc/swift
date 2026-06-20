import { describe, it, expect } from 'vitest';
import { pickVendorId } from './vendor.routes';

// The multi-store switch must never let an owner scope to a store they don't
// own (IDOR). pickVendorId is the single decision point — proven pure here.
describe('multi-store store selection (IDOR-safe)', () => {
  const owned = ['store-a', 'store-b', 'store-c'];

  it('honours a requested store the owner owns', () => {
    expect(pickVendorId(owned, 'store-b')).toBe('store-b');
  });

  it('falls back to the default for a store the owner does NOT own (IDOR)', () => {
    expect(pickVendorId(owned, 'someone-elses-store')).toBe('store-a');
  });

  it('falls back to the default when no store is requested', () => {
    expect(pickVendorId(owned, undefined)).toBe('store-a');
  });
});
