import axios, { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { MutationCache, QueryClient } from '@tanstack/react-query';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

// The native/React shell is replaced, but MutationObserver, Mutation.execute,
// awaited cache callbacks, retries and Axios interceptors are the real code.
// No test calls mutationFn/onMutate/onSuccess directly.
const env = vi.hoisted(() => {
  const previousApiUrl = process.env['EXPO_PUBLIC_API_URL'];
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return {
    previousApiUrl, session: null as AuthSessionSnapshot | null, anonymousGeneration: 0,
    client: null as any, frame: null as any, resetAttempt: () => {}, restartAttempt: () => {},
    effects: [] as Array<() => void | (() => void)>, toastError: vi.fn(),
    barrier: null as null | (() => Promise<void>), disposers: [] as Array<() => void>,
  };
});
vi.mock('react', async (original) => ({
  ...await original<object>(),
  useRef: (value: unknown) => { const f = env.frame; return f.refs[f.refIndex++] ??= { current: value }; },
  useState: (value: unknown) => {
    const f = env.frame; const index = f.stateIndex++;
    if (!(index in f.states)) f.states[index] = value;
    return [f.states[index], (next: unknown) => { f.states[index] = next; }];
  },
  useEffect: (effect: () => void | (() => void)) => { env.effects.push(effect); },
}));
vi.mock('@tanstack/react-query', async (original) => {
  const actual = await original<typeof import('@tanstack/react-query')>();
  return {
    ...actual, useQueryClient: () => env.client,
    useMutation: (options: any) => {
      const f = env.frame; const index = f.mutationIndex++;
      if (!f.observers[index]) {
        f.observers[index] = new actual.MutationObserver(env.client, options);
        env.disposers.push(f.observers[index].subscribe(() => {}));
      } else f.observers[index].setOptions(options);
      const observer = f.observers[index];
      return { ...observer.getCurrentResult(), mutateAsync: observer.mutate,
        mutate: (variables: unknown, callbacks: any) => { void observer.mutate(variables, callbacks).catch(() => {}); } };
    },
  };
});
vi.mock('../stores/authStore', async () => {
  const { samePrincipalBoundary } = await vi.importActual<typeof import('../lib/authSession')>('../lib/authSession');
  class AuthSessionBoundaryError extends Error { constructor() { super('Account changed'); this.name = 'AuthSessionBoundaryError'; } }
  const current = (s: AuthSessionSnapshot) => samePrincipalBoundary(s, env.session) && s.refreshToken === env.session?.refreshToken;
  return {
    AuthSessionBoundaryError, getAuthSessionSnapshot: () => env.session && { ...env.session },
    requireAuthSessionForPrincipal: (p: AuthSessionSnapshot) => {
      if (!samePrincipalBoundary(p, env.session)) throw new AuthSessionBoundaryError();
      return { ...env.session };
    },
    isAuthSessionSnapshotCurrent: current,
    useAuthStore: Object.assign((select: any) => select({ user: { id: env.session?.userId }, sessionGeneration: env.session?.generation ?? env.anonymousGeneration }), {
      getState: () => ({
        sessionGeneration: env.session?.generation ?? env.anonymousGeneration,
        rotateTokensIfCurrent: (s: AuthSessionSnapshot, tokens: { accessToken: string; refreshToken: string }) => {
          if (!current(s)) return null;
          env.session = { ...s, ...tokens }; return { ...env.session };
        },
        logoutIfCurrent: (s: AuthSessionSnapshot) => { if (!current(s)) return false; env.session = null; return true; },
      }),
    }),
  };
});
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } }));
vi.mock('../kit/toast', () => ({ toast: { error: env.toastError } }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/marketDepthMemory', () => ({ rememberedMarketDepth: () => null, rememberMarketDepth: () => {} }));
vi.mock('../lib/checkoutAttemptStore', async () => {
  const { createCheckoutAttempt } = await vi.importActual<typeof import('../lib/checkoutAttempt')>('../lib/checkoutAttempt');
  let next = 0;
  let serialized: string | null = null;
  const fresh = () => {
    return createCheckoutAttempt({ get: () => serialized, set: (v: string) => { serialized = v; }, clear: () => { serialized = null; } }, () => `chk_scheduler_${++next}`);
  };
  let attempt = fresh(); env.resetAttempt = () => { serialized = null; attempt = fresh(); };
  env.restartAttempt = () => { attempt = fresh(); };
  return { checkoutAttempt: new Proxy({}, { get: (_t, key) => Reflect.get(attempt, key) }) };
});

import { api } from '../services/api';
import { checkoutAttempt } from '../lib/checkoutAttemptStore';
import { queryClient } from '../lib/queryClient';
import { stableBodyHash } from '../lib/checkoutAttempt';
import { useAddToCart, useUpdateCartItem, useRemoveCartItem, useClearCart, useSetCartAddress, useSetCartTip, useRemoveCartPromo, useReorder, usePlaceOrder, useCheckoutRecovery } from './customer';

const A: AuthSessionSnapshot = { userId: 'a', generation: 1, accessToken: 'access-a', refreshToken: 'refresh-a' };
const B: AuthSessionSnapshot = { userId: 'b', generation: 2, accessToken: 'access-b', refreshToken: 'refresh-b' };
const body = { paymentMethod: 'CASH', tipAmount: 0 };
const changedBody = { ...body, tipAmount: 100 };
const originalApiAdapter = api.defaults.adapter;
const originalAxiosAdapter = axios.defaults.adapter;
const authOwner = (request: InternalAxiosRequestConfig) => request.headers.get('Authorization') === `Bearer ${A.accessToken}` ? 'a'
  : request.headers.get('Authorization') === `Bearer ${B.accessToken}` ? 'b' : 'other';
let requests: InternalAxiosRequestConfig[] = [];
let invalidate: ReturnType<typeof vi.spyOn>;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const response = (config: InternalAxiosRequestConfig, status = 200, data: unknown = {}) => ({ config, status, statusText: String(status), headers: {}, data: { success: status < 400, data } }) as AxiosResponse;
function reject(config: InternalAxiosRequestConfig, status: number): never {
  throw new AxiosError('Synthetic refusal', 'ERR_BAD_RESPONSE', config, undefined, response(config, status));
}
function mount(render: () => any) {
  const frame = { refs: [], states: [], observers: [], refIndex: 0, stateIndex: 0, mutationIndex: 0 };
  return () => { env.frame = frame; frame.refIndex = 0; frame.stateIndex = 0; frame.mutationIndex = 0; return render(); };
}
function switchToB() {
  env.session = { ...B };
  const begun = checkoutAttempt.begin({ principal: B, bodyHash: 'b-cart' });
  env.client.setQueryData(['customer', 'cart'], { owner: 'b' });
  invalidate.mockClear();
  return begun.key;
}
function assertBIntact(key: string | null) {
  expect(checkoutAttempt.currentFor(B)?.key).toBe(key);
  expect(env.client.getQueryData(['customer', 'cart'])).toEqual({ owner: 'b' });
  expect(invalidate).not.toHaveBeenCalled();
  expect(requests.filter((r) => !r.url?.includes('/auth/')).map((r) => r.headers.get('Authorization'))).not.toContain('Bearer access-b');
}
beforeEach(() => {
  env.session = { ...A }; env.anonymousGeneration = 0; env.resetAttempt(); env.barrier = null; env.effects = []; env.toastError.mockClear(); requests = [];
  env.client = new QueryClient({ mutationCache: new MutationCache({ onMutate: async () => { await env.barrier?.(); } }), defaultOptions: { mutations: { retry: false, gcTime: Infinity }, queries: { retry: false, gcTime: Infinity } } });
  invalidate = vi.spyOn(env.client, 'invalidateQueries');
  const adapter: AxiosAdapter = async (config) => { requests.push(config); return response(config); };
  api.defaults.adapter = adapter; axios.defaults.adapter = adapter;
});
afterEach(() => {
  env.disposers.splice(0).forEach((dispose) => dispose()); env.client.clear();
  api.defaults.adapter = originalApiAdapter; axios.defaults.adapter = originalAxiosAdapter;
  vi.useRealTimers();
});
afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

const changes: Array<[string, () => any, unknown]> = [
  ['add', useAddToCart, { vendorId: 'v1', itemId: 'i1' }], ['update', useUpdateCartItem, { id: 'i1', quantity: 2 }],
  ['remove', useRemoveCartItem, 'i1'], ['clear', useClearCart, undefined], ['address', useSetCartAddress, 'address-a'],
  ['tip', useSetCartTip, 100], ['promo', useRemoveCartPromo, undefined], ['reorder', useReorder, 'order-a'],
];

describe('[SX401] real mutation scheduling through cart transport', () => {
  it.each(changes)('%s routes guest capture refusal through mutation state and callbacks', async (_name, hook, payload) => {
    env.session = null;
    const render = mount(hook); const error = vi.fn(); const settled = vi.fn();
    expect(() => render().mutate(payload, { onError: error, onSettled: settled })).not.toThrow();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0]![0]).toMatchObject({ name: 'AuthSessionBoundaryError' });
    expect(settled).toHaveBeenCalledTimes(1); expect(requests).toEqual([]);
    expect(render()).toMatchObject({ isError: true, error: { name: 'AuthSessionBoundaryError' } });
  });

  it.each(changes)('%s suppresses queued guest failure callbacks after B signs in', async (_name, hook, payload) => {
    env.session = null; const entered = deferred(); const release = deferred();
    env.barrier = () => { entered.resolve(); return release.promise; };
    const render = mount(hook); const callback = vi.fn();
    expect(() => render().mutate(payload, { onError: callback, onSettled: callback })).not.toThrow();
    await entered.promise; const key = switchToB(); release.resolve();
    await vi.waitFor(() => expect(env.client.getMutationCache().getAll()[0].state.status).toBe('error'));
    expect(callback).not.toHaveBeenCalled(); expect(requests).toEqual([]); assertBIntact(key);
    expect(render()).toMatchObject({ error: null, isIdle: true, variables: undefined });
  });

  it('a queued guest refusal cannot publish into a later anonymous generation', async () => {
    env.session = null; const entered = deferred(); const release = deferred();
    env.barrier = () => { entered.resolve(); return release.promise; };
    const render = mount(useClearCart); const callback = vi.fn();
    render().mutate(undefined, { onError: callback, onSettled: callback });
    await entered.promise; env.anonymousGeneration++; release.resolve();
    await vi.waitFor(() => expect(env.client.getMutationCache().getAll()[0].state.status).toBe('error'));
    expect(callback).not.toHaveBeenCalled(); expect(requests).toEqual([]);
    expect(render()).toMatchObject({ error: null, isIdle: true });
  });

  it('an old A error cannot replace the same observer pending B operation', async () => {
    const aEntered = deferred(); const aRelease = deferred(); const bEntered = deferred(); const bRelease = deferred();
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (authOwner(config) === 'a') { aEntered.resolve(); await aRelease.promise; return reject(config, 400); }
      bEntered.resolve(); await bRelease.promise; return response(config, 200, { owner: 'b' });
    };
    const render = mount(useSetCartTip); const hook = render(); const stale = vi.fn(); const fresh = vi.fn();
    const a = hook.mutateAsync(10, { onError: stale, onSettled: stale }).catch((e: unknown) => e);
    await aEntered.promise; const key = switchToB();
    const b = hook.mutateAsync(20, { onSuccess: fresh });
    await bEntered.promise; aRelease.resolve();
    expect(await a).toMatchObject({ name: 'AuthSessionBoundaryError' });
    expect(render()).toMatchObject({ isPending: true, status: 'pending', variables: 20, data: undefined, error: null });
    expect(stale).not.toHaveBeenCalled(); expect(invalidate).not.toHaveBeenCalled();
    expect(checkoutAttempt.currentFor(B)?.key).toBe(key);
    bRelease.resolve(); expect(await b).toEqual({ owner: 'b' }); expect(fresh).toHaveBeenCalledTimes(1);
    expect(render()).toMatchObject({ isSuccess: true, data: { owner: 'b' }, variables: 20 });
  });

  it.each(changes)('%s captures before the awaited MutationCache onMutate boundary', async (_name, hook, payload) => {
    const entered = deferred(); const release = deferred();
    env.barrier = () => { entered.resolve(); return release.promise; };
    const render = mount(hook); const mutation = render(); const callback = vi.fn();
    const pending = mutation.mutateAsync(payload, { onSuccess: callback, onError: callback, onSettled: callback }).catch((e: unknown) => e);
    await entered.promise; const key = switchToB(); release.resolve();
    expect(await pending).toMatchObject({ name: 'AuthSessionBoundaryError' });
    expect(requests).toEqual([]); expect(callback).not.toHaveBeenCalled(); assertBIntact(key);
    expect(render()).toMatchObject({ data: undefined, error: null, variables: undefined, isIdle: true });
  });

  it.each(changes)('%s fences result, callbacks and cache after actual transport', async (_name, hook, payload) => {
    const entered = deferred(); const release = deferred();
    api.defaults.adapter = async (config) => { requests.push(config); entered.resolve(); await release.promise; return response(config, 200, { owner: 'a' }); };
    const render = mount(hook); const mutation = render(); const callback = vi.fn();
    const pending = mutation.mutateAsync(payload, { onSuccess: callback, onError: callback, onSettled: callback }).catch((e: unknown) => e);
    await entered.promise; const key = switchToB(); release.resolve();
    expect(await pending).toMatchObject({ name: 'AuthSessionBoundaryError' });
    expect(requests).toHaveLength(1); expect(callback).not.toHaveBeenCalled(); assertBIntact(key);
    expect(render()).toMatchObject({ data: undefined, error: null, variables: undefined, isIdle: true });
  });

  it.each(changes)('%s pins Axios auth across an awaited request interceptor', async (_name, hook, payload) => {
    const entered = deferred(); const release = deferred();
    // Axios runs request interceptors in reverse registration order. This real
    // async interceptor pauses before api.ts attaches/preserves Authorization.
    const interceptor = api.interceptors.request.use(async (config) => { entered.resolve(); await release.promise; return config; });
    try {
      const callback = vi.fn();
      const pending = mount(hook)().mutateAsync(payload, { onSuccess: callback, onError: callback, onSettled: callback }).catch((e: unknown) => e);
      await entered.promise; const key = switchToB(); release.resolve();
      const result = await pending;
      expect(requests).toHaveLength(1);
      expect(authOwner(requests[0]!)).toBe('a');
      expect(result).toMatchObject({ name: 'AuthSessionBoundaryError' });
      expect(callback).not.toHaveBeenCalled(); assertBIntact(key);
    } finally { api.interceptors.request.eject(interceptor); }
  });

  it.each(changes)('%s cannot retry a captured A request as B after refresh awaits', async (_name, hook, payload) => {
    const entered = deferred(); const release = deferred();
    api.defaults.adapter = async (config) => { requests.push(config); return reject(config, 401); };
    axios.defaults.adapter = async (config) => {
      requests.push(config); entered.resolve(); await release.promise;
      return response(config, 200, { accessToken: 'access-rotated', refreshToken: 'refresh-rotated' });
    };
    const render = mount(hook); const callback = vi.fn();
    const pending = render().mutateAsync(payload, { onSuccess: callback, onError: callback, onSettled: callback }).catch((e: unknown) => e);
    await entered.promise; const key = switchToB(); release.resolve();
    expect(await pending).toMatchObject({ name: 'AuthSessionBoundaryError' });
    expect(requests.filter((r) => !r.url?.includes('/auth/'))).toHaveLength(1);
    expect(callback).not.toHaveBeenCalled(); assertBIntact(key);
  });

  it.each(changes)('%s preserves an authorized refresh within the same login', async (_name, hook, payload) => {
    let attempts = 0; let refreshes = 0;
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (++attempts === 1) return reject(config, 401);
      expect(config.headers.get('Authorization')).toBe('Bearer access-rotated');
      return response(config, 200, { owner: 'a' });
    };
    axios.defaults.adapter = async (config) => { refreshes++; return response(config, 200, { accessToken: 'access-rotated', refreshToken: 'refresh-rotated' }); };
    const callback = vi.fn();
    expect(await mount(hook)().mutateAsync(payload, { onSuccess: callback })).toEqual({ owner: 'a' });
    expect(attempts).toBe(2); expect(refreshes).toBe(1); expect(callback).toHaveBeenCalledTimes(1);
    expect(env.session).toMatchObject({ userId: A.userId, generation: A.generation });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['customer', 'cart'] });
  });

  it('concurrent calls on one hook retain separate immutable principals', async () => {
    const entered = deferred(); const release = deferred(); let calls = 0;
    env.barrier = () => { if (++calls === 1) { entered.resolve(); return release.promise; } return Promise.resolve(); };
    const mutation = mount(useSetCartTip)(); const stale = vi.fn(); const fresh = vi.fn();
    const a = mutation.mutateAsync(10, { onSuccess: stale, onError: stale }).catch((e: unknown) => e);
    await entered.promise; switchToB();
    const b = mutation.mutateAsync(20, { onSuccess: fresh });
    await b; release.resolve();
    expect(await a).toMatchObject({ name: 'AuthSessionBoundaryError' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer access-b');
    expect(JSON.parse(requests[0]!.data)).toEqual({ amount: 20 });
    expect(stale).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledTimes(1);
  });
});

