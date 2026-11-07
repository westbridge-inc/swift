/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// ---------------------------------------------------------------------------
// [BUG-GUARDS C2 · REVIEW-F #2123 S3-1] An option's x is held per option (useRowHold): a second tap on the same x
// sends nothing, another option's x goes through. With two deletes in flight, TanStack hands per-call callbacks
// (mutate / mutateAsync options) only to the LATEST call, so each option must come off on its OWN call's promise —
// otherwise the first deleted option stays on screen. The REAL VendorItemEditorScreen; the delete hook is a stand-in
// that keeps TanStack's rule (only the latest call's per-call callbacks run).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  deletes: [] as Array<{ id: string; settle: () => void }>,
  save: vi.fn(),
  previewType: null as string | null,
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, typeof children === 'function' ? children({ pressed: false }) : children);
  const Pressable = ({ children, onPress, accessibilityLabel }: any) =>
    R.createElement('button', { type: 'button', 'aria-label': accessibilityLabel, onClick: onPress }, typeof children === 'function' ? children({ pressed: false }) : children);
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Image: View, Pressable,
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0 },
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }) }, AppState: { addEventListener: () => ({ remove() {} }) },
    Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) },
  };
});
vi.mock('@react-navigation/elements', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  const SafeAreaProviderCompat = Object.assign(Box, { initialMetrics: { frame: { width: 390, height: 844 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } } });
  return {
    SafeAreaProviderCompat, Screen: Box, Header: () => null, HeaderBackButton: () => null,
    HeaderBackContext: R.createContext(undefined), HeaderShownContext: R.createContext(false),
    HeaderHeightContext: R.createContext(0), useHeaderHeight: () => 0,
    getHeaderTitle: (_options: unknown, name: string) => name, getLabel: (options: any, fallback: string) => options.label ?? fallback,
    PlatformPressable: Box, Label: Box, Background: Box, Badge: () => null, MissingIcon: () => null,
    useFrameSize: () => ({ width: 390, height: 844 }), useLocale: () => ({ direction: 'ltr' }),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const R = await import('react');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return { SafeAreaInsetsContext: R.createContext(insets), useSafeAreaInsets: () => insets, SafeAreaProvider: ({ children }: any) => children };
});
vi.mock('react-native-screens', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { screensEnabled: () => false, Screen: Box, ScreenContainer: Box };
});

vi.mock('expo-image', () => ({ Image: () => null }));
// [MASTER-025] the stock row mints its adjustment key with expo-crypto (native).
vi.mock('expo-crypto', () => ({ randomUUID: () => 'stock-adjust-key' }));
vi.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  requestMediaLibraryPermissionsAsync: vi.fn(), requestCameraPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(), launchCameraAsync: vi.fn(),
}));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }) }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  const input = (p: any) => h('input', { 'aria-label': p.placeholder, value: p.value, onChange: (e: any) => p.onChangeText(e.target.value) });
  return {
    Card: Box, Screen: Box, IconChip: () => null, LinkText: () => null, PhotoDrop: () => null, Segmented: () => null,
    T: (p: any) => h('span', null, p.children), PopupTitle: Box,
    PopupCard: (p: any) => (p.visible ? h('div', null, p.children) : null),
    Chip: (p: any) => h('button', { type: 'button', 'aria-pressed': p.selected ? 'true' : 'false', onClick: p.onPress }, p.label),
    LabeledInput: input,
    PillButton: (p: any) => h('button', { type: 'button', disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onPress }, p.label),
    ConfirmDialog: (p: any) => (p.open
      ? h('div', { role: 'dialog' }, h('h2', null, p.title),
        h('button', { type: 'button', onClick: p.onClose }, p.cancelLabel ?? 'Cancel'),
        h('button', { type: 'button', onClick: p.onConfirm }, p.confirmLabel))
      : null),
  };
});
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (go: () => void) => { setTimeout(go, 0); } }));
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../shared', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    DAY_LABELS: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], GUTTER: 16,
    InlineInput: (p: any) => h('input', { 'aria-label': p.placeholder, value: p.value, onChange: (e: any) => p.onChangeText(e.target.value) }),
    SubHeader: (p: any) => h('header', null, h('button', { type: 'button', onClick: () => p.navigation.goBack() }, 'Back'), p.title),
  };
});
vi.mock('../../../services/api', () => ({ vendorApi: {} }));
vi.mock('../../../hooks/storeVat', () => ({ useStoreVat: () => ({ data: undefined }) })); // [STORE-VAT] owner-only read, no VAT here
vi.mock('../../../hooks/useVendorMutation', () => ({ useVendorMutation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/vendorops', () => {
  const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useVendorProfile: () => ({ store: { vendorType: 'RESTAURANT' } }),
    useSaveItem: () => ({ mutateAsync: fx.save, isPending: false }),
    useUploadItemImage: idle, useAddOptionGroup: idle, useDeleteOptionGroup: idle, useAddOption: idle,
    // TanStack's rule: a call's own promise always settles; per-call options reach only the latest call.
    useDeleteOption: () => ({
      isPending: false,
      mutate: vi.fn(),
      mutateAsync: (vars: { id: string }, options?: { onSuccess?: (data: unknown) => void }) => new Promise((resolve) => {
        const call = { id: vars.id, settle: () => {
          resolve({ deleted: true });
          if (fx.deletes.at(-1) === call) options?.onSuccess?.({ deleted: true });
        } };
        fx.deletes.push(call);
      }),
    }),
  };
});
vi.mock('../../../stores/authStore', () => ({
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionSnapshot: () => ({ userId: 'owner', generation: 1 }),
  requireAuthSessionForPrincipal: (session: unknown) => session,
}));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: 'store-A' }) } }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (select: (s: unknown) => unknown) => select({ previewType: fx.previewType }) }));
vi.mock('../../../lib/images', () => ({ mediaUrl: () => undefined, isKeptPhoto: () => false, storePhotoUrl: () => null, HERO_PHOTO_WIDTH: 1280 }));

