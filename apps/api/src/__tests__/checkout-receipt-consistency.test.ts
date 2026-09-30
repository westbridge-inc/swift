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
import { registerErrorHandler } from '../middleware/error-handler';

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
  expect(await app.redis.get(claimKey(c, key))).toBe('IN_FLIGHT');
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