describe('[SX401] an upstream retry refusal does not resolve an earlier send', () => {
  it('a delayed first-send refusal cannot reopen a concurrent committed same-key retry', async () => {
    vi.useFakeTimers();
    const entered = deferred(); const release = deferred(); let sends = 0;
    const committed = new Set<string>();
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url?.startsWith('/customer/checkout/receipts/')) return response(config, 200, { status: 'in_flight' });
      if (config.url === '/customer/checkout') {
        if (++sends === 1) { entered.resolve(); await release.promise; return reject(config, 400); }
        committed.add(String(config.headers.get('Idempotency-Key')));
        throw new AxiosError('Lost acknowledgement', 'ERR_NETWORK', config);
      }
      return response(config);
    };
    const first = mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    await entered.promise;
    const key = checkoutAttempt.currentFor(A)!.key;
    // A second mounted consumer still belongs to A and must reuse the key.
    const retryHook = mount(usePlaceOrder)();
    const retry = retryHook.mutateAsync(body).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await retry).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    release.resolve(); await vi.runAllTimersAsync();
    expect(await first).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(checkoutAttempt.currentFor(A)).toMatchObject({ key, state: 'sent' });
    await mount(useAddToCart)().mutateAsync({ vendorId: 'v1', itemId: 'i1' });
    const changed = retryHook.mutateAsync(changedBody).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await changed).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(committed).toEqual(new Set([key])); expect(sends).toBe(2);
  });

  it('an initial rate-limit response still consults receipt authority', async () => {
    vi.useFakeTimers();
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url?.startsWith('/customer/checkout/receipts/')) return response(config, 200, { status: 'in_flight' });
      return reject(config, 429);
    };
    const pending = mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(checkoutAttempt.currentFor(A)?.state).toBe('sent');
    expect(requests.some((r) => r.url?.startsWith('/customer/checkout/receipts/'))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422, 429])('retains committed/lost-response K through retry %s, cart refill and changed body', async (status) => {
    vi.useFakeTimers();
    const committed = new Set<string>(); let phase: 'lost' | 'refused' | 'ready' = 'lost'; let probe: 'in_flight' | 'placed' = 'in_flight';
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url?.startsWith('/customer/checkout/receipts/')) return response(config, 200, probe === 'placed' ? { status: 'placed', orderIds: ['original'] } : { status: 'in_flight' });
      if (config.url === '/customer/checkout') {
        if (phase === 'refused') return reject(config, status);
        committed.add(String(config.headers.get('Idempotency-Key')));
        if (phase === 'lost') throw new AxiosError('Lost acknowledgement', 'ERR_NETWORK', config);
        return response(config, 200, { orders: [{ id: 'duplicate' }] });
      }
      return response(config);
    };
    // A temporary refresh refusal leaves this session installed. No real auth or network.
    axios.defaults.adapter = async (config) => reject(config, 503);
    const render = mount(usePlaceOrder); const mutation = render();
    const run = async (payload: unknown) => {
      const pending = mutation.mutateAsync(payload).catch((e: unknown) => e);
      await vi.runAllTimersAsync(); return pending;
    };
    expect(await run(body)).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    const key = checkoutAttempt.currentFor(A)!.key;
    phase = 'refused'; await run(body);
    expect(checkoutAttempt.currentFor(A)).toMatchObject({ key, state: 'sent' });
    await mount(useAddToCart)().mutateAsync({ vendorId: 'v1', itemId: 'i1' });
    phase = 'ready'; expect(await run(changedBody)).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(committed).toEqual(new Set([key]));
    expect(requests.filter((r) => r.url === '/customer/checkout').map((r) => r.headers.get('Idempotency-Key'))).toEqual([key, key]);
    probe = 'placed'; expect(await run(changedBody)).toMatchObject({ name: 'CheckoutAlreadyPlacedError' });
    expect(committed).toEqual(new Set([key]));
  });

  it('authoritative none permits a safe replacement after an ambiguous refusal', async () => {
    vi.useFakeTimers();
    const initial = checkoutAttempt.begin({ principal: A, bodyHash: stableBodyHash(body) });
    checkoutAttempt.markSent(initial.key!, A);
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url?.startsWith('/customer/checkout/receipts/')) return response(config, 200, { status: 'none' });
      return reject(config, 429);
    };
    const pending = mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    await vi.runAllTimersAsync(); await pending;
    expect(requests.some((r) => r.url?.startsWith('/customer/checkout/receipts/'))).toBe(true);
    expect(checkoutAttempt.currentFor(A)).toMatchObject({ key: initial.key, state: 'open' });
    expect(checkoutAttempt.begin({ principal: A, bodyHash: stableBodyHash(changedBody) }).key).not.toBe(initial.key);
  });
});


