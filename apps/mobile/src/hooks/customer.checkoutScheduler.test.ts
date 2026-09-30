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
    previousApiUrl, session: null as AuthSessionSnapshot | null,
    client: null as any, frame: null as any, resetAttempt: () => {},
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
  useEffect: () => {},
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
    useAuthStore: Object.assign((select: any) => select({ user: { id: env.session?.userId }, sessionGeneration: env.session?.generation }), {
      getState: () => ({
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
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/marketDepthMemory', () => ({ rememberedMarketDepth: () => null, rememberMarketDepth: () => {} }));
vi.mock('../lib/checkoutAttemptStore', async () => {
  const { createCheckoutAttempt } = await vi.importActual<typeof import('../lib/checkoutAttempt')>('../lib/checkoutAttempt');
  let next = 0;
  const fresh = () => {
    let serialized: string | null = null;
    return createCheckoutAttempt({ get: () => serialized, set: (v: string) => { serialized = v; }, clear: () => { serialized = null; } }, () => `chk_scheduler_${++next}`);
  };
  let attempt = fresh(); env.resetAttempt = () => { attempt = fresh(); };
  return { checkoutAttempt: new Proxy({}, { get: (_t, key) => Reflect.get(attempt, key) }) };
});

import { api } from '../services/api';
import { checkoutAttempt } from '../lib/checkoutAttemptStore';
import { stableBodyHash } from '../lib/checkoutAttempt';
import { useAddToCart, useUpdateCartItem, useRemoveCartItem, useClearCart, useSetCartAddress, useSetCartTip, useRemoveCartPromo, useReorder, usePlaceOrder } from './customer';

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
  env.session = { ...A }; env.resetAttempt(); env.barrier = null; requests = [];
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
