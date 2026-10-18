/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [PINS · row 107] A saved address is the pin its owner confirmed on the map
// (AddAddressScreen + LocationPickerScreen), drawn by a real React renderer.
// Only native drawing, navigation, the device location and the address
// mutations are stand-ins. Coordinates are made up (Georgetown area).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  location: { latitude: null as number | null, longitude: null as number | null, status: 'unknown' as string },
  params: {} as Record<string, unknown>,
  navigate: vi.fn(),
  goBack: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  map: { initialRegion: null as null | { latitude: number; longitude: number }, pan: null as null | ((r: { latitude: number; longitude: number }) => void) },
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const View = (p: any) => h('div', null, p.children);
  const Pressable = (p: any) => h('div', { role: 'button', 'data-testid': p.testID, onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return { View, Text: View, Pressable, ScrollView: View, KeyboardAvoidingView: View, Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default } };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  const MapView = R.forwardRef((p: any, _ref: any) => {
    fx.map.initialRegion = p.initialRegion;
    fx.map.pan = (region) => p.onRegionChangeComplete?.({ ...region, latitudeDelta: 0.01, longitudeDelta: 0.01 });
    return R.createElement('div', { 'data-map': '' });
  });
  return { __esModule: true, default: MapView };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: fx.navigate, goBack: fx.goBack }),
  useRoute: () => ({ params: fx.params }),
}));
vi.mock('../../../components/MapCredits', () => ({ MapCredits: () => null }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => fx.location }));
vi.mock('../../../hooks/customer', () => ({
  useAddAddress: () => ({ mutate: fx.add, isPending: false, isError: false }),
  useUpdateAddress: () => ({ mutate: fx.update, isPending: false, isError: false }),
}));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    T: (p: any) => h('span', null, p.children),
    Screen: (p: any) => h('main', null, p.children),
    Header: (p: any) => h('h1', null, p.title),
    LabeledInput: (p: any) => h('input', { 'aria-label': p.label, value: p.value ?? '', onChange: (e: any) => p.onChangeText?.(e.target.value) }),
    BrandSwitch: (p: any) => h('button', { type: 'button', role: 'switch', 'aria-label': p.label, 'aria-checked': !!p.value, onClick: () => p.onChange(!p.value) }),
    CircleChip: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }),
    PillButton: (p: any) => h('button', { type: 'button', 'data-pill': '', disabled: !!(p.disabled || p.loading), onClick: p.disabled || p.loading ? undefined : p.onPress }, p.label),
  };
});

import { AddAddressScreen } from './AddAddressScreen';
import { LocationPickerScreen } from './LocationPickerScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
}
async function show(screen: React.ComponentType) {
  await act(async () => root.render(React.createElement(screen)));
  await settle();
}
const text = () => host.textContent ?? '';
const pill = () => host.querySelector('[data-pill]') as HTMLButtonElement;
async function type(label: string, value: string) {
  const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
    setter.call(input, value);
    const DomEvent = (input.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event;
    input.dispatchEvent(new DomEvent('input', { bubbles: true }));
  });
}
async function tap(el: Element | null) {
  expect(el, 'the control is on screen').toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
  await settle();
}
const pinRow = () => Array.from(host.querySelectorAll('[role="button"]')).find((el) => /pin/i.test(el.textContent ?? '')) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  fx.location = { latitude: 6.8121, longitude: -58.1432, status: 'granted' };
  fx.params = {};
  fx.map.initialRegion = null; fx.map.pan = null;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[PINS] a new saved address is the pin its owner confirmed', () => {
  it('the phone’s position is never taken as the pin unseen: Save waits for the map, and saves the confirmed point', async () => {
    await show(AddAddressScreen);
    await type('Label', 'Work');
    await type('Street Address', 'Lot 3 Example Road');

    // The phone has a live fix, but nobody has looked at a map yet.
    expect(text()).toContain('Drop the pin on the map');
    expect(text()).not.toContain('Pin set on the map');
    expect(pill().textContent).toBe('Drop the pin on the map');
    expect(pill().disabled).toBe(true);
    await tap(pill());
    expect(fx.add).not.toHaveBeenCalled();

    // The map row opens the picker with no pin of its own (it starts where the phone is).
    await tap(pinRow());
    const [name, params] = fx.navigate.mock.calls.at(-1)!;
    expect(name).toBe('LocationPicker');
    expect(params).toEqual({ returnTo: 'AddAddress', initial: null });

    // The picker hands back the confirmed point.
    fx.params = { picked: { latitude: 6.8150, longitude: -58.1401 } };
    await show(AddAddressScreen);
    expect(text()).toContain('Pin set on the map');
    expect(pill().textContent).toBe('Save Address');
    await tap(pill());
    expect(fx.add).toHaveBeenCalledTimes(1);
    expect(fx.add.mock.calls[0]![0]).toMatchObject({ label: 'Work', addressLine1: 'Lot 3 Example Road', latitude: 6.8150, longitude: -58.1401, isDefault: true });
  });

  it('an edited address keeps ITS pin, opens the picker on it, and is saved with it', async () => {
    fx.params = { address: { id: 'a1', label: 'Home', addressLine1: 'Lot 1 Example Street', city: 'Georgetown', latitude: 6.8, longitude: -58.1, isDefault: true } };
    await show(AddAddressScreen);
    expect(text()).toContain('6.80000, -58.10000');
    await tap(pinRow());
    expect(fx.navigate.mock.calls.at(-1)).toEqual(['LocationPicker', { returnTo: 'AddAddress', initial: { latitude: 6.8, longitude: -58.1 } }]);
    await tap(pill());
    expect(fx.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', data: expect.objectContaining({ latitude: 6.8, longitude: -58.1 }) }), expect.anything());
  });
});

describe('[PINS · WR-015] the address picker confirms only a place its owner could see', () => {
  it('a live fix (permission granted) opens the map there and can be confirmed as is', async () => {
    fx.params = { returnTo: 'AddAddress' };
    await show(LocationPickerScreen);
    expect(fx.map.initialRegion).toMatchObject({ latitude: 6.8121, longitude: -58.1432 });
    await tap(pill());
    expect(fx.navigate).toHaveBeenCalledWith({ name: 'AddAddress', params: { picked: { latitude: 6.8121, longitude: -58.1432 } }, merge: true });
  });

  it('where the phone LAST was (no live permission) is only a start: Confirm waits for a move', async () => {
    fx.location = { latitude: 6.79, longitude: -58.16, status: 'denied' };
    fx.params = { returnTo: 'AddAddress' };
    await show(LocationPickerScreen);
    expect(fx.map.initialRegion).toMatchObject({ latitude: 6.79, longitude: -58.16 });
    expect(text()).toContain('This is where your phone last was, not where it is now — move the map to your spot first.');
    expect(pill().disabled).toBe(true);
    await act(async () => { fx.map.pan!({ latitude: 6.79, longitude: -58.16 }); }); // the mount report is not a move
    expect(pill().disabled).toBe(true);
    await act(async () => { fx.map.pan!({ latitude: 6.7915, longitude: -58.16 }); });
    expect(pill().disabled).toBe(false);
    await tap(pill());
    expect(fx.navigate).toHaveBeenCalledWith({ name: 'AddAddress', params: { picked: { latitude: 6.7915, longitude: -58.16 } }, merge: true });
  });

  it('no location at all: the Georgetown centre is never a pin by itself', async () => {
    fx.location = { latitude: null, longitude: null, status: 'unknown' };
    await show(LocationPickerScreen);
    expect(text()).toContain('This is a city-centre starting point — move the map to your spot first.');
    expect(pill().disabled).toBe(true);
  });
});
