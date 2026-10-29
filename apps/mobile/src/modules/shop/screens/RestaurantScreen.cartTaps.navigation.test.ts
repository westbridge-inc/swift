/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct · owner: "every single button tap"] The store page's + (the customer's most frequent tap).
// Before: while ANY add or +/- was on its way, EVERY + on the page was disabled (one shared "busy"), and the number
// moved only after the write and the cart's re-quote. Now the number moves at the tap and the other items' + stay
// free (hooks/useCartSteppers, pinned in useCartSteppers.navigation.test.ts). The REAL RestaurantScreen; the cart
// writes are stand-ins that stay on their way (the shared hook's isPending is true, as while an add is out).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  route: { name: 'Restaurant', params: { vendorId: 'a' } } as any,
  vendors: {} as Record<string, unknown>,
  lines: [] as Array<{ id: string; itemId: string; quantity: number }>,
  writes: [] as Array<[string, unknown]>,
  report: vi.fn(),
  navigate: vi.fn(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, ScrollView: View, Pressable: View, TextInput: () => null,
    FlatList: (p: any) => R.createElement('div', null, (p.data ?? []).map((item: any, i: number) => R.createElement(R.Fragment, { key: i }, p.renderItem({ item, index: i })))),
    Dimensions: { get: () => ({ width: 390, height: 844 }) }, Linking: { openURL: vi.fn() }, Share: { share: vi.fn() },
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({ useRoute: () => fx.route, useNavigation: () => ({ navigate: fx.navigate, goBack: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@swift/ui', () => ({ color: fx.token, font: fx.token, fontSize: fx.token, radius: fx.token, space: fx.token, withAlpha: () => 'c' }));
vi.mock('../../../hooks/customer', () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false });
  // A cart write that is still out (isPending true, as the shared hook reads while ANY add is on its way).
  const out = (kind: string) => () => ({
    isPending: true,
    mutate: (body: unknown) => { fx.writes.push([kind, body]); },
    mutateAsync: (body: unknown) => { fx.writes.push([kind, body]); return new Promise(() => {}); },
  });
  return {
    useVendor: (id: string) => ({ data: fx.vendors[id], isLoading: false, isError: false, refetch: vi.fn() }),
    useCart: () => ({ data: { items: fx.lines }, dataUpdatedAt: 1 }),
    useReportContent: () => ({ mutate: fx.report, isPending: false }),
    useToggleFavorite: idle, useAddToCart: out('add'), useUpdateCartItem: out('set'),
  };
});
vi.mock('../../../kit/action-sheet', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    ActionSheet: (p: any) => p.open
      ? h('div', { role: 'dialog' }, p.actions.map((a: any) => h('button', { key: a.label, type: 'button', onClick: a.onPress }, a.label)))
      : null,
  };
});
vi.mock('../../../stores/authStore', () => {
  const state = { isAuthenticated: true, wantsAuth: false, promptLogin: vi.fn() };
  return { useAuthStore: (select?: (s: typeof state) => unknown) => (select ? select(state) : state) };
});
vi.mock('../../../navigation/authContinuation', () => ({ requestAuthContinuation: vi.fn() }));
// [IMAGES-E2E #1909] The store hero asks for the hero width (1280 px variant).
// [IMAGES-E2E #1973] Each menu section can carry its photo (SectionPhotoHeader): no photo here, so the plain
// section header shows; the native image view is not loaded.
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('../../../lib/images', () => ({ HERO_PHOTO_WIDTH: 1280, LIST_PHOTO_WIDTH: 640, categoryPhoto: () => null, itemPhoto: () => null, vendorPhoto: () => null }));
vi.mock('../../../components/SellerInfo', () => ({ SellerInfo: () => null }));
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../kit/scrim', () => ({ Scrim: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  const Nothing = () => null;
  return {
    // The mart grid's tile stepper: its number and its + (the restaurant rows use MenuRow below).
    AddMorph: (p: any) => h('div', { 'data-tile-qty': String(p.qty) }, h('button', { type: 'button', 'aria-label': 'Tile +', onClick: p.qty > 0 ? p.onInc : p.onAdd }, '+')),
    CartBar: Nothing, useCartBarClearance: () => 0, ErrorState: Nothing, FoodCard: Nothing,
    HeartBadge: Nothing, IconChip: Nothing, LoadingBlock: Nothing, Money: Nothing, Photo: Nothing, TonePill: Nothing,
    PopupCard: (p: any) => (p.visible ? h('div', null, p.children) : null), PopupTitle: Box,
    T: (p: any) => h('span', null, p.children), SectionHeader: (p: any) => h('h3', null, p.title),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
    Chip: (p: any) => h('button', { type: 'button', 'data-chip': p.label, 'aria-pressed': p.selected ? 'true' : 'false', onClick: p.onPress }, p.label),
    CircleChip: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }),
    MenuRow: (p: any) => h('div', { 'data-menu-row': p.name, 'data-qty': String(p.qty), 'data-busy': String(!!p.busy) },
      h('button', { type: 'button', 'aria-label': `Add ${p.name}`, disabled: !!p.busy, onClick: p.qty > 0 ? p.onInc : p.onAdd }, '+'),
      h('button', { type: 'button', 'aria-label': `Less ${p.name}`, disabled: !!p.busy, onClick: p.onDec }, '-')),
  };
});

import { RestaurantScreen } from './RestaurantScreen';
import { forgetCartSteppers } from '../../../hooks/useCartSteppers';

