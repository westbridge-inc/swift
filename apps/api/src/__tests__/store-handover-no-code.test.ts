import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type Order, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerTenantHeaderScope } from '../plugins/tenant-header-scope';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes, HANDED_TO_RIDER_NOTE } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { assignmentLogWhere } from '../modules/order/store-handover-log';
import { verifyHandoverDecision } from '../modules/handover/handover-decision';

// ---------------------------------------------------------------------------
// [O-2 · owner 22 Oct 2026, ruling 19:45Z] "Stores: no pickup code" — every
// store type. There is no rider pickup code; the code a store types is the
// TAKEAWAY code.
// - Takeaway: the code is OFF by default (requirePickupCode false). The store
//   checks the customer's first name + order number and taps "Handed to
//   customer" (the existing complete-pickup, no code). A code an older store
//   build still sends is verified exactly as before. A store may turn the
//   code on: then today's flow.
// - Delivery: the store taps "Handed to rider" (its card shows the rider's
//   photo, first name, vehicle and plate): one status-log row, no status
//   change. The rider's "Picked up" records the GPS distance to the store as
//   EVIDENCE ONLY — never a gate.
// Courier/parcel and taxi custody are untouched. Real routes, production composition.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920345';
const FIXTURE = 'store-flow-handover-no-code-fixture';
const DAY = 24 * 60 * 60 * 1000;
const STORE = { lat: 6.8013, lng: -58.1551 };
const HOME = { lat: 6.8045, lng: -58.1553 };

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type Rider = Actor & { riderId: string };
let customer: Actor;
let owner: Actor;
let vendorId: string;
let itemId: string;
const asStore = () => ({ 'x-vendor-id': vendorId });

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `Hand${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `o2-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

/** An onboarded, online rider; `at` is the rider's last known position (null = no fix on file). */
async function makeRider(firstName: string, at: { lat: number; lng: number } | null = STORE): Promise<Rider> {
  const actor = await makeUser(firstName, ['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: actor.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', vehicleMake: 'Honda', vehicleModel: 'CG125', vehicleColor: 'Red', licensePlate: 'CJ 1234',
      documentsVerified: true, isOnline: true, isAvailable: true,
      currentLat: at?.lat ?? null, currentLng: at?.lng ?? null, lastLocationUpdate: at ? new Date() : null,
      locationSessionId: actor.sessionId, floatLimit: 100_000,
    },
  }));
  return { ...actor, riderId: rider.id };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method, url,
    headers: { ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}
const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const logs = (orderId: string) => sys(() => app.prisma.orderStatusLog.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }));
const storeStep = async (orderId: string, step: string, expected: string) => {
  const res = await call('PUT', `/api/v1/vendor/orders/${orderId}/${step}`, owner.token, undefined, asStore());
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().data.status).toBe(expected);
};

async function placeOrder(fulfillment: 'PICKUP' | 'DELIVERY'): Promise<{ id: string; code: string | null }> {
  expect((await call('DELETE', '/api/v1/customer/cart', customer.token)).statusCode).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
  const body = fulfillment === 'PICKUP'
    ? { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } }
    : { paymentMethod: 'CASH' };
  const placed = await call('POST', '/api/v1/customer/checkout', customer.token, body, { 'idempotency-key': `o2-${nanoid(10)}` });
  expect(placed.statusCode, placed.body).toBe(200);
  const order = placed.json().data.order as { id: string; pickupCode?: string | null };
  await sys(() => app.prisma.order.update({ where: { id: order.id }, data: { holdExpiresAt: null } }));
  return { id: order.id, code: order.pickupCode ?? null };
}
const readyTakeaway = async () => {
  const order = await placeOrder('PICKUP');
  await storeStep(order.id, 'accept', 'PREPARING');
  await storeStep(order.id, 'ready', 'READY_FOR_PICKUP');
  return order;
};
const completePickup = (orderId: string, code?: string) =>
  call('PUT', `/api/v1/vendor/orders/${orderId}/complete-pickup`, owner.token, code === undefined ? {} : { code }, asStore());
