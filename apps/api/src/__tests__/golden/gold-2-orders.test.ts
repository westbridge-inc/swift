import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerTenantHeaderScope } from '../../plugins/tenant-header-scope';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { registerErrorHandler } from '../../middleware/error-handler';
import { customerRoutes } from '../../modules/user/customer.routes';
import { vendorRoutes } from '../../modules/vendor/vendor.routes';

// ---------------------------------------------------------------------------
// GOLD-2 · CUST-02 — checkout (cash), the customer's golden journey.
//
// The production composition (app.ts: tenant context per request, the empty-
// JSON parser, the vendor-header scope) with the real customer and vendor
// route modules at their mounted prefixes, real sessions, a real database.
// Every step is asserted on durable rows:
//   · a two-vendor CASH basket becomes one child order per vendor with exact
//     money, and each store sees only its own child
//   · one Idempotency-Key places one set of orders: a replay returns them, a
//     changed body under the key is refused, a new key finds nothing to buy,
//     and two in-flight submissions of one key place one set
//   · CARD is refused before anything is written — the key is not consumed
//   · two different keys racing one cart: exactly one set of orders
//   · [G3-F2] a same-key replay answers what the first call did
//   · [E01] the cart quote prices every vendor it will charge (fixed by #1285)
// The MMG half of CUST-02 (MMG checkout, dispute hold) is proven through the
// same routes in gold-2-mmg.test.ts.
// ---------------------------------------------------------------------------

// This file's own fixture block (+5920321nnn, 11 characters): audited against
// every phone literal, generator and purge prefix under apps/api/src. Phones
// and the crash-recovery purge share this ONE constant.
const PHONE_PREFIX = '+5920321';
const FIXTURE = 'gold2-orders-fixture';
const DAY = 24 * 60 * 60 * 1000;
// The delivery fee of each vendor's leg to the customer below (haversine
// distance, the seeded Guyana delivery rates): A is inside the included km.
const FEE_A = 500;
const FEE_B = 1532;

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string };
let ownerA: Actor;
let ownerB: Actor;
let vendorAId: string;
let vendorBId: string;
let itemAId: string;
let itemBId: string;

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName,
      lastName: `Orders${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      // Checkout's identity gate is not this journey (AUTH-03 / E27 own it).
      selfieCapturedAt: new Date(),
      trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `g2o-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token };
}

/** A customer with a Georgetown default address (Vendor A ~0.4 km away,
 *  Vendor B ~5.5 km away — two genuinely different delivery legs). */
async function makeCustomer(firstName: string): Promise<Actor> {
  const customer = await makeUser(firstName, ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: {
      userId: customer.userId, label: 'Home', addressLine1: '77 Gold Street', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8045, longitude: -58.1553, isDefault: true,
    },
  }));
  return customer;
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    headers: {
      ...headers,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** Empty the cart, then one line from each vendor (A added first, B last). */
async function fillTwoVendorCart(customer: Actor, quantityA = 1, quantityB = 1) {
  const cleared = await call('DELETE', '/api/v1/customer/cart', customer.token);
  expect(cleared.statusCode).toBe(200);
  const addA = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: vendorAId, itemId: itemAId, quantity: quantityA });
  expect(addA.statusCode, addA.body).toBe(201);
  const addB = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: vendorBId, itemId: itemBId, quantity: quantityB });
  expect(addB.statusCode, addB.body).toBe(201);
}

function checkout(customer: Actor, body: Record<string, unknown>, key?: string) {
  return call('POST', '/api/v1/customer/checkout', customer.token, body, key ? { 'idempotency-key': key } : {});
}

const ordersOf = (customerId: string) => sys(() => app.prisma.order.findMany({
  where: { customerId },
  include: { items: true },
  orderBy: { vendorId: 'asc' },
}));
const receiptsOf = (userId: string) => sys(() => app.prisma.checkoutReceipt.findMany({ where: { userId } }));

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } })).map((v) => v.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    if (orderIds.length > 0) {
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    // The vendor alert ladder (§A4) records every new-order alert it sends.
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await purgeRedis([...ids, ...vendorIds, ...orderIds]);
  });
}

/** Every Redis key that names one of this file's ids (checkout claims, cart
 *  and home caches, vendor boards). Nothing else is touched. */
