/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [UI-SWEEP U33] The store's Order history gets pull to refresh like its
// sibling lists. It is paged by hand ("Load more" appends a page), so a pull
// must reload from the newest page: the page-1 answer REPLACES the list, and a
// pull deep in the list never appends a page twice. The REAL screen on a real
// React renderer with a REAL TanStack query under the hook's own key (pinned
// to hooks/vendorops.ts below); only native drawing and the network are
// stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  orders: vi.fn(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const View = (p: any) => h('div', null, p.children);
  return {
    View,
    ScrollView: (p: any) => h('div', null, p.refreshControl ?? null, p.children),
    Pressable: (p: any) => h('button', { type: 'button', onClick: p.onPress }, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children),
    RefreshControl: (p: any) => h('button', { type: 'button', 'data-refreshing': String(!!p.refreshing), onClick: p.onRefresh }, 'pull to refresh'),
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, space: fx.token }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    Card: Box, Screen: Box, T: (p: any) => h('span', null, p.children),
    Chip: (p: any) => h('span', null, p.label), EmptyState: (p: any) => h('p', null, p.title), ErrorState: () => h('p', null, 'error'), LoadingBlock: () => null,
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
  };
});
vi.mock('../shared', async () => {
  const R = await import('react');
  return {
    GUTTER: 16, fmtWhen: () => '', OrderStatusPill: () => null,
    SubHeader: (p: any) => R.createElement('header', null, p.title), InlineInput: () => null,
  };
});
// The hook's own query, key and placeholder (hooks/vendorops.ts useVendorOrderHistory).
vi.mock('../../../hooks/vendorops', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    useVendorProfile: () => ({ store: { name: 'Regent Street Grocery' } }),
    useVendorOrderHistory: (filters: Record<string, unknown>) => useQuery({
      queryKey: ['vendor', 'orders', 'history', filters],
      queryFn: () => fx.orders(filters),
      placeholderData: (prev: unknown) => prev,
    }),
  };
});

import { VendorOrderHistoryScreen } from './VendorOrderHistoryScreen';

const order = (n: number) => ({ id: `o${n}`, orderNumber: `SW-${1000 + n}`, status: 'DELIVERED', totalAmount: 1000 });
const PAGE_1 = Array.from({ length: 20 }, (_, i) => order(i + 1));
const PAGE_2 = Array.from({ length: 5 }, (_, i) => order(i + 21));
const pageOf = (page: number, total = 25) => ({ data: page === 1 ? PAGE_1 : PAGE_2, meta: { page, limit: 20, total, hasNext: page === 1 } });

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const listed = () => (host.textContent?.match(/#SW-\d+/g) ?? []);
const buttonNamed = (start: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith(start)) ?? null;
const pullControl = () => host.querySelector('[data-refreshing]') as HTMLButtonElement | null;
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };

beforeEach(async () => {
  vi.clearAllMocks();
  fx.orders.mockImplementation(async (filters: { page: number }) => pageOf(filters.page));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(VendorOrderHistoryScreen, { navigation: { navigate: vi.fn(), goBack: vi.fn() } }))));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe('[UI-SWEEP U33] Order history: pull to refresh reloads from the newest page', () => {
  it('the list offers the pull, and its spinner is off until someone pulls', () => {
    expect(listed()).toHaveLength(20);
    expect(pullControl()?.getAttribute('data-refreshing')).toBe('false');
  });

  it('a pull after "Load more" shows page 1 once: no page appended twice, no stale page', async () => {
    await act(async () => { buttonNamed('Load more')!.click(); });
    await settle();
    expect(listed()).toHaveLength(25);
    // Meanwhile a new order landed at the top: the newest page now starts with it.
    fx.orders.mockImplementation(async (filters: { page: number }) => (filters.page === 1
      ? { data: [order(99), ...PAGE_1.slice(0, 19)], meta: { page: 1, limit: 20, total: 26, hasNext: true } }
      : pageOf(filters.page, 26)));
    await act(async () => { pullControl()!.click(); });
    await settle();
    const shown = listed();
    expect(shown[0]).toBe('#SW-1099');
    expect(shown).toHaveLength(20);
    expect(new Set(shown).size).toBe(shown.length);
    expect(fx.orders).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
    expect(pullControl()?.getAttribute('data-refreshing')).toBe('false');
  });

  it('a background re-read never shows the spinner; a pull shows it until its answer lands', async () => {
    let answer!: () => void;
    fx.orders.mockImplementationOnce((filters: { page: number }) => new Promise((resolve) => { answer = () => resolve(pageOf(filters.page)); }));
    // A focus / socket / invalidation re-read over the list on screen.
    await act(async () => { void client.invalidateQueries({ queryKey: ['vendor', 'orders', 'history'] }); });
    await settle();
    expect(pullControl()?.getAttribute('data-refreshing')).toBe('false');
    await act(async () => { answer(); });
    await settle();
    // The person's own pull.
    fx.orders.mockImplementationOnce((filters: { page: number }) => new Promise((resolve) => { answer = () => resolve(pageOf(filters.page)); }));
    await act(async () => { pullControl()!.click(); });
    await settle();
    expect(pullControl()?.getAttribute('data-refreshing')).toBe('true');
    await act(async () => { answer(); });
    await settle();
    expect(pullControl()?.getAttribute('data-refreshing')).toBe('false');
  });

  it('the mirrored key is the hook\'s own (a pull invalidates exactly this family)', () => {
    const hook = readFileSync(join(process.cwd(), 'src/hooks/vendorops.ts'), 'utf8');
    expect(hook).toMatch(/export function useVendorOrderHistory[\s\S]{0,200}queryKey: \['vendor', 'orders', 'history', filters\]/);
    const screen = readFileSync(join(process.cwd(), 'src/modules/vendor/screens/VendorOrderHistoryScreen.tsx'), 'utf8');
    expect(screen).toContain("queryKey: ['vendor', 'orders', 'history']");
  });
});
