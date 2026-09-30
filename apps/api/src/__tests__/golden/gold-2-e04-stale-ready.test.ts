import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
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
import { riderRoutes } from '../../modules/rider/rider.routes';

// ---------------------------------------------------------------------------
// GOLD-2 · RIDE-04 — [E04] a stale "ready"/"preparing" cannot land on a
// cancelled order. The kitchen's milestone timestamps (readyAt/preparingAt)
// are the alternate representation of kitchen progress while a rider owns the
// status lane (RIDER_ASSIGNED / *_EN_ROUTE_PICKUP / *_ARRIVED_PICKUP), and the
// vendor route wrote them with an UNCONDITIONAL update after an unguarded
// read. Cancel-first meant the stale tap answered 200, stamped readyAt onto the
// CANCELLED order, appended a "ready" row AFTER the CANCELLED status row and
// pushed the freed rider.
//
// The race is forced through the real routes: the milestone write is held at
// a deterministic seam between the route's order read and its write — the
// `assertVendorCanOperate` read of the vendor's subscription — until the
// customer's cancellation has committed (the rider is freed), then released.
// On the fix the write and the status-log append share one transaction on the
// order-row lock, so the lost race answers 409 and writes nothing — no
// timestamp, no status row, no push. The seam exists on main and on the fix,
// so this file is red on main at the assertions and green on the fix.
// ---------------------------------------------------------------------------

