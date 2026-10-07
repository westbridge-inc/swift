import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nativeRequire = createRequire(require.resolve('@react-navigation/native'));
const coreRequire = createRequire(nativeRequire.resolve('@react-navigation/core'));
const { CommonActions, StackRouter } = await import(/* @vite-ignore */ coreRequire.resolve('@react-navigation/routers')) as Pick<typeof import('@react-navigation/native'), 'CommonActions' | 'StackRouter'>;

// Native drawing/container bridge only. The route registry is the REAL active
// MoverStack, actions run through React Navigation's real StackRouter, and the
// selected fee screen and HTTP transport are real. No safeNavigate mock.
const fx = vi.hoisted(() => {
  const token: unknown = new Proxy({}, { get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : token });
  return {
    token, listener: undefined as undefined | ((_response: unknown) => void),
    dispatch: (_screen: string, _params?: object) => {}, effects: [] as Array<() => void>,
    moverKind: vi.fn(() => ({ kind: 'RIDER', loading: false })),
    owner: { userId: 'dual-owner', generation: 1, accessToken: 'test-access', refreshToken: 'test-refresh' },
  };
});
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const hooks = { useState: (initial: unknown) => [initial, vi.fn()], useEffect: (fn: () => void) => { fx.effects.push(fn); }, useMemo: (fn: () => unknown) => fn(), useRef: (current: unknown) => ({ current }), useCallback: (fn: unknown) => fn };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl', View: 'View', AppState: { addEventListener: () => ({ remove: vi.fn() }) } }));
vi.mock('@react-navigation/native', () => ({
  createNavigationContainerRef: () => ({ isReady: () => true, navigate: (screen: string, params?: object) => fx.dispatch(screen, params) }),
  useFocusEffect: () => {},
  // The fee screen's own navigation (its held-payment support door) goes through the same dispatch.
  useNavigation: () => ({ navigate: (screen: string, params?: object) => fx.dispatch(screen, params) }),
}));
vi.mock('@react-navigation/native-stack', () => ({ createNativeStackNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({ color: fx.token, space: fx.token }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-tap-key' }));
vi.mock('expo-notifications', () => ({ addNotificationResponseReceivedListener: (fn: typeof fx.listener) => { fx.listener = fn; return { remove: vi.fn() }; }, getLastNotificationResponseAsync: async () => null }));
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => fx.owner,
  useAuthStore: Object.assign((pick: (_s: unknown) => unknown) => pick({ user: { id: fx.owner.userId }, sessionGeneration: 1, intent: 'mover' }), { getState: () => ({ intent: 'mover' }) }),
}));
vi.mock('../stores/moverPreview', () => ({ useMoverPreview: (pick: (_s: unknown) => unknown) => pick({ preview: false }) }));
vi.mock('../stores/storeSwitcher', async () => {
  const { createStore } = await import('zustand/vanilla');
  const state = createStore(() => ({ selectedStoreId: 'store-B', storeGeneration: 0, feeContextPending: false, feeContextError: null as unknown, setSelectedStore: (id: string) => state.setState({ selectedStoreId: id, storeGeneration: state.getState().storeGeneration + 1 }), setFeeContextPending: (pending: boolean) => state.setState({ feeContextPending: pending }) }));
  return { useStoreSwitcher: Object.assign((pick: (_s: unknown) => unknown) => pick(state.getState()), state) };
});
vi.mock('../kit', () => Object.fromEntries(['Card', 'ErrorState', 'Header', 'LoadingBlock', 'PillButton', 'Screen', 'T'].map((name) => [name, name])));
vi.mock('../hooks', () => ({ useMoverKind: fx.moverKind, useMoverSubscription: () => ({ data: { id: 'mover-sub', status: 'ACTIVE' }, refetch: vi.fn() }) }));
vi.mock('../hooks/vendorops', () => ({ useVendorSubscription: () => ({ data: { id: 'subscription-A', status: 'ACTIVE' }, refetch: vi.fn() }) }));
vi.mock('../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false }) }));
vi.mock('../components/onboarding/WentLive', () => ({ useWentLive: vi.fn(), WentLivePopup: 'WentLivePopup' }));
vi.mock('../modules/chat/screens/ConversationScreen', () => ({ ConversationScreen: 'ConversationScreen' }));
vi.mock('../modules/mover/screens/MoverHomeScreen', () => ({ MoverHomeScreen: 'MoverHomeScreen' }));
vi.mock('../modules/mover/screens/ActiveJobScreen', () => ({ ActiveJobScreen: 'ActiveJobScreen' }));
vi.mock('../modules/mover/screens/EarningsScreen', () => ({ EarningsScreen: 'EarningsScreen' }));
vi.mock('../modules/mover/screens/ClaimsScreen', () => ({ ClaimsScreen: 'ClaimsScreen' }));
vi.mock('../modules/mover/screens/JobHistoryScreen', () => ({ JobHistoryScreen: 'JobHistoryScreen' }));
vi.mock('../modules/mover/screens/MoverAccountScreen', () => ({ MoverAccountScreen: 'MoverAccountScreen' }));
vi.mock('../modules/mover/screens/MoverDocumentsScreen', () => ({ MoverDocumentsScreen: 'MoverDocumentsScreen' }));
vi.mock('../modules/mover/screens/MoverVehicleScreen', () => ({ MoverVehicleScreen: 'MoverVehicleScreen' }));
vi.mock('../modules/mover/screens/MoverOnboardingScreen', () => ({ MoverOnboardingScreen: 'MoverOnboardingScreen' }));
vi.mock('../modules/profile/screens/GetHelpScreen', () => ({ GetHelpScreen: 'GetHelpScreen' }));
vi.mock('../modules/safety/screens/LivenessCheckScreen', () => ({ LivenessCheckScreen: 'LivenessCheckScreen' }));
vi.mock('../modules/safety/screens/GuardianDriverConfirmScreen', () => ({ GuardianDriverConfirmScreen: 'GuardianDriverConfirmScreen' }));
import { MoverStack } from '../modules/mover/MoverStack';
import { api } from './api';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { installNotificationTapRouter } from './notification-router';
type Element = ReactElement<{ children?: unknown; name?: string; component?: (_props: { route: unknown }) => unknown }>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const el = node as Element;
  return [el, ...elements(el.props.children)];
}
const original = api.defaults.adapter;
beforeEach(() => { fx.effects = []; fx.moverKind.mockClear(); useStoreSwitcher.setState({ selectedStoreId: 'store-B', storeGeneration: 0, feeContextPending: false, feeContextError: null }); });
afterEach(() => { api.defaults.adapter = original; });
describe('notification family with the active mover stack [AX316 R3]', () => {
  it('opens the store family inside Earner mode and never reads the vendor ref through mover endpoints', async () => {
    const screens = elements(MoverStack()).filter((el) => el.props.name && el.props.component);
    const router = StackRouter({ initialRouteName: 'MoverRoot' });
    const config = { routeNames: screens.map((el) => el.props.name as string), routeParamList: {}, routeGetIdList: {} };
    let state = router.getInitialState(config);
    fx.dispatch = (name, params) => {
      const next = router.getStateForAction(state, CommonActions.navigate(name, params), config);
      if (next) state = router.getRehydratedState(next, config);
    };
    const calls: Array<[string | undefined, unknown]> = [];
    api.defaults.adapter = async (request) => {
      calls.push([request.url, request.headers.get('x-vendor-id')]);
      return { config: request, status: 200, statusText: 'OK', headers: {}, data: { data: request.url?.endsWith('/subscription') ? { id: 'subscription-A' } : { ref: 'ref-A', status: 'CONFIRMED', amountGyd: 1200, subscriptionStatus: 'ACTIVE' } } };
    };
    const uninstall = installNotificationTapRouter();
    try {
      expect(state.routes[state.index]!.name).toBe('MoverRoot');
      fx.listener!({ notification: { request: { content: { data: { kind: 'billing_mmg_checkout', vendorId: 'store-A', subscriptionId: 'subscription-A', ref: 'ref-A' } } } } });
      await vi.waitFor(() => expect(state.routes[state.index]!.name).toBe('WeeklyFee'));
      const route = state.routes[state.index]!;
      let node: unknown = screens.find((el) => el.props.name === route.name)!.props.component!({ route });
      // Execute actual family/screen components down to the native Screen.
      while (node && typeof node === 'object' && typeof (node as Element).type === 'function') {
        const el = node as Element;
        node = (el.type as (_props: unknown) => unknown)(el.props);
      }
      const cleanups = fx.effects.splice(0).map((run) => run());
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect(calls).toEqual([['/vendor/subscription', 'store-A'], ['/vendor/subscription/mmg-checkout/ref-A', 'store-A']]);
      expect(fx.moverKind).not.toHaveBeenCalled();
      for (const cleanup of cleanups) if (typeof cleanup === 'function') (cleanup as () => void)();
    } finally { uninstall(); }
  });
});