describe('[SX405] shared receipt observations across mounted consumers', () => {
  it.each(['failure', 'changed-body', 'restart-recovery'] as const)('%s: old none produced before newer K send cannot reopen or replace it', async (path) => {
    vi.useFakeTimers();
    const produced = deferred(); const deliver = deferred(); let probes = 0; let sends = 0;
    const committed = new Set<string>();
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url?.startsWith('/customer/checkout/receipts/')) {
        if (++probes === 1) {
          // The server has produced a correct none BEFORE the second consumer
          // enters transport. Only delivery is held; it is never recomputed.
          const oldNone = response(config, 200, { status: 'none' });
          produced.resolve(); await deliver.promise; return oldNone;
        }
        return response(config, 200, { status: 'in_flight' });
      }
      if (config.url === '/customer/checkout') {
        ++sends;
        if (path === 'failure' && sends === 1) return reject(config, 400);
        committed.add(String(config.headers.get('Idempotency-Key')));
        throw new AxiosError('Lost acknowledgement', 'ERR_NETWORK', config);
      }
      return response(config);
    };
    if (path !== 'failure') {
      const intent = checkoutAttempt.begin({ principal: A, bodyHash: stableBodyHash(body) });
      checkoutAttempt.markSent(intent.key!, A);
    }
    if (path === 'restart-recovery') {
      env.restartAttempt(); env.session = { ...A, generation: 3 };
    }
    const principal = env.session!;
    const firstRender = path === 'restart-recovery' ? mount(useCheckoutRecovery) : mount(usePlaceOrder);
    const firstHook = firstRender();
    const first = path === 'restart-recovery' ? null
      : firstHook.mutateAsync(path === 'changed-body' ? changedBody : body).catch((e: unknown) => e);
    if (path === 'restart-recovery') env.effects.shift()!();
    await produced.promise;
    const key = checkoutAttempt.currentFor(principal)!.key;
    // A genuinely separate mounted MutationObserver starts K after production.
    const secondRender = mount(usePlaceOrder);
    const newer = secondRender().mutateAsync(body).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await newer).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(committed).toEqual(new Set([key]));
    deliver.resolve(); await vi.runAllTimersAsync();
    if (first) expect(await first).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    else expect(firstRender()).toMatchObject({ recovering: false, placedOrderIds: null });
    expect(checkoutAttempt.currentFor(principal), 'stale none must leave K SENT').toMatchObject({ key, state: 'sent' });
    await mount(useAddToCart)().mutateAsync({ vendorId: 'v1', itemId: 'i1' });
    expect(checkoutAttempt.currentFor(principal)?.key).toBe(key);
    const changed = secondRender().mutateAsync(changedBody).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await changed).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(committed).toEqual(new Set([key]));
    expect(requests.filter((r) => r.url === '/customer/checkout').map((r) => r.headers.get('Idempotency-Key')))
      .toEqual(path === 'failure' ? [key, key] : [key]);
  });

  it('none observed during an older live transport cannot authorize replacement', async () => {
    const entered = deferred(); const release = deferred(); let sends = 0;
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url?.startsWith('/customer/checkout/receipts/')) return response(config, 200, { status: 'none' });
      if (config.url === '/customer/checkout') {
        if (++sends === 1) { entered.resolve(); await release.promise; }
        return reject(config, 400);
      }
      return response(config);
    };
    const first = mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    await entered.promise;
    const key = checkoutAttempt.currentFor(A)!.key;
    const second = await mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    expect(second).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(checkoutAttempt.currentFor(A)).toMatchObject({ key, state: 'sent' });
    release.resolve(); expect(await first).toBeInstanceOf(AxiosError);
    expect(checkoutAttempt.currentFor(A)).toMatchObject({ key, state: 'open' });
  });
});

