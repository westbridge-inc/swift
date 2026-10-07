import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { HOME_RAIL_WINDOW, MARKET_WINDOW } from './listPerformance';
import { retryRead } from './appQueryPolicy';

// Execute the real TSX control flow with inert native leaves. This is a Node
// render/descriptor contract, not a native renderer, FPS or device benchmark.
function execute(path: string, imports: Record<string, unknown>) {
  const output = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', output)((id: string) => {
    if (id === 'react/jsx-runtime') return jsx;
    if (!(id in imports)) throw new Error(`Unmocked native dependency: ${id}`);
    return imports[id];
  }, module, module.exports);
  return module.exports;
}
function nodes(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children)];
}
const fluent: any = new Proxy(() => fluent, { get: () => fluent });
const colors = { primary: '#000', muted: '#777', base: '#fff', subtle: '#eee', sunken: '#ddd', 50: '#eee', 100: '#ddd', 500: '#900', 600: '#800' };
const theme = { color: { text: colors, surface: colors, border: colors, brand: colors, white: '#fff' }, radius: { full: 99 }, space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, '2xl': 24, '3xl': 32 } };

describe('actual tab render contracts', () => {
  it('keeps loaded descriptors and stable route keys on a tab revisit', () => {
    const packagePath = createRequire(import.meta.url).resolve('@react-navigation/bottom-tabs/package.json');
    const slots: any[] = [];
    let slot = 0;
    let dirty = false;
    const hooks = {
      ...React,
      useState: (initial: any) => {
        const index = slot++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; dirty = true; }];
      },
      useRef: (initial: any) => {
        const index = slot++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      },
      useEffect: () => {},
      useMemo: (fn: () => unknown) => fn(),
      useCallback: (fn: unknown) => fn,
      useContext: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
    };
    const safeArea = Object.assign(() => null, { initialMetrics: { frame: { width: 360, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } });
    const { BottomTabView } = execute(join(dirname(packagePath), 'src/views/BottomTabView.tsx'), {
      react: hooks,
      'react-native': { Platform: { OS: 'android' }, StyleSheet: { create: (x: unknown) => x, absoluteFill: {} }, Animated: {} },
      '@react-navigation/elements': { getHeaderTitle: (_: unknown, name: string) => name, Header: 'Header', Screen: 'Screen', SafeAreaProviderCompat: safeArea },
      '@react-navigation/native': { StackActions: {} },
      'react-native-safe-area-context': { SafeAreaInsetsContext: { Consumer: 'SafeAreaConsumer' } },
      '../TransitionConfigs/TransitionPresets': { FadeTransition: {}, ShiftTransition: {} },
      '../utils/BottomTabBarHeightCallbackContext': { BottomTabBarHeightCallbackContext: { Provider: 'HeightCallback' } },
      '../utils/BottomTabBarHeightContext': { BottomTabBarHeightContext: { Provider: 'HeightContext' } },
      '../utils/useAnimatedHashMap': { useAnimatedHashMap: ({ routes }: any) => Object.fromEntries(routes.map((r: any) => [r.key, {}])) },
      './BottomTabBar': { BottomTabBar: 'TabBar', getTabBarHeight: () => 50 },
      './ScreenFallback': { MaybeScreen: 'MaybeScreen', MaybeScreenContainer: 'MaybeScreenContainer' },
    });
    const routes = ['Home', 'Market', 'Cart', 'Profile'].map((name) => ({ key: name, name }));
    const descriptors = Object.fromEntries(routes.map((route) => [route.key, { options: { lazy: true, freezeOnBlur: route.name === 'Market' || route.name === 'Profile', animation: 'none' }, route, navigation: {}, render: () => React.createElement('Content', { name: route.name }) }]));
    for (const [index, expected] of [[0, 1], [1, 2], [2, 3], [3, 4], [0, 4]]) {
      let tree: any;
      let renders = 0;
      do {
        expect(++renders).toBeLessThan(10);
        slot = 0; dirty = false;
        tree = BottomTabView({ state: { index, routes, preloadedRouteKeys: [] }, descriptors, navigation: {} });
      } while (dirty);
      const screens = nodes(tree).filter((node) => node.type === 'MaybeScreen');
      expect(screens.map((screen) => screen.key)).toEqual(routes.slice(0, expected).map((route) => route.key));
      expect(screens.filter((screen) => screen.props.active === 2)).toHaveLength(1);
      expect(screens.every((screen) => screen.props.enabled)).toBe(true);
      for (const screen of screens) expect(screen.props.freezeOnBlur).toBe(screen.key === 'Market' || screen.key === 'Profile');
    }
    const customer = readFileSync(new URL('../navigation/CustomerStack.tsx', import.meta.url), 'utf8');
    expect(customer).toContain('lazy: true');
    expect(customer).toContain('freezeOnBlur: true');
    expect(customer).not.toContain('unmountOnBlur');
    for (const name of ['Home', 'Cart']) expect(customer).toContain(`name="${name}" component={${name}Screen} options={{ freezeOnBlur: false }}`);
  });

  it.each([
    [true, false, 0, true], [true, true, 0, true], [false, true, 0, true],
    [true, true, 401, true], [true, true, 403, true], [true, true, 400, true],
    [true, true, 503, true], [true, true, 408, true], [true, true, 429, true],
    [true, true, 401, false],
  ] as const)('F4: Profile hasData=%s, error=%s, status=%s, authenticated=%s retains only recoverable content', (hasData, isError, status, authenticated) => {
    let retries = 0;
    const kit = new Proxy({ useLogoutConfirm: () => ({ requestLogout() {}, logoutDialog: null }) }, { get: (target, key) => key in target ? target[key as keyof typeof target] : String(key) });
    const { ProfileScreen } = execute(new URL('../modules/profile/screens/ProfileScreen.tsx', import.meta.url).pathname, {
      react: { ...React, useState: (value: unknown) => [value, () => {}], useEffect: () => {} },
      'react-native': { Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View', StyleSheet: { hairlineWidth: 1 } },
      'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Feather: 'Feather' },
      '@react-navigation/native': { useNavigation: () => ({ navigate() {} }) },
      'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 48 }) },
      '@swift/ui': theme, '../../../lib/haptics': { haptic: { select() {} } },
      '../../../hooks/customer': { useProfile: () => ({ data: hasData ? { firstName: 'Fixture', lastName: 'Account' } : undefined, isLoading: false, isError, error: status ? { response: { status } } : new Error('Network Error'), refetch: () => { retries++; } }), useMyRating: () => ({}), useLiveOrders: () => ({}) },
      '../../../stores/authStore': { useAuthStore: () => ({ isAuthenticated: authenticated, user: { id: 'fixture' } }) },
      '../../../lib/appQueryPolicy': { retryRead },
      '../../safety/MonitoringControl': { MonitoringControl: 'MonitoringControl' },
      '../../../kit': kit, '../../../kit/controls': { BrandSwitch: 'BrandSwitch' },
      'react-native-reanimated': { default: { View: 'AnimatedView' }, __esModule: true, FadeInDown: fluent, ReduceMotion: { System: 'system' } },
      '../../../components/RoleSwitcherSheet': { RoleSwitcherSheet: 'RoleSwitcherSheet' },
      '../../../services/api': { API_URL: 'https://invalid.example' }, '../../../lib/payLink': {}, '@tanstack/react-query': {},
    });
    const rendered = nodes(ProfileScreen());
    const hasContent = authenticated && hasData && ![400, 401, 403].includes(status);
    expect(rendered.some((node) => node.type === 'ScrollView')).toBe(hasContent);
    expect(rendered.some((node) => node.type === 'ErrorState')).toBe(authenticated && !hasContent);
    expect(rendered.some((node) => node.type === 'EmptyState')).toBe(!authenticated);
    expect(rendered.some((node) => node.type === 'LoadingBlock')).toBe(false);
    if (isError && hasContent) {
      const masthead = rendered.find((node) => node.type === 'AnimatedView');
      expect(masthead.props.style.paddingTop).toBeGreaterThanOrEqual(48);
      const retry = nodes(masthead).find((node) => node.type === 'PillButton' && node.props.label === 'Try again');
      retry.props.onPress();
      expect(retries).toBe(1);
    }
  });

  it('wires smaller list-window props and honors reduced motion for card images', () => {
    expect(HOME_RAIL_WINDOW).toEqual({ initialNumToRender: 3, maxToRenderPerBatch: 3, windowSize: 3 });
    expect(MARKET_WINDOW).toEqual({ initialNumToRender: 4, maxToRenderPerBatch: 4, windowSize: 5 });
    const home = readFileSync(new URL('../modules/shop/screens/HomeScreen.tsx', import.meta.url), 'utf8');
    const market = readFileSync(new URL('../modules/shop/screens/MarketScreen.tsx', import.meta.url), 'utf8');
    expect(home.match(/<FlatList\s+\{\.\.\.HOME_RAIL_WINDOW\}/g)).toHaveLength(5);
    expect(market).toMatch(/<FlatList\s+\{\.\.\.MARKET_WINDOW\}/);
    for (const reduced of [false, true]) {
      const { Image } = execute(new URL('../kit/image.tsx', import.meta.url).pathname, {
        'expo-image': { Image: 'NativeImage' }, 'react-native-reanimated': { useReducedMotion: () => reduced },
      });
      expect(Image({ source: { uri: 'https://invalid.example/fixture.jpg' }, transition: 150 }).props).toMatchObject({
        cachePolicy: 'disk', allowDownscaling: true, enforceEarlyResizing: true, transition: reduced ? 0 : 150,
      });
    }
  });
});
