import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct · owner: "every single button tap, adding menus"] A menu change shows the server's answer at
// once and the menu is read again ONCE after a burst, not after every change.
//
// Before: every menu hook's onSuccess returned invalidateQueries(['vendor','menu']) — the button stayed busy until the
// WHOLE menu (every section, item, option group, choice) had downloaded again (2 round trips), and a store switching
// ten items off downloaded the menu ten times. Driven through the REAL hooks with a real query cache.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  qc: null as unknown as import('@tanstack/react-query').QueryClient,
  invalidated: [] as unknown[],
  store: { selectedStoreId: 'store-a' as string | null, storeGeneration: 1 },
  api: {} as Record<string, ReturnType<typeof vi.fn>>,
  prepared: [] as unknown[],
}));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return { ...real, useEffect: vi.fn(), useState: (v: unknown) => [v, vi.fn()], useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f(), useRef: (v: unknown) => ({ current: v }) };
});
vi.mock('react-native', () => ({ Vibration: { vibrate: vi.fn() } }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useQuery: (options: unknown) => options, useMutation: (options: unknown) => options, useQueryClient: () => fx.qc };
});
vi.mock('../services/api', () => ({ vendorApi: fx.api, vendorDiscoveryApi: {} }));
vi.mock('../lib/uploadImage', () => ({
  prepareUploadImage: vi.fn(async (file: { uri: string; name: string }) => {
    const sized = { uri: `${file.uri}#sized`, name: 'item.jpg', type: 'image/jpeg' };
    fx.prepared.push(sized);
    return sized;
  }),
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({}),
  getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: () => null, requireAuthSessionSnapshot: () => null,
}));
vi.mock('../lib/billingMutation', () => ({ runBillingMutation: vi.fn() }));
vi.mock('./cashSettlement', () => ({ confirmVendorCashSettlement: vi.fn() }));
vi.mock('./partnerPricing', () => ({ usePartnerPricing: vi.fn() }));
vi.mock('./useVendorMutation', () => ({ guardVendorOperation: vi.fn(), useVendorMutation: (options: unknown) => options }));
vi.mock('../lib/vendorPreviewData', () => ({
  vendorPreviewDataset: () => null, vendorPreviewSubscription: () => null, previewQuery: vi.fn(), previewMutation: vi.fn(), VENDOR_PREVIEW_MARKET: {},
}));
vi.mock('../services/socket', () => ({ connectSocket: vi.fn(), getSocket: () => ({ connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() }) }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: Object.assign(() => ({}), { getState: () => fx.store }) }));
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: (selector: (s: { previewType: null }) => unknown) => selector({ previewType: null }) }));

import {
  useAddOption, useAddOptionGroup, useCreateCategory, useDeleteCategory, useDeleteItem, useDeleteOption,
  useDeleteOptionGroup, useSaveItem, useSetItemAvailability, useUpdateCategory, useUploadItemImage,
} from './vendorops';

type Hook = {
  mutationKey?: unknown;
  mutationFn: (vars: any) => Promise<unknown>;
  onMutate?: (vars: any) => unknown;
  onSuccess?: (answer: any, vars: any, scope: any) => unknown;
};
const MENU = ['vendor', 'menu'];
const menu = () => [
  { id: 'mains', name: 'Mains', items: [
    { id: 'roti', categoryId: 'mains', name: 'Roti', basePrice: '500', isAvailable: true, optionGroups: [
      { id: 'g-size', itemId: 'roti', name: 'Size', options: [{ id: 'o-small', name: 'Small', additionalPrice: '0' }] },
    ] },
    { id: 'curry', categoryId: 'mains', name: 'Curry', basePrice: '900', isAvailable: true, optionGroups: [] },
  ] },
  { id: 'drinks', name: 'Drinks', items: [] },
];
const items = (sectionId: string) => (fx.qc.getQueryData<any[]>(MENU) ?? []).find((s) => s.id === sectionId)?.items ?? [];
const menuRereads = () => fx.invalidated.filter((k) => JSON.stringify(k) === JSON.stringify(MENU)).length;

/** One tap through the real hook: the store it was sent for, the request, then the hook's own onSuccess. */
async function tap(hook: Hook, vars: unknown) {
  const scope = hook.onMutate?.(vars);
  const answer = await hook.mutationFn(vars);
  return { answer, settled: hook.onSuccess?.(answer, vars, scope) };
}

