/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [IN-STORE-SALE · owner 27 Oct] "Sold in store −1" on the store's menu list. A store with no till system sells an
// item at the counter and takes it off its Swift stock in ONE tap (it used to be ~5 inside the item editor).
//
// The REAL MenuItemRow and its controls, the REAL sender hook (hooks/vendorops useSoldInStoreSender) and the shared
// line of taps (lib/inStoreSale), over a real query cache; the network, the kit and native drawing are stand-ins.
// The count moves at the tap and settles on the server's answer; taps add up; one request at a time per item, each
// with its own key; only that item waits; Undo; a refusal says why; no answer offers "Try again" (same key).
// ---------------------------------------------------------------------------

type Pending = { itemId: string; key?: string; saleKey?: string; resolve: (stock: number) => void; reject: (e: unknown) => void };
const fx = vi.hoisted(() => ({
  qc: null as unknown as import('@tanstack/react-query').QueryClient,
  sent: [] as Pending[],
  keys: 0,
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));
const answerOf = (stock: number) => ({ data: { success: true, data: { stockQuantity: stock, isAvailable: stock > 0, replayed: false } } });
const request = (itemId: string, extra: { key?: string; saleKey?: string }) => new Promise((resolve, reject) => {
  fx.sent.push({ itemId, ...extra, resolve: (stock) => resolve(answerOf(stock)), reject });
});

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, typeof children === 'function' ? children({ pressed: false }) : children);
  const Pressable = ({ children, onPress, accessibilityLabel, disabled }: any) =>
    R.createElement('button', { type: 'button', 'aria-label': accessibilityLabel, disabled: !!disabled, onClick: onPress }, typeof children === 'function' ? children({ pressed: false }) : children);
  return { View, ScrollView: View, FlatList: View, RefreshControl: View, Pressable, Vibration: { vibrate: () => undefined } };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useQueryClient: () => fx.qc };
});
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    Card: Box, Chip: Box, EmptyState: Box, ErrorState: Box, IconChip: () => null, LoadingBlock: Box, PopupTitle: Box, Screen: Box,
    PopupCard: (p: any) => (p.visible ? h('div', null, p.children) : null),
    T: (p: any) => h('span', null, p.children),
    TonePill: (p: any) => h('i', null, p.label),
    PillButton: (p: any) => h('button', { type: 'button', disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onPress }, p.label),
  };
});
vi.mock('../../../kit/switch', () => ({ Switch: () => null }));
vi.mock('../shared', () => ({
  GUTTER: 16, InlineInput: () => null, SubHeader: () => null,
  catalogueMeta: () => ({}), safeVendorRole: () => 'OWNER', numericFact: (v: unknown) => (typeof v === 'number' ? v : null),
}));
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({}) }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (pick: (s: { previewType: null }) => unknown) => pick({ previewType: null }) }));
vi.mock('../../../lib/images', () => ({ isKeptPhoto: () => false, storePhotoUrl: () => null }));
// The real hooks/vendorops, over stand-ins for what it reaches (as vendorops.menuAnswers.test.ts).
vi.mock('../../../services/api', () => ({
  vendorApi: {
    inStoreSale: (itemId: string, key: string) => request(itemId, { key }),
    undoInStoreSale: (itemId: string, saleKey: string) => request(itemId, { saleKey }),
  },
  vendorDiscoveryApi: {},
}));
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ sessionGeneration: 1 }),
  newCommandKey: () => `tap-key-${++fx.keys}`,
  getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: () => null, requireAuthSessionSnapshot: () => null,
}));
vi.mock('../../../hooks/useVendorMutation', () => ({
  guardVendorOperation: (fn: unknown) => fn,
  useVendorMutation: (options: { mutationFn: (vars: unknown) => Promise<unknown> }) => ({
    mutate: vi.fn(), mutateAsync: (vars: unknown) => options.mutationFn(vars), isPending: false, isError: false,
  }),
}));
vi.mock('../../../lib/uploadImage', () => ({ prepareUploadImage: vi.fn() }));
vi.mock('../../../lib/billingMutation', () => ({ runBillingMutation: vi.fn() }));
vi.mock('../../../hooks/cashSettlement', () => ({ confirmVendorCashSettlement: vi.fn() }));
vi.mock('../../../hooks/partnerPricing', () => ({ usePartnerPricing: vi.fn() }));
vi.mock('../../../lib/vendorPreviewData', () => ({
  vendorPreviewDataset: () => null, vendorPreviewSubscription: () => null, previewQuery: vi.fn(), previewMutation: vi.fn(), VENDOR_PREVIEW_MARKET: {},
}));
vi.mock('../../../services/socket', () => ({ connectSocket: vi.fn(), getSocket: () => ({ connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() }) }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: Object.assign(() => ({}), { getState: () => ({ selectedStoreId: 'store-a', storeGeneration: 1 }) }) }));

