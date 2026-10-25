import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createStore } from 'zustand/vanilla';
import type { User } from '@swift/types';
const native = vi.hoisted(() => ({
  stopMoverLocation: vi.fn(async () => {}),
  disconnectSocket: vi.fn(),
  preparePushTokenForLogout: vi.fn(async () => null),
  revokeAuthSession: vi.fn(async () => {}),
}));
vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem() {}, removeItem() {} } }));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope() {} }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `fixture-scope-${++next}` }; });
vi.mock('../services/push', () => ({ preparePushTokenForLogout: native.preparePushTokenForLogout }));
vi.mock('../services/api', () => ({ revokeAuthSession: native.revokeAuthSession }));
vi.mock('../services/backgroundLocation', () => ({ stopMoverLocation: native.stopMoverLocation }));
vi.mock('../services/socket', () => ({ disconnectSocket: native.disconnectSocket }));
vi.mock('./storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ setSelectedStore() {} }) } }));

// Resolve these mocked modules before auth schedules its dynamic teardown.
import '../services/backgroundLocation';
import '../services/socket';
import '../services/push';

import { bindQueryCacheScope } from '../lib/appQueryPolicy';
import { queryClient } from '../lib/queryClient';
import { getAuthSessionSnapshot, useAuthStore } from './authStore';
import { AuthRefreshCoordinator } from '../lib/authSession';

const keys = [['customer', 'profile'], ['market', 'items'], ['customer', 'cart'], ['mover', 'available']];
const person = (id: string) => ({ id, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', firstName: 'Fixture' }) as User;
const login = (id: string) => useAuthStore.getState().setAuth(person(id), 'synthetic-access', 'synthetic-refresh');
let stop: () => void;
beforeEach(() => {
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false });
  queryClient.clear();
  stop = bindQueryCacheScope(queryClient, useAuthStore);
});
afterEach(async () => {
  // Logout's fire-and-forget native teardown must finish while its mocks live.
  await vi.dynamicImportSettled();
  stop(); queryClient.clear();
});

describe('person-scoped in-memory cache', () => {
  it('the scope binding itself cancels and wipes the old cache, including mutation entries', () => {
    const client = new QueryClient();
    const source = createStore(() => ({ adEventScopeId: 'fixture-a', sessionGeneration: 1 }));
    const off = bindQueryCacheScope(client, source);
    client.setQueryData(keys[0]!, { owner: 'A' });
    client.getMutationCache().build(client, { mutationFn: async () => 'A' });
    const aHash = client.getQueryCache().getAll()[0]!.queryHash;
    source.setState({ adEventScopeId: 'fixture-b', sessionGeneration: 2 });
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(client.getQueryData(keys[0]!)).toBeUndefined();
    client.setQueryData(keys[0]!, { owner: 'B' });
    expect(client.getQueryCache().getAll()[0]!.queryHash).not.toBe(aHash);
    off(); client.clear();
  });

  it.each(['logout', 'account-switch', 'token-rejection'] as const)('wipes real authStore cache at %s', async (boundary) => {
    login('fixture-a');
    keys.forEach((key) => queryClient.setQueryData(key, { owner: 'A' }));
    if (boundary === 'logout') useAuthStore.getState().logout();
    if (boundary === 'account-switch') login('fixture-b');
    if (boundary === 'token-rejection') {
      const coordinator = new AuthRefreshCoordinator({
        current: getAuthSessionSnapshot,
        rotateTokensIfCurrent: (...args) => useAuthStore.getState().rotateTokensIfCurrent(...args),
        logoutIfCurrent: (session) => useAuthStore.getState().logoutIfCurrent(session),
      }, async () => { throw { response: { status: 401 } }; }, (error: any) => error.response?.status === 401);
      await coordinator.resolve(getAuthSessionSnapshot()!);
    }
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    keys.forEach((key) => expect(queryClient.getQueryData(key)).toBeUndefined());
  });

  it('a late account-A response cannot replace B, even at the same raw query key', async () => {
    login('fixture-a');
    let finishA!: (value: { owner: string }) => void;
    const aborted = vi.fn();
    const a = new QueryObserver(queryClient, {
      queryKey: keys[0]!, queryFn: ({ signal }) => new Promise<{ owner: string }>((resolve) => {
        finishA = resolve; signal.addEventListener('abort', aborted);
      }),
    });
    const off = a.subscribe(() => {});
    login('fixture-b');
    expect(aborted).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(keys[0]!)).toBeUndefined();
    await queryClient.fetchQuery({ queryKey: keys[0]!, queryFn: async () => ({ owner: 'B' }) });
    finishA({ owner: 'A' });
    await Promise.resolve();
    expect(queryClient.getQueryData(keys[0]!)).toEqual({ owner: 'B' });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
    off();
  });

  it('token rotation preserves the boundary and raw-prefix invalidation still works', async () => {
    login('fixture-a');
    queryClient.setQueryData(keys[0]!, { owner: 'A' });
    const hash = queryClient.getQueryCache().getAll()[0]!.queryHash;
    useAuthStore.getState().rotateTokensIfCurrent(getAuthSessionSnapshot()!, { accessToken: 'synthetic-next', refreshToken: 'synthetic-next' });
    expect(queryClient.getQueryData(keys[0]!)).toEqual({ owner: 'A' });
    expect(queryClient.getQueryCache().getAll()[0]!.queryHash).toBe(hash);
    await queryClient.invalidateQueries({ queryKey: ['customer'] });
    expect(queryClient.getQueryState(keys[0]!)?.isInvalidated).toBe(true);
  });
});