// This file's own fixture block (+5920325nnn, 11 characters); phones and the
// crash-recovery purge share this ONE constant. Audited against every phone
// literal and random range under apps/api/src: the gold-2 family owns
// +5920321 (orders), +5920322 (mmg), +5920323 (rides), +5920324 (money).
const PHONE_PREFIX = '+5920325';
const FIXTURE = 'e04-stale-ready-fixture';
const DAY = 24 * 60 * 60 * 1000;
const STORE = { lat: 6.8013, lng: -58.1551 };

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type Rider = Actor & { riderId: string };
let customer: Actor;
let owner: Actor;
let vendorId: string;
let itemId: string;
const vendorHeaders = () => ({ 'x-vendor-id': vendorId });

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName,
      lastName: `Stale${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      authMethod: 'OTP',
      deviceId: `e04-${seq}`,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

/** An onboarded, online rider at the store. */
async function makeRider(firstName: string): Promise<Rider> {
  const actor = await makeUser(firstName, ['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: actor.userId,
      riderType: 'BOTH',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      isOnline: true,
      isAvailable: true,
      currentLat: STORE.lat,
      currentLng: STORE.lng,
      lastLocationUpdate: new Date(),
      locationSessionId: actor.sessionId,
      floatLimit: 100_000,
    },
  }));
  return { ...actor, riderId: rider.id };
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

async function placeCashOrder(): Promise<{ id: string }> {
  expect((await call('DELETE', '/api/v1/customer/cart', customer.token)).statusCode).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
  const placed = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' }, { 'idempotency-key': `e04-${nanoid(10)}` });
  expect(placed.statusCode, placed.body).toBe(200);
  const id = placed.json().data.order.id as string;
  // [E04 fixture] LIFECYCLE_V2: checkout may stamp holdExpiresAt (the order is
  // then hidden from the vendor and rider accept answers ORDER_HELD). This
  // suite exercises the stale-screen race, not the hold window — clear the hold
  // so it behaves identically under LIFECYCLE_V2=0/1.
  await sys(() => app.prisma.order.update({ where: { id }, data: { holdExpiresAt: null } }));
  return { id };
}

async function vendorStep(orderId: string, step: 'accept', expected: string) {
  const res = await call('PUT', `/api/v1/vendor/orders/${orderId}/${step}`, owner.token, undefined, vendorHeaders());
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().data.status).toBe(expected);
}

const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const riderRow = (id: string) => sys(() => app.prisma.rider.findUniqueOrThrow({
  where: { id }, select: { currentOrderId: true, isAvailable: true },
}));
const statusLog = (orderId: string) => sys(() => app.prisma.orderStatusLog.findMany({
  where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { status: true, note: true },
}));

/**
 * Hold the route between its order read and its write until the customer's
 * cancellation has committed (the rider is freed), then release it and return
 * the route's pending response. The seam is the vendor-operability check's
 * subscription read inside `assertVendorCanOperate`: it runs on BOTH main and
 * the fix, strictly after `resolveOwnedOrder` has read the order as
 * RIDER_ASSIGNED with an empty milestone and strictly before the milestone
 * write (main's autocommit `order.update` / the fix's locked transaction).
 */
async function staleMilestoneAgainstCancellation(
  orderId: string,
  vendorCall: () => Promise<LightMyRequestResponse>,
): Promise<LightMyRequestResponse> {
  let atSeam!: () => void;
  let release!: () => void;
  let held = false;
  const reached = new Promise<void>((resolve) => { atSeam = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delegate = app.prisma.subscription;
  const realFindFirst = delegate.findFirst.bind(delegate);
  const spy = vi.spyOn(delegate, 'findFirst').mockImplementation((async (args: Parameters<typeof realFindFirst>[0]) => {
    if (!held && (args?.where as { vendorId?: string } | undefined)?.vendorId === vendorId) {
      held = true;
      atSeam();
      await gate;
    }
    return realFindFirst(args);
  }) as never);
  try {
    const pending = vendorCall();
    await Promise.race([
      reached,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the vendor route never reached the pre-write seam')), 10_000)),
    ]);
    const cancelled = await call('POST', `/api/v1/customer/orders/${orderId}/cancel`, customer.token, { reason: 'Plans changed' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await orderRow(orderId)).status).toBe('CANCELLED');
    release();
    return await pending;
  } finally {
    release();
    spy.mockRestore();
  }
}

/** Accept + rider-grab an order into the rider-owned lane with no timestamps. */
async function riderOwnedOrder(rider: Rider): Promise<string> {
  const orderId = (await placeCashOrder()).id;
  await vendorStep(orderId, 'accept', 'ACCEPTED');
  const grab = await call('POST', `/api/v1/rider/orders/${orderId}/accept`, rider.token, {});
  expect(grab.statusCode, grab.body).toBe(200);
  const row = await orderRow(orderId);
  expect(row).toMatchObject({ status: 'RIDER_ASSIGNED', riderId: rider.riderId });
  expect(row.readyAt).toBeNull();
  expect(row.preparingAt).toBeNull();
  return orderId;
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } })).map((v) => v.id);
    const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }, { riderId: { in: riderIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    if (orderIds.length > 0) {
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.reimbursementClaim.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    await app.prisma.strike.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }] } });
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
    await purgeRedis([...ids, ...vendorIds, ...riderIds, ...orderIds]);
  });
}

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

  customer = await makeUser('Dora', ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: {
      userId: customer.userId,
      label: 'Home',
      addressLine1: '44 Door Street',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.8045,
      longitude: -58.1553,
      isDefault: true,
    },
  }));
  owner = await makeUser('Kwame', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id,
      name: 'Stale Door Diner',
      slug: `e04-diner-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}900`,
      addressLine1: '6 Door Lane',
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
  vendorId = vendor.id;
  const category = await sys(() => app.prisma.category.create({ data: { vendorId, name: 'Mains', sortOrder: 0 } }));
  itemId = (await sys(() => app.prisma.item.create({
    data: { vendorId, categoryId: category.id, name: 'Door Pepperpot', basePrice: 2200, isAvailable: true },
  }))).id;
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('GOLD-2 · RIDE-04 — [E04] a stale kitchen milestone cannot land on a cancelled order', () => {
  it('the "ready" that lost the race is refused: no readyAt, no "ready" row after CANCELLED, no push to the freed rider', async () => {
    const rider = await makeRider('Eli');
    const orderId = await riderOwnedOrder(rider);

    const ready = await staleMilestoneAgainstCancellation(
      orderId,
      () => call('PUT', `/api/v1/vendor/orders/${orderId}/ready`, owner.token, undefined, vendorHeaders()),
    );

    expect(ready.statusCode, ready.body).toBe(409);
    expect(ready.json().error.code).toBe('HANDOVER_STALE');
    expect((await orderRow(orderId)).readyAt).toBeNull();
    const log = await statusLog(orderId);
    expect(log[log.length - 1]!.status).toBe('CANCELLED');
    const pushed = await sys(() => app.prisma.notification.count({
      where: { userId: rider.userId, data: { path: ['kind'], equals: 'prep_ready' } },
    }));
    expect(pushed).toBe(0);
    expect(await riderRow(rider.riderId)).toEqual({ currentOrderId: null, isAvailable: true });
  });

  it('the "preparing" that lost the race is refused: no preparingAt, no "preparing" row after CANCELLED', async () => {
    const rider = await makeRider('Nia');
    const orderId = await riderOwnedOrder(rider);

    const preparing = await staleMilestoneAgainstCancellation(
      orderId,
      () => call('PUT', `/api/v1/vendor/orders/${orderId}/preparing`, owner.token, undefined, vendorHeaders()),
    );

    expect(preparing.statusCode, preparing.body).toBe(409);
    expect(preparing.json().error.code).toBe('HANDOVER_STALE');
    expect((await orderRow(orderId)).preparingAt).toBeNull();
    const log = await statusLog(orderId);
    expect(log[log.length - 1]!.status).toBe('CANCELLED');
    expect(await riderRow(rider.riderId)).toEqual({ currentOrderId: null, isAvailable: true });
  });
});
