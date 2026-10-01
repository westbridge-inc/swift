import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosAdapter } from 'axios';

const mock = vi.hoisted(() => ({
  owner: { userId: 'owner', generation: 1, accessToken: 'test-access', refreshToken: 'test-refresh' },
  listener: undefined as undefined | ((_response: unknown) => void),
  navigate: vi.fn(),
  io: vi.fn(() => ({ disconnect: vi.fn() })),
}));
vi.mock('socket.io-client', () => ({ io: mock.io }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: () => ({ ...mock.owner }), useAuthStore: { getState: () => ({}) } }));
vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: typeof mock.listener) => { mock.listener = listener; return { remove: vi.fn() }; },
  getLastNotificationResponseAsync: async () => null,
}));
vi.mock('../navigation/navigationRef', () => ({ navigationRef: { isReady: () => true }, safeNavigate: mock.navigate }));
import { API_URL, api, weeklyFeeApi, vendorApi } from './api';
import { getSocket, disconnectSocket } from './socket';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { destinationFor, installNotificationTapRouter } from './notification-router';
import { resolveFeeNotification } from './weekly-fee-notification';
const notice = { kind: 'billing_mmg_checkout', vendorId: 'store-A', subscriptionId: 'subscription-A', ref: 'ref-A', status: 'CONFIRMED' };
const original = api.defaults.adapter;
beforeEach(() => {
  mock.owner.userId = 'owner'; mock.owner.generation = 1; mock.owner.accessToken = 'test-access';
  mock.navigate.mockReset().mockReturnValue(true);
  useStoreSwitcher.setState({ selectedStoreId: 'store-B', feeContextPending: false, feeContextError: null });
});
afterEach(() => { api.defaults.adapter = original; });

