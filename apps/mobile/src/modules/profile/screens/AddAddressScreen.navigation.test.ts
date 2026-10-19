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
  popTo: vi.fn(),
  /** Set by the real-router stack below: the screen being drawn reads its own route from it. */
  stack: null as null | { route(key: string): unknown; navigation(key: string): unknown },
  RouteKey: null as unknown,
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
vi.mock('@react-navigation/native', async () => {
  const R = await import('react');
  const RouteKey = R.createContext('');
  fx.RouteKey = RouteKey;
  // Inside a simulated stack a screen gets ITS route and a navigation object
  // backed by the installed library's real stack router; alone, plain spies.
  return {
    useNavigation: () => { const key = R.useContext(RouteKey); return key && fx.stack ? fx.stack.navigation(key) : { navigate: fx.navigate, goBack: fx.goBack, popTo: fx.popTo }; },
    useRoute: () => { const key = R.useContext(RouteKey); return key && fx.stack ? fx.stack.route(key) : { params: fx.params }; },
  };
});
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

import { createRequire } from 'node:module';
import { AddAddressScreen } from './AddAddressScreen';
import { LocationPickerScreen } from './LocationPickerScreen';

// The installed navigation library's pure stack router (as storefrontEntry.test.ts loads it).
const fromNative = createRequire(import.meta.resolve('@react-navigation/native'));
const fromCore = createRequire(fromNative.resolve('@react-navigation/core'));
const { StackRouter } = await import(fromCore.resolve('@react-navigation/routers')) as Pick<typeof import('@react-navigation/native'), 'StackRouter'>;
type StackRoute = { key: string; name: string; params?: Record<string, unknown> };

/** A customer stack driven by the real router: navigate/popTo/goBack dispatch real actions. */
function realStack(names: Array<string | { name: string; params: object }>) {
  const router = StackRouter({});
  const options = { routeNames: ['Tabs', 'Addresses', 'AddAddress', 'LocationPicker'], routeParamList: {}, routeGetIdList: {} };
  let state = router.getInitialState(options);
  const dispatch = (action: { type: string; payload?: object; source?: string }) => {
    const next = router.getStateForAction(state, { ...action, target: state.key } as never, options);
    expect(next, `the stack handles ${action.type}`).toBeTruthy();
    state = router.getRehydratedState(next as never, options);
  };
  for (const entry of names.slice(1)) dispatch({ type: 'PUSH', payload: typeof entry === 'string' ? { name: entry } : entry });
  const routes = () => state.routes as unknown as StackRoute[];
  const stack = {
    names: () => routes().map((r) => r.name),
    focused: () => routes()[state.index]!,
    route: (key: string) => routes().find((r) => r.key === key) ?? { key, params: {} },
    navigation: (key: string) => ({
      navigate: (to: string | { name: string; params?: object; merge?: boolean }, params?: object) => dispatch({
        type: 'NAVIGATE', payload: typeof to === 'string' ? { name: to, params } : { name: to.name, params: to.params, merge: to.merge }, source: key,
      }),
      popTo: (name: string, params?: object, opts?: { merge?: boolean }) => dispatch({ type: 'POP_TO', payload: { name, params, merge: opts?.merge }, source: key }),
      goBack: () => dispatch({ type: 'GO_BACK', source: key }),
    }),
  };
  fx.stack = stack;
  return stack;
}
/** Draw the screen of a stack route into a root (re-drawing keeps that screen's state). */
async function drawRoute(into: ReturnType<typeof createRoot>, key: string, screen: React.ComponentType) {
  const Provider = (fx.RouteKey as React.Context<string>).Provider;
  await act(async () => into.render(React.createElement(Provider, { value: key }, React.createElement(screen))));
  await settle();
}

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
  fx.map.initialRegion = null; fx.map.pan = null; fx.stack = null;
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
    expect(fx.popTo).toHaveBeenCalledWith('AddAddress', { picked: { latitude: 6.8121, longitude: -58.1432 } }, { merge: true });
    expect(fx.navigate).not.toHaveBeenCalled();
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
    expect(fx.popTo).toHaveBeenCalledWith('AddAddress', { picked: { latitude: 6.7915, longitude: -58.16 } }, { merge: true });
    expect(fx.navigate).not.toHaveBeenCalled();
  });

  it('no location at all: the Georgetown centre is never a pin by itself', async () => {
    fx.location = { latitude: null, longitude: null, status: 'unknown' };
    await show(LocationPickerScreen);
    expect(text()).toContain('This is a city-centre starting point — move the map to your spot first.');
    expect(pill().disabled).toBe(true);
  });
});

