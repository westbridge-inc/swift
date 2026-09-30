import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosAdapter } from 'axios';

const mock = vi.hoisted(() => ({
  owner: { userId: 'owner', generation: 1, accessToken: 'test-access', refreshToken: 'test-refresh' },
  listener: undefined as undefined | ((_response: unknown) => void),
  navigate: vi.fn(),
}));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: () => ({ ...mock.owner }), useAuthStore: { getState: () => ({}) } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: typeof mock.listener) => { mock.listener = listener; return { remove: vi.fn() }; },
  getLastNotificationResponseAsync: async () => null,
}));
vi.mock('../navigation/navigationRef', () => ({ navigationRef: { isReady: () => true }, safeNavigate: mock.navigate }));
import { api, weeklyFeeApi } from './api';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { destinationFor, installNotificationTapRouter } from './notification-router';
import { resolveFeeNotification } from './weekly-fee-notification';
const notice = { kind: 'billing_mmg_checkout', vendorId: 'store-A', subscriptionId: 'subscription-A', ref: 'ref-A', status: 'CONFIRMED' };
const original = api.defaults.adapter;
beforeEach(() => {
  mock.owner.generation = 1;
  mock.navigate.mockReset().mockReturnValue(true);
  useStoreSwitcher.setState({ selectedStoreId: 'store-B', feeContextPending: false });
});
afterEach(() => { api.defaults.adapter = original; });

describe('notified subscription context', () => {
  it('selects A before navigation and polls A only with A’s header; push status is not evidence', async () => {
    const calls: Array<[string | undefined, unknown]> = [];
    let finish!: () => void;
    api.defaults.adapter = (async (config) => {
      calls.push([config.url, config.headers.get('x-vendor-id')]);
      expect(config.headers.get('x-client-platform')).toBe('ios');
      if (config.url === '/vendor/subscription') {
        await new Promise<void>((resolve) => { finish = resolve; });
        return { config, status: 200, statusText: 'OK', headers: {}, data: { data: { id: 'subscription-A' } } };
      }
      return { config, status: 200, statusText: 'OK', headers: {}, data: { data: { ref: 'ref-A', status: 'EXPIRED' } } };
    }) as AxiosAdapter;
    mock.navigate.mockImplementation((_screen, params) => {
      expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
      expect(params).toEqual({ vendorId: 'store-A', subscriptionId: 'subscription-A', ref: 'ref-A', feeFamily: 'vendor' });
      return true;
    });
    const uninstall = installNotificationTapRouter();
    try {
      mock.listener!({ notification: { request: { content: { data: notice } } } });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(useStoreSwitcher.getState().feeContextPending).toBe(true);
      expect(mock.navigate).not.toHaveBeenCalled();
      finish(); await vi.waitFor(() => expect(mock.navigate).toHaveBeenCalledOnce());
      expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
      const client = weeklyFeeApi('vendor', mock.owner, 'store-A');
      expect((await client.read('ref-A')).status).toBe('EXPIRED');
      expect(calls).toEqual([['/vendor/subscription', 'store-A'], ['/vendor/subscription/mmg-checkout/ref-A', 'store-A']]);
      useStoreSwitcher.getState().setSelectedStore('store-B');
      await expect(client.read('ref-A')).rejects.toThrow('paying account changed');
      expect(calls).toHaveLength(2);
    } finally { uninstall(); }
  });
  it.each([403, 404])('falls back on %s without carrying A’s ref to B', async (status) => {
    api.defaults.adapter = async () => { throw { response: { status } }; };
    const params = await resolveFeeNotification(destinationFor(notice)!.params!);
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-B');
    expect(params).toEqual({ vendorId: 'store-B', ref: undefined, subscriptionId: undefined });
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
  });
  it.each(['timeout', '503'])('keeps %s unresolved until Retry succeeds, or Cancel returns to B without A’s ref', async (failure) => {
    const error = failure === 'timeout' ? { code: 'ECONNABORTED' } : { response: { status: 503 } };
    api.defaults.adapter = async () => { throw error; };
    const navigate = vi.fn();
    await resolveFeeNotification(destinationFor(notice)!.params!, navigate);
    expect(useStoreSwitcher.getState().feeContextPending).toBe(true);
    const recovery = useStoreSwitcher.getState().feeContextError;
    expect(recovery).not.toBeNull();
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-B');
    recovery!.cancel();
    expect(navigate).toHaveBeenLastCalledWith({ vendorId: 'store-B', ref: undefined, subscriptionId: undefined });
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    expect(useStoreSwitcher.getState().feeContextError).toBeNull();

    await resolveFeeNotification(destinationFor(notice)!.params!, navigate);
    api.defaults.adapter = async (config) => ({ config, status: 200, statusText: 'OK', headers: {}, data: { data: { id: 'subscription-A' } } });
    await useStoreSwitcher.getState().feeContextError!.retry();
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    expect(useStoreSwitcher.getState().feeContextError).toBeNull();
    expect(navigate).toHaveBeenLastCalledWith(destinationFor(notice)!.params);
  });
  it.each(['store', 'account'])('does not navigate if the %s changes during resolution', async (change) => {
    api.defaults.adapter = async (config) => {
      if (change === 'store') useStoreSwitcher.getState().setSelectedStore('store-C');
      else mock.owner.generation++;
      return { config, status: 200, statusText: 'OK', headers: {}, data: { data: { id: 'subscription-A' } } };
    };
    expect(await resolveFeeNotification(destinationFor(notice)!.params!)).toBeNull();
    expect(useStoreSwitcher.getState().selectedStoreId).not.toBe('store-A');
  });
});