import { VendorItemEditorScreen } from './VendorItemEditorScreen';

const nav = createNavigationContainerRef<Record<string, object | undefined>>();
const Stack = createNativeStackNavigator();
const h = React.createElement;
const VendorMenu = () => h('p', null, 'menu list');
const ITEM = {
  id: 'item-1', name: 'Roti', basePrice: 500, categoryId: 'mains', isAvailable: true,
  optionGroups: [{ id: 'g1', name: 'Size', isRequired: false, minSelect: 0, maxSelect: 1, options: [
    { id: 'o-small', name: 'Small', additionalPrice: 0 }, { id: 'o-large', name: 'Large', additionalPrice: 200 },
  ] }],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  fx.previewType = null;
  fx.deletes = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const shown = (name: string) => Array.from(host.querySelectorAll('span')).some((s) => s.textContent === name);
/** The option row's x: the one button in the row that names the option. */
const xOf = (name: string) => Array.from(host.querySelectorAll('span')).find((s) => s.textContent === name)!.parentElement!.querySelector('button')!;
async function tapX(name: string) { await act(async () => { xOf(name).click(); }); await settle(); }
async function openItem() {
  await act(async () => root.render(h(NavigationContainer as any, { ref: nav, linking: { enabled: false, prefixes: [] } },
    h(Stack.Navigator, {
      screenOptions: { headerShown: false },
      children: [
        h(Stack.Screen, { key: 'VendorMenu', name: 'VendorMenu', component: VendorMenu }),
        h(Stack.Screen, { key: 'VendorItemEditor', name: 'VendorItemEditor', component: VendorItemEditorScreen }),
      ],
    }))));
  await act(async () => nav.navigate('VendorItemEditor', { item: ITEM, categories: [{ id: 'mains', name: 'Mains' }] }));
  await settle();
  expect(shown('Small') && shown('Large')).toBe(true);
}

describe('[BUG-GUARDS C2 · REVIEW-F #2123 S3-1] deleting options', () => {
  it('two options deleted at once both come off when their deletes finish (the first is not left on screen)', async () => {
    await openItem();
    await tapX('Small');
    await tapX('Large');
    expect(fx.deletes.map((d) => d.id)).toEqual(['o-small', 'o-large']);
    await act(async () => { fx.deletes[0]!.settle(); });
    await settle();
    await act(async () => { fx.deletes[1]!.settle(); });
    await settle();
    expect(shown('Small'), 'the first deleted option').toBe(false);
    expect(shown('Large'), 'the second deleted option').toBe(false);
  });

  it('a second tap on the same x sends nothing while its delete runs; another option\'s x goes through', async () => {
    await openItem();
    await tapX('Small');
    await tapX('Small');
    await tapX('Large');
    expect(fx.deletes.map((d) => d.id)).toEqual(['o-small', 'o-large']);
  });
});