describe('[PINS] after the pin, the person is back on THEIR address form, and Save returns to the list', () => {
  it('Confirm pops back to the form they filled in (one form, its words kept); Save then lands on My Addresses', async () => {
    const stack = realStack(['Tabs', 'Addresses', 'AddAddress']);
    const form = stack.focused().key;
    await drawRoute(root, form, AddAddressScreen);
    await type('Label', 'Work');
    await type('Street Address', 'Lot 3 Example Road');
    await tap(pinRow());
    expect(stack.names()).toEqual(['Tabs', 'Addresses', 'AddAddress', 'LocationPicker']);

    const pickerHost = document.createElement('div'); document.body.append(pickerHost);
    const picker = createRoot(pickerHost);
    await drawRoute(picker, stack.focused().key, LocationPickerScreen);
    await act(async () => { (pickerHost.querySelector('[data-pill]') as HTMLButtonElement).click(); });
    await act(async () => picker.unmount()); pickerHost.remove();

    // Back on the SAME form: no second, empty copy pushed on top of the picker.
    expect(stack.names()).toEqual(['Tabs', 'Addresses', 'AddAddress']);
    expect(stack.focused().key).toBe(form);
    expect(stack.focused().params).toEqual({ picked: { latitude: 6.8121, longitude: -58.1432 } });
    await drawRoute(root, form, AddAddressScreen);
    expect((host.querySelector('input[aria-label="Label"]') as HTMLInputElement).value).toBe('Work');
    expect((host.querySelector('input[aria-label="Street Address"]') as HTMLInputElement).value).toBe('Lot 3 Example Road');
    expect(text()).toContain('Pin set on the map');

    await tap(pill());
    expect(fx.add).toHaveBeenCalledTimes(1);
    expect(fx.add.mock.calls[0]![0]).toMatchObject({ label: 'Work', addressLine1: 'Lot 3 Example Road', latitude: 6.8121, longitude: -58.1432 });
    await act(async () => { (fx.add.mock.calls[0]![1] as { onSuccess: () => void }).onSuccess(); });
    expect(stack.names()).toEqual(['Tabs', 'Addresses']);
  });

  it('an edited address comes back to its own form too: the pin merges in, the address being edited is kept', async () => {
    const address = { id: 'a1', label: 'Home', addressLine1: 'Lot 1 Example Street', city: 'Georgetown', latitude: 6.8, longitude: -58.1, isDefault: true };
    const stack = realStack(['Tabs', 'Addresses', { name: 'AddAddress', params: { address } }]);
    const form = stack.focused().key;
    await drawRoute(root, form, AddAddressScreen);
    await tap(pinRow());
    const pickerHost = document.createElement('div'); document.body.append(pickerHost);
    const picker = createRoot(pickerHost);
    await drawRoute(picker, stack.focused().key, LocationPickerScreen);
    await act(async () => { fx.map.pan!({ latitude: 6.8012, longitude: -58.1 }); });
    await act(async () => { (pickerHost.querySelector('[data-pill]') as HTMLButtonElement).click(); });
    await act(async () => picker.unmount()); pickerHost.remove();
    expect(stack.names()).toEqual(['Tabs', 'Addresses', 'AddAddress']);
    expect(stack.focused().params).toEqual({ address, picked: { latitude: 6.8012, longitude: -58.1 } });
    await drawRoute(root, form, AddAddressScreen);
    await tap(pill());
    expect(fx.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', data: expect.objectContaining({ latitude: 6.8012, longitude: -58.1 }) }), expect.anything());
    await act(async () => { (fx.update.mock.calls[0]![1] as { onSuccess: () => void }).onSuccess(); });
    expect(stack.names()).toEqual(['Tabs', 'Addresses']);
  });

  it('Back from the picker returns to the form without a pin', async () => {
    const stack = realStack(['Tabs', 'Addresses', 'AddAddress', 'LocationPicker']);
    await drawRoute(root, stack.focused().key, LocationPickerScreen);
    await tap(host.querySelector('button[aria-label="Back"]'));
    expect(stack.names()).toEqual(['Tabs', 'Addresses', 'AddAddress']);
    expect(stack.focused().params).toBeUndefined();
  });

  it('opened from Home (no form below it), Confirm replaces the picker with the form, so Save goes back Home', async () => {
    const stack = realStack(['Tabs', 'LocationPicker']);
    await drawRoute(root, stack.focused().key, LocationPickerScreen);
    await tap(pill());
    expect(stack.names()).toEqual(['Tabs', 'AddAddress']);
    expect(stack.focused().params).toEqual({ picked: { latitude: 6.8121, longitude: -58.1432 } });
  });
});
