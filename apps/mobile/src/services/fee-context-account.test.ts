import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@swift/types';

// Real authentication actions, tenant store and resolver. Storage, transport
// and native teardown are synthetic; this suite never opens a service.
const fx = vi.hoisted(() => ({ subscription: vi.fn(), sequence: 0 }));
vi.mock('../lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } }));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope: vi.fn() }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `synthetic-scope-${++fx.sequence}` }));
vi.mock('../services/api', () => ({ vendorApi: { subscription: fx.subscription }, revokeAuthSession: vi.fn(async () => undefined) }));
vi.mock('../services/socket', () => ({ disconnectSocket: vi.fn(), reconnectSocketForStoreHandoff: vi.fn() }));
vi.mock('../services/backgroundLocation', () => ({ stopMoverLocation: vi.fn() }));
vi.mock('../services/push', () => ({ preparePushTokenForLogout: vi.fn(async () => null) }));
import { getAuthSessionSnapshot, useAuthStore } from '../stores/authStore';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { queryClient } from '../lib/queryClient';
import { resolveFeeNotification } from './weekly-fee-notification';

function signIn(id: string) {
  useAuthStore.getState().setAuth({ id, roles: ['VENDOR', 'RIDER'], activeRole: 'VENDOR' } as unknown as User, 'synthetic-access', 'synthetic-refresh');
}
const params = { vendorId: 'target-A', subscriptionId: 'subscription-A', ref: 'checkout-A' };

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: null, isAuthenticated: false, accessToken: null, refreshToken: null, sessionGeneration: 0 });
  useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null, feeContextPending: false, feeContextError: null });
  signIn('account-A');
});
afterEach(() => queryClient.clear());

describe('R3 departing account fee state retirement', () => {
  it.each(['logout-login', 'interactive-login', 'expired-session'] as const)('retires pending context at %s even with selected ID already null', async boundary => {
    let finish!: () => void;
    fx.subscription.mockImplementation(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { data: { data: { id: 'subscription-A' } } };
    });
    const old = resolveFeeNotification(params);
    expect(useStoreSwitcher.getState().selectedStoreId).toBeNull();
    expect(useStoreSwitcher.getState().feeContextPending).toBe(true);
    if (boundary === 'logout-login') { useAuthStore.getState().logout(); signIn('account-B'); }
    else if (boundary === 'expired-session') {
      expect(useAuthStore.getState().logoutIfCurrent(getAuthSessionSnapshot()!)).toBe(true);
      signIn('account-B');
    } else signIn('account-B');
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    expect(useStoreSwitcher.getState().feeContextError).toBeNull();
    finish(); expect(await old).toBeNull();
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    expect(useStoreSwitcher.getState().selectedStoreId).toBeNull();
  });

  it.each(['logout-login', 'interactive-login'] as const)('retires failed context and both retained controls at %s', async boundary => {
    fx.subscription.mockRejectedValue({ response: { status: 503 } });
    const navigate = vi.fn();
    await resolveFeeNotification(params, navigate);
    const old = useStoreSwitcher.getState().feeContextError!;
    expect(old).not.toBeNull();
    if (boundary === 'logout-login') useAuthStore.getState().logout();
    signIn('account-B');
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    expect(useStoreSwitcher.getState().feeContextError).toBeNull();
    await old.retry(); old.cancel();
    expect(fx.subscription).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
  });

  it.each(['pending', 'error'] as const)('old controls preserve B’s newer %s context after real interactive login', async phase => {
    fx.subscription.mockRejectedValue({ response: { status: 503 } });
    const navigate = vi.fn();
    await resolveFeeNotification(params, navigate);
    const old = useStoreSwitcher.getState().feeContextError!;
    signIn('account-B');
    let finish!: () => void;
    fx.subscription.mockImplementation(async () => {
      if (phase === 'error') throw { response: { status: 503 } };
      await new Promise<void>(resolve => { finish = resolve; });
      return { data: { data: { id: 'subscription-B' } } };
    });
    const next = resolveFeeNotification({ vendorId: 'target-B', subscriptionId: 'subscription-B' });
    if (phase === 'error') await next;
    const owned = useStoreSwitcher.getState();
    await old.retry(); old.cancel();
    expect(useStoreSwitcher.getState().feeContextPending).toBe(owned.feeContextPending);
    expect(useStoreSwitcher.getState().feeContextError).toBe(owned.feeContextError);
    expect(navigate).not.toHaveBeenCalled();
    if (phase === 'pending') { finish(); await next; }
  });

  it.each(['success', 'error'] as const)('a late A %s after B begins its own resolution neither navigates nor clears B', async outcome => {
    let finishA!: () => void;
    fx.subscription.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishA = resolve; });
      if (outcome === 'error') throw { response: { status: 503 } };
      return { data: { data: { id: 'subscription-A' } } };
    });
    const navigateA = vi.fn();
    const old = resolveFeeNotification(params, navigateA);
    useAuthStore.getState().logout(); signIn('account-B');
    let finishB!: () => void;
    fx.subscription.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishB = resolve; });
      return { data: { data: { id: 'subscription-B' } } };
    });
    const next = resolveFeeNotification({ vendorId: 'target-B', subscriptionId: 'subscription-B' });
    expect(useStoreSwitcher.getState().feeContextPending).toBe(true);
    finishA(); expect(await old).toBeNull();
    // A's finalizer and failure path belong to A: B's lookup is still pending.
    expect(useStoreSwitcher.getState().feeContextPending).toBe(true);
    expect(useStoreSwitcher.getState().feeContextError).toBeNull();
    expect(useStoreSwitcher.getState().selectedStoreId).toBeNull();
    expect(navigateA).not.toHaveBeenCalled();
    finishB(); await next;
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('target-B');
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
  });

  it.each(['store-B', 'roundtrip'] as const)('retires stale same-account error on %s without requiring Retry or Cancel', async selection => {
    useStoreSwitcher.getState().setSelectedStore('store-A');
    fx.subscription.mockRejectedValue({ response: { status: 503 } });
    const navigate = vi.fn();
    await resolveFeeNotification(params, navigate);
    const old = useStoreSwitcher.getState().feeContextError!;
    useStoreSwitcher.getState().setSelectedStore('store-B');
    if (selection === 'roundtrip') useStoreSwitcher.getState().setSelectedStore('store-A');
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    expect(useStoreSwitcher.getState().feeContextError).toBeNull();
    await old.retry(); old.cancel();
    expect(navigate).not.toHaveBeenCalled();
    expect(fx.subscription).toHaveBeenCalledOnce();
  });
});
