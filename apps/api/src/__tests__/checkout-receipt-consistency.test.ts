import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { OrderService } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { registerErrorHandler } from '../middleware/error-handler';
import { checkoutUnknownSettleSeconds, newCheckoutClaim, settleCheckoutClaim } from '../modules/order/checkout-outbox';

// ---------------------------------------------------------------------------
// [CHECKOUT-IDEM · AX354 S1] The receipt probe never answers "none" for an
// order that was placed.
//
// Before: the probe read the receipt, THEN the claim, and the checkout route
// released the claim on ANY thrown error — including one raised AFTER the
// order had committed (the vendor-owner lookup that follows the transaction).
// Interleaved: the probe misses the receipt (not committed yet) → the checkout
// commits → a post-commit step throws → the route deletes the claim → the
// probe misses the claim → "none" for a placed order, which the recovery
// screens read as licence to place it again (a duplicate order).
//
// Now: (a) nothing after the commit throws out of checkout — the committed
// answer, the receipt, is returned; (b) the route releases the claim only for
// a failure BEFORE the commit point the service reports; (c) the probe reads
// the claim FIRST, then the receipt.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const vendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_764_000_000 + Math.floor(Math.random() * 900_000);
let ownerId: string;
let vendorId: string;
let itemId: string;
let minVendorId: string;
let minItemId: string;

interface Customer { userId: string; token: string; addressId: string }

async function makeCustomer(): Promise<Customer> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Receipt', lastName: `C${seq}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'ckidem', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const addr = await app.prisma.address.create({ data: { userId: user.id, label: 'Home', addressLine1: '1 Receipt', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true } });
  return { userId: user.id, token, addressId: addr.id };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string, headers: Record<string, string> = {}) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers } });
}

async function fillCart(c: Customer, vendor: string, item: string) {
  const add = await inject('POST', '/api/v1/customer/cart/items', { vendorId: vendor, itemId: item, quantity: 1 }, c.token);
  expect(add.statusCode, add.body).toBeLessThan(300);
  const address = await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
  expect(address.statusCode, address.body).toBeLessThan(300);
}

const checkout = (c: Customer, key: string) =>
  inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, c.token, { 'idempotency-key': key });
const probe = (c: Customer, key: string) =>
  inject('GET', `/api/v1/customer/checkout/receipts/${encodeURIComponent(key)}`, undefined, c.token);
const claimKey = (c: Customer, key: string) => `checkout:idem:${c.userId}:${key}`;
const receiptOf = (c: Customer, key: string) =>
  app.prisma.checkoutReceipt.findUnique({ where: { userId_idempotencyKey: { userId: c.userId, idempotencyKey: key } } });
const ordersOf = (userId: string) => app.prisma.order.count({ where: { customerId: userId } });

/** The claim's TTL lapses: Redis expires the key. */
async function lapse(k: string) {
  await app.redis.pexpire(k, 1);
  await new Promise((r) => setTimeout(r, 25));
  expect(await app.redis.exists(k)).toBe(0);
}

/** [AX372 F1b] The read that settles an unknown commit (the durable receipt,
 *  by its row id) fails once: the outcome stays UNKNOWN even though the order
 *  did commit. */
