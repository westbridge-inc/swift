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


describe('item Add continuation', () => {
  const destination: AuthContinuationDestination = { screen: 'MenuItem', vendorId: 'scanned-store', itemId: 'roti',
    addDraft: { quantity: 2, selectedOptions: { filling: 'chickpea' }, dayOffset: 0, slot: null, visitMode: 'AT_BUSINESS' },
  };

  it.each(['customer', 'vendor', 'mover', 'advertiser'] as const)('resumes the item above its own menu for %s, once navigation is ready', intent => {
    requestAuthContinuation(destination, vi.fn());
    const deliver = vi.fn(() => false as boolean);
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent }, deliver)).toBe('retry');
    deliver.mockReturnValue(true);
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent }, deliver)).toBe('delivered');
    expect(deliver).toHaveBeenLastCalledWith(destination);
    const route = rootRouteForAuthContinuation(destination);
    expect(route.screen).toBe('Storefront');
    if (!('state' in route.params)) throw new Error('Missing item stack');
    const router = StackRouter({});
    const options = { routeNames: ['Tabs', 'Restaurant', 'MenuItem'], routeParamList: {}, routeGetIdList: {} };
    const state = router.getRehydratedState(route.params.state, options);
    expect(state.routes[state.index]).toMatchObject({ name: 'MenuItem', params: { vendorId: 'scanned-store', itemId: 'roti', addDraft: destination.addDraft, addAfterSignIn: true } });
    const back = router.getStateForAction(state, { type: 'GO_BACK' }, options)!;
    expect(back.index).toBe(0);
    expect(back.routes[0]).toMatchObject({ name: 'Restaurant', params: { vendorId: 'scanned-store' } });
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent }, deliver)).toBe('none');
  });

  it('cancels the pending item Add when authentication is cancelled', () => {
    requestAuthContinuation(destination, vi.fn());
    discardAuthContinuation();
    const deliver = vi.fn(() => true);
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent: 'customer' }, deliver)).toBe('none');
    expect(deliver).not.toHaveBeenCalled();
  });
});