/** React Native's FormData keeps the { uri, name, type } file object as it is; Node's would turn it into a string. */
class PhoneFormData {
  private parts: Array<[string, unknown]> = [];
  append(key: string, value: unknown) { this.parts.push([key, value]); }
  get(key: string) { return this.parts.find(([k]) => k === key)?.[1] ?? null; }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('FormData', PhoneFormData);
  fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  fx.invalidated.length = 0;
  fx.prepared.length = 0;
  fx.store.selectedStoreId = 'store-a';
  fx.store.storeGeneration = 1;
  const real = fx.qc.invalidateQueries.bind(fx.qc);
  fx.qc.invalidateQueries = ((filters: { queryKey: unknown }) => { fx.invalidated.push(filters.queryKey); return real(filters as never); }) as never;
  fx.qc.setQueryData(MENU, menu());
  const answer = (data: unknown) => vi.fn(async () => ({ data: { success: true, data } }));
  Object.assign(fx.api, {
    setItemAvailability: vi.fn(async (id: string, isAvailable: boolean) => ({ data: { data: { id, name: 'x', isAvailable } } })),
    createItem: answer({ id: 'chow', categoryId: 'mains', name: 'Chow mein', basePrice: '700', isAvailable: true, bulk: 'normal', catalogueCheck: null,
      optionGroups: [{ id: 'g-new', name: 'Size', options: [{ id: 'o-l', name: 'Large', additionalPrice: '200' }] }] }),
    updateItem: answer({ id: 'curry', categoryId: 'drinks', name: 'Curry', basePrice: '950', isAvailable: true, bulk: 'bulky', catalogueCheck: null, optionGroups: [] }),
    deleteItem: answer({ deleted: true }),
    createCategory: answer({ id: 'sides', name: 'Sides', sortOrder: 2 }),
    updateCategory: answer({ id: 'mains', name: 'Main dishes', sortOrder: 0 }),
    deleteCategory: answer({ deleted: true, itemsRemoved: 2 }),
    addOptionGroup: answer({ id: 'g-extra', itemId: 'curry', name: 'Extras', options: [] }),
    deleteOptionGroup: answer({ deleted: true }),
    addOption: answer({ id: 'o-large', optionGroupId: 'g-size', name: 'Large', additionalPrice: '200' }),
    deleteOption: answer({ deleted: true }),
    uploadItemImage: vi.fn(async (_id: string, _form: unknown) => ({ data: { data: { id: 'roti', name: 'Roti', imageUrl: 'store-photos/roti.jpg' } } })),
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('[TAP-AUDIT] a menu change: the server\'s answer at once, one re-read after the burst', () => {
  it('in stock / sold out: the answer is on the menu at once and the button is free at the answer (nothing awaited)', async () => {
    const { settled } = await tap(useSetItemAvailability() as unknown as Hook, { id: 'roti', isAvailable: false });
    expect(items('mains').find((i: any) => i.id === 'roti').isAvailable).toBe(false);
    expect(settled, 'onSuccess hands back nothing to wait for').toBeUndefined();
    expect(menuRereads(), 'no whole-menu download at the answer').toBe(0);
  });

  it('ten items switched off at closing = ONE whole-menu re-read, after the changes stop', async () => {
    const hook = useSetItemAvailability() as unknown as Hook;
    for (let i = 0; i < 10; i++) {
      await tap(hook, { id: i % 2 ? 'roti' : 'curry', isAvailable: i % 2 === 0 });
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(menuRereads()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(menuRereads()).toBe(1);
  });

  it('the re-read waits while another menu change is still on its way (it would show that change\'s old value)', async () => {
    await tap(useSetItemAvailability() as unknown as Hook, { id: 'roti', isAvailable: false });
    let finish!: () => void;
    // A second change still out: TanStack counts it as mutating under the menu key.
    const out = fx.qc.getMutationCache().build(fx.qc, { mutationKey: ['vendor', 'menu', 'write'], mutationFn: () => new Promise<void>((resolve) => { finish = resolve; }) });
    void out.execute(undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(menuRereads()).toBe(0);
    finish();
    await vi.advanceTimersByTimeAsync(1_300);
    expect(menuRereads()).toBe(1);
  });

  it('every menu change carries the menu-change key (the re-read can see it)', () => {
    for (const hook of [useSetItemAvailability, useSaveItem, useDeleteItem, useCreateCategory, useUpdateCategory, useDeleteCategory,
      useAddOptionGroup, useDeleteOptionGroup, useAddOption, useDeleteOption, useUploadItemImage]) {
      expect((hook() as unknown as Hook).mutationKey, hook.name).toEqual(['vendor', 'menu', 'write']);
    }
  });

  it('an answer that lands after the owner switched store is not written into the other store\'s menu', async () => {
    const hook = useSetItemAvailability() as unknown as Hook;
    const scope = hook.onMutate?.({ id: 'roti', isAvailable: false });
    const answer = await hook.mutationFn({ id: 'roti', isAvailable: false });
    fx.store.selectedStoreId = 'store-b';
    fx.store.storeGeneration = 2;
    fx.qc.setQueryData(MENU, menu()); // store B's menu happens to hold the same ids
    hook.onSuccess?.(answer, { id: 'roti', isAvailable: false }, scope);
    expect(items('mains').find((i: any) => i.id === 'roti').isAvailable).toBe(true);
    // A -> B -> A: the generation still tells them apart.
    fx.store.selectedStoreId = 'store-a';
    fx.store.storeGeneration = 3;
    hook.onSuccess?.(answer, { id: 'roti', isAvailable: false }, scope);
    expect(items('mains').find((i: any) => i.id === 'roti').isAvailable).toBe(true);
  });

  it('a new item (with the groups and choices the server saved with it) is added at the end of its section', async () => {
    await tap(useSaveItem() as unknown as Hook, { data: { categoryId: 'mains', name: 'Chow mein' } });
    expect(items('mains').map((i: any) => i.id)).toEqual(['roti', 'curry', 'chow']);
    expect(items('mains')[2].optionGroups[0].options[0].name).toBe('Large');
  });

  it('an edited item takes the server\'s fields and moves when its section changed', async () => {
    await tap(useSaveItem() as unknown as Hook, { id: 'curry', data: { categoryId: 'drinks', basePrice: 950 } });
    expect(items('mains').map((i: any) => i.id)).toEqual(['roti']);
    expect(items('drinks')).toEqual([expect.objectContaining({ id: 'curry', basePrice: '950', bulk: 'bulky' })]);
  });

  it('a deleted item and a deleted section leave the menu at the answer', async () => {
    await tap(useDeleteItem() as unknown as Hook, 'curry');
    expect(items('mains').map((i: any) => i.id)).toEqual(['roti']);
    await tap(useDeleteCategory() as unknown as Hook, 'drinks');
    expect((fx.qc.getQueryData<any[]>(MENU) ?? []).map((s) => s.id)).toEqual(['mains']);
  });

  it('a section added is shown at the end; a renamed one keeps its items', async () => {
    await tap(useCreateCategory() as unknown as Hook, { name: 'Sides' });
    await tap(useUpdateCategory() as unknown as Hook, { id: 'mains', data: { name: 'Main dishes' } });
    const sections = fx.qc.getQueryData<any[]>(MENU) ?? [];
    expect(sections.map((s) => [s.id, s.name, s.items.length])).toEqual([['mains', 'Main dishes', 2], ['drinks', 'Drinks', 0], ['sides', 'Sides', 0]]);
  });

  it('option groups and choices: added and removed from the answer, no whole-menu download per choice', async () => {
    await tap(useAddOptionGroup() as unknown as Hook, { itemId: 'curry', data: { name: 'Extras' } });
    await tap(useAddOption() as unknown as Hook, { groupId: 'g-size', data: { name: 'Large', additionalPrice: 200 } });
    expect(items('mains')[1].optionGroups.map((g: any) => g.name)).toEqual(['Extras']);
    expect(items('mains')[0].optionGroups[0].options.map((o: any) => o.name)).toEqual(['Small', 'Large']);
    await tap(useDeleteOption() as unknown as Hook, { id: 'o-small' });
    await tap(useDeleteOptionGroup() as unknown as Hook, { id: 'g-extra' });
    expect(items('mains')[0].optionGroups[0].options.map((o: any) => o.name)).toEqual(['Large']);
    expect(items('mains')[1].optionGroups).toEqual([]);
    expect(menuRereads()).toBe(0);
  });
});

describe('[TAP-AUDIT] an item photo is sized on the phone before it is sent (as section and store photos are)', () => {
  it('the request carries the sized photo, not the 2-4 MB camera original', async () => {
    const hook = useUploadItemImage() as unknown as Hook;
    await tap(hook, { id: 'roti', file: { uri: 'file:///camera/IMG_0001.HEIC', name: 'IMG_0001.HEIC', type: 'image/heic' } });
    expect(fx.prepared).toHaveLength(1);
    const form = fx.api['uploadItemImage']!.mock.calls[0]![1] as unknown as PhoneFormData;
    expect(form.get('file')).toEqual(fx.prepared[0]);
  });

  it('the photo the server kept is on the menu at once', async () => {
    await tap(useUploadItemImage() as unknown as Hook, { id: 'roti', file: { uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg' } });
    expect(items('mains')[0].imageUrl).toBe('store-photos/roti.jpg');
  });
});