import { MenuItemRow } from './VendorMenuScreen';
import { soldInStore } from '../../../hooks/useSoldInStore';
import { SOLD_IN_STORE, SOLD_UNDO_MS } from '../../../lib/inStoreSale';

const MENU = ['vendor', 'menu'];
const h = React.createElement;
const items = () => [
  { id: 'rice', categoryId: 'shelf', name: 'Rice 1 kg', basePrice: '500', isAvailable: true, stockQuantity: 5, lowStockThreshold: null, optionGroups: [] },
  { id: 'oil', categoryId: 'shelf', name: 'Oil', basePrice: '900', isAvailable: true, stockQuantity: 3, lowStockThreshold: null, optionGroups: [] },
  { id: 'roti', categoryId: 'shelf', name: 'Roti', basePrice: '300', isAvailable: true, stockQuantity: null, lowStockThreshold: null, optionGroups: [] },
];
/** The menu list's rows, drawn from the menu the screen holds (as VendorMenuScreen draws them). */
function Rows() {
  const [, redraw] = React.useState(0);
  React.useEffect(() => fx.qc.getQueryCache().subscribe(() => redraw((n) => n + 1)), []);
  const menu = fx.qc.getQueryData<any[]>(MENU) ?? [];
  return h('div', null, (menu[0]?.items ?? []).map((item: any) => h('section', { key: item.id, 'data-item': item.id },
    h(MenuItemRow, { item, navigation: { navigate: vi.fn() }, categories: [], canEdit: false }))));
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fx.sent = [];
  fx.keys = 0;
  fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  fx.qc.setQueryData(MENU, [{ id: 'shelf', name: 'Shelf', items: items() }]);
  soldInStore.reset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(h(Rows)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
const row = (id: string) => host.querySelector(`section[data-item="${id}"]`)!;
const rowText = (id: string) => row(id).textContent ?? '';
const sellButton = (id: string) => Array.from(row(id).querySelectorAll('button')).find((b) => b.textContent === SOLD_IN_STORE.button);
const buttonIn = (id: string, text: string) => Array.from(row(id).querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(text));
async function press(el: Element | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => { (el as HTMLButtonElement).click(); });
  await settle();
}
const menuStock = (id: string) => (fx.qc.getQueryData<any[]>(MENU)![0].items as any[]).find((i) => i.id === id).stockQuantity;

describe('[IN-STORE-SALE] "Sold in store −1" on the phone menu list', () => {
  it('shows on a tracked item only; an item whose stock is not counted has no button', () => {
    expect(sellButton('rice')).toBeTruthy();
    expect(sellButton('oil')).toBeTruthy();
    expect(sellButton('roti')).toBeUndefined();
  });

  it('the count moves at the tap, and settles on the server\'s answer', async () => {
    expect(rowText('rice')).toContain('5 in stock');
    await press(sellButton('rice'));
    expect(rowText('rice'), 'at the tap, before any answer').toContain('4 in stock');
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]!).toMatchObject({ itemId: 'rice', key: 'tap-key-1' });
    fx.sent[0]!.resolve(4);
    await settle();
    expect(menuStock('rice'), 'the server\'s count is in the menu').toBe(4);
    expect(rowText('rice')).toContain('4 in stock');
    expect(rowText('rice')).toContain(`${SOLD_IN_STORE.sold(1)} · ${SOLD_IN_STORE.undo}`);
  });

  it('taps add up: one request at a time, each tap with its own key, none lost; only that item waits', async () => {
    await press(sellButton('rice'));
    await press(sellButton('rice'));
    await press(sellButton('rice'));
    expect(rowText('rice')).toContain('2 in stock');
    expect(fx.sent.map((s) => s.itemId)).toEqual(['rice']);
    await press(sellButton('oil'));
    expect(fx.sent.map((s) => s.itemId), 'another item does not wait for rice').toEqual(['rice', 'oil']);
    expect(rowText('oil')).toContain('2 in stock');
    fx.sent[0]!.resolve(4);
    await settle();
    fx.sent[2]!.resolve(3);
    await settle();
    fx.sent[3]!.resolve(2);
    await settle();
    expect(fx.sent.filter((s) => s.itemId === 'rice').map((s) => s.key)).toEqual(['tap-key-1', 'tap-key-2', 'tap-key-3']);
    expect(menuStock('rice')).toBe(2);
    expect(rowText('rice')).toContain('2 in stock');
    expect(rowText('rice')).toContain(SOLD_IN_STORE.sold(3));
  });

  it('Undo takes the tap back: an undo naming its key, the count back at once, and the Undo goes after a few seconds', async () => {
    await press(sellButton('rice'));
    fx.sent[0]!.resolve(4);
    await settle();
    await press(buttonIn('rice', SOLD_IN_STORE.undo));
    expect(fx.sent[1]!).toMatchObject({ itemId: 'rice', saleKey: 'tap-key-1' });
    expect(rowText('rice')).toContain('5 in stock');
    fx.sent[1]!.resolve(5);
    await settle();
    expect(menuStock('rice')).toBe(5);
    expect(rowText('rice')).not.toContain(SOLD_IN_STORE.undo);

    await press(sellButton('rice'));
    fx.sent[2]!.resolve(4);
    await settle();
    expect(rowText('rice')).toContain(SOLD_IN_STORE.sold(1));
    await act(async () => { vi.advanceTimersByTime(SOLD_UNDO_MS + 10); });
    await settle();
    expect(rowText('rice')).not.toContain(SOLD_IN_STORE.undo);
  });

  it('a refusal shows the server\'s words on the row and the count goes back to what Swift has', async () => {
    await press(sellButton('oil'));
    await press(sellButton('oil'));
    fx.sent[0]!.reject({ response: { status: 409, data: { error: { code: 'NONE_LEFT', message: SOLD_IN_STORE.noneLeft } } } });
    await settle();
    expect(rowText('oil')).toContain(SOLD_IN_STORE.noneLeft);
    expect(fx.sent).toHaveLength(1);
    expect(rowText('oil')).toContain('3 in stock');
  });

  it('no answer: the tap is kept and NOT sent again by itself; "Try again" sends the SAME key', async () => {
    await press(sellButton('rice'));
    fx.sent[0]!.reject(new Error('Network Error'));
    await settle();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await settle();
    expect(fx.sent).toHaveLength(1);
    expect(rowText('rice')).toContain(SOLD_IN_STORE.notSent(1));
    expect(rowText('rice')).toContain('4 in stock');
    await press(buttonIn('rice', SOLD_IN_STORE.tryAgain));
    expect(fx.sent.map((s) => s.key)).toEqual(['tap-key-1', 'tap-key-1']);
    fx.sent[1]!.resolve(4);
    await settle();
    expect(rowText('rice')).not.toContain(SOLD_IN_STORE.notSent(1));
    expect(menuStock('rice')).toBe(4);
  });

  it('at 0 on screen the button waits (nothing to sell on Swift)', async () => {
    for (let i = 0; i < 3; i++) await press(sellButton('oil'));
    expect(rowText('oil')).toContain('0 left');
    expect(sellButton('oil')!.disabled).toBe(true);
    await press(sellButton('oil'));
    expect(fx.sent.filter((s) => s.itemId === 'oil')).toHaveLength(1); // only the first is out; none added by the 4th press
    expect(soldInStore.view('oil').unsent).toBe(3);
  });
});
