/// <reference lib="dom" />
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContainer, createNavigationContainerRef, createNavigatorFactory, StackRouter, useNavigationBuilder } from '@react-navigation/native';

const fx = vi.hoisted(() => ({
  listener: undefined as undefined | ((response: any) => void), reads: vi.fn(),
  client: undefined as QueryClient | undefined, navigate: undefined as undefined | ((name: string, params?: any) => boolean),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'web', select: (options: any) => options.web ?? options.default }, Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) },
  BackHandler: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (fn: typeof fx.listener) => { fx.listener = fn; return { remove() {} }; },
  getLastNotificationResponseAsync: async () => null,
}));
vi.mock('../navigation/navigationRef', () => ({ navigationRef: { isReady: () => !!fx.navigate }, safeNavigate: (name: string, params?: any) => fx.navigate?.(name, params) }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: () => ({ userId: 'fixture-recipient', generation: 1 }) }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null, storeGeneration: 0 }) } }));
vi.mock('../services/api', () => ({ customerApi: { teamInvites: () => fx.reads() } }));
vi.mock('../lib/queryClient', () => ({ get queryClient() { return fx.client; } }));
import { useTeamInvites } from '../hooks/teamInvites';
import { installNotificationTapRouter } from './notification-router';

// React Navigation and React Query run normally; only drawing and API I/O are
// replaced. The same mounted Notifications route receives consecutive taps.
function Navigator({ children }: { children: React.ReactNode }) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, { children });
  return React.createElement(NavigationContent, null, descriptors[state.routes[state.index]!.key]!.render());
}
const Stack = createNavigatorFactory(Navigator)();
let mounts = 0;
function Inbox() {
  useEffect(() => { mounts++; }, []);
  const invites = useTeamInvites();
  return React.createElement('div', null, invites.data?.map(invite => React.createElement('span', { key: invite.id }, invite.storeName)));
}
function Storefront() {
  return React.createElement(Stack.Navigator, null, React.createElement(Stack.Screen, { name: 'Notifications', component: Inbox }));
}
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let uninstall: (() => void) | undefined;
afterEach(async () => {
  uninstall?.(); fx.navigate = undefined;
  await act(async () => root?.unmount()); host?.remove(); fx.client?.clear();
  vi.clearAllMocks();
});

describe('a repeated invitation tap refreshes an already focused inbox', () => {
  it('fetches and renders the new invitation without remounting Notifications', async () => {
    mounts = 0;
    let rows: Array<{ id: string; storeName: string; role: 'STAFF'; expiresAt: string; createdAt: string }> = [];
    fx.reads.mockImplementation(async () => ({ data: { data: rows } }));
    fx.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ref = createNavigationContainerRef<any>();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(React.createElement(QueryClientProvider, { client: fx.client! },
      React.createElement(NavigationContainer, { ref }, React.createElement(Stack.Navigator, null,
        React.createElement(Stack.Screen, { name: 'Storefront', component: Storefront }))))));
    fx.navigate = (name, params) => { ref.navigate(name, params); return true; };
    uninstall = installNotificationTapRouter();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(fx.reads).toHaveBeenCalledTimes(1);
    expect(mounts).toBe(1);
    const tap = { notification: { request: { content: { data: { kind: 'staff_invite', audience: 'customer', vendorId: 'fixture-store' } } } } };
    // Both pushes arrive while the inbox is already focused. Neither may
    // rely on a mount/focus event to load its newly delivered invitation.
    for (let n = 1; n <= 2; n++) {
      rows = [{ id: `fixture-${n}`, storeName: `Fixture store ${n}`, role: 'STAFF', expiresAt: '2099-01-01', createdAt: '2026-10-07' }];
      await act(async () => { fx.listener!(tap); await new Promise(resolve => setTimeout(resolve, 60)); });
      expect(ref.getCurrentRoute()?.name).toBe('Notifications');
      expect(mounts).toBe(1);
      expect(host.textContent, `invite push ${n} refreshes the focused inbox`).toContain(`Fixture store ${n}`);
      expect(fx.reads).toHaveBeenCalledTimes(n + 1);
    }
  });
});