const setCodeRequired = async (on: boolean) => {
  const res = await call('PUT', '/api/v1/vendor/profile', owner.token, { requirePickupCode: on }, asStore());
  expect(res.statusCode, res.body).toBe(200);
};
const handedToRider = (orderId: string) => call('PUT', `/api/v1/vendor/orders/${orderId}/handed-to-rider`, owner.token, undefined, asStore());
/** The customer's own order view (GET /customer/orders/:id). */
const customerDetail = async (orderId: string) => {
  const res = await call('GET', `/api/v1/customer/orders/${orderId}`, customer.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as Record<string, unknown> & { timeline: Array<{ status: string; note: string | null }>; vendor: Record<string, unknown> };
};
const storeDetail = async (orderId: string) => {
  const res = await call('GET', `/api/v1/vendor/orders/${orderId}`, owner.token, undefined, asStore());
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as Record<string, unknown> & { rider?: Record<string, unknown> & { user?: Record<string, unknown> } | null };
};
/** A delivery accepted by the store and taken by `rider`. */
async function riderOwnedDelivery(rider: Rider) {
  const order = await placeOrder('DELIVERY');
  await storeStep(order.id, 'accept', 'PREPARING');
  const grab = await call('POST', `/api/v1/rider/orders/${order.id}/accept`, rider.token, {});
  expect(grab.statusCode, grab.body).toBe(200);
  return order.id;
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } })).map((v) => v.id);
    const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }, { riderId: { in: riderIds } }] }, select: { id: true },
    })).map((o) => o.id);
    if (orderIds.length > 0) await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.earning.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
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
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  await purgeFixtures();

  customer = await makeUser('Asha', ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: '5 Handover Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME.lat, longitude: HOME.lng, isDefault: true },
  }));
  owner = await makeUser('Owner', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  vendorId = (await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: 'Handover Diner', slug: `o2-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}900`, addressLine1: '7 Handover Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
    },
  }))).id;
  const category = await sys(() => app.prisma.category.create({ data: { vendorId, name: 'Mains', sortOrder: 0 } }));
  itemId = (await sys(() => app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Pepperpot', basePrice: 2200, isAvailable: true } }))).id;
});

afterAll(async () => {
  try { await purgeFixtures(); } finally { await app.close(); }
});

describe('[O-2] takeaway: the pickup code is off by default, for every store', () => {
  it('a new store has the code off; "Handed to customer" completes a ready takeaway order with no code', async () => {
    expect((await sys(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }))).requirePickupCode).toBe(false);
    const order = await readyTakeaway();
    expect(await storeDetail(order.id)).toMatchObject({ pickupCodeRequired: false, orderNumber: expect.any(String), customer: { firstName: 'Asha' } });
    // [REVIEW-F S3-3] The customer's view says the store does not ask for the code (the code is still there
    // if an older store build asks); the store's own setting is not passed through as a store field.
    const mine = await customerDetail(order.id);
    expect(mine).toMatchObject({ pickupCodeRequired: false, pickupCode: expect.stringMatching(/^\d{6}$/) });
    expect(mine.vendor).not.toHaveProperty('requirePickupCode');
    const handed = await completePickup(order.id);
    expect(handed.statusCode, handed.body).toBe(200);
    expect((await orderRow(order.id)).status).toBe('COMPLETED');
    // [REVIEW-F S3-1] The record states only what the server knows: no code was asked for.
    expect((await logs(order.id)).at(-1)).toMatchObject({ status: 'COMPLETED', note: "Handed to the customer without a pickup code (the store's code is off)" });
  });

  it('[COORD ruling, G S4-3] an order locked by wrong-code guesses never completes without a code, even with the code off', async () => {
    const order = await readyTakeaway();
    await sys(() => app.prisma.order.update({ where: { id: order.id }, data: { pickupCodeAttempts: 5 } }));
    const res = await completePickup(order.id);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('MAX_ATTEMPTS');
    expect((await orderRow(order.id)).status).toBe('READY_FOR_PICKUP');
  });

  it('an older store build that still sends the code: the code is verified exactly as before (a wrong one refused)', async () => {
    const order = await readyTakeaway();
    expect(order.code).toMatch(/^\d{6}$/);
    const wrong = await completePickup(order.id, order.code === '000000' ? '111111' : '000000');
    expect(wrong.statusCode, wrong.body).toBe(400);
    expect(wrong.json().error.code).toBe('WRONG_PICKUP_CODE');
    expect((await orderRow(order.id)).status).toBe('READY_FOR_PICKUP');
    const right = await completePickup(order.id, order.code!);
    expect(right.statusCode, right.body).toBe(200);
    expect((await logs(order.id)).at(-1)).toMatchObject({ status: 'COMPLETED', note: 'Picked up by customer' });
  });

  it('a store that turns the code on gets today\'s flow: no code is refused, the right code completes', async () => {
    await setCodeRequired(true);
    try {
      const profile = await call('GET', '/api/v1/vendor/profile', owner.token, undefined, asStore());
      expect((profile.json().data.vendors as Array<{ id: string; requirePickupCode: boolean }>).find((v) => v.id === vendorId)?.requirePickupCode).toBe(true);
      const order = await readyTakeaway();
      expect(await storeDetail(order.id)).toMatchObject({ pickupCodeRequired: true });
      expect(await customerDetail(order.id)).toMatchObject({ pickupCodeRequired: true });
      const missing = await completePickup(order.id);
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.code).toBe('MISSING_PICKUP_CODE');
      expect((await completePickup(order.id, order.code!)).statusCode).toBe(200);
    } finally {
      await setCodeRequired(false);
    }
  });
});