function failReceiptReconciliationOnce() {
  let fired = 0;
  const receipts = app.prisma.checkoutReceipt;
  const real = receipts.count.bind(receipts);
  const spy = vi.spyOn(receipts, 'count').mockImplementation(((args: unknown) => {
    if (fired === 0) {
      fired += 1;
      return Promise.reject(new Error('Connection terminated unexpectedly (the receipt read settling an unknown commit)'));
    }
    return real(args as never);
  }) as never);
  return { fired: () => fired, restore: () => spy.mockRestore() };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** The step the finding names: the vendor-owner lookup that runs AFTER the
 *  order transaction commits. It fails once, for this test's store owner. */
function failVendorOwnerLookupOnce() {
  let fired = 0;
  const delegate = app.prisma.vendorOwner;
  const real = delegate.findUnique.bind(delegate);
  const spy = vi.spyOn(delegate, 'findUnique').mockImplementation(((args: { where?: { id?: string } }) => {
    if (fired === 0 && args?.where?.id === ownerId) {
      fired += 1;
      return Promise.reject(new Error('Connection terminated unexpectedly (vendor-owner lookup, after the commit)'));
    }
    return real(args as never);
  }) as never);
  return { fired: () => fired, restore: () => spy.mockRestore() };
}

/**
 * [AX366 F1] A lost COMMIT acknowledgement. The next checkout's transaction
 * body runs to its end and hands its work to COMMIT, then the caller sees a
 * connection error either way. `landed` decides what the database really did:
 * true → it committed (the acknowledgement was lost on the way back); false →
 * it did not (the commit failed, and the error cannot say so).
 */
function loseCommitAcknowledgement(landed: boolean) {
  let fired = 0;
  const realCheckout = OrderService.prototype.checkout;
  const spy = vi.spyOn(OrderService.prototype, 'checkout').mockImplementationOnce(async function (this: OrderService, input) {
    const prisma = app.prisma;
    const realTx = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    const txSpy = vi.spyOn(prisma, '$transaction').mockImplementation((async (operation: unknown, options?: unknown) => {
      if (typeof operation !== 'function') return realTx(operation, options);
      let isCheckout = false;
      const undo = new Error('the commit did not land');
      try {
        const result = await realTx(async (tx: unknown) => {
          const staged = await (operation as (tx: unknown) => Promise<unknown>)(tx);
          isCheckout = !!staged && typeof staged === 'object' && 'orders' in staged && 'answer' in staged;
          if (isCheckout && !landed) throw undo;
          return staged;
        }, options);
        if (!isCheckout) return result;
      } catch (err) {
        if (err !== undo) throw err;
      }
      fired += 1;
      throw new Error('Server has closed the connection (the COMMIT acknowledgement never arrived)');
    }) as never);
    try {
      return await realCheckout.call(this, input);
    } finally {
      txSpy.mockRestore();
    }
  });
  return { fired: () => fired, restore: () => spy.mockRestore() };
}

/**
 * The race, driven deterministically. A checkout is held in flight — its key
 * claimed, its transaction not yet begun — and the probe starts. The FIRST of
 * the probe's two reads (whichever store it reads first) returns what it saw,
 * then the checkout is released and runs to its end (commit and all that
 * follows), then `between` runs, and only then may the probe read again.
 */
async function probeAcrossCheckout(c: Customer, key: string, between: () => Promise<void> = async () => {}) {
  const inFlight = deferred();
  const gate = deferred();
  const realCheckout = OrderService.prototype.checkout;
  const checkoutSpy = vi.spyOn(OrderService.prototype, 'checkout').mockImplementation(async function (this: OrderService, input) {
    return realCheckout.call(this, { ...input, beforeTransaction: async () => { inFlight.resolve(); await gate.promise; } });
  });
  const posting = checkout(c, key);
  await inFlight.promise;
  expect(await app.redis.get(claimKey(c, key))).toMatch(/^IN_FLIGHT/);
  expect(await receiptOf(c, key)).toBeNull();

  let interleaved = false;
  let post: LightMyRequestResponse | undefined;
  const afterProbeRead = async () => {
    if (interleaved) return;
    interleaved = true;
    gate.resolve();
    post = await posting;
    await between();
  };
  const redis = app.redis;
  const realGet = redis.get.bind(redis);
  const getSpy = vi.spyOn(redis, 'get').mockImplementation((async (k: string) => {
    const seen = await realGet(k);
    if (k === claimKey(c, key)) await afterProbeRead();
    return seen;
  }) as never);
  const receipts = app.prisma.checkoutReceipt;
  const realFind = receipts.findUnique.bind(receipts);
  const findSpy = vi.spyOn(receipts, 'findUnique').mockImplementation((async (args: { where?: { userId_idempotencyKey?: { idempotencyKey?: string } } }) => {
    const seen = await realFind(args as never);
    if (args?.where?.userId_idempotencyKey?.idempotencyKey === key) await afterProbeRead();
    return seen;
  }) as never);
  try {
    const answer = await probe(c, key);
    expect(interleaved).toBe(true); // the checkout really ran between the probe's two reads
    return { answer, post: post! };
  } finally {
    findSpy.mockRestore();
    getSpy.mockRestore();
    checkoutSpy.mockRestore();
    gate.resolve();
    await posting;
  }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const ownerUser = await app.prisma.user.create({ data: { phone: `+${phoneBase + 990}`, firstName: 'Receipt', lastName: 'Vend', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  ownerId = owner.id;
  const store = (name: string, phone: number, minOrderAmount: number) => app.prisma.vendor.create({ data: { ownerId, name, slug: `ckidem-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${phone}`, addressLine1: '1 R St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount } });
  const plate = async (vendor: string) => {
    const cat = await app.prisma.category.create({ data: { vendorId: vendor, name: 'Menu', sortOrder: 0 } });
    return (await app.prisma.item.create({ data: { vendorId: vendor, categoryId: cat.id, name: 'Receipt Plate', basePrice: 2000, isAvailable: true } })).id;
  };
  vendorId = (await store('Receipt Diner', phoneBase + 991, 0)).id;
  itemId = await plate(vendorId);
  // One plate (2,000) is under this store's minimum; two plates meet it.
  minVendorId = (await store('Minimum Diner', phoneBase + 992, 3000)).id;
  minItemId = await plate(minVendorId);
  vendorIds.push(vendorId, minVendorId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  vi.restoreAllMocks();
  const orders = await app.prisma.order.findMany({ where: { customerId: { in: createdUserIds } }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: oids } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('(a) a failure AFTER the commit is never answered as a failure', () => {
  it('the vendor-owner lookup fails after the order commits: the answer is the placed receipt (200), the claim is kept, the probe says placed, and a same-key retry replays it', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const lookup = failVendorOwnerLookupOnce();
    let res: LightMyRequestResponse;
    try {
      res = await checkout(c, key);
    } finally {
      lookup.restore();
    }
    expect(lookup.fired()).toBe(1); // the injected failure really ran, after the commit
    const receipt = await receiptOf(c, key);
    expect(receipt).not.toBeNull(); // the order and its receipt committed
    expect(res.statusCode, res.body).toBe(200); // the old code answered 500 for this placed order
    expect(res.json().data).toEqual(receipt!.result); // the answer IS the receipt
    expect(res.json().data.orders.map((o: { id: string }) => o.id)).toEqual(receipt!.orderIds);
    expect(await ordersOf(c.userId)).toBe(1);

    const claim = await app.redis.get(claimKey(c, key));
    expect(claim).not.toBeNull(); // never released for a placed order
    expect(JSON.parse(claim!)).toEqual(res.json().data);
    expect((await probe(c, key)).json().data).toEqual({ status: 'placed', orderIds: receipt!.orderIds });

    await fillCart(c, vendorId, itemId); // a retrying client's cart is full again
    const again = await checkout(c, key);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect(again.json().data.orders[0].id).toBe(receipt!.orderIds[0]);
    expect(await ordersOf(c.userId)).toBe(1);
  });

  it('OrderService.checkout itself resolves with the committed answer when a post-commit step fails, and reports its commit point with the receipt row id', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const service = new OrderService(app.prisma, app.io);
    const commits: unknown[] = [];
    const lookup = failVendorOwnerLookupOnce();
    let answer: unknown;
    try {
      answer = await service.checkout({
        userId: c.userId,
        paymentMethod: 'CASH',
        idempotency: { key, requestHash: 'h'.repeat(64) },
        onCommitted: (commit) => { commits.push(commit); },
      });
    } finally {
      lookup.restore();
    }
    expect(lookup.fired()).toBe(1);
    const receipt = await app.prisma.checkoutReceipt.findUniqueOrThrow({
      where: { userId_idempotencyKey: { userId: c.userId, idempotencyKey: key } },
      select: { id: true, orderIds: true, result: true },
    });
    expect(JSON.parse(JSON.stringify(answer))).toEqual(receipt.result);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ receiptId: receipt.id });
    expect((commits[0] as { answer: unknown }).answer).toBe(answer);
  });
});

describe('(b) the claim is released only for a failure BEFORE the commit', () => {
  it('a failure before the commit (MIN_ORDER) releases the claim: nothing placed, the probe says none, and the SAME key places once the cart meets the minimum', async () => {
    const c = await makeCustomer();
    await fillCart(c, minVendorId, minItemId);
    const key = `ckidem-${nanoid(10)}`;
    const refused = await checkout(c, key);
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.code).toBe('MIN_ORDER');
    expect(await app.redis.get(claimKey(c, key))).toBeNull(); // released: not IN_FLIGHT for a day
    expect(await receiptOf(c, key)).toBeNull();
    expect(await ordersOf(c.userId)).toBe(0);
    expect((await probe(c, key)).json().data).toEqual({ status: 'none' });

    // The customer fixes the problem: two plates meet the store's minimum.
    const line = await app.prisma.cartItem.findFirstOrThrow({ where: { cart: { customerId: c.userId } } });
    const bump = await inject('PUT', `/api/v1/customer/cart/items/${line.id}`, { quantity: 2 }, c.token);
    expect(bump.statusCode, bump.body).toBe(200);
    const retry = await checkout(c, key);
    expect(retry.statusCode, retry.body).toBe(200); // not the 409 a stranded claim answers
    expect(retry.json().replayed).toBeUndefined();
    expect(await ordersOf(c.userId)).toBe(1);
    expect((await probe(c, key)).json().data.status).toBe('placed');
  });

  it('a failure inside the transaction AFTER the receipt row is written is still before the commit: everything rolls back, the claim is released, the probe says none, and the same key places cleanly', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const realCheckout = OrderService.prototype.checkout;
    let reachedTail = 0;
    const spy = vi.spyOn(OrderService.prototype, 'checkout').mockImplementationOnce(async function (this: OrderService, input) {
      return realCheckout.call(this, { ...input, afterDurableTail: async () => { reachedTail += 1; throw new Error('the commit failed'); } });
    });
    let failed: LightMyRequestResponse;
    try {
      failed = await checkout(c, key);
    } finally {
      spy.mockRestore();
    }
    expect(reachedTail).toBe(1); // the receipt row had been written inside the transaction
    expect(failed.statusCode, failed.body).toBe(500); // never answered as placed
    expect(await receiptOf(c, key)).toBeNull();
    expect(await ordersOf(c.userId)).toBe(0);
    expect(await app.redis.get(claimKey(c, key))).toBeNull();
    expect((await probe(c, key)).json().data).toEqual({ status: 'none' });

    const retry = await checkout(c, key); // the rolled-back cart is still full
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().replayed).toBeUndefined();
    expect(await ordersOf(c.userId)).toBe(1);
  });

  it('an error that escapes checkout AFTER its commit point never releases the claim: the route answers the committed receipt', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const realCheckout = OrderService.prototype.checkout;
    let escaped = 0;
    const spy = vi.spyOn(OrderService.prototype, 'checkout').mockImplementation(async function (this: OrderService, input) {
      await realCheckout.call(this, input);
      escaped += 1;
      throw new Error('a post-commit step escaped checkout');
    });
    let res: LightMyRequestResponse;
    try {
      res = await checkout(c, key);
    } finally {
      spy.mockRestore();
    }
    expect(escaped).toBe(1);
    const receipt = await receiptOf(c, key);
    expect(receipt).not.toBeNull();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual(receipt!.result);
    expect(await app.redis.get(claimKey(c, key))).not.toBeNull();
    expect((await probe(c, key)).json().data).toEqual({ status: 'placed', orderIds: receipt!.orderIds });
    expect(await ordersOf(c.userId)).toBe(1);
  });
});

describe('(c) the probe reads the claim FIRST, then the receipt', () => {
  it('the AX354 race: the probe starts while the checkout is in flight; between its two reads the order commits and the vendor-owner lookup fails — the probe answers placed, never none', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const lookup = failVendorOwnerLookupOnce();
    const { answer, post } = await probeAcrossCheckout(c, key);
    lookup.restore();
    expect(lookup.fired()).toBe(1);
    const receipt = await receiptOf(c, key);
    expect(receipt).not.toBeNull(); // the order was placed while the probe was between its reads
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json().data).toEqual({ status: 'placed', orderIds: receipt!.orderIds });
    expect(post.statusCode, post.body).toBe(200);
    expect(await ordersOf(c.userId)).toBe(1);
  });

  it('the claim vanishes after the commit (its TTL lapsed, Redis evicted it) while the probe is between its reads: still placed, never none', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const { answer, post } = await probeAcrossCheckout(c, key, async () => {
      await app.redis.del(claimKey(c, key));
    });
    expect(post.statusCode, post.body).toBe(200);
    const receipt = await receiptOf(c, key);
    expect(receipt).not.toBeNull();
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json().data).toEqual({ status: 'placed', orderIds: receipt!.orderIds });
  });

  it('a claim that cannot be read is never taken for "none": a placed order still answers placed, and an unplaced one is a retryable 503', async () => {
    const c = await makeCustomer();
    const redis = app.redis;
    const realGet = redis.get.bind(redis);
    let failedReads = 0;
    // Only the claim read fails — the rest of Redis answers as usual.
    const outage = (key: string) => vi.spyOn(redis, 'get').mockImplementation(((k: string) => {
      if (k !== claimKey(c, key)) return realGet(k);
      failedReads += 1;
      return Promise.reject(new Error('redis: connection lost'));
    }) as never);

    const unplaced = `ckidem-${nanoid(10)}`;
    let spy = outage(unplaced);
    const unknown = await probe(c, unplaced);
    spy.mockRestore();
    expect(unknown.statusCode, unknown.body).toBe(503);
    expect(unknown.json().error.code).toBe('CHECKOUT_STATUS_UNAVAILABLE');

    await fillCart(c, vendorId, itemId);
    const placedKey = `ckidem-${nanoid(10)}`;
    const placed = await checkout(c, placedKey);
    expect(placed.statusCode, placed.body).toBe(200);
    spy = outage(placedKey);
    const known = await probe(c, placedKey);
    spy.mockRestore();
    expect(failedReads).toBeGreaterThanOrEqual(1); // the outage was really injected into a probe's claim read
    expect(known.statusCode, known.body).toBe(200);
    expect(known.json().data).toEqual({ status: 'placed', orderIds: [placed.json().data.orders[0].id] });
  });
});