describe('[SX405] application MutationCache feedback ownership', () => {
  const applicationCache = () => {
    env.client.clear(); env.client = queryClient; queryClient.clear();
    queryClient.getMutationCache().config.onMutate = async () => { await env.barrier?.(); };
    invalidate = vi.spyOn(env.client, 'invalidateQueries');
  };
  afterEach(() => { queryClient.getMutationCache().config.onMutate = undefined; });

  it.each(changes)('%s late A failure produces no global toast after switch', async (_name, hook, payload) => {
    applicationCache(); const entered = deferred(); const release = deferred();
    api.defaults.adapter = async (config) => { requests.push(config); entered.resolve(); await release.promise; return reject(config, 400); };
    const callback = vi.fn(); const render = mount(hook);
    const pending = render().mutateAsync(payload, { onError: callback }).catch((e: unknown) => e);
    await entered.promise; switchToB(); release.resolve();
    expect(await pending).toMatchObject({ name: 'AuthSessionBoundaryError' });
    expect(queryClient.getMutationCache().getAll().at(-1)!.state.status).toBe('error');
    expect(env.toastError, 'stale A must not publish a global toast').not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
  it.each(changes)('%s queued guest failure produces no global toast after sign-in', async (_name, hook, payload) => {
    applicationCache(); env.session = null; const entered = deferred(); const release = deferred();
    env.barrier = () => { entered.resolve(); return release.promise; };
    const pending = mount(hook)().mutateAsync(payload).catch((e: unknown) => e);
    await entered.promise; switchToB(); release.resolve();
    expect(await pending).toMatchObject({ name: 'AuthSessionBoundaryError' });
    expect(requests).toEqual([]);
    expect(env.toastError, 'stale guest must not publish a global toast').not.toHaveBeenCalled();
  });
  it.each(changes)('%s current account failure still publishes global feedback', async (_name, hook, payload) => {
    applicationCache(); api.defaults.adapter = async (config) => reject(config, 400);
    const error = await mount(hook)().mutateAsync(payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AxiosError);
    expect(env.toastError).toHaveBeenCalledExactlyOnceWith('Couldn’t complete that', expect.any(String));
  });
  it('current anonymous generation still receives its failure toast', async () => {
    applicationCache(); env.session = null;
    expect(await mount(useClearCart)().mutateAsync(undefined).catch((e: unknown) => e)).toMatchObject({ name: 'AuthSessionBoundaryError' });
    expect(env.toastError).toHaveBeenCalledTimes(1); expect(requests).toEqual([]);
  });
});


describe('[SX405] positive authority and concurrent first sends', () => {
  it('a placed receipt produced before a newer send still recovers the existing order', async () => {
    vi.useFakeTimers();
    const produced = deferred(); const deliver = deferred(); let probes = 0; let sends = 0;
    const committed = new Set<string>();
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url?.startsWith('/customer/checkout/receipts/')) {
        if (++probes === 1) {
          const placed = response(config, 200, { status: 'placed', orderIds: ['original'] });
          produced.resolve(); await deliver.promise; return placed;
        }
        return response(config, 200, { status: 'in_flight' });
      }
      ++sends; committed.add(String(config.headers.get('Idempotency-Key')));
      throw new AxiosError('Lost acknowledgement', 'ERR_NETWORK', config);
    };
    const first = mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    await produced.promise; const key = checkoutAttempt.currentFor(A)!.key;
    const newer = mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    await vi.runAllTimersAsync(); expect(await newer).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    deliver.resolve(); await vi.runAllTimersAsync();
    expect(await first).toMatchObject({ name: 'CheckoutAlreadyPlacedError', orderIds: ['original'] });
    expect(checkoutAttempt.currentFor(A)).toBeNull();
    expect(committed).toEqual(new Set([key])); expect(sends).toBe(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['customer', 'orders'] });
  });
  it('a delayed old 422 conflict cannot discard a newer unresolved K send', async () => {
    vi.useFakeTimers(); const entered = deferred(); const release = deferred(); let sends = 0;
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url?.startsWith('/customer/checkout/receipts/')) return response(config, 200, { status: 'in_flight' });
      if (++sends === 1) {
        entered.resolve(); await release.promise;
        const conflict = response(config, 422); conflict.data = { error: { code: 'IDEMPOTENCY_KEY_REUSED' } };
        throw new AxiosError('Synthetic conflict', 'ERR_BAD_RESPONSE', config, undefined, conflict);
      }
      throw new AxiosError('Lost acknowledgement', 'ERR_NETWORK', config);
    };
    const first = mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    await entered.promise; const key = checkoutAttempt.currentFor(A)!.key;
    const newer = mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    await vi.runAllTimersAsync(); expect(await newer).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    release.resolve(); await vi.runAllTimersAsync();
    expect(await first, 'old conflict loses send authority').toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(checkoutAttempt.currentFor(A)).toMatchObject({ key, state: 'sent' });
    expect(sends).toBe(2);
  });
  it('two first invocations released together use one shared key', async () => {
    vi.useFakeTimers(); const entered = deferred(); const release = deferred(); let scheduled = 0;
    env.barrier = () => { if (++scheduled === 2) entered.resolve(); return release.promise; };
    const committed = new Set<string>();
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url?.startsWith('/customer/checkout/receipts/')) return response(config, 200, { status: 'in_flight' });
      committed.add(String(config.headers.get('Idempotency-Key')));
      throw new AxiosError('Lost acknowledgement', 'ERR_NETWORK', config);
    };
    const first = mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    const second = mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    await entered.promise; release.resolve(); await vi.runAllTimersAsync();
    expect(await first).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(await second).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    const key = checkoutAttempt.currentFor(A)!.key;
    expect(checkoutAttempt.currentFor(A)?.state).toBe('sent');
    expect(committed).toEqual(new Set([key]));
    expect(requests.filter((r) => r.url === '/customer/checkout').map((r) => r.headers.get('Idempotency-Key'))).toEqual([key, key]);
  });
});


