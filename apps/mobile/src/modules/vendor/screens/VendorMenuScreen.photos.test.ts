import { beforeEach, describe, expect, it, vi } from 'vitest';

// [IMAGES-E2E PR4 · REVIEW-F S4-1 on #1965] The store's own menu screen and its photos: an item
// or section holding an outside address (saved before photos were uploaded) is named, never
// loaded; a section's photo sheet promises nothing Home may not do (REVIEW-F S3-1); removing
// a section photo asks first. The components are called as functions (no RN renderer), as in
// WithdrawStaffInvites.test.ts; useState is a small store so a second call sees the first's state.

vi.hoisted(() => { (globalThis as { __DEV__?: boolean }).__DEV__ = false; });
const h = vi.hoisted(() => ({
  state: [] as unknown[],
  at: 0,
  mutations: {} as Record<string, { mutate: ReturnType<typeof import('vitest').vi.fn>; isPending: boolean }>,
}));

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const slot = h.at++;
    if (!(slot in h.state)) h.state[slot] = initial;
    return [h.state[slot], (next: unknown) => { h.state[slot] = next; }];
  },
  useEffect: () => undefined,
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', View: 'View' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({
  color: { brand: {}, text: {}, surface: {}, warning: 'warning', error: 'error', white: 'white', scrim: 'scrim' },
  radius: {}, space: {},
}));
vi.mock('../../../kit', () => ({
  Card: 'Card', Chip: 'Chip', EmptyState: 'EmptyState', ErrorState: 'ErrorState', IconChip: 'IconChip', LoadingBlock: 'LoadingBlock',
  PillButton: 'PillButton', PopupCard: 'PopupCard', PopupTitle: 'PopupTitle', Screen: 'Screen', T: 'T', TonePill: 'TonePill',
}));
vi.mock('../../../kit/switch', () => ({ Switch: 'Switch' }));
vi.mock('../shared', () => ({
  GUTTER: 0, InlineInput: 'InlineInput', SubHeader: 'SubHeader',
  catalogueMeta: () => ({}), safeVendorRole: () => 'OWNER', numericFact: (v: unknown) => (typeof v === 'number' ? v : null),
}));
vi.mock('../../../hooks/vendorops', () => {
  const mutation = (name: string) => () => (h.mutations[name] ??= { mutate: vi.fn(), isPending: false });
  return {
  useVendorProfile: () => ({}), useVendorMenu: () => ({}),
  useCreateCategory: mutation('createCategory'), useUpdateCategory: mutation('updateCategory'), useDeleteCategory: mutation('deleteCategory'),
  useDeleteItem: mutation('deleteItem'), useSetItemAvailability: mutation('setAvailability'),
  useUploadCategoryPhoto: mutation('uploadPhoto'), useRemoveCategoryPhoto: mutation('removePhoto'),
  };
});
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({}) }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (pick: (s: { previewType: null }) => unknown) => pick({ previewType: null }) }));
// lib/images pulls native modules; its isKeptPhoto rule is pinned in images.test.ts (a path with no host).
vi.mock('../../../lib/images', () => ({
  isKeptPhoto: (v: unknown) => typeof v === 'string' && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(v),
  storePhotoUrl: (key: string, w: number) => `door:${key}?w=${w}`,
}));

import { CategoryHeader, MenuItemRow, OUTSIDE_PHOTO_NOTE } from './VendorMenuScreen';

function all(node: any, match: (n: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) all(n, match, out); return out; }
  if (match(node)) out.push(node);
  for (const child of [node.props?.children].flat(Infinity)) {
    if (typeof child === 'function') continue;
    all(child, match, out);
  }
  return out;
}
const textOf = (n: any) => [n.props.children].flat(Infinity).filter((c) => typeof c === 'string' || typeof c === 'number').join('');
const texts = (tree: any) => all(tree, (n) => n.type === 'T' || n.type === 'PopupTitle').map(textOf);
const ofType = (tree: any, type: string) => all(tree, (n) => n.type === type);
const pill = (tree: any, label: string) => ofType(tree, 'PillButton').find((b) => b.props.label === label);
const sheet = (tree: any) => ofType(tree, 'PopupCard')[0];

const KEPT = 'items/v1/abcdefghijklmnop.jpg';
const OUTSIDE = 'https://elsewhere.example/plate.jpg';

