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
    session: { userId: 'customer-1', generation: 1, accessToken: 'access-1' },
    mutation: null as null | Record<string, any>,
    effects: [] as Array<() => void | (() => void)>,
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useRef: <T,>(value: T) => ({ current: value }),
    useState: <T,>(value: T) => [value, () => {}],
    useEffect: (effect: () => void | (() => void)) => { env.effects.push(effect); },
  };
});
vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: Symbol('keepPreviousData'),
  useInfiniteQuery: vi.fn(),
  useQuery: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
  useMutation: (options: Record<string, any>) => { env.mutation = options; return options; },
}));
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => env.session,
  isAuthSessionSnapshotCurrent: () => true,
  useAuthStore: { getState: () => ({ rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }) },
}));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/marketDepthMemory', () => ({ rememberedMarketDepth: () => null, rememberMarketDepth: () => {} }));
vi.mock('../lib/checkoutAttemptStore', async () => {
  const { createCheckoutAttempt } = await vi.importActual<typeof import('../lib/checkoutAttempt')>('../lib/checkoutAttempt');
  let stored: string | null = null;
  let minted = 0;
  return {
    checkoutAttempt: createCheckoutAttempt(
      { get: () => stored, set: (value: string) => { stored = value; }, clear: () => { stored = null; } },
      () => `chk_test_${++minted}_0000000000`,
    ),
  };
});

import { api } from '../services/api';
import { checkoutAttempt } from '../lib/checkoutAttemptStore';
import { CheckoutAlreadyPlacedError, CheckoutOutcomeUnknownError, useCheckoutRecovery, usePlaceOrder } from './customer';

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

const originalAdapter = api.defaults.adapter;
beforeEach(() => {
  vi.useFakeTimers();
  seen = [];
  placeReplies = [];
  probeReplies = [];
  env.mutation = null;
  env.effects = [];
  checkoutAttempt.end();
  const adapter: AxiosAdapter = async (config) => {
    seen.push(config);
    const probe = config.method === 'get' && (config.url ?? '').startsWith('/customer/checkout/receipts/');
    const place = config.method === 'post' && config.url === '/customer/checkout';
    const reply = probe ? (probeReplies.length > 1 ? probeReplies.shift() : probeReplies[0]) : place ? placeReplies.shift() : undefined;
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
  // Rendered outside React: the runtimes above hand back what it registers.
  (usePlaceOrder as () => unknown)();
  const mutation = env.mutation!;
  const run = (mutation['mutationFn'] as (p: unknown) => Promise<unknown>)(payload)
    .then((data) => ({ ok: true as const, data }), (err: unknown) => ({ ok: false as const, err }));
  await vi.runAllTimersAsync();
  const out = await run;
  if (out.ok) mutation['onSuccess']?.(out.data, payload);
  else mutation['onError']?.(out.err, payload);
  mutation['onSettled']?.();
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
  ])('%s is definitive: nothing was placed, the intent re-opens at once, nothing is asked', async (_label, reply) => {
    placeReplies = [reply];
    const out = await placeOrder(DELIVERY);
    const K = posts()[0]!.slice('POST '.length);
    expect(checkoutAttempt.currentFor(PRINCIPAL)).toMatchObject({ key: K, state: 'open' });
    expect(out.ok).toBe(false);
    expect((out as { err: unknown }).err).toBeInstanceOf(AxiosError);
    expect(requests()).toEqual([`POST ${K}`]);
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