describe('[O-2] the waiver is decided on the locked store row, not the route preview', () => {
  const lockedTx = (requirePickupCode: boolean) => ({
    vendor: { findUnique: async () => ({ requirePickupCode }) },
    order: { update: async () => ({}) },
  }) as unknown as Prisma.TransactionClient;
  const source = { id: 'o2-unit', vendorId: 'o2-store', pickupCode: 'stored-code-digest', pickupCodeAttempts: 0 } as unknown as Order;

  it('the store turned the code ON after the route read "off": no code is refused', async () => {
    const failure = await verifyHandoverDecision(lockedTx(true), source, { purpose: 'pickup', codeWaived: true });
    expect(failure?.handoverFailure.code).toBe('MISSING_PICKUP_CODE');
  });

  it('a locked order (MAX_ATTEMPTS) is refused even when the code is off', async () => {
    const locked = { ...source, pickupCodeAttempts: 5 } as unknown as Order;
    const failure = await verifyHandoverDecision(lockedTx(false), locked, { purpose: 'pickup', codeWaived: true });
    expect(failure?.handoverFailure.code).toBe('MAX_ATTEMPTS');
  });

  it('still off under the lock: no code needed', async () => {
    expect(await verifyHandoverDecision(lockedTx(false), source, { purpose: 'pickup', codeWaived: true })).toBeNull();
  });
});