const store = { id: 'a', name: 'Store a', vendorType: 'RESTAURANT', isCurrentlyOpen: true, operatingHours: [], activePromos: [],
  categories: [{ id: 'a-mains', name: 'Mains', items: [{ id: 'curry', name: 'Curry chicken', basePrice: 1000 }, { id: 'pepperpot', name: 'Pepperpot', basePrice: 1200 }] }] };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const row = (name: string) => host.querySelector(`[data-menu-row="${name}"]`)!;
const click = async (el: Element) => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });

beforeEach(async () => {
  vi.clearAllMocks();
  forgetCartSteppers(); // one stepper per line for the whole app: none carried over from another test
  fx.vendors = { a: store };
  fx.lines = [{ id: 'line-curry', itemId: 'curry', quantity: 1 }];
  fx.writes = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(React.createElement(RestaurantScreen)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[TAP-AUDIT] the store page\'s + answers at the tap', () => {
  it('while a cart write is out, every other item\'s + stays free', async () => {
    expect(row('Curry chicken').getAttribute('data-busy')).toBe('false');
    expect(row('Pepperpot').getAttribute('data-busy')).toBe('false');
  });

  it('the number moves at the tap, and a second + adds up (sent once the cart is read again)', async () => {
    expect(row('Curry chicken').getAttribute('data-qty')).toBe('1');
    await click(row('Curry chicken').querySelector('[aria-label="Add Curry chicken"]')!);
    expect(row('Curry chicken').getAttribute('data-qty')).toBe('2');
    await click(row('Curry chicken').querySelector('[aria-label="Add Curry chicken"]')!);
    expect(row('Curry chicken').getAttribute('data-qty')).toBe('3');
    expect(fx.writes).toEqual([['set', { id: 'line-curry', quantity: 2 }]]);
  });

  it('an item not in the cart: + shows 1 at once and adds it; another item\'s + goes out too', async () => {
    await click(row('Pepperpot').querySelector('[aria-label="Add Pepperpot"]')!);
    expect(row('Pepperpot').getAttribute('data-qty')).toBe('1');
    await click(row('Curry chicken').querySelector('[aria-label="Add Curry chicken"]')!);
    expect(fx.writes).toEqual([['add', { vendorId: 'a', itemId: 'pepperpot', quantity: 1 }], ['set', { id: 'line-curry', quantity: 2 }]]);
  });
});

describe('[BOOK-POLISH · #2205] a booking on the store page has no + / −', () => {
  // A store that lists a booking (an APPOINTMENT listing) among its goods: its + opens the booking screen (pick a
  // time) and never sets a quantity, even with the booking already in the cart.
  const massage = { id: 'massage', name: 'Chair massage', basePrice: 3000, fulfillment: 'APPOINTMENT' };
  const draw = async (vendor: Record<string, unknown>) => {
    fx.vendors = { a: vendor };
    await act(async () => root.render(React.createElement('div', null)));
    await act(async () => root.render(React.createElement(RestaurantScreen)));
  };

  it('menu row: shows no quantity; + opens the booking screen and writes nothing', async () => {
    fx.lines = [{ id: 'line-massage', itemId: 'massage', quantity: 1 }];
    await draw({ ...store, categories: [{ id: 'a-mains', name: 'Mains', items: [massage, { id: 'curry', name: 'Curry chicken', basePrice: 1000 }] }] });
    expect(row('Chair massage').getAttribute('data-qty')).toBe('0');
    await click(row('Chair massage').querySelector('[aria-label="Add Chair massage"]')!);
    expect(fx.navigate).toHaveBeenCalledWith('MenuItem', { vendorId: 'a', itemId: 'massage' });
    expect(fx.writes).toEqual([]);
    expect(row('Chair massage').getAttribute('data-qty')).toBe('0');
  });

  it('control: a goods row beside it keeps its stepper', async () => {
    fx.lines = [{ id: 'line-curry', itemId: 'curry', quantity: 1 }];
    await draw({ ...store, categories: [{ id: 'a-mains', name: 'Mains', items: [massage, { id: 'curry', name: 'Curry chicken', basePrice: 1000 }] }] });
    expect(row('Curry chicken').getAttribute('data-qty')).toBe('1');
  });

  it('shop grid tile: shows no quantity; + opens the booking screen and writes nothing', async () => {
    fx.lines = [{ id: 'line-massage', itemId: 'massage', quantity: 1 }];
    await draw({ ...store, vendorType: 'STORE', categories: [{ id: 'a-aisle', name: 'Aisle', items: [massage] }] });
    const tile = host.querySelector('[data-tile-qty]')!;
    expect(tile.getAttribute('data-tile-qty')).toBe('0');
    await click(tile.querySelector('[aria-label="Tile +"]')!);
    expect(fx.navigate).toHaveBeenCalledWith('MenuItem', { vendorId: 'a', itemId: 'massage' });
    expect(fx.writes).toEqual([]);
  });

  it('control: a goods tile keeps its quantity', async () => {
    fx.lines = [{ id: 'line-curry', itemId: 'curry', quantity: 2 }];
    await draw({ ...store, vendorType: 'STORE', categories: [{ id: 'a-aisle', name: 'Aisle', items: [{ id: 'curry', name: 'Curry chicken', basePrice: 1000 }] }] });
    expect(host.querySelector('[data-tile-qty]')!.getAttribute('data-tile-qty')).toBe('2');
  });
});
