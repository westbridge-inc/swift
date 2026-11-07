import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [SPEED 6 Nov] Why the store tabs are drawn ahead with `lazy: false` once Swift
// is quiet (navigation/warmTabs), and not with React Navigation's
// `navigation.preload`: the installed bottom-tabs view (its real source, run
// with inert native leaves as in lib/appSpeed.render.test) mounts a non-lazy
// hidden tab with `shouldFreeze` set, so react-native-screens pauses it after
// one draw; a PRELOADED hidden tab is mounted with `shouldFreeze` false and
// redraws on every poll until it is first visited.
// ---------------------------------------------------------------------------

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

function tabView() {
  const packagePath = createRequire(import.meta.url).resolve('@react-navigation/bottom-tabs/package.json');
  const slots: any[] = [];
  let slot = 0;
  const hooks = {
    ...React,
    useState: (initial: any) => {
      const index = slot++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
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
  return (warm: string[], preloaded: string[]) => {
    slot = 0;
    const routes = ['Orders', 'Menu', 'Insights', 'Account'].map((name) => ({ key: name, name }));
    // The store tab bar's options (VendorStack VendorTabs): lazy and frozen on blur, `lazy: false` once warm.
    const descriptors = Object.fromEntries(routes.map((route) => [route.key, {
      options: { lazy: !warm.includes(route.name), freezeOnBlur: true, animation: 'none' },
      route, navigation: {}, render: () => React.createElement('Content', { name: route.name }),
    }]));
    const tree = BottomTabView({ state: { index: 0, routes, preloadedRouteKeys: preloaded }, descriptors, navigation: {} });
    return Object.fromEntries(nodes(tree).filter((node) => node.type === 'MaybeScreen')
      .map((screen) => [screen.key, { frozen: !!screen.props.freezeOnBlur && !!screen.props.shouldFreeze }]));
  };
}

describe('[SPEED 6 Nov] a store tab drawn ahead is paused while hidden', () => {
  it('before Swift is quiet only Orders is drawn; once warm, Menu, Insights and Account are drawn and FROZEN', () => {
    const render = tabView();
    expect(render([], [])).toEqual({ Orders: { frozen: false } });
    expect(render(['Menu', 'Insights', 'Account'], [])).toEqual({
      Orders: { frozen: false }, Menu: { frozen: true }, Insights: { frozen: true }, Account: { frozen: true },
    });
  });

  it('control: React Navigation\'s preload would draw them UNFROZEN (redrawn on every poll until visited)', () => {
    const render = tabView();
    expect(render([], ['Menu', 'Insights', 'Account'])).toEqual({
      Orders: { frozen: false }, Menu: { frozen: false }, Insights: { frozen: false }, Account: { frozen: false },
    });
  });

  it('the store tab bar keeps freezeOnBlur and draws ahead through `lazy`, never through preload', () => {
    const stack = readFileSync(new URL('../modules/vendor/VendorStack.tsx', import.meta.url), 'utf8');
    expect(stack).toContain('freezeOnBlur: true,');
    for (const name of ['Menu', 'Insights', 'Account']) expect(stack).toContain(`lazy: !warm.has('${name}')`);
    expect(stack).not.toMatch(/\.preload\(|freezeOnBlur: false/);
  });
});