beforeEach(() => {
  h.state = [];
  h.mutations = {};
});

describe('an item row on the store\'s own menu', () => {
  const row = (imageUrl: string | null) => {
    h.at = 0;
    return MenuItemRow({ item: { id: 'i1', name: 'Plate', basePrice: 1000, isAvailable: true, imageUrl }, navigation: {}, categories: [], canEdit: true });
  };

  it('shows a kept photo through the photo door, with no note', () => {
    const tree = row(KEPT);
    expect(ofType(tree, 'Image').map((i) => i.props.source.uri)).toEqual([`door:${KEPT}?w=160`]);
    expect(texts(tree)).not.toContain(OUTSIDE_PHOTO_NOTE);
  });

  it('names an outside address for what it is and never loads it; no photo at all says nothing', () => {
    const outside = row(OUTSIDE);
    expect(ofType(outside, 'Image')).toEqual([]);
    expect(texts(outside)).toContain("Its old photo link isn't shown to customers. Upload the photo again.");
    expect(texts(row(null))).not.toContain(OUTSIDE_PHOTO_NOTE);
  });
});

describe('a menu section\'s photo sheet', () => {
  let cat: { id: string; name: string; imageUrl: string | null; items: unknown[] };
  const draw = () => { h.at = 0; return CategoryHeader({ cat, canEdit: true }); };
  const open = () => { ofType(draw(), 'Pressable')[0].props.onPress(); return draw(); };

  beforeEach(() => { cat = { id: 'c1', name: 'Mains', imageUrl: KEPT, items: [] }; });

  it('promises only that Home CAN show it, and says the camera data goes [REVIEW-F S3-1]', () => {
    const tree = open();
    expect(sheet(tree).props.visible).toBe(true);
    expect(texts(tree)).toContain('This photo can show on Home as the picture for “Mains”. Location and camera details are removed.');
    expect(texts(tree).join(' ')).not.toMatch(/Customers see it on Home/);
  });

  it('"Remove photo" asks first: "Keep it" keeps it, "Remove photo" removes it and closes the sheet', () => {
    let tree = open();
    pill(tree, 'Remove photo').props.onPress();
    tree = draw();
    expect(h.mutations['removePhoto']?.mutate ?? vi.fn()).not.toHaveBeenCalled();
    expect(texts(tree)).toContain('Remove this photo? It is deleted from Swift and customers stop seeing it.');
    pill(tree, 'Keep it').props.onPress();
    tree = draw();
    expect(pill(tree, 'Choose a new photo')).toBeTruthy();
    expect(h.mutations['removePhoto']!.mutate).not.toHaveBeenCalled();

    pill(tree, 'Remove photo').props.onPress();
    tree = draw();
    pill(tree, 'Remove photo').props.onPress();
    expect(h.mutations['removePhoto']!.mutate).toHaveBeenCalledWith('c1', expect.any(Object));
    const handlers = h.mutations['removePhoto']!.mutate.mock.calls.at(-1)![1];
    handlers.onError({ response: { data: { error: { message: 'Only a store manager can do this' } } } });
    expect(texts(draw())).toContain('Only a store manager can do this');
    handlers.onSuccess();
    expect(sheet(draw()).props.visible).toBe(false);
  });

  it('a section holding an outside address is named, with a warning icon, and removing it says it is taken off [REVIEW-F S4-4]', () => {
    cat.imageUrl = OUTSIDE;
    const row = draw();
    expect(ofType(row, 'Image')).toEqual([]);
    expect(ofType(row, 'Feather')[0].props.name).toBe('alert-circle');
    const tree = open();
    expect(texts(tree)).toContain(OUTSIDE_PHOTO_NOTE);
    pill(tree, 'Remove photo').props.onPress();
    expect(texts(draw())).toContain('Remove this photo link? It is taken off this section.');
  });

  it('a section with no photo offers "Choose a photo" and no remove', () => {
    cat.imageUrl = null;
    const tree = open();
    expect(ofType(tree, 'Feather')[0].props.name).toBe('camera');
    expect(pill(tree, 'Choose a photo')).toBeTruthy();
    expect(pill(tree, 'Remove photo')).toBeUndefined();
    expect(texts(tree)).not.toContain(OUTSIDE_PHOTO_NOTE);
  });
});