describe('[AX366 F1] a commit whose outcome is unknown is settled by the durable receipt, never released blind', () => {
  it('the COMMIT lands but its acknowledgement is lost: the receipt proves it, so the answer is the placed receipt (200), the claim is kept, the store is told, and the probe says placed', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const told = vi.spyOn(NotificationService.prototype, 'newOrderForVendor');
    const lost = loseCommitAcknowledgement(true);
    let res: LightMyRequestResponse;
    try {
      res = await checkout(c, key);
    } finally {
      lost.restore();
    }
    expect(lost.fired()).toBe(1); // the checkout's own transaction rejected after its body finished
    const receipt = await receiptOf(c, key);
    expect(receipt).not.toBeNull(); // the database did commit
    expect(res.statusCode, res.body).toBe(200); // not an error for a placed order
    expect(res.json().data).toEqual(receipt!.result);
    expect(await ordersOf(c.userId)).toBe(1);
    expect(await app.redis.get(claimKey(c, key))).not.toBeNull();
    expect((await probe(c, key)).json().data).toEqual({ status: 'placed', orderIds: receipt!.orderIds });
    // The committed order is treated as committed all the way: its store is told.
    expect(told.mock.calls.some((args) => args[4] === receipt!.orderIds[0])).toBe(true);

    await fillCart(c, vendorId, itemId);
    const again = await checkout(c, key);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect(await ordersOf(c.userId)).toBe(1);
  });

  it('the COMMIT does not land and the error cannot say so: no receipt, so the claim is KEPT, the answer is a retryable 503, the probe says in_flight, and a same-key retry places nothing', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const lost = loseCommitAcknowledgement(false);
    let res: LightMyRequestResponse;
    try {
      res = await checkout(c, key);
    } finally {
      lost.restore();
    }
    expect(lost.fired()).toBe(1);
    expect(await receiptOf(c, key)).toBeNull();
    expect(await ordersOf(c.userId)).toBe(0);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error.code).toBe('CHECKOUT_OUTCOME_UNKNOWN');
    // Unknown is not "nothing placed": the claim stays until the receipt appears or it expires.
    expect(await app.redis.get(claimKey(c, key))).toMatch(/^IN_FLIGHT/);
    expect(await app.redis.ttl(claimKey(c, key))).toBeGreaterThan(0);
    expect((await probe(c, key)).json().data).toEqual({ status: 'in_flight' });
    const again = await checkout(c, key);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('DUPLICATE_REQUEST');
    expect(await ordersOf(c.userId)).toBe(0);
  });
});

