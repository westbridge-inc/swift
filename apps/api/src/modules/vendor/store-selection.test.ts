import { describe, it, expect } from 'vitest';
import { ordersScope, pickVendorId } from './vendor.routes';

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

// The order board must match the store the operator selected (the dashboard
// header, menu and insights all scope to it); the franchise roll-up across
// every owned store only applies when nothing is selected.
describe('order-board scope (store switcher coherence)', () => {
  const owned = ['store-a', 'store-b', 'store-c'];
  const accessFor = (requested?: string) => ({ vendorId: pickVendorId(owned, requested), vendorIds: owned });

  it('scopes to the selected store when one is requested', () => {
    expect(ordersScope(accessFor('store-b'), 'store-b')).toBe('store-b');
  });

  it('never scopes to an unowned store — falls back to the default store (IDOR)', () => {
    expect(ordersScope(accessFor('someone-elses-store'), 'someone-elses-store')).toBe('store-a');
  });

  it('rolls up all owned stores when no store is selected (franchise view)', () => {
    expect(ordersScope(accessFor(undefined), undefined)).toEqual({ in: owned });
  });
});
