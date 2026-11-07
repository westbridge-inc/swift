/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// ---------------------------------------------------------------------------
// [BOOK-S5a · owner A4/C2 28 Oct 2026] The item editor's booking settings: hours per day with more
// than one window (a break), the gap after each booking, the minimum notice, and "Confirm bookings
// automatically" (shown only on the server's word). The REAL VendorItemEditorScreen in a real
// NavigationContainer + native-stack; native drawing, the kit and the network are stand-ins (the
// harness of VendorItemEditorScreen.newItemOptions.navigation.test.ts).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  save: vi.fn(),
  addGroup: vi.fn(),
  addOption: vi.fn(),
  saveError: null as unknown,
  previewType: null as string | null,
  store: { vendorType: 'SERVICE' } as Record<string, unknown>,
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
    Card: Box, Screen: Box, IconChip: () => null, PhotoDrop: () => null, Segmented: () => null,
    LinkText: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
    BrandSwitch: (p: any) => h('button', { type: 'button', role: 'switch', 'aria-label': p.label, 'aria-checked': p.value ? 'true' : 'false', onClick: () => p.onChange(!p.value) }, p.label),
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
    useVendorProfile: () => ({ store: fx.store, myRole: 'OWNER' }),
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
const CATEGORIES = [{ id: 'chair', name: 'Chair' }];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  fx.previewType = null;
  fx.saveError = null;
  fx.store = { vendorType: 'SERVICE' };
  fx.save.mockResolvedValue({ id: 'item-1' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);
const shown = (text: string) => Array.from(host.querySelectorAll('span')).some((s) => s.textContent === text);
const instantSwitch = () => host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Confirm bookings automatically"]');
async function tap(label: string, nth = 0) {
  const el = Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === label)[nth];
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
async function openEditor(item?: Record<string, unknown>) {
  await act(async () => root.render(h(NavigationContainer as any, { ref: nav, linking: { enabled: false, prefixes: [] } },
    h(Stack.Navigator, {
      screenOptions: { headerShown: false },
      children: [
        h(Stack.Screen, { key: 'VendorMenu', name: 'VendorMenu', component: VendorMenu }),
        h(Stack.Screen, { key: 'VendorItemEditor', name: 'VendorItemEditor', component: VendorItemEditorScreen }),
      ],
    }))));
  await act(async () => nav.navigate('VendorItemEditor', { categories: CATEGORIES, ...(item ? { item } : {}) }));
  await settle();
}
const savedConfig = () => fx.save.mock.calls[0]![0].data.bookingConfig as Record<string, unknown>;

/** A listing saved with different hours per day and a lunch break on Monday. */
const STORED = {
  durationMinutes: 60,
  slots: [
    { dayOfWeek: 2, start: '10:00', end: '14:00' },
    { dayOfWeek: 1, start: '13:00', end: '17:00' },
    { dayOfWeek: 1, start: '09:00', end: '12:00' },
  ],
  serviceMode: 'AT_BUSINESS',
  bufferMinutes: 15,
  minNoticeMinutes: 60,
  instantBooking: true,
};
const existingItem = (bookingConfig: Record<string, unknown> = STORED) => ({
  id: 'item-1', name: 'Cut', basePrice: 2000, categoryId: 'chair', isAvailable: true, fulfillment: 'APPOINTMENT', bookingConfig,
});

describe('[BOOK-S5a] the booking settings in the item editor', () => {
  it('an unchanged save keeps every day\'s own hours and the break (the old editor put Monday\'s first window on every day)', async () => {
    fx.store = { vendorType: 'SERVICE', instantBookingAvailable: true };
    await openEditor(existingItem());
    await tap('Save changes');
    expect(savedConfig()).toEqual({
      durationMinutes: 60,
      slots: [
        { dayOfWeek: 1, start: '09:00', end: '12:00' },
        { dayOfWeek: 1, start: '13:00', end: '17:00' },
        { dayOfWeek: 2, start: '10:00', end: '14:00' },
      ],
      serviceMode: 'AT_BUSINESS',
      bufferMinutes: 15,
      minNoticeMinutes: 60,
      instantBooking: true,
    });
  });

  it('the server has not offered "Confirm bookings automatically" (switch off, older server): no switch, and the save never names it', async () => {
    await openEditor(existingItem());
    expect(instantSwitch()).toBeNull();
    expect(shown('Confirm bookings automatically')).toBe(false);
    await tap('Save changes');
    expect('instantBooking' in savedConfig()).toBe(false);
    expect(savedConfig()).toMatchObject({ bufferMinutes: 15, minNoticeMinutes: 60 });
  });

  it('a new bookable service, the server offering the setting: confirmed automatically with 2 hours\' notice, until the business changes it', async () => {
    fx.store = { vendorType: 'SERVICE', instantBookingAvailable: true };
    await openEditor();
    expect(instantSwitch()?.getAttribute('aria-checked')).toBe('true');
    expect(button('2 hours')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { instantSwitch()!.click(); });
    await settle();
    expect(shown('Every booking waits for you to accept it.')).toBe(true);
    // The gap's chips come first (its "1 hour" is the first); the notice's "1 hour" is the second.
    await tap('1 hour', 1);
    await type('Item name', 'Beard trim');
    await type('Price (GYD)', '800');
    await tap('Add item');
    expect(savedConfig()).toMatchObject({ instantBooking: false, minNoticeMinutes: 60, bufferMinutes: 0 });
    expect(savedConfig()['slots']).toEqual([1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, start: '09:00', end: '17:00' })));
  });

  it('a new service, the setting not offered: no switch, no notice by default (today\'s behaviour)', async () => {
    await openEditor();
    expect(instantSwitch()).toBeNull();
    // The gap's "None" first, the notice's second: both chosen.
    expect(Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === 'None').map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    await type('Item name', 'Trim');
    await type('Price (GYD)', '800');
    await tap('Add item');
    expect(savedConfig()).toMatchObject({ minNoticeMinutes: 0, bufferMinutes: 0 });
    expect('instantBooking' in savedConfig()).toBe(false);
  });

  it('[REVIEW-F #2196 S4-2] the minimum notice says what it measures: how close to its start a time can still be booked', async () => {
    await openEditor(existingItem());
    expect(shown('Minimum notice')).toBe(true);
    expect(shown('How close to its start a customer can still book a time.')).toBe(true);
    expect(shown('How soon before a time a customer can still book it.')).toBe(false);
  });

  it('Add hours gives Monday another window after its last one', async () => {
    await openEditor(existingItem());
    // Monday is the first open day: its "Add hours" is the first one.
    await tap('Add hours');
    await tap('Save changes');
    expect(savedConfig()['slots']).toEqual([
      { dayOfWeek: 1, start: '09:00', end: '12:00' },
      { dayOfWeek: 1, start: '13:00', end: '17:00' },
      { dayOfWeek: 1, start: '18:00', end: '20:00' },
      { dayOfWeek: 2, start: '10:00', end: '14:00' },
    ]);
  });

  it('overlapping hours stop the save, in plain words', async () => {
    await openEditor(existingItem());
    // Monday's second window now starts inside its first.
    await type('09:00', '11:00', 1);
    expect(shown('On Monday, 09:00–12:00 and 11:00–17:00 overlap. Join them into one, or change one.')).toBe(true);
    expect(button('Fix the hours')?.disabled).toBe(true);
    expect(fx.save).not.toHaveBeenCalled();
  });

  it('closing a day removes its hours from the save', async () => {
    await openEditor(existingItem());
    await tap('Tue');
    await tap('Save changes');
    expect((savedConfig()['slots'] as Array<{ dayOfWeek: number }>).map((s) => s.dayOfWeek)).toEqual([1, 1]);
  });
});
