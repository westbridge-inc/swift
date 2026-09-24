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
import { MAX_HANDOVER_ATTEMPTS } from '../../modules/handover/handover-security';
import { TERMINAL_ORDER_STATUSES } from '../../modules/order/order-status';

// ---------------------------------------------------------------------------
// GOLD-6 · CUST-05 — "Pickup code at counter" (the H-3 pickup variant), the
// customer's golden journey from a checkout that chooses PICKUP to the code
// handover at the counter. Proven through the REAL mounted customer and vendor
// route modules as real role sessions, asserted on durable rows:
//   · pickup creation — `fulfillmentSelections: { [vendor]: 'PICKUP' }` at
//     checkout produces ONE PICKUP order, priced with zero delivery fee, a
//     6-digit customer-held pickup code, and the customer can read that code
//     from the live order while the vendor (the verifier) never sees it;
//     a malformed selection is refused, and the pickup-close route refuses a
//     DELIVERY order
//   · wrong-code denial / lockout — a wrong code is refused with
//     WRONG_PICKUP_CODE, every wrong try burns a durable attempt, and after
//     MAX_HANDOVER_ATTEMPTS wrong tries the order locks: even the RIGHT code
//     is refused with MAX_ATTEMPTS and the order stays READY_FOR_PICKUP;
//     a missing code, another store's owner, and the customer herself are
//     refused with their exact codes
//   · counter completion — accept → preparing → ready, the customer reads her
//     code from the order detail, one wrong try is refused, the right code
//     completes the order into the terminal COMPLETED state with the full
//     append-only status chain, and a second completion is refused
// Nothing here is device-gated: every step is an HTTP route or a durable row.
// The delivery-PIN half of the handover family (MKT-F057) is goods-door-pin
// .test.ts's; the seeded-order lockout regression is handover-pickup-lockout
// .test.ts's — this file closes the gap between them with one end-to-end
// journey from checkout to counter.
// ---------------------------------------------------------------------------

// This file's own fixture block (+5920327nnn, 11 characters): audited against
// every phone literal, generator and purge prefix under apps/api/src — the
// gold-2 family owns +5920321…+5920325 and billing-stop-billing owns
// +5920326; nothing else claims +5920327.
const PHONE_PREFIX = '+5920327';
const FIXTURE = 'gold6-cust05-fixture';
const DAY = 24 * 60 * 60 * 1000;
const STORE = { lat: 6.8013, lng: -58.1551 };
const ITEM_PRICE = 2200;

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string };
let ownerA: Actor;
let ownerB: Actor;
let vendorId: string;
let vendorBId: string;
let itemId: string;

const vendorHeaders = () => ({ 'x-vendor-id': vendorId });

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName,
      lastName: `Cust05${seq}`,
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
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      authMethod: 'OTP',
      deviceId: `g6c05-${seq}`,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  }));
  return { userId: user.id, token };
}

/** A customer with a Georgetown default address (needed for the DELIVERY
 *  control order in case 1; PICKUP itself never routes an address). */
async function makeCustomer(firstName: string): Promise<Actor> {
  const customer = await makeUser(firstName, ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: {
      userId: customer.userId,
      label: 'Home',
      addressLine1: '77 Gold Street',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.8045,
      longitude: -58.1553,
      isDefault: true,
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

/** Empty the cart, then one line from the store. */
async function fillCart(customer: Actor, quantity = 1) {
  const cleared = await call('DELETE', '/api/v1/customer/cart', customer.token);
  expect(cleared.statusCode).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId, quantity });
  expect(added.statusCode, added.body).toBe(201);
}

function checkoutPickup(customer: Actor, key: string) {
  return call('POST', '/api/v1/customer/checkout', customer.token, {
    paymentMethod: 'CASH',
    fulfillmentSelections: { [vendorId]: 'PICKUP' },
  }, { 'idempotency-key': key });
}

/** A full PICKUP checkout: the response is the first proof, and the returned
 *  code is what the customer holds at the counter. */
async function placePickupOrder(customer: Actor, quantity = 2): Promise<{ id: string; code: string }> {
  await fillCart(customer, quantity);
  const placed = await checkoutPickup(customer, `cust05-${nanoid(10)}`);
  expect(placed.statusCode, placed.body).toBe(200);
  const order = placed.json().data.order as { id: string; fulfillment: string; pickupCode: string };
  expect(order.fulfillment).toBe('PICKUP');
  expect(order.pickupCode).toMatch(/^\d{6}$/);
  // [LIFECYCLE_V2] checkout may stamp holdExpiresAt (the order is then hidden
  // from the vendor). This suite exercises the pickup handover, not the hold
  // window — clear the hold so it behaves identically under LIFECYCLE_V2=0/1.
  await sys(() => app.prisma.order.update({ where: { id: order.id }, data: { holdExpiresAt: null } }));
  return { id: order.id, code: order.pickupCode };
}

/** Drive the vendor-side kitchen ladder one step and assert the answer. */
async function vendorStep(orderId: string, step: 'accept' | 'preparing' | 'ready', expected: string) {
  const res = await call('PUT', `/api/v1/vendor/orders/${orderId}/${step}`, ownerA.token, undefined, vendorHeaders());
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().data.status).toBe(expected);
}