describe('[AX366 F1] a claim is released only by the request that holds it', () => {
  it('an older request that fails before its commit never deletes a newer request’s claim on the same key', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const olderInFlight = deferred();
    const olderGate = deferred();
    const newerInFlight = deferred();
    const newerGate = deferred();
    let calls = 0;
    const realCheckout = OrderService.prototype.checkout;
    const spy = vi.spyOn(OrderService.prototype, 'checkout').mockImplementation(async function (this: OrderService, input) {
      calls += 1;
      if (calls === 1) {
        return realCheckout.call(this, { ...input, beforeTransaction: async () => { olderInFlight.resolve(); await olderGate.promise; throw new Error('the older attempt failed before its commit'); } });
      }
      return realCheckout.call(this, { ...input, beforeTransaction: async () => { newerInFlight.resolve(); await newerGate.promise; } });
    });
    let older: Promise<LightMyRequestResponse> | undefined;
    let newer: Promise<LightMyRequestResponse> | undefined;
    try {
      older = checkout(c, key);
      await olderInFlight.promise;
      const olderClaim = await app.redis.get(claimKey(c, key));
      expect(olderClaim).toMatch(/^IN_FLIGHT/);
      await app.redis.del(claimKey(c, key)); // the older claim is lost (its TTL lapsed, Redis evicted it)
      newer = checkout(c, key);
      await newerInFlight.promise;
      const newerClaim = await app.redis.get(claimKey(c, key));
      expect(newerClaim).toMatch(/^IN_FLIGHT/);
      expect(newerClaim).not.toBe(olderClaim); // each request holds a token of its own

      olderGate.resolve();
      const olderRes = await older;
      expect(olderRes.statusCode, olderRes.body).toBe(500);
      expect(await app.redis.get(claimKey(c, key))).toBe(newerClaim); // not the older request's to release
      expect((await probe(c, key)).json().data).toEqual({ status: 'in_flight' });

      newerGate.resolve();
      const newerRes = await newer;
      expect(newerRes.statusCode, newerRes.body).toBe(200);
      expect(await ordersOf(c.userId)).toBe(1);
      expect((await probe(c, key)).json().data.status).toBe('placed');
    } finally {
      spy.mockRestore();
      olderGate.resolve();
      newerGate.resolve();
      await Promise.allSettled([older, newer]);
    }
  });
});