describe('notified subscription context', () => {
  it('keeps the socket origin when the API loads the shared store handoff first', () => {
    disconnectSocket();
    getSocket();
    expect(mock.io).toHaveBeenLastCalledWith(API_URL, expect.any(Object));
    disconnectSocket();
  });
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

  it('discards a notification for C when validation spans A → B → A', async () => {
    useStoreSwitcher.getState().setSelectedStore('store-A');
    let finish!: () => void;
    api.defaults.adapter = async (config) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { config, status: 200, statusText: 'OK', headers: {}, data: { data: { id: 'subscription-C' } } };
    };
    const pending = resolveFeeNotification({ vendorId: 'store-C', subscriptionId: 'subscription-C' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    useStoreSwitcher.getState().setSelectedStore('store-B');
    useStoreSwitcher.getState().setSelectedStore('store-A');
    finish();
    expect(await pending).toBeNull();
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
  });

  it('retires a failed notification retry after A → B → A', async () => {
    useStoreSwitcher.getState().setSelectedStore('store-A');
    const request = vi.fn(async () => { throw { response: { status: 503 } }; });
    api.defaults.adapter = request;
    const navigate = vi.fn();
    await resolveFeeNotification({ vendorId: 'store-C', subscriptionId: 'subscription-C' }, navigate);
    const retry = useStoreSwitcher.getState().feeContextError!.retry;
    expect(request).toHaveBeenCalledOnce();
    useStoreSwitcher.getState().setSelectedStore('store-B');
    useStoreSwitcher.getState().setSelectedStore('store-A');
    await retry();
    expect(request).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    expect(useStoreSwitcher.getState().feeContextError).toBeNull();
  });
});


describe('DS390 obsolete fee recovery ownership', () => {
  it('retires only its obsolete error after a real store change without requesting or navigating', async () => {
    const request = vi.fn(async () => { throw { response: { status: 503 } }; });
    api.defaults.adapter = request;
    const navigate = vi.fn();
    await resolveFeeNotification(destinationFor(notice)!.params!, navigate);
    const recovery = useStoreSwitcher.getState().feeContextError!;
    const stalePayment = weeklyFeeApi('vendor', { ...mock.owner }, 'store-B');
    useStoreSwitcher.getState().setSelectedStore('store-C');
    await recovery.retry();
    await expect(stalePayment.start('obsolete-payment')).rejects.toThrow('paying account changed');
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    expect(useStoreSwitcher.getState().feeContextError).toBeNull();
    expect(request).toHaveBeenCalledOnce(); expect(navigate).not.toHaveBeenCalled();
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-C');
  });
  it.each(['retry', 'cancel'] as const)('old %s cannot clear another account’s recovery state', async action => {
    api.defaults.adapter = async () => { throw { response: { status: 503 } }; };
    const navigate = vi.fn();
    await resolveFeeNotification(destinationFor(notice)!.params!, navigate);
    const recovery = useStoreSwitcher.getState().feeContextError!;
    mock.owner.userId = 'next-owner'; mock.owner.generation++;
    const newer = { retry: vi.fn(), cancel: vi.fn() };
    useStoreSwitcher.setState({ feeContextPending: true, feeContextError: newer });
    await recovery[action]();
    expect(useStoreSwitcher.getState().feeContextPending).toBe(true);
    expect(useStoreSwitcher.getState().feeContextError).toBe(newer);
    expect(navigate).not.toHaveBeenCalled();
  });
});


describe('DS390 fee recovery interleavings', () => {
  it.each(['pending', 'error', 'resolved'] as const)('old retry and cancel preserve a newer %s resolution', async phase => {
    api.defaults.adapter = async () => { throw { response: { status: 503 } }; };
    const oldNavigate = vi.fn();
    await resolveFeeNotification(destinationFor(notice)!.params!, oldNavigate);
    const old = useStoreSwitcher.getState().feeContextError!;
    let finish!: () => void;
    api.defaults.adapter = async config => {
      if (phase === 'pending') await new Promise<void>(resolve => { finish = resolve; });
      if (phase === 'error') throw { response: { status: 503 } };
      return { config, status: 200, statusText: 'OK', headers: {}, data: { data: { id: 'subscription-C' } } };
    };
    const next = resolveFeeNotification({ vendorId: 'store-C', subscriptionId: 'subscription-C' });
    if (phase === 'pending') await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    else await next;
    const state = useStoreSwitcher.getState();
    await old.retry(); old.cancel();
    expect(useStoreSwitcher.getState().feeContextPending).toBe(state.feeContextPending);
    expect(useStoreSwitcher.getState().feeContextError).toBe(state.feeContextError);
    expect(oldNavigate).not.toHaveBeenCalled();
    if (phase === 'pending') { finish(); await next; }
  });
  it.each(['retry', 'cancel'] as const)('old %s cannot clear a replacement error even in the same account', async action => {
    api.defaults.adapter = async () => { throw { response: { status: 503 } }; };
    const navigate = vi.fn();
    await resolveFeeNotification(destinationFor(notice)!.params!, navigate);
    const old = useStoreSwitcher.getState().feeContextError!;
    useStoreSwitcher.getState().setSelectedStore('store-C');
    const replacement = { retry: vi.fn(), cancel: vi.fn() };
    useStoreSwitcher.setState({ feeContextPending: true, feeContextError: replacement });
    await old[action]();
    expect(useStoreSwitcher.getState().feeContextError).toBe(replacement);
    expect(useStoreSwitcher.getState().feeContextPending).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });
  it.each(['store', 'roundtrip', 'account'] as const)('a retried request completing after %s cannot navigate or select the old target', async boundary => {
    api.defaults.adapter = async () => { throw { response: { status: 503 } }; };
    const navigate = vi.fn();
    await resolveFeeNotification(destinationFor(notice)!.params!, navigate);
    let finish!: () => void;
    api.defaults.adapter = async config => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { config, status: 200, statusText: 'OK', headers: {}, data: { data: { id: 'subscription-A' } } };
    };
    const retry = useStoreSwitcher.getState().feeContextError!.retry();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (boundary === 'account') mock.owner.generation++;
    else { useStoreSwitcher.getState().setSelectedStore('store-C'); if (boundary === 'roundtrip') useStoreSwitcher.getState().setSelectedStore('store-B'); }
    const replacement = { retry: vi.fn(), cancel: vi.fn() };
    if (boundary === 'account') useStoreSwitcher.setState({ feeContextPending: true, feeContextError: replacement });
    finish(); await retry;
    expect(navigate).not.toHaveBeenCalled();
    expect(useStoreSwitcher.getState().selectedStoreId).not.toBe('store-A');
    if (boundary === 'account') { expect(useStoreSwitcher.getState().feeContextError).toBe(replacement); expect(useStoreSwitcher.getState().feeContextPending).toBe(true); }
  });
});


