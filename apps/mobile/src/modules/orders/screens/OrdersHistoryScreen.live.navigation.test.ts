/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [row 5 · ANDROID-QA 5 Oct, S3] "Orders list not live."
//
// The REAL activity screen over the REAL order hooks and a real query client;
// only the transport (customerApi.getOrders), native drawing and the OS app
// state are stand-ins. The list used to refresh only on a tab switch or a pull:
// while the customer watched it, an order moved from "Preparing" to "On the
// way" (or finished) and the screen did not change. No socket event reaches
// this list (order events go to the order's own room), so it re-asks while it
// is on screen, the app is in front and something is in progress.
// ---------------------------------------------------------------------------

type Row = { id: string; status: string; orderType: string; orderNumber: string; placedAt: string; totalAmount: number; vendor: { name: string } };
const fx = vi.hoisted(() => ({
  goBack: vi.fn(),
  live: [] as Row[],
  history: [] as Row[],
  calls: { live: 0, history: 0 },
  focused: true,
  appState: { current: 'active' as string, listeners: new Set<(s: string) => void>() },
}));
const order = (id: string, status: string): Row => ({
  id, status, orderType: 'FOOD_DELIVERY', orderNumber: id.toUpperCase(), placedAt: '2026-10-16T12:00:00.000Z', totalAmount: 2500, vendor: { name: `Store ${id}` },
});