describe('[AX372 R2] a cached answer is replayed only for the request that made it', () => {
  /**
   * The reviewer's interleaving, driven deterministically. A holds key K for
   * its body (claimed, its transaction not yet begun). B submits K with
   * `bBody`: B's receipt lookup misses (A has not committed), and only then
   * does A commit and cache its answer under K. B then fails to claim K and
   * finds A's cached answer.
   */
  async function cacheRace(bBody: Record<string, unknown>) {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const aInFlight = deferred();
    const aGate = deferred();
    const realCheckout = OrderService.prototype.checkout;
    const checkoutSpy = vi.spyOn(OrderService.prototype, 'checkout').mockImplementationOnce(async function (this: OrderService, input) {
      return realCheckout.call(this, { ...input, beforeTransaction: async () => { aInFlight.resolve(); await aGate.promise; } });
    });
    const postingA = checkout(c, key);
    let a: LightMyRequestResponse | undefined;
    let bLookupMissed: boolean | undefined;
    let findSpy: { mockRestore: () => void } | undefined;
    try {
      await aInFlight.promise;
      expect(await app.redis.get(claimKey(c, key))).toMatch(/^IN_FLIGHT/);
      const receipts = app.prisma.checkoutReceipt;
      const realFind = receipts.findUnique.bind(receipts);
      findSpy = vi.spyOn(receipts, 'findUnique').mockImplementation((async (args: { where?: { userId_idempotencyKey?: { idempotencyKey?: string } } }) => {
        const seen = await realFind(args as never);
        if (bLookupMissed === undefined && args?.where?.userId_idempotencyKey?.idempotencyKey === key) {
          bLookupMissed = seen === null;
          aGate.resolve();
          a = await postingA; // A commits and caches its answer under K
        }
        return seen;
      }) as never);
      const b = await inject('POST', '/api/v1/customer/checkout', bBody, c.token, { 'idempotency-key': key });
      expect(bLookupMissed).toBe(true); // B looked before A committed
      expect(a!.statusCode, a!.body).toBe(200);
      return { c, key, a: a!, b };
    } finally {
      findSpy?.mockRestore();
      checkoutSpy.mockRestore();
      aGate.resolve();
      await postingA;
    }
  }

  it('A holds K for H1, B submits K with a different body H2 before A commits: B gets 422 IDEMPOTENCY_KEY_REUSED, never a 200 replay of A’s order', async () => {
    const { c, key, b } = await cacheRace({ paymentMethod: 'CASH', deliveryInstructions: 'Leave it at the gate' });
    // B fell back to A's cached answer: the claim is gone, the answer is there.
    const cached = await app.redis.get(claimKey(c, key));
    expect(cached).not.toBeNull();
    expect(cached).not.toMatch(/^IN_FLIGHT/);
    expect(b.statusCode, b.body).toBe(422);
    expect(b.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await ordersOf(c.userId)).toBe(1);
  });

  it('a cached answer whose receipt cannot be found is never replayed: the key is busy (409), as the probe reports it (in_flight)', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    await app.redis.set(claimKey(c, key), JSON.stringify({ orders: [{ id: 'someone-else' }], grandTotal: 1 }), 'EX', 60);
    const res = await checkout(c, key);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE_REQUEST');
    expect((await probe(c, key)).json().data).toEqual({ status: 'in_flight' });
    expect(await ordersOf(c.userId)).toBe(0);
    await app.redis.del(claimKey(c, key));
  });

  it('the same interleaving with the SAME body is a replay of A’s order: its durable receipt, field for field', async () => {
    const { c, key, a, b } = await cacheRace({ paymentMethod: 'CASH' });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().replayed).toBe(true);
    const receipt = await receiptOf(c, key);
    expect(b.json().data).toEqual(receipt!.result);
    expect(b.json().data).toEqual(a.json().data);
    expect(await ordersOf(c.userId)).toBe(1);
  });
});