describe('DS390 captured notification reads and final retry boundary', () => {
  it('pins profile and order reads to their captured principal and explicit store', async () => {
    const captured = { ...mock.owner };
    const calls: Array<[unknown, unknown, unknown]> = [];
    api.defaults.adapter = async config => {
      calls.push([config.url, config.headers.get('Authorization'), config.headers.get('x-vendor-id')]);
      return { config, status: 200, statusText: 'OK', headers: {}, data: { data: {} } };
    };
    mock.owner.userId = 'next-owner'; mock.owner.generation++; mock.owner.accessToken = 'next-test-access';
    useStoreSwitcher.getState().setSelectedStore('store-C');
    await vendorApi.profile(captured, 'store-A');
    await vendorApi.order('order-A', captured, 'store-A');
    expect(calls).toEqual([['/vendor/profile', 'Bearer test-access', 'store-A'], ['/vendor/orders/order-A', 'Bearer test-access', 'store-A']]);
  });
  it.each(['store', 'roundtrip', 'account', 'newer-resolution'] as const)('rechecks %s after retry validation and before the callback', async change => {
    api.defaults.adapter = async () => { throw { response: { status: 503 } }; };
    const navigate = vi.fn();
    await resolveFeeNotification(destinationFor(notice)!.params!, navigate);
    const recovery = useStoreSwitcher.getState().feeContextError!;
    api.defaults.adapter = async config => {
      if (config.headers.get('x-vendor-id') === 'store-C') throw { response: { status: 503 } };
      return { config, status: 200, statusText: 'OK', headers: {}, data: { data: { id: 'subscription-A' } } };
    };
    let traversed = false; let newer: Promise<unknown> | undefined;
    const unsubscribe = useStoreSwitcher.subscribe(state => {
      if (state.selectedStoreId !== 'store-A' || traversed) return;
      traversed = true;
      queueMicrotask(() => {
        if (change === 'account') mock.owner.generation++;
        else if (change === 'newer-resolution') newer = resolveFeeNotification({ vendorId: 'store-C', subscriptionId: 'subscription-C' });
        else { useStoreSwitcher.getState().setSelectedStore('store-B'); if (change === 'roundtrip') useStoreSwitcher.getState().setSelectedStore('store-A'); }
      });
    });
    try {
      await recovery.retry(); await newer;
      expect(traversed).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
      if (change === 'newer-resolution') { expect(useStoreSwitcher.getState().feeContextPending).toBe(true); expect(useStoreSwitcher.getState().feeContextError).not.toBeNull(); }
    } finally { unsubscribe(); }
  });
});


describe('DS390 recovery state finalizer ownership', () => {
  it.each(['retry', 'cancel'] as const)('an account boundary retires old %s authority even when the error object remains', async action => {
    api.defaults.adapter = async () => { throw { response: { status: 503 } }; };
    const navigate = vi.fn();
    await resolveFeeNotification(destinationFor(notice)!.params!, navigate);
    const old = useStoreSwitcher.getState().feeContextError!;
    mock.owner.generation++;
    await old[action]();
    expect(useStoreSwitcher.getState().feeContextPending).toBe(true);
    expect(useStoreSwitcher.getState().feeContextError).toBe(old);
    expect(navigate).not.toHaveBeenCalled();
  });
  it('an older pending request cannot finalize a newer error resolution', async () => {
    let finish!: () => void;
    api.defaults.adapter = async config => {
      if (config.headers.get('x-vendor-id') === 'store-C') throw { response: { status: 503 } };
      await new Promise<void>(resolve => { finish = resolve; });
      return { config, status: 200, statusText: 'OK', headers: {}, data: { data: { id: 'subscription-A' } } };
    };
    const old = resolveFeeNotification(destinationFor(notice)!.params!);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await resolveFeeNotification({ vendorId: 'store-C', subscriptionId: 'subscription-C' });
    const newer = useStoreSwitcher.getState().feeContextError;
    finish(); expect(await old).toBeNull();
    expect(useStoreSwitcher.getState().feeContextPending).toBe(true);
    expect(useStoreSwitcher.getState().feeContextError).toBe(newer);
  });
});

// [AX449 #2] A cold fee tap waits on subscription validation while the shell's
// first profile makes the automatic null -> first-store selection. Only that
// automatic handoff may land under the lookup; the notice keeps its intent.
describe('R3 cold fee notification across the automatic first store', () => {
  it.each(['store-A', 'store-C'])('preserves only automatic cold hydration while resolving %s', async target => {
    useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null });
    let finish!: () => void;
    const request = vi.spyOn(vendorApi, 'subscription').mockImplementation(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { data: { data: { id: `subscription-${target}` } } } as never;
    });
    try {
      const params = { vendorId: target, subscriptionId: `subscription-${target}`, ref: 'cold-ref' };
      const result = resolveFeeNotification(params);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      useStoreSwitcher.getState().initializeSelectedStore('store-A');
      // The automatic handoff is not a choice: Pay stays blocked for the notice.
      expect(useStoreSwitcher.getState().feeContextPending).toBe(true);
      finish();
      expect(await result).toEqual(params);
      expect(useStoreSwitcher.getState().selectedStoreId).toBe(target);
      expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    } finally { request.mockRestore(); }
  });

  it.each(['explicit', 'roundtrip'] as const)('an %s first choice while the lookup waits retires the cold notice', async change => {
    useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null });
    let finish!: () => void;
    const request = vi.spyOn(vendorApi, 'subscription').mockImplementation(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { data: { data: { id: 'subscription-C' } } } as never;
    });
    try {
      const result = resolveFeeNotification({ vendorId: 'store-C', subscriptionId: 'subscription-C', ref: 'cold-ref' });
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      if (change === 'explicit') useStoreSwitcher.getState().setSelectedStore('store-A');
      else {
        useStoreSwitcher.getState().initializeSelectedStore('store-A');
        useStoreSwitcher.getState().setSelectedStore('store-B');
        useStoreSwitcher.getState().setSelectedStore('store-A');
      }
      finish();
      expect(await result).toBeNull();
      expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
      expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    } finally { request.mockRestore(); }
  });
});