describe('[O-2] delivery: the store taps "Handed to rider"; custody stays the rider\'s "Picked up"', () => {
  it('the card names the rider (photo resolved, first name, vehicle, plate); one tap writes one log row and moves nothing; a repeat is a 200 no-op', async () => {
    const rider = await makeRider('Ravi');
    // [REVIEW-G S4-1] A bare storage key (how production stores it): the card gets a signed URL, never the key.
    const AVATAR_KEY = 'avatars/o2-ravi.jpg';
    await sys(() => app.prisma.user.update({ where: { id: rider.userId }, data: { avatar: AVATAR_KEY } }));
    const orderId = await riderOwnedDelivery(rider);
    const before = await orderRow(orderId);
    const card = await storeDetail(orderId);
    expect(card).toMatchObject({ handedToRiderAt: null });
    expect(typeof card.rider?.photoUrl).toBe('string');
    expect(card.rider?.photoUrl).not.toBe(AVATAR_KEY);
    expect(card.rider?.photoUrl).toMatch(/\?.*(expires|signature)=/i); // a signed, expiring read of the private object
    expect(card.rider).toMatchObject({
      vehicleMake: 'Honda', vehicleModel: 'CG125', vehicleColor: 'Red', licensePlate: 'CJ 1234',
      user: { firstName: 'Ravi' },
    });
    expect(card.rider?.user).not.toHaveProperty('avatar'); // never the raw stored value

    // The dispatch journal counts assignment episodes by RIDER_ASSIGNED rows: the store's evidence row
    // (written while the order sits at RIDER_ASSIGNED) must never look like a second assignment.
    expect(before.status).toBe('RIDER_ASSIGNED');
    const episodes = () => sys(() => app.prisma.orderStatusLog.count({ where: assignmentLogWhere(orderId, 'RIDER_ASSIGNED') }));
    const episodesBefore = await episodes();
    expect(episodesBefore).toBe(1);

    const tap = await handedToRider(orderId);
    expect(tap.statusCode, tap.body).toBe(200);
    expect(await episodes()).toBe(episodesBefore);
    expect((await logs(orderId)).filter((l) => l.status === 'RIDER_ASSIGNED')).toHaveLength(2); // the assignment + the tap
    const at = tap.json().data.handedToRiderAt as string;
    expect(new Date(at).getTime()).toBeGreaterThan(0);
    const after = await orderRow(orderId);
    expect({ status: after.status, riderId: after.riderId }).toEqual({ status: before.status, riderId: rider.riderId });
    expect((await logs(orderId)).filter((l) => l.note === HANDED_TO_RIDER_NOTE)).toHaveLength(1);

    const again = await handedToRider(orderId);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.handedToRiderAt).toBe(at);
    expect((await logs(orderId)).filter((l) => l.note === HANDED_TO_RIDER_NOTE)).toHaveLength(1);
    expect(await storeDetail(orderId)).toMatchObject({ handedToRiderAt: at });
    const board = await call('GET', '/api/v1/vendor/orders', owner.token, undefined, asStore());
    expect((board.json().data as Array<{ id: string; handedToRiderAt: string | null }>).find((o) => o.id === orderId)?.handedToRiderAt).toBe(at);
  });

  it('no rider yet: the tap is refused with the reason; a takeaway order is never "handed to a rider"', async () => {
    const delivery = await placeOrder('DELIVERY');
    await storeStep(delivery.id, 'accept', 'PREPARING');
    const early = await handedToRider(delivery.id);
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json().error.code).toBe('NO_RIDER_YET');
    const takeaway = await readyTakeaway();
    const wrong = await handedToRider(takeaway.id);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('NOT_A_RIDER_DELIVERY');
  });

  it('a tap is per rider: after the rider hands the order back, the next rider\'s card is not "handed" and the tap is recorded again', async () => {
    const first = await makeRider('Ade');
    const orderId = await riderOwnedDelivery(first);
    expect((await handedToRider(orderId)).statusCode).toBe(200);
    const back = await call('POST', `/api/v1/rider/orders/${orderId}/handback`, first.token, { reason: 'bike trouble' });
    expect(back.statusCode, back.body).toBe(200);

    const next = await makeRider('Kemi');
    const grab = await call('POST', `/api/v1/rider/orders/${orderId}/accept`, next.token, {});
    expect(grab.statusCode, grab.body).toBe(200);
    expect(await storeDetail(orderId)).toMatchObject({ handedToRiderAt: null, rider: { user: { firstName: 'Kemi' } } });
    const tap = await handedToRider(orderId);
    expect(tap.statusCode, tap.body).toBe(200);
    expect((await logs(orderId)).filter((l) => l.note === HANDED_TO_RIDER_NOTE)).toHaveLength(2);
    expect(await storeDetail(orderId)).toMatchObject({ handedToRiderAt: tap.json().data.handedToRiderAt });
  });

  it('[REVIEW-G S4-2] the tap waits for the order lock: a handback committing first means "no rider yet", not a row', async () => {
    const rider = await makeRider('Lola');
    const orderId = await riderOwnedDelivery(rider);
    let locked!: () => void; const isLocked = new Promise<void>((r) => { locked = r; });
    let release!: () => void; const released = new Promise<void>((r) => { release = r; });
    // Another transition (a rider handing back) holds the order lock and clears the rider.
    const holder = sys(() => app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR UPDATE`;
      locked();
      await released;
      await tx.order.update({ where: { id: orderId }, data: { status: 'PREPARING', riderId: null } });
    }, { timeout: 20_000 }));
    await isLocked;
    const tap = handedToRider(orderId);
    await new Promise((r) => setTimeout(r, 400)); // the tap is now waiting on the lock
    release();
    await holder;
    const res = await tap;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('NO_RIDER_YET');
    expect((await logs(orderId)).some((l) => l.note === HANDED_TO_RIDER_NOTE)).toBe(false);
  });

  it('[REVIEW-G S4-4] a closed store cannot tap, like every other in-flight store action', async () => {
    const rider = await makeRider('Tari');
    const orderId = await riderOwnedDelivery(rider);
    await sys(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'CLOSED' } }));
    try {
      const res = await handedToRider(orderId);
      expect(res.statusCode, res.body).toBe(403);
      expect((await logs(orderId)).some((l) => l.note === HANDED_TO_RIDER_NOTE)).toBe(false);
    } finally {
      await sys(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'ACTIVE' } }));
    }
  });

  it('the rider\'s "Picked up" records the GPS distance to the store as evidence; a rider with no fix is never stopped', async () => {
    const near = await makeRider('Nia', STORE);
    await sys(() => app.prisma.user.update({ where: { id: near.userId }, data: { avatar: 'avatars/o2-nia.jpg' } }));
    const nearOrder = await riderOwnedDelivery(near);
    expect(typeof (await storeDetail(nearOrder)).rider?.photoUrl).toBe('string');
    expect((await handedToRider(nearOrder)).statusCode).toBe(200);
    for (const step of ['en-route-pickup', 'arrived-pickup', 'picked-up']) {
      const res = await call('PUT', `/api/v1/rider/orders/${nearOrder}/${step}`, near.token, {});
      expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
    }
    const picked = (await logs(nearOrder)).find((l) => l.status === 'PICKED_UP')!;
    expect(picked.note).toMatch(/^Rider confirmed collecting the order — .*\(0 m from the pickup, fix \d+s old\)$/);

    // [REVIEW-G S3-1] Once the rider has it, the store no longer gets the rider's photo (the name and
    // vehicle stay, like every other part of the card).
    const after = await storeDetail(nearOrder);
    expect(after.rider).toMatchObject({ photoUrl: null, user: { firstName: 'Nia' } });

    // [REVIEW-F S3-2] The customer's timeline: the store's tap is not a second "Rider assigned" step, and
    // the rider's position evidence never reaches the customer (the record keeps it, above).
    const timeline = (await customerDetail(nearOrder)).timeline;
    expect(timeline.filter((e) => e.status === 'RIDER_ASSIGNED')).toHaveLength(1);
    expect(timeline.some((e) => e.note === HANDED_TO_RIDER_NOTE)).toBe(false);
    expect(timeline.find((e) => e.status === 'PICKED_UP')?.note).toBe('Rider confirmed collecting the order');
    expect(timeline.find((e) => e.status === 'RIDER_ARRIVED_PICKUP')?.note).toBe('Rider reported arriving at pickup');
    expect(JSON.stringify(timeline)).not.toMatch(/gps:|GPS fix/);

    const blind = await makeRider('Bo', null);
    const blindOrder = await riderOwnedDelivery(blind);
    for (const step of ['en-route-pickup', 'arrived-pickup', 'picked-up']) {
      const res = await call('PUT', `/api/v1/rider/orders/${blindOrder}/${step}`, blind.token, {});
      expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
    }
    expect((await logs(blindOrder)).find((l) => l.status === 'PICKED_UP')!.note).toBe('Rider confirmed collecting the order — no GPS fix on file');
    expect((await customerDetail(blindOrder)).timeline.find((e) => e.status === 'PICKED_UP')?.note).toBe('Rider confirmed collecting the order');
  });
});
