/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [UI-SWEEP U34] "Deliver To": picking the basket's address. The rows stayed
// tappable with no feedback while the address was being set, so a second tap
// raced the first. The REAL AddressesScreen on a real React renderer, with a
// REAL TanStack mutation (isPending / variables exactly as on the phone); only
// native drawing, the address list and the network are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  setCartAddress: vi.fn(),
  goBack: vi.fn(),
  alert: vi.fn(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const View = (p: any) => h('div', null, p.children);
  return {
    View,
    FlatList: (p: any) => h('div', null, (p.data ?? []).map((item: any) => h(R.Fragment, { key: p.keyExtractor(item) }, p.renderItem({ item })))),
    Pressable: (p: any) => h('button', {
      type: 'button', disabled: !!p.disabled, 'aria-busy': p.accessibilityState?.busy ? 'true' : undefined,
      onClick: p.disabled ? undefined : p.onPress,
    }, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children),
    Alert: { alert: fx.alert },
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, space: fx.token }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: fx.goBack, navigate: vi.fn() }),
  useRoute: () => ({ params: { selectFor: 'cart' } }),
}));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    Card: Box, Screen: Box, IconChip: () => null, LoadingBlock: () => null, ErrorState: () => null, EmptyState: () => null,
    Header: (p: any) => h('header', null, p.title), PillButton: (p: any) => h('span', null, p.label),
    T: (p: any) => h('span', null, p.children),
  };
});
vi.mock('../../../hooks/customer', () => ({
  useAddresses: () => ({
    isLoading: false, isError: false, refetch: vi.fn(),
    data: [
      { id: 'home', label: 'Home', addressLine1: 'Lot 1', city: 'Georgetown', isDefault: true },
      { id: 'work', label: 'Work', addressLine1: 'Lot 2', city: 'Georgetown', isDefault: false },
    ],
  }),
  useSetCartAddress: () => useMutation({ mutationFn: (id: string) => fx.setCartAddress(id) }),
  useSetDefaultAddress: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteAddress: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AddressesScreen } from './AddressesScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const rowFor = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith(label)) ?? null;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
function deferred() {
  let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(AddressesScreen))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe('[UI-SWEEP U34] Deliver To: one pick at a time, and the pick says so', () => {
  it('a second tap while the first is saving sends nothing; the tapped row says Saving and the list is locked', async () => {
    const answer = deferred();
    fx.setCartAddress.mockReturnValueOnce(answer.promise);
    // The same frame: a double tap and a tap on another row, before any re-render
    // could lock the list (the screen's own one-pick guard has to hold here).
    await act(async () => { const home = rowFor('Home')!; const work = rowFor('Work')!; home.click(); home.click(); work.click(); });
    await settle();
    // And after the re-render, the locked list sends nothing either.
    await act(async () => { rowFor('Work')!.click(); rowFor('Home')!.click(); });
    await settle();
    expect(fx.setCartAddress).toHaveBeenCalledTimes(1);
    expect(fx.setCartAddress).toHaveBeenCalledWith('home');
    expect(rowFor('Home')!.textContent).toContain('Saving…');
    expect(rowFor('Home')!.getAttribute('aria-busy')).toBe('true');
    expect(rowFor('Work')!.disabled).toBe(true);
    expect(fx.goBack).not.toHaveBeenCalled();
    await act(async () => { answer.resolve({}); });
    await settle();
    expect(fx.goBack).toHaveBeenCalledTimes(1);
  });

  it('a failed pick says so and unlocks the list: the next tap sends', async () => {
    const answer = deferred();
    fx.setCartAddress.mockReturnValueOnce(answer.promise);
    await act(async () => { rowFor('Work')!.click(); });
    await act(async () => { answer.reject(new Error('Network Error')); });
    await settle();
    expect(fx.alert).toHaveBeenCalledWith('Could not use this address', 'Check your connection and try again.');
    expect(rowFor('Work')!.disabled).toBe(false);
    expect(rowFor('Work')!.textContent).not.toContain('Saving…');
    fx.setCartAddress.mockResolvedValueOnce({});
    await act(async () => { rowFor('Work')!.click(); });
    await settle();
    expect(fx.setCartAddress).toHaveBeenCalledTimes(2);
    expect(fx.goBack).toHaveBeenCalledTimes(1);
  });
});
