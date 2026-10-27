/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct · owner: "adding menus"] A NEW item takes its option groups and choices before its first save,
// and they go with it in the ONE create request (POST /vendor/items takes optionGroups).
//
// Before: "Save the item first to add options & add-ons". The store saved, the editor closed, it found the item in the
// list again, tapped Edit item, then added the group and each choice one request at a time (a typical item with a
// photo and "Size: Small / Medium / Large" = 12 taps, two editor visits and 6 requests in a row). The REAL
// VendorItemEditorScreen in a real NavigationContainer + native-stack; native drawing, the kit and the network are
// stand-ins (the harness of VendorItemEditorScreen.discard.navigation.test.ts).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  save: vi.fn(),
  addGroup: vi.fn(),
  addOption: vi.fn(),
  saveError: null as unknown,
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
    useSaveItem: () => ({ mutateAsync: fx.save, isPending: false, isError: fx.saveError != null, error: fx.saveError }),
    useUploadItemImage: idle, useDeleteOptionGroup: idle, useDeleteOption: idle,
    useAddOptionGroup: () => ({ mutate: vi.fn(), mutateAsync: fx.addGroup, isPending: false }),
    useAddOption: () => ({ mutate: vi.fn(), mutateAsync: fx.addOption, isPending: false }),
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
  fx.saveError = null;
  fx.save.mockResolvedValue({ id: 'item-1' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const stack = () => nav.getRootState().routes.map((r) => r.name);
const dialog = () => host.querySelector('[role="dialog"]');
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);
const shown = (text: string) => Array.from(host.querySelectorAll('span')).some((s) => s.textContent === text);
async function tap(label: string) {
  const el = button(label);
  expect(el, label).toBeTruthy();
  await act(async () => { el!.click(); });
  await settle();
}
async function type(placeholder: string, value: string, nth = 0) {
  const el = host.querySelectorAll<HTMLInputElement>(`input[aria-label="${placeholder}"]`)[nth]!;
  expect(el, placeholder).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); });
}
/** A choice typed into the group's row, then that row's + . */
async function addChoice(name: string, price = '') {
  await type('Choice (e.g. Large)', name);
  if (price) await type('+GYD', price);
  const plus = host.querySelector('input[aria-label="Choice (e.g. Large)"]')!.parentElement!.querySelector('button')!;
  await act(async () => { plus.click(); });
  await settle();
}
/** The x on a choice's row. */
async function removeChoice(name: string) {
  const x = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === name)!.parentElement!.querySelector('button')!;
  await act(async () => { x.click(); });
  await settle();
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
}

describe('[TAP-AUDIT] options on a new item, in the one create request', () => {
  it('a new item with "Size: Small / Large +200" is saved in ONE request with its group and choices, and the editor closes', async () => {
    await openNewItem();
    await type('Item name', 'Roti');
    await type('Price (GYD)', '500');
    await type('New group (e.g. Size, Toppings)', 'Size');
    await tap('Required');
    await tap('Add option group');
    expect(shown('Size'), 'the group is on screen at once').toBe(true);
    await addChoice('Small');
    await addChoice('Medium', '100');
    await addChoice('Large', '200');
    expect(shown('Small') && shown('Medium') && shown('Large')).toBe(true);
    await removeChoice('Medium');
    expect(shown('Medium')).toBe(false);
    expect(fx.addGroup, 'no request until the item is saved').not.toHaveBeenCalled();
    expect(fx.addOption).not.toHaveBeenCalled();

    await tap('Add item');
    expect(fx.save).toHaveBeenCalledTimes(1);
    expect(fx.save.mock.calls[0]![0].data.optionGroups).toEqual([
      { name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, options: [{ name: 'Small', additionalPrice: 0 }, { name: 'Large', additionalPrice: 200 }] },
    ]);
    expect(fx.addGroup).not.toHaveBeenCalled();
    expect(fx.addOption).not.toHaveBeenCalled();
    expect(stack()).toEqual(['VendorMenu']);
  });

  it('a new item with no groups sends no optionGroups (the request is as before)', async () => {
    await openNewItem();
    await type('Item name', 'Pepperpot');
    await type('Price (GYD)', '1500');
    await tap('Add item');
    expect(fx.save).toHaveBeenCalledTimes(1);
    expect(fx.save.mock.calls[0]![0].data).not.toHaveProperty('optionGroups');
  });

  it('a group removed before the save is not sent; "Multiple picks" is sent as up to 10', async () => {
    await openNewItem();
    await type('Item name', 'Roti');
    await type('Price (GYD)', '500');
    await type('New group (e.g. Size, Toppings)', 'Size');
    await tap('Add option group');
    await type('New group (e.g. Size, Toppings)', 'Toppings');
    await tap('Multiple picks');
    await tap('Add option group');
    const trash = host.querySelector('button[aria-label="Remove Size"]') as HTMLButtonElement;
    await act(async () => { trash.click(); });
    await settle();
    await tap('Add item');
    expect(fx.save.mock.calls[0]![0].data.optionGroups).toEqual([
      { name: 'Toppings', isRequired: false, minSelect: 0, maxSelect: 10, options: [] },
    ]);
  });

  it('leaving with only option groups typed asks before they are thrown away', async () => {
    await openNewItem();
    await type('New group (e.g. Size, Toppings)', 'Size');
    await tap('Add option group');
    await tap('Back');
    expect(dialog()?.textContent).toContain('Discard your changes?');
    expect(stack()).toEqual(['VendorMenu', 'VendorItemEditor']);
  });
});

describe('[TAP-AUDIT] a refused save says why, in the server\'s words', () => {
  it('a banned word: the server\'s sentence, not "Check the details"', async () => {
    fx.saveError = { response: { data: { error: { code: 'PROHIBITED_ITEM', message: 'Rum is not allowed on Swift.' } } } };
    await openNewItem();
    expect(shown('Rum is not allowed on Swift.')).toBe(true);
  });

  it('a form-shape refusal keeps the editor\'s own words', async () => {
    fx.saveError = { response: { data: { error: { code: 'VALIDATION_ERROR', message: 'Validation failed' } } } };
    await openNewItem();
    expect(shown("Couldn't save. Check the details and try again.")).toBe(true);
    expect(shown('Validation failed')).toBe(false);
  });

  it('no answer at all (offline) keeps the editor\'s own words', async () => {
    fx.saveError = new Error('Network Error');
    await openNewItem();
    expect(shown("Couldn't save. Check the details and try again.")).toBe(true);
  });
});
