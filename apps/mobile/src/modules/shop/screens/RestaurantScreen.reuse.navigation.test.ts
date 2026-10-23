/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [UI-SWEEP U10 · REVIEW-F #1902 S3-1] A store link or QR for store B goes
// BACK to a store page already in the stack (navigate + pop) and hands that
// SAME mounted page store B. The page's local choices used to survive: store
// A's menu section filtered store B's menu down to nothing, and an open
// "Report this store" sheet for A filed its report against B. The REAL
// RestaurantScreen on a real React renderer; only native drawing, the kit,
// the store read and the network are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  route: { name: 'Restaurant', params: {} as Record<string, unknown> },
  vendors: {} as Record<string, any>,
  report: vi.fn(),
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
vi.mock('@react-navigation/native', () => ({ useRoute: () => fx.route, useNavigation: () => ({ navigate: vi.fn(), goBack: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@swift/ui', () => ({ color: fx.token, font: fx.token, fontSize: fx.token, radius: fx.token, space: fx.token, withAlpha: () => 'c' }));
vi.mock('../../../hooks/customer', () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useVendor: (id: string) => ({ data: fx.vendors[id], isLoading: false, isError: false, refetch: vi.fn() }),
    useCart: () => ({ data: undefined }),
    useReportContent: () => ({ mutate: fx.report, isPending: false }),
    useToggleFavorite: idle, useAddToCart: idle, useUpdateCartItem: idle,
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
    AddMorph: Nothing, CartBar: Nothing, useCartBarClearance: () => 0, ErrorState: Nothing, FoodCard: Nothing,
    HeartBadge: Nothing, IconChip: Nothing, LoadingBlock: Nothing, Money: Nothing, Photo: Nothing, TonePill: Nothing,
    PopupCard: (p: any) => (p.visible ? h('div', null, p.children) : null), PopupTitle: Box,
    T: (p: any) => h('span', null, p.children), SectionHeader: (p: any) => h('h3', null, p.title),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
    Chip: (p: any) => h('button', { type: 'button', 'data-chip': p.label, 'aria-pressed': p.selected ? 'true' : 'false', onClick: p.onPress }, p.label),
    CircleChip: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }),
    MenuRow: (p: any) => h('div', { 'data-menu-row': p.name }, p.name),
  };
});

import { RestaurantScreen } from './RestaurantScreen';

const store = (id: string, sections: Array<[string, string[]]>) => ({
  id, name: `Store ${id}`, vendorType: 'RESTAURANT', isCurrentlyOpen: true, operatingHours: [], activePromos: [],
  categories: sections.map(([name, items]) => ({
    id: `${id}-${name}`, name, items: items.map((item) => ({ id: `${id}-${item}`, name: item, basePrice: 1000 })),
  })),
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const menuRows = () => Array.from(host.querySelectorAll('[data-menu-row]')).map((n) => n.getAttribute('data-menu-row'));
const click = async (el: Element) => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
/** React Navigation re-renders the SAME mounted page with the new route (navigate + pop). */
async function show(vendorId: string) {
  fx.route = { ...fx.route, params: { vendorId } };
  await act(async () => root.render(React.createElement(RestaurantScreen)));
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.vendors = {
    a: store('a', [['Mains', ['Curry chicken', 'Pepperpot']], ['Drinks', ['Mauby']]]),
    b: store('b', [['Breakfast', ['Bake and saltfish']], ['Juices', ['Sorrel']]]),
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[UI-SWEEP U10 S3-1] a store page, reused for another store, starts on that store', () => {
  it('store A’s menu section never empties store B’s menu', async () => {
    await show('a');
    await click(host.querySelector('[data-chip="Drinks"]')!);
    expect(menuRows()).toEqual(['Mauby']);

    await show('b');

    expect(menuRows(), 'store B’s whole menu is shown').toEqual(['Bake and saltfish', 'Sorrel']);
    expect(host.querySelector('[data-chip="Full menu"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('a Report sheet opened on store A is closed on store B, so no report is filed against B by mistake', async () => {
    await show('a');
    await click(host.querySelector('[aria-label="Report this store"]')!);
    expect(host.querySelector('[role="dialog"]'), 'the report sheet is open on A').not.toBeNull();

    await show('b');

    expect(host.querySelector('[role="dialog"]'), 'no sheet carries across to B').toBeNull();
    expect(fx.report).not.toHaveBeenCalled();
  });

  it('the SAME store handed again keeps the chosen menu section (no reset without a new store)', async () => {
    await show('a');
    await click(host.querySelector('[data-chip="Drinks"]')!);
    await show('a');
    expect(menuRows()).toEqual(['Mauby']);
  });
});
