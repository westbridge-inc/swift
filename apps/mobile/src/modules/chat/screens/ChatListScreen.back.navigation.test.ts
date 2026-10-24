/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [UI-SWEEP U11] Chat is a pushed stack screen (CustomerStack), not a tab: it
// draws the kit Header, whose chevron chip goes back (kit/screen.tsx Header).
// It used to draw a bare title, leaving only a swipe or a hardware key.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ authed: true, goBack: vi.fn(), orders: { data: [] as unknown[], isLoading: false, isError: false, refetch: vi.fn() } }));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  return { View, FlatList: ({ data, renderItem }: any) => R.createElement('ul', null, (data ?? []).map((item: any) => renderItem({ item }))) };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: new Proxy({}, { get: () => ({}) }), space: new Proxy({}, { get: () => 0 }) }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn(), goBack: fx.goBack }) }));
vi.mock('../../../hooks/customer', () => ({ useOrders: () => fx.orders }));
vi.mock('../../../stores/authStore', () => ({ useAuthStore: () => ({ isAuthenticated: fx.authed, promptLogin: vi.fn() }) }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = ({ children }: any) => h('div', null, children);
  return {
    Screen: Box, Card: Box, T: ({ children }: any) => h('span', null, children),
    // The kit Header: its back chip calls goBack (kit/screen.tsx).
    Header: ({ title }: any) => h('header', null, h('button', { 'aria-label': 'Back', onClick: () => fx.goBack() }), h('h1', null, title)),
    EmptyState: ({ title }: any) => h('section', null, title), ErrorState: () => h('div', null, 'error'), LoadingBlock: () => h('div', null, 'loading'),
  };
});

import { ChatListScreen } from './ChatListScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { fx.goBack.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[UI-SWEEP U11] the Chat list has a way back', () => {
  it.each([['signed in', true], ['signed out', false]] as const)('%s: the kit header with its Back chip', async (_case, authed) => {
    fx.authed = authed;
    await act(async () => root.render(React.createElement(ChatListScreen)));
    expect(host.querySelector('header h1')?.textContent).toBe('Chat');
    const back = host.querySelector<HTMLButtonElement>('header button[aria-label="Back"]');
    expect(back, 'a back control on Chat').not.toBeNull();
    await act(async () => back!.click());
    expect(fx.goBack).toHaveBeenCalledTimes(1);
  });
});
