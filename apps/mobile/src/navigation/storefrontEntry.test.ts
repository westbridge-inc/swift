import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { discardAuthContinuation, flushAuthContinuation, requestAuthContinuation, rootRouteForAuthContinuation, type AuthContinuationDestination } from './authContinuation';

// Load the installed navigation library's pure router without importing its
// native drawing layer or depending on a hoisted transitive package.
const fromNative = createRequire(import.meta.resolve('@react-navigation/native'));
const fromCore = createRequire(fromNative.resolve('@react-navigation/core'));
const { StackRouter } = await import(fromCore.resolve('@react-navigation/routers')) as Pick<typeof import('@react-navigation/native'), 'StackRouter'>;

beforeEach(() => discardAuthContinuation());

describe('a linked menu survives the root authentication boundary', () => {
  it('leaves the public store to show requested sign-in when its navigation key changes', () => {
    const router = StackRouter({});
    const guest = { routeNames: ['RolePicker', 'Storefront'], routeParamList: {}, routeGetIdList: {} };
    const initial = router.getInitialState(guest);
    const scanned = router.getRehydratedState(router.getStateForAction(initial, {
      type: 'NAVIGATE', payload: { name: 'Storefront', params: { screen: 'Restaurant', params: { vendorId: 'scanned-store' } } },
    }, guest)!, guest);
    expect(scanned.routes[scanned.index]?.name).toBe('Storefront');
    const auth = router.getStateForRouteNamesChange(scanned, {
      routeNames: ['Auth', 'Storefront'], routeParamList: {}, routeGetIdList: {}, routeKeyChanges: ['Storefront'],
    });
    expect(auth.routes[auth.index]?.name).toBe('Auth');
  });

  it.each(['customer', 'vendor', 'mover', 'advertiser'] as const)('returns a signed-in %s to the scanned menu once, retaining its vendor ID', intent => {
    const deliver = vi.fn((_destination: AuthContinuationDestination) => true);
    const prompt = vi.fn();
    requestAuthContinuation({ screen: 'Restaurant', vendorId: 'scanned-store' }, prompt);
    expect(prompt).toHaveBeenCalledOnce();
    expect(flushAuthContinuation({ isAuthenticated: false, entryGate: 'auth', intent }, deliver)).toBe('waiting');
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'selfie', intent }, deliver)).toBe('waiting');
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent }, deliver)).toBe('delivered');
    expect(rootRouteForAuthContinuation(deliver.mock.calls[0]![0]!)).toEqual({
      screen: 'Storefront', params: { screen: 'Restaurant', params: { vendorId: 'scanned-store' } },
    });
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent }, deliver)).toBe('none');
  });
});
