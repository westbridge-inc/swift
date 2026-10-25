/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// ---------------------------------------------------------------------------
// [UI-SWEEP U67] The business item editor lost typed, unsaved changes
// silently: Back, a swipe, or a board door to the menu list (U29's pop)
// closed it with no ask. The REAL VendorItemEditorScreen inside a real
// NavigationContainer + native-stack (the Menu stack's shape: VendorMenu,
// VendorItemEditor); only native drawing, the kit, the stores and the network
// are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
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
    useUploadItemImage: idle, useAddOptionGroup: idle, useDeleteOptionGroup: idle, useAddOption: idle, useDeleteOption: idle,
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
const CATEGORIES = [{ id: 'mains', name: 'Mains' }];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  fx.previewType = null;
  fx.save.mockResolvedValue({ id: 'item-1' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const stack = () => nav.getRootState().routes.map((r) => r.name);
const dialog = () => host.querySelector('[role="dialog"]');
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);
async function tap(label: string) {
  const el = button(label);
  expect(el, label).toBeTruthy();
  await act(async () => { el!.click(); });
  await settle();
}
async function type(placeholder: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(`input[aria-label="${placeholder}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); });
}
async function openNewItem() {
  await act(async () => root.render(h(NavigationContainer as any, { ref: nav, linking: { enabled: false, prefixes: [] } },
    h(Stack.Navigator, {
      screenOptions: { headerShown: false },
      children: [
        h(Stack.Screen, { key: 'VendorMenu', name: 'VendorMenu', component: VendorMenu }),
        h(Stack.Screen, { key: 'VendorItemEditor', name: 'VendorItemEditor', component: VendorItemEditorScreen }),
      ],
    }))));
  await act(async () => nav.navigate('VendorItemEditor', { categories: CATEGORIES }));
  await settle();
  expect(stack()).toEqual(['VendorMenu', 'VendorItemEditor']);
}

describe('[UI-SWEEP U67] the item editor asks before typed changes are thrown away', () => {
  it('an untouched editor closes on Back with no ask', async () => {
    await openNewItem();
    await tap('Back');
    expect(dialog()).toBeNull();
    expect(stack()).toEqual(['VendorMenu']);
  });

  it('Back with typed changes asks; Keep editing keeps the typing; Discard closes', async () => {
    await openNewItem();
    await type('Item name', 'Pepperpot');
    await tap('Back');
    expect(stack(), 'the editor is still open').toEqual(['VendorMenu', 'VendorItemEditor']);
    expect(dialog()?.textContent).toContain('Discard your changes?');

    await tap('Keep editing');
    expect(dialog()).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Item name"]')!.value).toBe('Pepperpot');
    expect(stack()).toEqual(['VendorMenu', 'VendorItemEditor']);

    await tap('Back');
    await tap('Discard');
    expect(dialog()).toBeNull();
    expect(stack()).toEqual(['VendorMenu']);
  });

  it('a board door that goes back to the menu list (navigate + pop) asks too', async () => {
    await openNewItem();
    await type('Price (GYD)', '1500');
    await act(async () => (nav.navigate as any)('VendorMenu', undefined, { pop: true }));
    await settle();
    expect(stack()).toEqual(['VendorMenu', 'VendorItemEditor']);
    expect(dialog()?.textContent).toContain('Discard your changes?');
    await tap('Discard');
    expect(stack()).toEqual(['VendorMenu']);
  });

  it('a saved item closes with no ask', async () => {
    await openNewItem();
    await type('Item name', 'Pepperpot');
    await type('Price (GYD)', '1500');
    await tap('Add item');
    expect(fx.save).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(stack()).toEqual(['VendorMenu']);
  });

  it('typing that is put back the way it opened is not a change', async () => {
    await openNewItem();
    await type('Item name', 'Pepperpot');
    await type('Item name', '');
    await tap('Back');
    expect(dialog()).toBeNull();
    expect(stack()).toEqual(['VendorMenu']);
  });

  it('a preview (read-only) editor never asks', async () => {
    fx.previewType = 'OWNER_PREVIEW';
    await openNewItem();
    await type('Item name', 'Pepperpot');
    await tap('Back');
    expect(dialog()).toBeNull();
    expect(stack()).toEqual(['VendorMenu']);
  });
});