describe('[AX372 F1b] an unknown outcome holds its key for a short settle window, not a day', () => {
  it('the claim an unknown outcome keeps is re-set to the settle window (120 s by default); once it lapses with no receipt, the probe says none and the same key places exactly one order', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const lost = loseCommitAcknowledgement(false);
    let res: LightMyRequestResponse;
    try {
      res = await checkout(c, key);
    } finally {
      lost.restore();
    }
    expect(lost.fired()).toBe(1);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error.code).toBe('CHECKOUT_OUTCOME_UNKNOWN');
    expect(await receiptOf(c, key)).toBeNull();
    // Still this request's own claim, now for the settle window, not the 24 h claim.
    expect(await app.redis.get(claimKey(c, key))).toMatch(/^IN_FLIGHT:/);
    const ttl = await app.redis.ttl(claimKey(c, key));
    expect(ttl).toBeGreaterThan(60);
    expect(ttl).toBeLessThanOrEqual(120);
    // Inside the window the outcome is still unsettled.
    expect((await probe(c, key)).json().data).toEqual({ status: 'in_flight' });
    expect((await checkout(c, key)).statusCode).toBe(409);
    expect(await ordersOf(c.userId)).toBe(0);

    await lapse(claimKey(c, key));
    expect((await probe(c, key)).json().data).toEqual({ status: 'none' });
    const again = await checkout(c, key);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().replayed).toBeUndefined();
    expect(await ordersOf(c.userId)).toBe(1);
    const receipt = await receiptOf(c, key);
    expect((await probe(c, key)).json().data).toEqual({ status: 'placed', orderIds: receipt!.orderIds });
    await fillCart(c, vendorId, itemId);
    const replay = await checkout(c, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(await ordersOf(c.userId)).toBe(1);
  });

  it('once the window lapses over an order that DID commit (its receipt unreadable when the outcome was settled), the probe says placed and the same key replays it: never a second order', async () => {
    const c = await makeCustomer();
    await fillCart(c, vendorId, itemId);
    const key = `ckidem-${nanoid(10)}`;
    const lost = loseCommitAcknowledgement(true);
    const unreadable = failReceiptReconciliationOnce();
    let res: LightMyRequestResponse;
    try {
      res = await checkout(c, key);
    } finally {
      unreadable.restore();
      lost.restore();
    }
    expect(lost.fired()).toBe(1);
    expect(unreadable.fired()).toBe(1);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error.code).toBe('CHECKOUT_OUTCOME_UNKNOWN');
    const receipt = await receiptOf(c, key);
    expect(receipt).not.toBeNull(); // the database did commit
    const ttl = await app.redis.ttl(claimKey(c, key));
    expect(ttl).toBeGreaterThan(60);
    expect(ttl).toBeLessThanOrEqual(120);

    await lapse(claimKey(c, key));
    expect((await probe(c, key)).json().data).toEqual({ status: 'placed', orderIds: receipt!.orderIds });
    await fillCart(c, vendorId, itemId);
    const again = await checkout(c, key);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect(again.json().data).toEqual(receipt!.result);
    expect(await ordersOf(c.userId)).toBe(1);
  });

  it('the window is read from CHECKOUT_UNKNOWN_SETTLE_S when the outcome is unknown', async () => {
    const prev = process.env['CHECKOUT_UNKNOWN_SETTLE_S'];
    process.env['CHECKOUT_UNKNOWN_SETTLE_S'] = '300';
    try {
      const c = await makeCustomer();
      await fillCart(c, vendorId, itemId);
      const key = `ckidem-${nanoid(10)}`;
      const lost = loseCommitAcknowledgement(false);
      let res: LightMyRequestResponse;
      try {
        res = await checkout(c, key);
      } finally {
        lost.restore();
      }
      expect(res.statusCode, res.body).toBe(503);
      const ttl = await app.redis.ttl(claimKey(c, key));
      expect(ttl).toBeGreaterThan(120);
      expect(ttl).toBeLessThanOrEqual(300);
    } finally {
      if (prev === undefined) delete process.env['CHECKOUT_UNKNOWN_SETTLE_S'];
      else process.env['CHECKOUT_UNKNOWN_SETTLE_S'] = prev;
    }
  });

  it('the window is 120 s by default and never under 60 s', () => {
    const prev = process.env['CHECKOUT_UNKNOWN_SETTLE_S'];
    const at = (v: string | undefined) => {
      if (v === undefined) delete process.env['CHECKOUT_UNKNOWN_SETTLE_S'];
      else process.env['CHECKOUT_UNKNOWN_SETTLE_S'] = v;
      return checkoutUnknownSettleSeconds();
    };
    try {
      expect(at(undefined)).toBe(120);
      expect(at('')).toBe(120);
      expect(at('soon')).toBe(120);
      expect(at('0')).toBe(120);
      expect(at('-5')).toBe(120);
      expect(at('300')).toBe(300);
      expect(at('90.7')).toBe(90);
      expect(at('60')).toBe(60);
      expect(at('59')).toBe(60);
      expect(at('1')).toBe(60);
    } finally {
      at(prev);
    }
  });

  it('the re-set is atomic and ownership-checked: only this request’s own claim is re-set, never a newer claim or a cached answer, and a lapsed claim is never re-created', async () => {
    const k = `checkout:idem:ckidem-settle:${nanoid(10)}`;
    const mine = newCheckoutClaim();
    const newer = newCheckoutClaim();
    try {
      await app.redis.set(k, newer, 'EX', 86_400);
      expect(await settleCheckoutClaim(app.redis, k, mine, 120)).toBe(false);
      expect(await app.redis.get(k)).toBe(newer);
      expect(await app.redis.ttl(k)).toBeGreaterThan(86_000);

      const answer = JSON.stringify({ orders: [{ id: 'o1' }] });
      await app.redis.set(k, answer, 'EX', 86_400);
      expect(await settleCheckoutClaim(app.redis, k, mine, 120)).toBe(false);
      expect(await app.redis.get(k)).toBe(answer);
      expect(await app.redis.ttl(k)).toBeGreaterThan(86_000);

      await app.redis.set(k, mine, 'EX', 86_400);
      expect(await settleCheckoutClaim(app.redis, k, mine, 120)).toBe(true);
      expect(await app.redis.get(k)).toBe(mine);
      const ttl = await app.redis.ttl(k);
      expect(ttl).toBeGreaterThan(100);
      expect(ttl).toBeLessThanOrEqual(120);

      await app.redis.del(k);
      expect(await settleCheckoutClaim(app.redis, k, mine, 120)).toBe(false);
      expect(await app.redis.exists(k)).toBe(0);
    } finally {
      await app.redis.del(k);
    }
  });
});
