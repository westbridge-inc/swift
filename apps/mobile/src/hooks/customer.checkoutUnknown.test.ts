import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [AX372 R1] A checkout whose outcome is UNKNOWN is never re-opened.
//
// The server answers 503 CHECKOUT_OUTCOME_UNKNOWN when it cannot yet say
// whether an order committed (a lost commit acknowledgement, AX366 F1). A
// 5xx, a timeout or no answer at all leaves the phone just as unsure. Before:
// any answer with a response re-opened the intent (markOpen), so restart
// recovery skipped it (it probes only SENT intents) and a changed body minted
// a new key without asking what became of the first order.
//
// Now: an unknown outcome keeps the intent SENT and the phone asks the
// receipt probe, with backoff, what became of it: placed → the order; none →
// only then re-opened; still in flight → it stays sent, and the customer reads
// "We're checking whether your order went through."
//
// These run the REAL hooks and the REAL request seam (`customerApi`, answered
// at the axios adapter) over the REAL intent (lib/checkoutAttempt on a memory
// store). Only React's and React Query's hook runtimes are replaced, to hand
// back the mutation and the effect they would run.
// ---------------------------------------------------------------------------

const env = vi.hoisted(() => {
  const previousApiUrl = process.env['EXPO_PUBLIC_API_URL'];
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return {
    previousApiUrl,
    session: { userId: 'customer-1', generation: 1, accessToken: 'access-1', refreshToken: 'refresh-1' },
    invalidations: [] as unknown[],
    updates: [] as unknown[],
    variables: null as any,
    callbacks: null as any,
    resetAttempt: () => {},
    afterMutation: null as null | (() => void),
    frame: null as null | { refs: Array<{ current: unknown }>; states: unknown[]; refIndex: number; stateIndex: number },
    mutationView: {} as Record<string, any>,
    mutation: null as null | Record<string, any>,
    effects: [] as Array<() => void | (() => void)>,
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useRef: <T,>(value: T) => {
      if (!env.frame) return { current: value };
      const i = env.frame.refIndex++;
      return (env.frame.refs[i] ??= { current: value }) as { current: T };
    },
    useState: <T,>(value: T) => {
      const frame = env.frame; const i = frame ? frame.stateIndex++ : -1;
      if (frame && !(i in frame.states)) frame.states[i] = value;
      return [frame ? frame.states[i] : value, (next: T) => { env.updates.push(next); if (frame) frame.states[i] = next; }];
    },
    useEffect: (effect: () => void | (() => void)) => { env.effects.push(effect); },
  };
});
vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: Symbol('keepPreviousData'),
  useInfiniteQuery: vi.fn(),
  useQuery: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: (key: unknown) => { env.invalidations.push(key); return Promise.resolve(); } }),
  useMutation: (options: Record<string, any>) => {
    env.mutation = options;
    return { ...options, ...env.mutationView, mutateAsync: async (variables: unknown, callbacks: unknown) => {
      env.variables = variables; env.callbacks = callbacks;
      try { const result = await options['mutationFn'](variables); env.afterMutation?.(); return result; }
      catch (error) { env.afterMutation?.(); throw error; }
    },
      mutate: (variables: unknown, callbacks: unknown) => { env.variables = variables; env.callbacks = callbacks; void options['mutationFn'](variables).catch(() => {}); } };
  },
}));
vi.mock('../stores/authStore', async () => {
  const { samePrincipalBoundary } = await vi.importActual<typeof import('../lib/authSession')>('../lib/authSession');
  class AuthSessionBoundaryError extends Error { constructor() { super('Account changed'); this.name = 'AuthSessionBoundaryError'; } }
  return {
    AuthSessionBoundaryError,
    getAuthSessionSnapshot: () => env.session,
    requireAuthSessionForPrincipal: (principal: typeof env.session) => {
      if (!samePrincipalBoundary(env.session, principal)) throw new AuthSessionBoundaryError();
      return env.session;
    },
    isAuthSessionSnapshotCurrent: (s: typeof env.session) => samePrincipalBoundary(s, env.session) && s.refreshToken === env.session.refreshToken,
    useAuthStore: Object.assign((select: (state: any) => unknown) => select({ user: { id: env.session.userId }, sessionGeneration: env.session.generation }), {
      getState: () => ({ rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }),
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
  let minted = 0;
  const fresh = () => {
    let stored: string | null = null;
    return createCheckoutAttempt({ get: () => stored, set: (value: string) => { stored = value; }, clear: () => { stored = null; } }, () => `chk_test_${++minted}_0000000000`);
  };
  let attempt = fresh();
  env.resetAttempt = () => { attempt = fresh(); };
  return { checkoutAttempt: new Proxy({}, { get: (_target, key) => Reflect.get(attempt, key) }) };
});

import { api } from '../services/api';
import { stableBodyHash } from '../lib/checkoutAttempt';
import { checkoutAttempt } from '../lib/checkoutAttemptStore';
import { CheckoutAlreadyPlacedError, CheckoutOutcomeUnknownError, useAddToCart, useUpdateCartItem, useRemoveCartItem, useClearCart, useSetCartAddress, useSetCartTip, useRemoveCartPromo, useReorder, useCheckoutRecovery, usePlaceOrder } from './customer';

// The mocked hook runtime is invoked directly by these deterministic schedulers.
const renderPlaceOrder = usePlaceOrder;
const renderCheckoutRecovery = useCheckoutRecovery;

type Reply = { status: number; data?: unknown } | 'offline' | 'timeout';

const PRINCIPAL = { userId: env.session.userId, generation: env.session.generation };
const DELIVERY = { paymentMethod: 'CASH', tipAmount: 0 };
const PICKUP = { paymentMethod: 'CASH', tipAmount: 0, fulfillmentSelections: { v1: 'PICKUP' } };
const UNKNOWN_503: Reply = { status: 503, data: { success: false, error: { code: 'CHECKOUT_OUTCOME_UNKNOWN', message: 'We could not confirm this order yet. Check your orders before you try again.' } } };
const IN_FLIGHT: Reply = { status: 200, data: { success: true, data: { status: 'in_flight' } } };
const NONE: Reply = { status: 200, data: { success: true, data: { status: 'none' } } };
const placed = (orderIds: string[]): Reply => ({ status: 200, data: { success: true, data: { status: 'placed', orderIds } } });
const ORDER: Reply = { status: 200, data: { success: true, data: { orders: [{ id: 'order-1' }] } } };
const failure = (status: number, code: string): Reply => ({ status, data: { success: false, error: { code, message: code } } });

let seen: InternalAxiosRequestConfig[] = [];
let placeReplies: Reply[] = [];
/** Answered in order; the last answer repeats (a key that stays in flight). */
let probeReplies: Reply[] = [];
let beforeReply: ((config: InternalAxiosRequestConfig) => Promise<void>) | null = null;

const originalAdapter = api.defaults.adapter;
beforeEach(() => {
  vi.useFakeTimers();
  env.session = { userId: 'customer-1', generation: 1, accessToken: 'access-1', refreshToken: 'refresh-1' };
  env.invalidations = []; env.updates = []; beforeReply = null; env.afterMutation = null; env.frame = null; env.mutationView = {};
  seen = [];
  placeReplies = [];
  probeReplies = [];
  env.mutation = null;
  env.effects = [];
  env.resetAttempt();
  const adapter: AxiosAdapter = async (config) => {
    seen.push(config);
    const probe = config.method === 'get' && (config.url ?? '').startsWith('/customer/checkout/receipts/');
    const place = config.method === 'post' && config.url === '/customer/checkout';
    const cart = (config.url ?? '').startsWith('/customer/cart') || (config.url ?? '').endsWith('/reorder');
    const reply = probe ? (probeReplies.length > 1 ? probeReplies.shift() : probeReplies[0]) : place ? placeReplies.shift() : cart ? { status: 200, data: { success: true, data: {} } } : undefined;
    if (beforeReply) await beforeReply(config);
    if (!reply) throw new Error(`unexpected request: ${config.method} ${config.url}`);
    if (reply === 'offline') throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config);
    if (reply === 'timeout') throw new AxiosError('timeout of 10000ms exceeded', AxiosError.ECONNABORTED, config);
    const response = { config, status: reply.status, statusText: String(reply.status), headers: {}, data: reply.data } as AxiosResponse;
    if (reply.status >= 400) {
      throw new AxiosError(`Request failed with status code ${reply.status}`, reply.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST, config, null, response);
    }
    return response;
  };
  api.defaults.adapter = adapter;
});
afterEach(() => {
  api.defaults.adapter = originalAdapter;
  vi.useRealTimers();
});
afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

const keyOf = (config: InternalAxiosRequestConfig) => String(config.headers?.get?.('Idempotency-Key') ?? '');
/** Every request the phone made, in order: `GET <key>` for a receipt probe, `POST <key>` for a checkout. */
const requests = () => seen.map((config) => (config.method === 'post'
  ? `POST ${keyOf(config)}`
  : `GET ${decodeURIComponent((config.url ?? '').slice('/customer/checkout/receipts/'.length))}`));
const posts = () => requests().filter((r) => r.startsWith('POST '));

/** "Place order", through the real hook, to the end (every backoff wait run
 *  out), then its settle callbacks as React Query would run them. */
async function placeOrder(payload: unknown): Promise<{ ok: true; data: unknown } | { ok: false; err: any }> {
  const hook = renderPlaceOrder();
  const mutation = env.mutation!;
  const run = hook.mutateAsync(payload).then((data) => ({ ok: true as const, data }), (err: unknown) => ({ ok: false as const, err }));
  const operation = env.variables;
  await vi.runAllTimersAsync();
  const out = await run;
  if (out.ok) mutation['onSuccess']?.(out.data, operation);
  else mutation['onError']?.(out.err, operation);
  mutation['onSettled']?.(out.ok ? out.data : undefined, out.ok ? null : out.err, operation);
  return out;
}

/** The cart screen mounts after a restart: the recovery effect runs to the end. */
async function recoverOnRestart() {
  env.effects = [];
  (useCheckoutRecovery as () => unknown)();
  expect(env.effects).toHaveLength(1);
  env.effects[0]!();
  await vi.runAllTimersAsync();
}

/** A first checkout of DELIVERY whose outcome stays unknown: returns its key. */
async function unresolvedFirstOrder(): Promise<string> {
  placeReplies = [UNKNOWN_503];
  probeReplies = [IN_FLIGHT];
  const out = await placeOrder(DELIVERY);
  expect(out.ok).toBe(false);
  const [first] = posts();
  expect(first).toBeDefined();
  return first!.slice('POST '.length);
}

describe('[AX372 R1] an unknown outcome keeps the intent SENT', () => {
  it('503 CHECKOUT_OUTCOME_UNKNOWN: never re-opened; the phone keeps asking about K, and a restart’s recovery probes K', async () => {
    placeReplies = [UNKNOWN_503];
    probeReplies = [IN_FLIGHT];
    const out = await placeOrder(DELIVERY);
    const [post] = posts();
    const K = post!.slice('POST '.length);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toMatchObject({ key: K, state: 'sent' });
    expect(out.ok).toBe(false);
    expect((out as { err: unknown }).err).toBeInstanceOf(CheckoutOutcomeUnknownError);
    expect((out as { err: Error }).err.message).toBe("We're checking whether your order went through.");
    // It asked what became of K, again and again (backing off), and placed nothing else.
    expect(requests().filter((r) => r === `GET ${K}`).length).toBeGreaterThan(2);
    expect(posts()).toEqual([`POST ${K}`]);

    // The app is killed and comes back: the cart screen's recovery asks about
    // K, and keeps asking while it is still in flight.
    seen = [];
    probeReplies = [IN_FLIGHT, NONE];
    await recoverOnRestart();
    expect(requests()).toEqual([`GET ${K}`, `GET ${K}`]);
    // ...and only "none" re-opens it: the same key may now be retried.
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toMatchObject({ key: K, state: 'open' });
  });

  it.each([
    ['a 500', failure(500, 'INTERNAL_ERROR')],
    ['a 502 from the edge', failure(502, 'BAD_GATEWAY')],
    ['a 504 from the edge', failure(504, 'GATEWAY_TIMEOUT')],
    ['no answer (offline)', 'offline' as Reply],
    ['a timeout', 'timeout' as Reply],
  ])('%s is just as unknown: the intent stays sent while K is still in flight', async (_label, reply) => {
    placeReplies = [reply];
    probeReplies = [IN_FLIGHT];
    const out = await placeOrder(DELIVERY);
    const K = posts()[0]!.slice('POST '.length);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toMatchObject({ key: K, state: 'sent' });
    expect(out.ok).toBe(false);
    expect((out as { err: unknown }).err).toBeInstanceOf(CheckoutOutcomeUnknownError);
    expect(requests()).toContain(`GET ${K}`);
  });

  it.each([
    ['a validation refusal (400)', failure(400, 'VALIDATION_ERROR')],
    ['no riders (409)', failure(409, 'DELIVERY_NO_RIDERS')],
    ['under the store minimum (422)', failure(422, 'MIN_ORDER_NOT_MET')],
  ])('%s re-opens only after the receipt authority proves nothing was placed', async (_label, reply) => {
    placeReplies = [reply];
    probeReplies = [NONE];
    const out = await placeOrder(DELIVERY);
    const K = posts()[0]!.slice('POST '.length);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toMatchObject({ key: K, state: 'open' });
    expect(out.ok).toBe(false);
    expect((out as { err: unknown }).err).toBeInstanceOf(AxiosError);
    expect(requests()).toEqual([`POST ${K}`, `GET ${K}`]);
  });

  it('when asking settles it: placed goes to the order (the intent ends); none re-opens the same key and shows the server’s own answer', async () => {
    placeReplies = [UNKNOWN_503];
    probeReplies = [IN_FLIGHT, placed(['order-9'])];
    const found = await placeOrder(DELIVERY);
    expect(found.ok).toBe(false);
    expect((found as { err: unknown }).err).toBeInstanceOf(CheckoutAlreadyPlacedError);
    expect((found as { err: CheckoutAlreadyPlacedError }).err.orderIds).toEqual(['order-9']);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toBeNull();

    seen = [];
    placeReplies = ['timeout'];
    probeReplies = [IN_FLIGHT, NONE];
    const nothing = await placeOrder(DELIVERY);
    const K = posts()[0]!.slice('POST '.length);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toMatchObject({ key: K, state: 'open' });
    expect(nothing.ok).toBe(false);
    expect((nothing as { err: unknown }).err).toBeInstanceOf(AxiosError);
    expect(requests()).toEqual([`POST ${K}`, `GET ${K}`, `GET ${K}`]);
  });
});

describe('[AX372 R1] a changed body over an unresolved K asks first, and mints no key until the server says none', () => {
  it('K unknown (503), then a changed body: the probe is asked (in flight, in flight, none) BEFORE a new key is minted and sent', async () => {
    const K = await unresolvedFirstOrder();
    seen = [];
    placeReplies = [ORDER];
    probeReplies = [IN_FLIGHT, IN_FLIGHT, NONE];
    const out = await placeOrder(PICKUP);
    expect(out.ok).toBe(true);
    const sent = posts();
    expect(sent).toHaveLength(1);
    const K2 = sent[0]!.slice('POST '.length);
    expect(K2).not.toBe(K);
    expect(requests()).toEqual([`GET ${K}`, `GET ${K}`, `GET ${K}`, `POST ${K2}`]);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toBeNull(); // placed: the intent ended
  });

  it('K still in flight when the asking runs out: nothing is placed, no key is minted, K stays sent, and the customer is told it is being checked', async () => {
    const K = await unresolvedFirstOrder();
    seen = [];
    probeReplies = [IN_FLIGHT];
    const out = await placeOrder(PICKUP);
    expect(posts()).toEqual([]);
    expect(requests().every((r) => r === `GET ${K}`)).toBe(true);
    expect(requests().length).toBeGreaterThan(2);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toMatchObject({ key: K, state: 'sent' });
    expect(out.ok).toBe(false);
    expect((out as { err: unknown }).err).toBeInstanceOf(CheckoutOutcomeUnknownError);
  });

  it('K found placed: the changed body goes to that order; nothing new is placed', async () => {
    const K = await unresolvedFirstOrder();
    seen = [];
    probeReplies = [placed(['order-7'])];
    const out = await placeOrder(PICKUP);
    expect(requests()).toEqual([`GET ${K}`]);
    expect(out.ok).toBe(false);
    expect((out as { err: unknown }).err).toBeInstanceOf(CheckoutAlreadyPlacedError);
    expect((out as { err: CheckoutAlreadyPlacedError }).err.orderIds).toEqual(['order-7']);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toBeNull();
  });
});


// The request adapter and intent store stay real; only the hook scheduler is
// controlled so account switches can land at exact await/callback boundaries.
describe('[SX391] checkout belongs to its captured account through completion', () => {
  const B = { userId: 'customer-b', generation: 3, accessToken: 'access-b', refreshToken: 'refresh-b' };
  const start = (payload: unknown, options?: any) => {
    const hook = renderPlaceOrder();
    const mutation = env.mutation!;
    const result = hook.mutateAsync(payload, options).then((data: unknown) => ({ ok: true as const, data }), (err: unknown) => ({ ok: false as const, err }));
    return { mutation, result, operation: env.variables, callbacks: env.callbacks };
  };
  const switchToB = () => {
    env.session = B;
    const b = checkoutAttempt.begin({ principal: B, bodyHash: 'b-cart' });
    if (b.kind === 'ambiguous') throw new Error('unexpected pending B');
    return b.key;
  };
  for (const schedule of ['backoff', 'probe-response'] as const) {
    it(`stops A at ${schedule}; no B checkout or clearing of B intent`, async () => {
      const K = await unresolvedFirstOrder();
      seen = []; probeReplies = schedule === 'backoff' ? [IN_FLIGHT, NONE] : [NONE]; placeReplies = [ORDER];
      let bKey = '';
      if (schedule === 'probe-response') beforeReply = async () => { if (!bKey) bKey = switchToB(); };
      const pending = start(PICKUP);
      if (schedule === 'backoff') {
        await vi.advanceTimersByTimeAsync(0);
        expect(requests()).toEqual([`GET ${K}`]);
        bKey = switchToB();
      }
      await vi.runAllTimersAsync();
      const answer = await pending.result;
      expect(answer.ok).toBe(false);
      expect(posts()).toEqual([]);
      expect(checkoutAttempt.currentFor(B)?.key).toBe(bKey);
      expect(seen.every((c) => c.headers.get('Authorization') === 'Bearer access-1')).toBe(true);
    });
  }
  it('the first async key boundary cannot submit A payload after B takes over', async () => {
    placeReplies = [ORDER];
    const pending = start(DELIVERY);
    const bKey = switchToB();
    await vi.runAllTimersAsync();
    expect((await pending.result).ok).toBe(false);
    expect(posts()).toEqual([]);
    expect(checkoutAttempt.currentFor(B)?.key).toBe(bKey);
  });
  for (const reply of [ORDER, failure(422, 'IDEMPOTENCY_KEY_REUSED'), failure(400, 'VALIDATION_ERROR')]) {
    it(`drops account-specific result after a checkout await (${reply === ORDER ? 'success' : String((reply as { status: number }).status)})`, async () => {
      placeReplies = [reply];
      let bKey = '';
      beforeReply = async () => { bKey = switchToB(); };
      const pending = start(DELIVERY);
      await vi.runAllTimersAsync();
      const answer = await pending.result;
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect((answer.err as Error).name).toBe('AuthSessionBoundaryError');
      expect(checkoutAttempt.currentFor(B)?.key).toBe(bKey);
      expect(env.invalidations).toEqual([]);
    });
  }
  it('a late A success callback cannot complete or invalidate B intent', async () => {
    placeReplies = [ORDER];
    const ui = vi.fn();
    const pending = start(DELIVERY, { onSuccess: ui });
    await vi.runAllTimersAsync();
    const answer = await pending.result;
    expect(answer.ok).toBe(true);
    const bKey = switchToB();
    pending.mutation['onSuccess']?.(answer.ok ? answer.data : undefined, pending.operation);
    pending.callbacks.onSuccess(answer.ok ? answer.data : undefined, pending.operation);
    expect(ui).not.toHaveBeenCalled();
    expect(checkoutAttempt.currentFor(B)?.key).toBe(bKey);
    expect(env.invalidations).toEqual([]);
  });
  it('restart recovery cannot display A order or complete B after a probe await', async () => {
    await unresolvedFirstOrder();
    probeReplies = [placed(['order-a'])];
    let bKey = '';
    beforeReply = async () => { bKey = switchToB(); };
    env.invalidations = []; env.updates = [];
    await recoverOnRestart();
    expect(checkoutAttempt.currentFor(B)?.key).toBe(bKey);
    expect(env.updates).not.toContainEqual(['order-a']);
    expect(env.invalidations).toEqual([]);
  });
  it('cart refill preserves unresolved K and its placed receipt prevents K2', async () => {
    const K = await unresolvedFirstOrder();
    const hook = useAddToCart();
    const cart = env.mutation!;
    const item = { vendorId: 'v1', itemId: 'i1' };
    const added = await hook.mutateAsync(item);
    cart['onSuccess']?.(added, env.variables);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toMatchObject({ key: K, state: 'sent' });
    seen = []; probeReplies = [placed(['order-a'])]; placeReplies = [ORDER];
    const answer = await placeOrder(PICKUP);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.err).toBeInstanceOf(CheckoutAlreadyPlacedError);
    expect(posts()).toEqual([]);
  });
  it('a late A error callback cannot invalidate B or run the old screen callback', async () => {
    placeReplies = [failure(422, 'IDEMPOTENCY_KEY_REUSED')];
    const ui = vi.fn();
    const pending = start(DELIVERY, { onError: ui });
    await vi.runAllTimersAsync();
    const answer = await pending.result;
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('expected refusal');
    const bKey = switchToB();
    pending.mutation['onError']?.(answer.err, pending.operation);
    pending.callbacks.onError(answer.err, pending.operation);
    expect(ui).not.toHaveBeenCalled();
    expect(checkoutAttempt.currentFor(B)?.key).toBe(bKey);
    expect(env.invalidations).toEqual([]);
  });
  it('returning A adopts its sent key, and an old A generation cannot complete it', async () => {
    const K = await unresolvedFirstOrder();
    seen = []; probeReplies = [placed(['order-a'])];
    const returned = { ...env.session, generation: 7, accessToken: 'access-returned', refreshToken: 'refresh-returned' };
    beforeReply = async () => {
      switchToB();
      env.session = returned;
      expect(checkoutAttempt.begin({ principal: returned, bodyHash: stableBodyHash(DELIVERY) })).toMatchObject({ kind: 'reused', key: K });
    };
    const pending = start(PICKUP);
    await vi.runAllTimersAsync();
    const answer = await pending.result;
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect((answer.err as Error).name).toBe('AuthSessionBoundaryError');
    expect(checkoutAttempt.currentFor(returned)).toMatchObject({ key: K, state: 'sent' });
    expect(posts()).toEqual([]);
  });
  it('a late A settled callback cannot unlock a newer B checkout on the same hook', async () => {
    const hook = renderPlaceOrder(); const mutation = env.mutation!;
    placeReplies = [ORDER, ORDER, ORDER];
    const a = hook.mutateAsync(DELIVERY); const aOperation = env.variables;
    await vi.runAllTimersAsync(); await a;
    switchToB();
    // B's cart intent differs, but is unsent and may be superseded.
    const releases: Array<() => void> = [];
    beforeReply = () => new Promise<void>((resolve) => { releases.push(resolve); });
    const b = hook.mutateAsync(PICKUP); const bOperation = env.variables;
    await vi.advanceTimersByTimeAsync(0);
    mutation['onSettled']?.(undefined, null, aOperation);
    const duplicate = hook.mutateAsync(PICKUP).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    for (const release of releases) release();
    await b;
    expect(await duplicate).toMatchObject({ name: 'CheckoutInFlightError' });
    expect(posts()).toHaveLength(2);
    mutation['onSettled']?.(undefined, null, bOperation);
  });
  const cartChanges: Array<[string, () => unknown, unknown]> = [
    ['add', useAddToCart, { vendorId: 'v1', itemId: 'i1' }], ['update', useUpdateCartItem, { id: 'i1', quantity: 2 }],
    ['remove', useRemoveCartItem, 'i1'], ['clear', useClearCart, undefined], ['address', useSetCartAddress, 'a1'],
    ['tip', useSetCartTip, 100], ['promo', useRemoveCartPromo, undefined], ['reorder', useReorder, 'o1'],
  ];
  it.each(cartChanges)('%s preserves sent K; a late cart success cannot clear B', async (_name, render, payload) => {
    const K = await unresolvedFirstOrder();
    const hook = render() as { mutateAsync: (payload: unknown) => Promise<unknown> };
    const mutation = env.mutation!;
    const changed = await hook.mutateAsync(payload);
    const operation = env.variables;
    mutation['onSuccess'](changed, operation);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toMatchObject({ key: K, state: 'sent' });
    const bKey = switchToB();
    const before = env.invalidations.length;
    mutation['onSuccess'](changed, operation);
    expect(checkoutAttempt.currentFor(B)?.key).toBe(bKey);
    expect(env.invalidations).toHaveLength(before);
  });
  it('an open unsent intent is safely superseded after a successful cart change', async () => {
    const initial = checkoutAttempt.begin({ principal: PRINCIPAL, bodyHash: stableBodyHash(DELIVERY) });
    const hook = useAddToCart(); const mutation = env.mutation!;
    const item = { vendorId: 'v1', itemId: 'i1' };
    const changed = await hook.mutateAsync(item);
    mutation['onSuccess'](changed, env.variables);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toBeNull();
    expect(checkoutAttempt.begin({ principal: PRINCIPAL, bodyHash: stableBodyHash(DELIVERY) }).key).not.toBe(initial.key);
  });

  for (const reply of [ORDER, failure(422, 'IDEMPOTENCY_KEY_REUSED')]) {
    it(`checks account again after the mutation scheduler yields (${reply === ORDER ? 'success' : 'error'})`, async () => {
      placeReplies = [reply];
      let bKey = '';
      env.afterMutation = () => { bKey = switchToB(); };
      const pending = start(DELIVERY);
      await vi.runAllTimersAsync();
      const answer = await pending.result;
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect((answer.err as Error).name).toBe('AuthSessionBoundaryError');
      expect(checkoutAttempt.currentFor(B)?.key).toBe(bKey);
    });
  }

  it('an account switch hides already-settled mutation data and internal operation variables', async () => {
    env.frame = { refs: [], states: [], refIndex: 0, stateIndex: 0 };
    const render = () => { env.frame!.refIndex = 0; env.frame!.stateIndex = 0; return renderPlaceOrder(); };
    const hook = render(); placeReplies = [ORDER];
    const pending = hook.mutateAsync(DELIVERY); await vi.runAllTimersAsync(); const data = await pending;
    env.mutationView = { data, variables: env.variables, isSuccess: true, isError: false, isPending: false, isIdle: false, status: 'success' };
    const own = render();
    expect(own.isSuccess).toBe(true); expect(own.data).toEqual(data); expect(own.variables).toEqual(DELIVERY);
    switchToB();
    const other = render();
    expect(other.isSuccess).toBe(false); expect(other.data).toBeUndefined(); expect(other.variables).toBeUndefined();
    expect(other.status).toBe('idle');
  });
  it('an account switch hides an already-displayed recovered receipt before the next effect runs', async () => {
    await unresolvedFirstOrder(); probeReplies = [placed(['order-a'])];
    env.effects = []; env.frame = { refs: [], states: [], refIndex: 0, stateIndex: 0 };
    const render = () => { env.frame!.refIndex = 0; env.frame!.stateIndex = 0; return renderCheckoutRecovery(); };
    render(); env.effects[0]!(); await vi.runAllTimersAsync();
    expect(render().placedOrderIds).toEqual(['order-a']);
    switchToB();
    expect(render()).toEqual({ recovering: false, placedOrderIds: null });
  });

});