function completePickup(orderId: string, code: string | undefined, token: Actor = ownerA, headers: Record<string, string> = vendorHeaders()) {
  return call('PUT', `/api/v1/vendor/orders/${orderId}/complete-pickup`, token.token, { code }, headers);
}

const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const statusLog = (orderId: string) => sys(() => app.prisma.orderStatusLog.findMany({
  where: { orderId },
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  select: { status: true, note: true, changedBy: true },
}));

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
    // The vendor alert ladder (§A4) records every new-order alert it sends,
    // and the prep-time shadow writes a decision row at accept.
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...vendorIds] } } });
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

async function makeVendor(owner: Actor, name: string, slugTag: string, dish: string) {
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id,
      name,
      slug: `gold6-c05-${slugTag}-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`,
      addressLine1: name === 'Counter Diner' ? '6 Counter Lane' : '8 Counter Row',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: STORE.lat,
      longitude: STORE.lng,
      status: 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: true,
      deliveryRadius: 50,
    },
  }));
  const category = await sys(() => app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains', sortOrder: 0 } }));
  const item = await sys(() => app.prisma.item.create({
    data: { vendorId: vendor.id, categoryId: category.id, name: dish, basePrice: ITEM_PRICE, isAvailable: true },
  }));
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

  ownerA = await makeUser('Kofi', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  ownerB = await makeUser('Lena', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  ({ vendorId, itemId } = await makeVendor(ownerA, 'Counter Diner', 'diner', 'Counter Pepperpot'));
  ({ vendorId: vendorBId } = await makeVendor(ownerB, 'Counter Cafe', 'cafe', 'Counter Cook-Up'));
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('GOLD-6 · CUST-05 — pickup creation: checkout picks PICKUP and mints the customer-held code', () => {
  it('fulfillmentSelections PICKUP prices one zero-fee pickup order; the customer reads the code, the verifier never does', async () => {
    const customer = await makeCustomer('Pia');
    const stranger = await makeCustomer('Rufus');
    await fillCart(customer, 2);

    // The quote the customer reads before paying prices her PICKUP choice:
    // same zero-fee plan checkout will charge.
    const quoted = await call('GET',
      `/api/v1/customer/cart?fulfillmentSelections=${encodeURIComponent(JSON.stringify({ [vendorId]: 'PICKUP' }))}`,
      customer.token);
    expect(quoted.statusCode, quoted.body).toBe(200);
    const quote = quoted.json().data as { vendors: Array<{ fulfillment: string; deliveryFee: number; subtotal: number }>; deliveryFee: number; subtotalCustomer: number; totalAmount: number };
    expect(quote.vendors).toHaveLength(1);
    expect(quote.vendors[0]).toMatchObject({ fulfillment: 'PICKUP', deliveryFee: 0, subtotal: ITEM_PRICE * 2 });
    expect(quote.deliveryFee).toBe(0);
    expect(quote.subtotalCustomer).toBe(ITEM_PRICE * 2);
    expect(quote.totalAmount).toBe(ITEM_PRICE * 2);

    const placed = await checkoutPickup(customer, `cust05-create-${nanoid(8)}`);
    expect(placed.statusCode, placed.body).toBe(200);
    const data = placed.json().data as {
      order: { id: string; status: string; fulfillment: string; pickupCode: string; paymentMethod: string; subtotal: number; deliveryFee: number; tip: number; discount: number; total: number; vendorName: string };
      orders: Array<{ id: string }>;
    };
    expect(data.orders).toHaveLength(1);
    expect(data.orders[0]!.id).toBe(data.order.id);
    expect(data.order.vendorName).toBe('Counter Diner');
    expect(data.order).toMatchObject({
      status: 'PENDING',
      fulfillment: 'PICKUP',
      paymentMethod: 'CASH',
      subtotal: ITEM_PRICE * 2,
      deliveryFee: 0,
      tip: 0,
      discount: 0,
      total: ITEM_PRICE * 2,
    });
    expect(data.order.pickupCode).toMatch(/^\d{6}$/);

    // Durable: one PICKUP order, the exact money, no fee, the code minted and
    // zero attempts spent, the pickup address pointing at the store.
    const row = await orderRow(data.order.id);
    expect(row).toMatchObject({
      status: 'PENDING',
      fulfillment: 'PICKUP',
      orderType: 'FOOD_DELIVERY',
      paymentMethod: 'CASH',
      customerId: customer.userId,
      vendorId,
      pickupAddress: '6 Counter Lane, Georgetown',
      pickupLat: STORE.lat,
      pickupLng: STORE.lng,
    });
    expect(Number(row.subtotalCustomer)).toBe(ITEM_PRICE * 2);
    expect(Number(row.deliveryFee)).toBe(0);
    expect(Number(row.totalAmount)).toBe(ITEM_PRICE * 2);
    expect(row.pickupCode).toBe(data.order.pickupCode);
    expect(row.pickupCodeAttempts).toBe(0);

    // The customer can read the code back from the live order — it must
    // survive past the checkout confirmation screen to the counter.
    const detail = await call('GET', `/api/v1/customer/orders/${row.id}`, customer.token);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data).toMatchObject({
      id: row.id,
      status: 'PENDING',
      fulfillment: 'PICKUP',
      pickupCode: row.pickupCode,
      deliveryFee: 0,
      pickupAddress: '6 Counter Lane, Georgetown',
    });

    // Another customer cannot read the order — and the VENDOR, the code
    // VERIFIER, never sees the code on the detail or the board (HND-003).
    const strangerRead = await call('GET', `/api/v1/customer/orders/${row.id}`, stranger.token);
    expect(strangerRead.statusCode).toBe(404);
    expect(strangerRead.json().error.code).toBe('NOT_FOUND');
    const vendorDetail = await call('GET', `/api/v1/vendor/orders/${row.id}`, ownerA.token, undefined, vendorHeaders());
    expect(vendorDetail.statusCode).toBe(200);
    expect(vendorDetail.json().data.id).toBe(row.id);
    expect(vendorDetail.json().data.pickupCode).toBeUndefined();
    expect(vendorDetail.json().data.pickupCodeAttempts).toBeUndefined();
    const board = await call('GET', '/api/v1/vendor/orders?limit=50', ownerA.token, undefined, vendorHeaders());
    expect(board.statusCode).toBe(200);
    const boardRow = (board.json().data as Array<{ id: string; pickupCode?: unknown }>).find((o) => o.id === row.id);
    expect(boardRow).toBeTruthy();
    expect(boardRow!.pickupCode).toBeUndefined();

    // The cart was consumed: a second checkout has nothing to buy.
    const cartAfter = await call('GET', '/api/v1/customer/cart', customer.token);
    expect(cartAfter.json().data).toBeNull();
    const fresh = await checkoutPickup(customer, `cust05-fresh-${nanoid(8)}`);
    expect(fresh.statusCode).toBe(400);
    expect(fresh.json().error.code).toBe('EMPTY_CART');
  });

  it('refuses a malformed selection, and the pickup-close route refuses a DELIVERY order', async () => {
    const customer = await makeCustomer('Tara');
    await fillCart(customer);

    // A malformed fulfillmentSelections is a validation error — and it must
    // not silently fall back to DELIVERY pricing.
    const malformed = await call('POST', '/api/v1/customer/checkout', customer.token, {
      paymentMethod: 'CASH',
      fulfillmentSelections: 'PICKUP',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('VALIDATION_ERROR');

    // The same basket placed as a DELIVERY order is not closable through the
    // pickup counter: the route refuses by fulfillment, not status.
    const delivered = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' }, { 'idempotency-key': `cust05-del-${nanoid(8)}` });
    expect(delivered.statusCode, delivered.body).toBe(200);
    const deliveryId = (delivered.json().data.order as { id: string }).id;
    await sys(() => app.prisma.order.update({ where: { id: deliveryId }, data: { holdExpiresAt: null } }));
    const notAPickup = await completePickup(deliveryId, '000000');
    expect(notAPickup.statusCode).toBe(400);
    expect(notAPickup.json().error.code).toBe('NOT_A_PICKUP');
    expect((await orderRow(deliveryId)).status).toBe('PENDING');
  });
});

describe('GOLD-6 · CUST-05 — wrong-code denial and the counter lockout', () => {
  it('a wrong code burns one attempt per try and locks after MAX tries; wrong parties are refused with exact codes', async () => {
    const customer = await makeCustomer('Vera');
    const { id, code } = await placePickupOrder(customer);
    await vendorStep(id, 'accept', 'ACCEPTED');
    await vendorStep(id, 'preparing', 'PREPARING');
    await vendorStep(id, 'ready', 'READY_FOR_PICKUP');

    // A coded order cannot be closed without the code.
    const missing = await completePickup(id, undefined);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('MISSING_PICKUP_CODE');

    // Wrong-party refusals: another store's owner gets an existence-free 404;
    // the customer has no vendor surface at all.
    const otherOwner = await completePickup(id, code, ownerB, { 'x-vendor-id': vendorBId });
    expect(otherOwner.statusCode).toBe(404);
    expect(otherOwner.json().error.code).toBe('NOT_FOUND');
    const customerTry = await completePickup(id, code, customer);
    expect(customerTry.statusCode).toBe(403);
    expect(customerTry.json().error.code).toBe('FORBIDDEN');
    expect((await orderRow(id)).pickupCodeAttempts).toBe(0);

    // Burn the whole real budget (MAX_HANDOVER_ATTEMPTS) with wrong codes:
    // every wrong try is refused, names the tries left off the real limit,
    // and is counted on the row BEFORE the comparison.
    for (let i = 0; i < MAX_HANDOVER_ATTEMPTS; i++) {
      const wrong = await completePickup(id, '000000');
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error.code).toBe('WRONG_PICKUP_CODE');
      expect(wrong.json().error.message).toContain(`${MAX_HANDOVER_ATTEMPTS - 1 - i} attempt(s) remaining`);
    }
    expect((await orderRow(id)).pickupCodeAttempts).toBe(MAX_HANDOVER_ATTEMPTS);

    // Now even the RIGHT code is refused — the budget is spent and the order
    // stays at the counter for support.
    const locked = await completePickup(id, code);
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.code).toBe('MAX_ATTEMPTS');
    expect((await orderRow(id))).toMatchObject({
      status: 'READY_FOR_PICKUP',
      pickupCodeAttempts: MAX_HANDOVER_ATTEMPTS,
    });
  });
});

describe('GOLD-6 · CUST-05 — counter completion with the right code', () => {
  it('accept → ready, the customer reads her code, one wrong try, then the right code completes the order terminally', async () => {
    const customer = await makeCustomer('Wendy');
    const { id, code } = await placePickupOrder(customer);

    // The counter cannot close an order the kitchen never made ready.
    const tooEarly = await completePickup(id, code);
    expect(tooEarly.statusCode).toBe(400);
    expect(tooEarly.json().error.code).toBe('INVALID_STATUS');

    await vendorStep(id, 'accept', 'ACCEPTED');
    await vendorStep(id, 'preparing', 'PREPARING');
    await vendorStep(id, 'ready', 'READY_FOR_PICKUP');

    // The customer reads her pickup code from the live order at the counter.
    const detail = await call('GET', `/api/v1/customer/orders/${id}`, customer.token);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data).toMatchObject({
      id,
      status: 'READY_FOR_PICKUP',
      fulfillment: 'PICKUP',
      pickupCode: code,
    });

    // One wrong try is refused and burned; the right code then completes.
    const wrong = await completePickup(id, '000000');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('WRONG_PICKUP_CODE');
    expect((await orderRow(id)).pickupCodeAttempts).toBe(1);

    const done = await completePickup(id, code);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().data.status).toBe('COMPLETED');

    // Durable terminal state: COMPLETED is terminal, the correct try counted
    // too, and the whole append-only chain is on the order.
    const row = await orderRow(id);
    expect(row.status).toBe('COMPLETED');
    expect(TERMINAL_ORDER_STATUSES).toContain(row.status);
    expect(row.pickupCodeAttempts).toBe(2);
    expect(row.readyAt).toBeInstanceOf(Date);
    const log = await statusLog(id);
    expect(log.map((l) => l.status)).toEqual(['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'COMPLETED']);
    expect(log[0]!.changedBy).toBe(customer.userId);
    expect(log[0]!.note).toBe('Order placed');
    expect(log[log.length - 1]!).toMatchObject({ changedBy: ownerA.userId, note: 'Picked up by customer' });

    // A completed order cannot be completed twice.
    const again = await completePickup(id, code);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('INVALID_STATUS');

    // The customer's own surfaces agree: not cancellable, timeline ends at
    // COMPLETED, and the vendor still holds no copy of the code.
    const after = await call('GET', `/api/v1/customer/orders/${id}`, customer.token);
    expect(after.json().data.status).toBe('COMPLETED');
    expect(after.json().data.canCancel).toBe(false);
    const timeline = after.json().data.timeline as Array<{ status: string }>;
    expect(timeline[timeline.length - 1]!.status).toBe('COMPLETED');
    const vendorDetail = await call('GET', `/api/v1/vendor/orders/${id}`, ownerA.token, undefined, vendorHeaders());
    expect(vendorDetail.json().data.status).toBe('COMPLETED');
    expect(vendorDetail.json().data.pickupCode).toBeUndefined();
  });
});