describe('[SX405] observations made while transport is live', () => {
  it('none produced during an older K transport cannot reopen it after that transport commits', async () => {
    vi.useFakeTimers(); const transportEntered = deferred(); const transportRelease = deferred();
    const noneProduced = deferred(); const noneDeliver = deferred(); let sends = 0; let probes = 0;
    const committed = new Set<string>();
    api.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url?.startsWith('/customer/checkout/receipts/')) {
        if (++probes === 1) {
          const oldNone = response(config, 200, { status: 'none' });
          noneProduced.resolve(); await noneDeliver.promise; return oldNone;
        }
        return response(config, 200, { status: 'in_flight' });
      }
      if (config.url === '/customer/checkout') {
        if (++sends === 1) {
          transportEntered.resolve(); await transportRelease.promise;
          committed.add(String(config.headers.get('Idempotency-Key')));
          throw new AxiosError('Lost acknowledgement', 'ERR_NETWORK', config);
        }
        return reject(config, 400);
      }
      return response(config);
    };
    const first = mount(usePlaceOrder)().mutateAsync(body).catch((e: unknown) => e);
    await transportEntered.promise; const key = checkoutAttempt.currentFor(A)!.key;
    const secondRender = mount(usePlaceOrder);
    const second = secondRender().mutateAsync(body).catch((e: unknown) => e);
    await noneProduced.promise; transportRelease.resolve(); await vi.runAllTimersAsync();
    expect(await first).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(committed).toEqual(new Set([key]));
    noneDeliver.resolve(); await vi.runAllTimersAsync();
    expect(await second, 'live observation remains invalid after transport finishes').toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(checkoutAttempt.currentFor(A)).toMatchObject({ key, state: 'sent' });
    await mount(useAddToCart)().mutateAsync({ vendorId: 'v1', itemId: 'i1' });
    const changed = secondRender().mutateAsync(changedBody).catch((e: unknown) => e);
    await vi.runAllTimersAsync(); expect(await changed).toMatchObject({ name: 'CheckoutOutcomeUnknownError' });
    expect(sends).toBe(2); expect(committed).toEqual(new Set([key]));
  });
});
