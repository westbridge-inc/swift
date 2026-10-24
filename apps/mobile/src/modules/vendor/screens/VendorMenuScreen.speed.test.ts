import { beforeEach, describe, expect, it, vi } from 'vitest';

// [SPEED 22 Oct · owner: "switching the tabs from Orders to Products is slow"] The store's
// Products/Menu tab used to build EVERY item row of every section before it could show
// (a plain ScrollView: categories.map -> items.map -> MenuItemRow). It now hands the rows to
// a windowed list: the first batch is drawn at once, the rest as the owner scrolls. Same menu
// read, same rows, same order, same section filter. As in VendorMenuScreen.photos.test.ts the
// screen is called as a function (no RN renderer) and its element tree is inspected.

vi.hoisted(() => { (globalThis as { __DEV__?: boolean }).__DEV__ = false; });
const h = vi.hoisted(() => ({
  state: [] as unknown[],
  at: 0,
  menu: [] as unknown[],
  refetch: vi.fn(),
}));

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const slot = h.at++;
    if (!(slot in h.state)) h.state[slot] = initial;
    return [h.state[slot], (next: unknown) => { h.state[slot] = next; }];
  },
  useEffect: () => undefined,
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
}));
vi.mock('react-native', () => ({ FlatList: 'FlatList', Pressable: 'Pressable', RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', View: 'View' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({
  color: { brand: {}, text: {}, surface: {}, soft: {}, warning: 'warning', error: 'error', white: 'white', scrim: 'scrim' },
  radius: {}, space: {},
}));
vi.mock('../../../kit', () => ({
  Card: 'Card', Chip: 'Chip', EmptyState: 'EmptyState', ErrorState: 'ErrorState', IconChip: 'IconChip', LoadingBlock: 'LoadingBlock',
  PillButton: 'PillButton', PopupCard: 'PopupCard', PopupTitle: 'PopupTitle', Screen: 'Screen', T: 'T', TonePill: 'TonePill',
}));
vi.mock('../../../kit/switch', () => ({ Switch: 'Switch' }));
vi.mock('../shared', () => ({
  GUTTER: 0, InlineInput: 'InlineInput', SubHeader: 'SubHeader',
  catalogueMeta: () => ({ label: 'Products', catPlaceholder: 'e.g. Drinks' }), safeVendorRole: () => 'OWNER',
  numericFact: (v: unknown) => (typeof v === 'number' ? v : null),
}));
vi.mock('../../../hooks/vendorops', () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useVendorProfile: () => ({ owner: { myRole: 'OWNER' }, store: { vendorType: 'STORE' } }),
    useVendorMenu: () => ({ data: h.menu, isLoading: false, isError: false, refetch: h.refetch }),
    useCreateCategory: mutation, useUpdateCategory: mutation, useDeleteCategory: mutation,
    useDeleteItem: mutation, useSetItemAvailability: mutation, useUploadCategoryPhoto: mutation, useRemoveCategoryPhoto: mutation,
  };
});
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false, onRefresh: async () => undefined }) }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (pick: (s: { previewType: null }) => unknown) => pick({ previewType: null }) }));
vi.mock('../../../lib/images', () => ({ isKeptPhoto: () => false, storePhotoUrl: (key: string) => key }));

import { CategoryHeader, MenuItemRow, VendorMenuScreen } from './VendorMenuScreen';
import { MENU_LIST_WINDOW } from '../../../lib/listPerformance';

function all(node: any, match: (n: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) all(n, match, out); return out; }
  if (match(node)) out.push(node);
  for (const value of Object.values(node.props ?? {})) {
    if (typeof value === 'function') continue;
    all(value, match, out);
  }
  return out;
}
const ofType = (tree: any, type: unknown) => all(tree, (n) => n.type === type);
const textOf = (n: any) => [n.props.children].flat(Infinity).filter((c) => typeof c === 'string' || typeof c === 'number').join('');

const SECTIONS = 3;
const PER_SECTION = 70;
const menu = () => Array.from({ length: SECTIONS }, (_, s) => ({
  id: `c${s}`, name: `Aisle ${s}`, imageUrl: null,
  items: Array.from({ length: PER_SECTION }, (_, i) => ({ id: `c${s}-i${i}`, name: `Product ${s}.${i}`, basePrice: 500 + i, isAvailable: i % 10 !== 0, stockQuantity: null })),
}));
const draw = () => { h.at = 0; return VendorMenuScreen({ navigation: { navigate: vi.fn() } }); };
const list = (tree: any) => { const found = ofType(tree, 'FlatList'); expect(found).toHaveLength(1); return found[0]; };
const rowsOf = (flat: any) => (flat.props.data as any[]).map((row, index) => flat.props.renderItem({ item: row, index }));

beforeEach(() => {
  h.state = [];
  h.menu = menu();
  h.refetch.mockClear();
});

describe('the store\'s Products tab draws a window of rows, not the whole catalogue', () => {
  it('builds no item row up front: 210 items go to a windowed list with a small first batch', () => {
    const tree = draw();
    expect(ofType(tree, MenuItemRow)).toHaveLength(0);
    expect(ofType(tree, 'ScrollView').filter((s) => !s.props.horizontal)).toHaveLength(0);
    const flat = list(tree);
    expect(flat.props).toMatchObject(MENU_LIST_WINDOW);
    expect(MENU_LIST_WINDOW.initialNumToRender).toBeLessThanOrEqual(10);
    expect(typeof flat.props.keyExtractor).toBe('function');
    const keys = (flat.props.data as any[]).map((row, i) => flat.props.keyExtractor(row, i));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps every row, in menu order: each section header, then its items', () => {
    const flat = list(draw());
    const drawn = rowsOf(flat).flatMap((el) => all(el, (n) => n.type === MenuItemRow || n.type === CategoryHeader));
    const order = drawn.map((el) => (el.type === CategoryHeader ? `#${el.props.cat.id}` : el.props.item.id));
    const expected = menu().flatMap((c) => [`#${c.id}`, ...c.items.map((i) => i.id)]);
    expect(order).toEqual(expected);
    const row = drawn.find((el) => el.type === MenuItemRow)!;
    expect(row.props).toMatchObject({ canEdit: true, categories: menu().map((c) => ({ id: c.id, name: c.name })) });
  });

  it('a section chip still shows only that section', () => {
    let tree = draw();
    const chip = ofType(tree, 'Chip').find((c) => String(c.props.label).startsWith('Aisle 1'));
    chip.props.onPress();
    tree = draw();
    const ids = rowsOf(list(tree)).flatMap((el) => all(el, (n) => n.type === MenuItemRow)).map((el) => el.props.item.id);
    expect(ids).toHaveLength(PER_SECTION);
    expect(ids.every((id) => id.startsWith('c1-'))).toBe(true);
  });

  it('an empty section still says so, the counts and the pull-to-refresh stay', () => {
    h.menu = [{ id: 'c9', name: 'Empty aisle', imageUrl: null, items: [] }, ...menu()];
    const tree = draw();
    const flat = list(tree);
    expect(rowsOf(flat).flatMap((el) => all(el, (n) => n.type === 'T')).map(textOf)).toContain('No items yet.');
    const header = all(flat.props.ListHeaderComponent, (n) => n.type === 'T').map(textOf);
    expect(header).toContain('189 active · 21 sold out');
    expect(flat.props.refreshControl.type).toBe('RefreshControl');
  });
});