vi.mock('react-native', async () => {
  const { createElement: h, Fragment } = await import('react');
  const kids = (p: any) => (typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  const el = (c: any) => (c == null ? null : React.isValidElement(c) ? c : h(c));
  return {
    View: (p: any) => h('div', null, kids(p)),
    Pressable: (p: any) => h('button', { onClick: p.onPress, 'aria-label': p.accessibilityLabel }, kids(p)),
    RefreshControl: () => null,
    FlatList: (p: any) => h('div', null, el(p.ListHeaderComponent),
      (p.data ?? []).map((item: any, index: number) => h(Fragment, { key: p.keyExtractor(item, index) }, p.renderItem({ item, index }))),
      el(p.ListFooterComponent)),
    AppState: {
      get currentState() { return fx.appState.current; },
      addEventListener: (_: string, fn: (s: string) => void) => { fx.appState.listeners.add(fn); return { remove: () => fx.appState.listeners.delete(fn) }; },
    },
    Platform: { OS: 'android' },
  };
});
vi.mock('react-native-reanimated', async () => {
  const { createElement: h } = await import('react');
  const chain: any = { duration: () => chain, delay: () => chain, reduceMotion: () => chain };
  return { __esModule: true, default: { View: (p: any) => h('div', null, p.children) }, FadeInDown: chain, ReduceMotion: { System: 'system' } };
});
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn(), goBack: fx.goBack }), useIsFocused: () => fx.focused }));
vi.mock('../../../services/api', () => ({
  API_URL: 'https://api.test',
  customerApi: {
    getOrders: vi.fn(async (_page: number, opts: { live?: boolean }) => {
      const rows = opts?.live ? fx.live : fx.history;
      if (opts?.live) fx.calls.live += 1; else fx.calls.history += 1;
      return { data: { data: rows, meta: { page: 1, totalPages: 1, total: rows.length } } };
    }),
  },
  marketApi: {}, discoveryApi: {}, moderationApi: {},
}));
vi.mock('../../../services/socket', () => ({ getSocket: () => ({ connected: false }) }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../../../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn(), checkoutFailureOutcome: vi.fn(), settleUnresolvedIntent: vi.fn() }));
vi.mock('../../../lib/marketDepthMemory', () => ({ rememberedMarketDepth: vi.fn(), rememberMarketDepth: vi.fn() }));
vi.mock('../../../stores/authStore', () => {
  const state = { isAuthenticated: true, promptLogin: () => {}, sessionGeneration: 1, user: { id: 'customer-1' } };
  return {
    useAuthStore: Object.assign((select?: (s: typeof state) => unknown) => (select ? select(state) : state), { getState: () => state }),
    getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: vi.fn(), AuthSessionBoundaryError: class extends Error {},
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../lib/images', () => ({ vendorPhoto: () => undefined }));
vi.mock('../../../kit/controls', async () => {
  const { createElement: h } = await import('react');
  return { TonePill: (p: any) => h('span', { 'data-status': '' }, p.label) };
});
vi.mock('../../../kit', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  return {
    Screen: Box, T: (p: any) => h('span', null, p.children),
    Photo: () => null, Pictogram: () => null, Money: (p: any) => h('span', null, p.amount),
    PillButton: (p: any) => h('button', { onClick: p.onPress }, p.label),
    CircleChip: (p: any) => h('button', { 'aria-label': p.label, onClick: p.onPress }),
    EmptyState: (p: any) => h('section', null, p.title), ErrorState: () => h('div', null, 'Error'), LoadingBlock: () => h('div', null, 'Loading'),
  };
});

import { OrdersHistoryScreen } from './OrdersHistoryScreen';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let client: QueryClient;
// Advance the clock, then let the answer land: the query core hands results
// to React on a zero-delay timer, so a few short ticks follow every advance.
const settle = async (ms = 0) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  for (let i = 0; i < 3; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
};
async function render() {
  await act(async () => root!.render(React.createElement(QueryClientProvider, { client }, React.createElement(OrdersHistoryScreen))));
  await settle();
}
const text = () => host.textContent ?? '';
async function appGoes(state: string) {
  fx.appState.current = state;
  await act(async () => { for (const fn of [...fx.appState.listeners]) fn(state); });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  fx.live = []; fx.history = []; fx.calls = { live: 0, history: 0 }; fx.focused = true;
  fx.appState.current = 'active'; fx.appState.listeners.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined; client.clear();
  vi.useRealTimers();
});

describe('[UI-SWEEP U11] Your activity is a pushed screen with its own way back', () => {
  it.each([
    ['with orders', true],
    ['with nothing yet', false],
  ] as const)('%s, the Back chip is on screen and goes back', async (_case, withRows) => {
    if (withRows) fx.history = [{ id: 'o-1', status: 'DELIVERED', orderType: 'FOOD_DELIVERY', vendor: { name: 'Store' }, placedAt: new Date().toISOString(), totalAmount: 1000, items: [] } as any];
    await render();
    const back = host.querySelector<HTMLButtonElement>('button[aria-label="Back"]');
    expect(back, 'a back control on Your activity').not.toBeNull();
    await act(async () => back!.click());
    expect(fx.goBack).toHaveBeenCalledTimes(1);
    fx.goBack.mockClear();
  });
});

describe('the activity list follows orders in progress while it is on screen', () => {
  it('a live order’s new status shows without a tab switch or a pull', async () => {
    const { orderStatusLabel, presentedVertical } = await import('../../../lib/orderStatus');
    const label = (o: Row) => orderStatusLabel(o.status, presentedVertical(o as any));
    expect(label(order('a1', 'PREPARING')), 'guards the guard').not.toBe(label(order('a1', 'PICKED_UP')));
    fx.live = [order('a1', 'PREPARING')];
    await render();
    expect(host.querySelector('[data-status]')?.textContent).toBe(label(order('a1', 'PREPARING')));
    const before = fx.calls.live;
    fx.live = [order('a1', 'PICKED_UP')];
    await settle(15_000);
    expect(fx.calls.live, 'the live list re-asked').toBeGreaterThan(before);
    expect(host.querySelector('[data-status]')?.textContent).toBe(label(order('a1', 'PICKED_UP')));
  });

  it('an order that finishes leaves IN PROGRESS and joins history (never in neither)', async () => {
    fx.live = [order('a1', 'PICKED_UP')];
    await render();
    expect(text()).toContain('IN PROGRESS');
    fx.live = [];
    fx.history = [order('a1', 'DELIVERED')];
    await settle(15_000);
    await settle();
    expect(text()).not.toContain('IN PROGRESS');
    expect(text(), 'the finished order is in history').toContain('Store a1');
  });

  it('back from the background, both lists are read again at once', async () => {
    fx.live = [order('a1', 'PREPARING')];
    await render();
    await appGoes('background');
    const live = fx.calls.live; const history = fx.calls.history;
    await settle(60_000);
    expect(fx.calls.live, 'no polling while the app is in the background').toBe(live);
    await appGoes('active');
    expect(fx.calls.live).toBe(live + 1);
    expect(fx.calls.history).toBe(history + 1);
  });

  it('control: nothing in progress, nothing to follow — no polling', async () => {
    fx.history = [order('h1', 'DELIVERED')];
    await render();
    const live = fx.calls.live; const history = fx.calls.history;
    await settle(60_000);
    expect(fx.calls.live).toBe(live);
    expect(fx.calls.history).toBe(history);
  });

  it('control: another tab on screen — no polling', async () => {
    fx.focused = false;
    fx.live = [order('a1', 'PREPARING')];
    await render();
    const live = fx.calls.live;
    await settle(60_000);
    expect(fx.calls.live).toBe(live);
  });
});