async function purgeRedis(ids: string[]) {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(':').some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

async function makeVendor(owner: Actor, name: string, at: { lat: number; lng: number }, dish: { name: string; price: number }) {
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name, slug: `gold2-ord-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`, addressLine1: `${name} Road`, city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: at.lat, longitude: at.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
    },
  }));
  const category = await sys(() => app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains', sortOrder: 0 } }));
  const item = await sys(() => app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: dish.name, basePrice: dish.price, isAvailable: true } }));
  return { vendorId: vendor.id, itemId: item.id };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  registerTenantHeaderScope(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  await purgeFixtures(); // a crashed earlier run leaves nothing to collide with

  ownerA = await makeUser('Asha', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  ownerB = await makeUser('Bram', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  ({ vendorId: vendorAId, itemId: itemAId } = await makeVendor(ownerA, 'Gold Cafe A', { lat: 6.8013, lng: -58.1551 }, { name: 'Gold Pepperpot', price: 2500 }));
  ({ vendorId: vendorBId, itemId: itemBId } = await makeVendor(ownerB, 'Gold Cafe B', { lat: 6.7550, lng: -58.1551 }, { name: 'Gold Cook-Up', price: 1200 }));
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('GOLD-2 · CUST-02 — two-vendor cash checkout', () => {
  it('splits a two-vendor CASH basket into one child order per vendor with exact money, and each store sees only its own child', async () => {
    const customer = await makeCustomer('Cora');
    const stranger = await makeCustomer('Sol');
    await fillTwoVendorCart(customer, 2, 3);

    const placed = await checkout(customer, { paymentMethod: 'CASH' }, `cust02-split-${nanoid(8)}`);
    expect(placed.statusCode, placed.body).toBe(200);
    const data = placed.json().data as {
      order: { id: string };
      orders: Array<{ id: string; vendorName: string; status: string; paymentMethod: string; subtotal: number; deliveryFee: number; tip: number; discount: number; total: number; items: Array<{ name: string; quantity: number; price: number }> }>;
      grandTotal: number; paymentAction: unknown; message: string;
    };
    expect(data.message).toBe('2 orders placed — each vendor will confirm shortly.');
    expect(data.paymentAction).toBeNull(); // cash: nothing to open, Swift holds nothing
    expect(data.orders).toHaveLength(2);
    const byVendor = Object.fromEntries(data.orders.map((o) => [o.vendorName, o]));
    expect(byVendor['Gold Cafe A']!.items).toEqual([{ name: 'Gold Pepperpot', quantity: 2, price: 5000 }]);
    expect(byVendor['Gold Cafe B']!.items).toEqual([{ name: 'Gold Cook-Up', quantity: 3, price: 3600 }]);
    expect(byVendor['Gold Cafe A']!.subtotal).toBe(5000);
    expect(byVendor['Gold Cafe B']!.subtotal).toBe(3600);
    // Each child is its own delivery leg, priced by the Guyana delivery rates:
    // Vendor A is inside the included distance, Vendor B ~5 km further.
    expect(byVendor['Gold Cafe A']!.deliveryFee).toBe(FEE_A);
    expect(byVendor['Gold Cafe B']!.deliveryFee).toBe(FEE_B);
    for (const child of data.orders) {
      expect(child).toMatchObject({ status: 'PENDING', paymentMethod: 'CASH', tip: 0, discount: 0 });
      expect(child.total).toBe(child.subtotal + child.deliveryFee);
    }
    expect(data.grandTotal).toBe(byVendor['Gold Cafe A']!.total + byVendor['Gold Cafe B']!.total);

    // Durable: exactly the two children, each with its own line and the money
    // the response promised, and the cart is gone.
    const rows = await ordersOf(customer.userId);
    expect(rows.map((o) => o.vendorId).sort()).toEqual([vendorAId, vendorBId].sort());
    for (const row of rows) {
      const answered = data.orders.find((o) => o.id === row.id)!;
      expect(answered).toBeDefined();
      expect({ status: row.status, paymentMethod: row.paymentMethod, paymentStatus: row.paymentStatus, fulfillment: row.fulfillment })
        .toEqual({ status: 'PENDING', paymentMethod: 'CASH', paymentStatus: 'PENDING', fulfillment: 'DELIVERY' });
      expect(Number(row.subtotalCustomer)).toBe(answered.subtotal);
      expect(Number(row.deliveryFee)).toBe(answered.deliveryFee);
      expect(Number(row.totalAmount)).toBe(answered.total);
      expect(row.items).toHaveLength(1);
    }
    const lineA = rows.find((o) => o.vendorId === vendorAId)!.items[0]!;
    const lineB = rows.find((o) => o.vendorId === vendorBId)!.items[0]!;
    expect({ itemId: lineA.itemId, quantity: lineA.quantity, total: Number(lineA.totalCustomer) }).toEqual({ itemId: itemAId, quantity: 2, total: 5000 });
    expect({ itemId: lineB.itemId, quantity: lineB.quantity, total: Number(lineB.totalCustomer) }).toEqual({ itemId: itemBId, quantity: 3, total: 3600 });
    const cartAfter = await call('GET', '/api/v1/customer/cart', customer.token);
    expect(cartAfter.statusCode).toBe(200);
    expect(cartAfter.json().data).toBeNull();

    // Each store works its own child — and only its own.
    const childA = rows.find((o) => o.vendorId === vendorAId)!.id;
    const childB = rows.find((o) => o.vendorId === vendorBId)!.id;
    const ownRead = await call('GET', `/api/v1/vendor/orders/${childA}`, ownerA.token, undefined, { 'x-vendor-id': vendorAId });
    expect(ownRead.statusCode).toBe(200);
    expect(ownRead.json().data.id).toBe(childA);
    const crossRead = await call('GET', `/api/v1/vendor/orders/${childB}`, ownerA.token, undefined, { 'x-vendor-id': vendorAId });
    expect(crossRead.statusCode).toBe(404);
    const crossAccept = await call('PUT', `/api/v1/vendor/orders/${childB}/accept`, ownerA.token, undefined, { 'x-vendor-id': vendorAId });
    expect(crossAccept.statusCode).toBe(404);
    const boardA = await call('GET', '/api/v1/vendor/orders?limit=50', ownerA.token, undefined, { 'x-vendor-id': vendorAId });
    expect(boardA.statusCode).toBe(200);
    expect((boardA.json().data as Array<{ id: string }>).map((o) => o.id)).toEqual([childA]);
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: childB } }))).status).toBe('PENDING');

    // Another customer cannot read or cancel either child.
    const strangerRead = await call('GET', `/api/v1/customer/orders/${childA}`, stranger.token);
    expect(strangerRead.statusCode).toBe(404);
    const strangerCancel = await call('POST', `/api/v1/customer/orders/${childA}/cancel`, stranger.token, { reason: 'not mine' });
    expect(strangerCancel.statusCode).toBe(404);
    const strangerList = await call('GET', '/api/v1/customer/orders?limit=50', stranger.token);
    expect(strangerList.statusCode).toBe(200);
    expect(strangerList.json().data).toEqual([]);
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: childA } }))).status).toBe('PENDING');
  });

  it('one Idempotency-Key places one set of orders: a replay returns them, a changed body is refused, and a new key finds nothing left to buy', async () => {
    const customer = await makeCustomer('Ines');
    await fillTwoVendorCart(customer);
    const key = `cust02-key-${nanoid(10)}`;

    const first = await checkout(customer, { paymentMethod: 'CASH' }, key);
    expect(first.statusCode, first.body).toBe(200);
    const placedIds = (first.json().data.orders as Array<{ id: string }>).map((o) => o.id).sort();
    expect(placedIds).toHaveLength(2);
    const receipts = await receiptsOf(customer.userId);
    expect(receipts.map((r) => ({ key: r.idempotencyKey, orderIds: [...r.orderIds].sort() }))).toEqual([{ key, orderIds: placedIds }]);

    // The network retries the same request: the stored answer, never a second order.
    const replay = await checkout(customer, { paymentMethod: 'CASH' }, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect((replay.json().data.orders as Array<{ id: string }>).map((o) => o.id).sort()).toEqual(placedIds);
    expect((await ordersOf(customer.userId)).map((o) => o.id).sort()).toEqual(placedIds);

    // The same key under a different body is a different request.
    const changed = await checkout(customer, { paymentMethod: 'CASH', deliveryInstructions: 'Ring the bell' }, key);
    expect(changed.statusCode).toBe(422);
    expect(changed.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // A fresh key cannot buy the same basket twice: it was consumed.
    const fresh = await checkout(customer, { paymentMethod: 'CASH' }, `cust02-key2-${nanoid(8)}`);
    expect(fresh.statusCode).toBe(400);
    expect(fresh.json().error.code).toBe('EMPTY_CART');

    expect((await ordersOf(customer.userId)).map((o) => o.id).sort()).toEqual(placedIds);
    expect(await receiptsOf(customer.userId)).toHaveLength(1);
    const probe = await call('GET', `/api/v1/customer/checkout/receipts/${key}`, customer.token);
    expect(probe.json().data).toEqual({ status: 'placed', orderIds: expect.any(Array) });
    expect([...(probe.json().data.orderIds as string[])].sort()).toEqual(placedIds);
  });

  it('two in-flight submissions of one key place exactly one set of orders', async () => {
    const customer = await makeCustomer('Omar');
    await fillTwoVendorCart(customer);
    const key = `cust02-dup-${nanoid(10)}`;

    const [a, b] = await Promise.all([
      checkout(customer, { paymentMethod: 'CASH' }, key),
      checkout(customer, { paymentMethod: 'CASH' }, key),
    ]);
    const answers = [a, b];
    const placedAnswer = answers.find((r) => r.statusCode === 200 && r.json().replayed === undefined);
    expect(placedAnswer, `${a.statusCode} ${a.body} | ${b.statusCode} ${b.body}`).toBeDefined();
    const placedIds = (placedAnswer!.json().data.orders as Array<{ id: string }>).map((o) => o.id).sort();
    const other = answers.find((r) => r !== placedAnswer)!;
    // The twin either met the in-flight claim, or arrived after the commit and
    // was answered from the receipt — never a second placement.
    if (other.statusCode === 409) {
      expect(other.json().error.code).toBe('DUPLICATE_REQUEST');
    } else {
      expect(other.statusCode).toBe(200);
      expect(other.json().replayed).toBe(true);
      expect((other.json().data.orders as Array<{ id: string }>).map((o) => o.id).sort()).toEqual(placedIds);
    }
    expect((await ordersOf(customer.userId)).map((o) => o.id).sort()).toEqual(placedIds);
    expect(await receiptsOf(customer.userId)).toHaveLength(1);
  });

  it('refuses CARD before anything is written — the key is not consumed, and the same key then places the corrected CASH order', async () => {
    const customer = await makeCustomer('Kai');
    await fillTwoVendorCart(customer);
    const key = `cust02-card-${nanoid(10)}`;

    for (const method of ['CARD', 'BANK_TRANSFER']) {
      const denied = await checkout(customer, { paymentMethod: method }, key);
      expect(denied.statusCode).toBe(400);
      expect(denied.json().error.code).toBe('VALIDATION_ERROR');
      expect(denied.json().error.message).toBe('Invalid payment method. Valid options: CASH, MOBILE_MONEY');
    }
    expect(await ordersOf(customer.userId)).toEqual([]);
    expect(await receiptsOf(customer.userId)).toEqual([]);
    const probe = await call('GET', `/api/v1/customer/checkout/receipts/${key}`, customer.token);
    expect(probe.json().data).toEqual({ status: 'none' });
    const cart = await call('GET', '/api/v1/customer/cart', customer.token);
    expect(cart.json().data.itemCount).toBe(2);

    // [M-12] The refused request never claimed the key: it still places.
    const cash = await checkout(customer, { paymentMethod: 'CASH' }, key);
    expect(cash.statusCode, cash.body).toBe(200);
    expect(cash.json().replayed).toBeUndefined();
    const placedIds = (cash.json().data.orders as Array<{ id: string }>).map((o) => o.id).sort();
    expect(placedIds).toHaveLength(2);
    expect((await ordersOf(customer.userId)).map((o) => ({ id: o.id, paymentMethod: o.paymentMethod })).sort((x, y) => x.id.localeCompare(y.id)))
      .toEqual(placedIds.map((id) => ({ id, paymentMethod: 'CASH' })));
  });

  it('two different keys racing one cart place exactly one set of orders; the loser is told the cart changed and its key stays unused', async () => {
    const customer = await makeCustomer('Rhea');
    await fillTwoVendorCart(customer);
    const keyA = `cust02-race-a-${nanoid(8)}`;
    const keyB = `cust02-race-b-${nanoid(8)}`;

    const [ra, rb] = await Promise.all([
      checkout(customer, { paymentMethod: 'CASH' }, keyA),
      checkout(customer, { paymentMethod: 'CASH' }, keyB),
    ]);
    expect([ra.statusCode, rb.statusCode].sort(), `${ra.body} | ${rb.body}`).toEqual([200, 409]);
    const [winner, loser] = ra.statusCode === 200 ? [ra, rb] : [rb, ra];
    const winnerKey = winner === ra ? keyA : keyB;
    const loserKey = winner === ra ? keyB : keyA;
    expect(loser.json().error.code).toBe('CART_CHANGED');

    const placedIds = (winner.json().data.orders as Array<{ id: string }>).map((o) => o.id).sort();
    expect((await ordersOf(customer.userId)).map((o) => o.id).sort()).toEqual(placedIds);
    expect((await receiptsOf(customer.userId)).map((r) => r.idempotencyKey)).toEqual([winnerKey]);
    const loserProbe = await call('GET', `/api/v1/customer/checkout/receipts/${loserKey}`, customer.token);
    expect(loserProbe.json().data).toEqual({ status: 'none' });
  });
});

