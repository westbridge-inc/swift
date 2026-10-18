/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// Owner screenshot, 17 Oct (search "Garlic"): the "Open now" row and the
// suggestion chips under it had their bottoms cut off. React Native gives a
// ScrollView `flexShrink: 1` and `overflow: scroll`, and the screen is one flex
// column whose results list measures as tall as its content, so the column
// overflows and squeezes every shrinkable row; the squeezed horizontal row
// then clips its chips. A chip with a fixed `height` clips the same way once
// the phone's text size is turned up.
//
// This renders the REAL screen and the REAL kit Chip. Native drawing is a
// stand-in that writes each box's flattened style onto the DOM, so the test
// reads the exact style React Native would lay out.
const fx = vi.hoisted(() => ({ params: {} as Record<string, unknown> }));

vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const flatten = (s: any): Record<string, unknown> =>
    Array.isArray(s) ? Object.assign({}, ...s.map(flatten)) : s && typeof s === 'object' ? { ...s } : {};
  const kids = (p: any) => (typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  const box = (role: string) => (p: any) =>
    h('div', { 'data-rn': role, 'data-horizontal': p.horizontal ? '1' : undefined, 'data-style': JSON.stringify(flatten(p.style)) }, kids(p));
  return {
    View: box('view'),
    ScrollView: box('scroll'),
    Text: (p: any) => h('span', null, p.children),
    Pressable: (p: any) => h('button', { onClick: p.onPress, 'aria-label': p.accessibilityLabel }, kids(p)),
    TextInput: (p: any) => h('input', { value: p.value, readOnly: true }),
    FlatList: () => null,
    Switch: () => null,
    StyleSheet: { flatten, create: (x: any) => x, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 3 }),
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  };
});
vi.mock('react-native-svg', () => ({ default: () => null, Path: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: vi.fn(), goBack: vi.fn() }),
  useRoute: () => ({ params: fx.params }),
}));
vi.mock('../../../lib/haptics', () => ({ haptic: { select: vi.fn() } }));
vi.mock('../../../kit/text', async () => {
  const { createElement: h } = await import('react');
  return { T: (p: any) => h('span', null, p.children) };
});
vi.mock('../../../kit/card', () => ({ cardShadow: {} }));
vi.mock('../../../kit/action-sheet', () => ({ ActionSheet: () => null }));
vi.mock('../../../stores/appStore', () => ({ useAppStore: () => ({ recentSearches: [], pushSearch: () => {}, clearSearches: () => {} }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: null, longitude: null, status: 'denied' }) }));
vi.mock('../../../lib/images', () => ({ itemPhoto: () => undefined, vendorPhoto: () => undefined }));
vi.mock('../../../hooks/customer', () => {
  const q = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
  return {
    useHome: () => q({ popularItems: [] }),
    useVendors: () => q([]),
    useSearch: () => q({ vendors: [], items: [] }),
    useSearchSuggestions: () => q([
      { type: 'item', text: 'Garlic / Cheese Naan' },
      { type: 'item', text: 'Butter Garlice Prawns' },
      { type: 'item', text: 'Chilly Garlic Mushroom' },
    ]),
    useSearchTrending: () => q([]),
  };
});
vi.mock('../../../kit', async () => {
  const { createElement: h } = await import('react');
  const { Chip } = await vi.importActual<typeof import('../../../kit/controls')>('../../../kit/controls');
  const Box = (p: any) => h('div', null, p.children);
  return {
    Chip,
    Screen: Box, T: Box, SectionHeader: (p: any) => h('h2', null, p.title),
    CartBar: () => null, useCartBarClearance: () => 0,
    EmptyState: () => null, ErrorState: () => null, LoadingBlock: () => null,
    Money: () => null, Photo: () => null, RatingMeta: () => null,
  };
});

import { SearchScreen } from './SearchScreen';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined;
});

async function renderSearch(params: Record<string, unknown>) {
  fx.params = params;
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(SearchScreen)));
}

type Drawn = { flexShrink?: unknown; height?: unknown; minHeight?: unknown; paddingHorizontal?: unknown };
const style = (el: Element) => JSON.parse(el.getAttribute('data-style') ?? '{}') as Drawn;
const rows = () => [...host.querySelectorAll('[data-rn="scroll"][data-horizontal="1"]')];
// A chip's drawn box is the first view inside its button.
const chipBoxes = (row: Element) => [...row.querySelectorAll('button')].map((b) => b.querySelector('[data-rn="view"]')!);

function expectRowsShowWholeChips(expectedRows: number, mustContain: string[]) {
  const all = rows();
  expect(all.length).toBe(expectedRows);
  for (const label of mustContain) expect(host.textContent).toContain(label);
  for (const row of all) {
    // The row must hug its chips: never squeezed by the results below it.
    expect(style(row).flexShrink, `row "${row.textContent}" can be squeezed`).toBe(0);
    expect(style(row).height, `row "${row.textContent}" has a fixed height`).toBeUndefined();
    const boxes = chipBoxes(row);
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      const s = style(box);
      // A floor, never a ceiling: large text grows the chip instead of clipping it.
      expect(s.height, `chip "${box.textContent}" has a fixed height`).toBeUndefined();
      expect(typeof s.minHeight, `chip "${box.textContent}" lost its size floor`).toBe('number');
    }
  }
}

describe('search chip rows are never clipped (owner screenshot 17 Oct)', () => {
  it('engine search: the type row, the "Open now" row and the suggestion chips each show whole chips', async () => {
    await renderSearch({ q: 'Garlic' });
    expectRowsShowWholeChips(3, ['Open now', 'Garlic / Cheese Naan', 'Butter Garlice Prawns']);
  });

  it('browse search: the type row and the sort + "Open now" row show whole chips', async () => {
    await renderSearch({ q: 'Hardware', type: 'STORE' });
    expectRowsShowWholeChips(2, ['Open now', 'Sort']);
  });

  it('the kit Chip keeps a caller\'s size as a floor, so every chip in the app grows with text size', async () => {
    const { Chip } = await vi.importActual<typeof import('../../../kit/controls')>('../../../kit/controls');
    host = document.createElement('div'); document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(React.createElement('div', null,
      React.createElement(Chip, { label: 'Default' }),
      React.createElement(Chip, { label: 'Sized', style: { height: 36, paddingHorizontal: 12 } }),
    )));
    const [plain, sized] = [...host.querySelectorAll('button')].map((b) => style(b.querySelector('[data-rn="view"]')!));
    expect(plain!.height).toBeUndefined();
    expect(plain!.minHeight).toBe(48);
    expect(sized!.height).toBeUndefined();
    expect(sized!.minHeight).toBe(36);
    expect(sized!.paddingHorizontal).toBe(12);
  });
});
