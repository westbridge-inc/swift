import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Execute the real tap router against React Navigation's installed StackRouter.
// Business/driver Main has no Notifications route; the root's separately
// mounted CustomerStack must receive the nested action, without changing modes.
const fromNative = createRequire(import.meta.resolve('@react-navigation/native'));
const fromCore = createRequire(fromNative.resolve('@react-navigation/core'));
const { StackRouter } = await import(fromCore.resolve('@react-navigation/routers')) as Pick<typeof import('@react-navigation/native'), 'StackRouter'>;
const fx = vi.hoisted(() => ({
  listener: undefined as undefined | ((response: unknown) => void),
  navigate: vi.fn(), last: vi.fn(), ready: true,
}));
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: typeof fx.listener) => { fx.listener = listener; return { remove: vi.fn() }; },
  getLastNotificationResponseAsync: () => fx.last(),
}));
vi.mock('../navigation/navigationRef', () => ({ navigationRef: { isReady: () => fx.ready }, safeNavigate: fx.navigate }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: () => ({ userId: 'invite-recipient', generation: 1 }) }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null, storeGeneration: 0 }) } }));
import { installNotificationTapRouter, flushPendingNavigation } from './notification-router';

let uninstall: (() => void) | undefined;
afterEach(() => { uninstall?.(); vi.clearAllMocks(); });

describe('team invitation taps reach the mounted inbox', () => {
  it.each(['vendor', 'mover', 'advertiser', 'customer'])('warm and cold taps from %s reach Notifications without a manual mode switch', async mode => {
    const source = readFileSync(new URL('../navigation/RootNavigator.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/name="Storefront"\s+component=\{CustomerStack\}/);
    const customer = readFileSync(new URL('../navigation/CustomerStack.tsx', import.meta.url), 'utf8');
    const customerNames = [...customer.matchAll(/\.Screen[^>]*?name="([A-Za-z0-9_]+)"/g)].map(match => match[1]!);
    expect(customerNames).toContain('Notifications');
    const root = StackRouter({});
    const options = { routeNames: ['Main', 'Storefront', 'QrOutcome'], routeParamList: {}, routeGetIdList: {} };
    let state = root.getInitialState(options);
    const child = StackRouter({});
    const childOptions = { routeNames: customerNames, routeParamList: {}, routeGetIdList: {} };
    const stackPath = mode === 'customer' ? '../navigation/CustomerStack.tsx'
      : mode === 'vendor' ? '../modules/vendor/VendorStack.tsx'
        : mode === 'mover' ? '../modules/mover/MoverStack.tsx' : '../modules/advertiser/AdvertiserStack.tsx';
    const mainSource = readFileSync(new URL(stackPath, import.meta.url), 'utf8');
    const mainNames = [...mainSource.matchAll(/\.Screen[^>]*?name="([A-Za-z0-9_]+)"/g)].map(match => match[1]!);
    expect(mainNames.length).toBeGreaterThan(1);
    const mainRouter = StackRouter({});
    const mainOptions = { routeNames: mainNames, routeParamList: {}, routeGetIdList: {} };
    let mainState = mainRouter.getInitialState(mainOptions);
    let landed: string | undefined;
    fx.navigate.mockImplementation((screen: string, params: Record<string, unknown> | undefined) => {
      const action = { type: 'NAVIGATE' as const, payload: { name: screen, params } };
      // Try the actual active Main stack first, then bubble an unhandled
      // action to root exactly as React Navigation does. Customer Main is a
      // positive control; the partner stacks do not mount Notifications.
      if (state.routes[state.index]?.name === 'Main') {
        const mainNext = mainRouter.getStateForAction(mainState, action, mainOptions);
        if (mainNext) {
          mainState = mainRouter.getRehydratedState(mainNext, mainOptions); landed = mainState.routes[mainState.index]?.name;
          return landed === 'Notifications';
        }
      }
      const next = root.getStateForAction(state, action, options);
      if (!next) return false;
      state = root.getRehydratedState(next, options);
      const route = state.routes[state.index]!;
      if (route.name !== 'Storefront') return false;
      const nested = child.getStateForAction(child.getInitialState(childOptions), {
        type: 'NAVIGATE', payload: { name: String(params?.['screen']) },
      }, childOptions);
      const nestedState = nested ? child.getRehydratedState(nested, childOptions) : undefined;
      landed = nestedState?.routes[nestedState.index]?.name;
      return landed === 'Notifications';
    });
    const response = { notification: { request: { content: { data: { kind: 'staff_invite', audience: 'customer', vendorId: 'fixture-store' } } } } };
    fx.last.mockResolvedValue(null); fx.ready = true;
    uninstall = installNotificationTapRouter();
    fx.listener!(response);
    await vi.waitFor(() => expect(landed, `${mode} warm tap`).toBe('Notifications'));
    uninstall(); landed = undefined;
    state = root.getInitialState(options); mainState = mainRouter.getInitialState(mainOptions);
    fx.ready = false; fx.last.mockResolvedValue(response);
    uninstall = installNotificationTapRouter();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(landed).toBeUndefined();
    fx.ready = true; flushPendingNavigation();
    await vi.waitFor(() => expect(landed, `${mode} cold tap`).toBe('Notifications'));
  });
});