// ---------------------------------------------------------------------------
// G3-F2 (reported by GOLD-3, proposed S2; CUST-02's duplicate-key case).
// The receipt used to store the raw rows — `{ orders: created, paymentAction }`
// — while the first answer is the curated summary
// `{ order, orders, grandTotal, paymentAction, message }`. The replay returns
// the receipt, so a retried checkout got a different shape: no `order`, no
// `grandTotal`, no `message`, and every internal column of every order
// (riskReason, subtotalBase/subtotalMarkup, customerId, tenantId, …). Fixed:
// the receipt now stores exactly the shaped answer the fresh checkout returns
// (shapeCheckoutAnswer, built inside the transaction), so the replay is the
// first answer. This pins the contract the code states ("one key, one
// request, one immutable answer").
// ---------------------------------------------------------------------------
describe('GOLD-2 · CUST-02 — [G3-F2] a same-key replay is the same answer', () => {
  let first: Record<string, unknown>;
  let replay: Record<string, unknown>;

  beforeAll(async () => {
    const customer = await makeCustomer('Remi');
    await fillTwoVendorCart(customer);
    const key = `cust02-g3f2-${nanoid(10)}`;
    const a = await checkout(customer, { paymentMethod: 'CASH' }, key);
    expect(a.statusCode, a.body).toBe(200);
    const b = await checkout(customer, { paymentMethod: 'CASH' }, key);
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().replayed).toBe(true);
    first = a.json().data as Record<string, unknown>;
    replay = b.json().data as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(['grandTotal', 'message', 'order', 'orders', 'paymentAction']);
  });

  it('[G3-F2] the replay carries the first answer’s fields and none of the order’s internal columns', () => {
    expect(Object.keys(replay).sort()).toEqual(Object.keys(first).sort());
    expect(replay['grandTotal']).toBe(first['grandTotal']);
    expect((replay['order'] as { id: string }).id).toBe((first['order'] as { id: string }).id);
    const firstOrders = first['orders'] as Array<Record<string, unknown>>;
    const replayOrders = replay['orders'] as Array<Record<string, unknown>>;
    expect(replayOrders.map((o) => Object.keys(o).sort())).toEqual(firstOrders.map((o) => Object.keys(o).sort()));
    for (const order of replayOrders) {
      for (const internal of ['riskReason', 'subtotalBase', 'subtotalMarkup', 'customerId', 'tenantId']) {
        expect(order).not.toHaveProperty(internal);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// E01 (S1, fixed by #1285): the cart quote used to price the whole basket off
// `cart.vendor` — the vendor added LAST — while checkout charges one delivery
// fee per vendor leg (order.service.ts). So the quote a customer read before
// paying was not what the children cost. #1285 made the quote and checkout
// one computation (order/cart-plans.ts); this pins that contract: the quote's
// delivery fee and total equal the sum of what checkout charges. The basket,
// the quote and the checkout are all taken in beforeAll, so the assertion is
// the comparison alone.
// ---------------------------------------------------------------------------
describe('GOLD-2 · CUST-02 — [E01] the two-vendor quote equals what checkout charges', () => {
  let quote: { subtotalCustomer: number; deliveryFee: number; totalAmount: number };
  let children: Array<{ subtotal: number; deliveryFee: number; total: number }>;
  let grandTotal: number;

  beforeAll(async () => {
    const customer = await makeCustomer('Quin');
    await fillTwoVendorCart(customer, 1, 1);
    const quoted = await call('GET', '/api/v1/customer/cart', customer.token);
    expect(quoted.statusCode).toBe(200);
    quote = quoted.json().data;
    expect(quote.subtotalCustomer).toBe(2500 + 1200);
    const placed = await checkout(customer, { paymentMethod: 'CASH' }, `cust02-e01-${nanoid(8)}`);
    expect(placed.statusCode, placed.body).toBe(200);
    children = placed.json().data.orders;
    grandTotal = placed.json().data.grandTotal;
    expect(children).toHaveLength(2);
    expect(children.reduce((s, o) => s + o.subtotal, 0)).toBe(quote.subtotalCustomer);
    expect(children.map((o) => o.deliveryFee).sort((a, b) => a - b)).toEqual([FEE_A, FEE_B]);
  });

  it('[E01] the quote carries every vendor’s delivery fee and the total checkout will charge', () => {
    expect(quote.deliveryFee).toBe(children.reduce((s, o) => s + o.deliveryFee, 0));
    expect(quote.totalAmount).toBe(grandTotal);
  });
});
