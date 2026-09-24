import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerErrorHandler } from '../../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { customerRoutes } from '../../modules/user/customer.routes';
import { vendorRoutes } from '../../modules/vendor/vendor.routes';
import { riderRoutes } from '../../modules/rider/rider.routes';
import { adminRoutes } from '../../modules/admin/admin.routes';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../../lib/audit-immutability';
import { recordDispatchQueue } from '../helpers/dispatch-queue';

// ---------------------------------------------------------------------------
// GOLD-5 · ADMIN-05 — suspend, ban and reinstate, through the REAL mounted
// admin, rider, customer and vendor routes as real sessions, on real orders
// placed through the real checkout and offered by the real dispatch:
//
//   · an ISSUED OFFER meets a suspension: the card is retracted and the order
//     re-offered to the next mover, who takes it; the suspended mover's token
//     is refused everywhere (revocation) and a late tap on the old card fails
//   · an ACTIVE JOB refuses suspension (ACTIVE_JOB) and changes nothing; the
//     operator's cancel releases the mover, and the suspension then lands
//   · the wrong parties — a customer, another tenant's admin, a reasonless
//     call — are refused; a duplicate suspension is an honest 400
//   · REINSTATEMENT restores the account, never the supply: the same session
//     works again, but no work arrives until the mover taps GO; a duplicate
//     reinstatement is refused
//   · a BAN is a global revocation — sessions die, devices go silent — and
//     permanent; an ADMIN cannot ban another admin
//   · a suspended STORE refuses new orders and cannot work existing ones;
//     approval cannot reinstate it without its document checklist
//   · G5-F4 [it.fails] an ADMIN can permanently ban the SUPER_ADMIN
//
// Dispatch runs through the suite's acknowledged route→worker double
// (helpers/dispatch-queue.ts). Fixture range: +5920357nnn (this file only;
// audited range-aware).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920357';
const FIXTURE = 'gold5-admin-accounts-fixture';
const TENANT_SLUG_PREFIX = 'gold5-accounts-';
const TENANT_B = `${TENANT_SLUG_PREFIX}${nanoid(6).toLowerCase()}`;
const STORE_AT = { lat: 6.80131, lng: -58.15512 };
const HOME_AT = { lat: 6.80455, lng: -58.15533 };
// Riders at 0.5 km and 2 km from the store: the nearer is offered first.
const NEAR = { lat: 6.80580, lng: -58.15512 };
const FAR = { lat: 6.81930, lng: -58.15512 };
const REASON = { 'x-swift-reason': 'GOLD-5 golden journey: an operator acting on an account' };

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; phone: string };

async function makeUser(roles: UserRole[], activeRole: UserRole, opts: { tenantId?: string; admin?: boolean; firstName?: string } = {}): Promise<Actor> {
  seq += 1;
  const phone = `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone, firstName: opts.firstName ?? 'Gold5', lastName: `Acct${seq}`, roles, activeRole,
      tenantId: opts.tenantId ?? 'swift-default',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(opts.admin && { admin: { create: { permissions: ['*'] } } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `gold5-acct-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, phone };
}

async function makeRider(firstName: string, at: { lat: number; lng: number }) {
  const user = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER', { firstName });
  const rider = await sys(() => app.prisma.rider.create({ data: { userId: user.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000 } }));
  const go = await call('POST', '/api/v1/rider/go-online', user.token, { latitude: at.lat, longitude: at.lng });
  expect(go.statusCode, go.body).toBe(200);
  return { ...user, riderId: rider.id };
}

async function makeStore(name: string) {
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vendorOwner = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name, slug: `gold5-acct-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: owner.phone, addressLine1: '1 Golden Account Way', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE_AT.lat, longitude: STORE_AT.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 10,
    },
  }));
  const category = await sys(() => app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains', sortOrder: 0 } }));
  const item = await sys(() => app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Bake and saltfish', basePrice: 1500, isAvailable: true } }));
  return { vendorId: vendor.id, itemId: item.id, owner, name };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

function admin(options: InjectOptions & { token: string }) {
  const { token, headers, ...rest } = options;
  return app.inject({ ...rest, headers: { ...(headers as Record<string, string> | undefined), ...REASON, authorization: `Bearer ${token}` } });
}

async function fillCart(customer: Actor, store: { vendorId: string; itemId: string }) {
  const address = await sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: `${seq} Golden Account Street`, city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME_AT.lat, longitude: HOME_AT.lng, isDefault: true },
  }));
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: store.vendorId, itemId: store.itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBeLessThan(300);
  const addressed = await call('PUT', '/api/v1/customer/cart/address', customer.token, { addressId: address.id });
  expect(addressed.statusCode, addressed.body).toBe(200);
}

async function checkout(customer: Actor) {
  return call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' }, { 'idempotency-key': `gold5-acct-${nanoid(12)}` });
}

/** A real cash order, placed and accepted by the store (dispatch starts at accept). */
async function placeAcceptedOrder(customer: Actor, store: Awaited<ReturnType<typeof makeStore>>) {
  await fillCart(customer, store);
  const placed = await checkout(customer);
  expect(placed.statusCode, placed.body).toBe(200);
  const orderId = (placed.json().data.orders as Array<{ id: string }>)[0]!.id;
  const accepted = await call('PUT', `/api/v1/vendor/orders/${orderId}/accept`, store.owner.token, {});
  expect(accepted.statusCode, accepted.body).toBe(200);
  return orderId;
}

const userRow = (id: string) => sys(() => app.prisma.user.findUniqueOrThrow({ where: { id } }));
const riderRow = (id: string) => sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id } }));
const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const offerOwner = async (orderId: string) => (await app.redis.get(`dispatch:offer:${orderId}`))?.split(':')[0] ?? null;

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
      const ownerIds = (await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
      const vendorIds = (await app.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } })).map((v) => v.id);
      const orderIds = (await app.prisma.order.findMany({
        where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }, { riderId: { in: riderIds } }] },
        select: { id: true },
      })).map((o) => o.id);
      await app.prisma.privilegedApproval.deleteMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] } });
      await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: [...orderIds, ...ids, ...vendorIds] } }] }, 'test-cleanup:gold-5-admin-accounts fixtures');
      await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: ids } }, 'test-cleanup:gold-5-admin-accounts fixture reads');
      await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
      await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
      await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds] } } });
      await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
      await app.prisma.batchEvaluation.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
      await app.prisma.earning.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
      await app.prisma.moverRevocationOutbox.deleteMany({ where: { userId: { in: ids } } });
      if (orderIds.length > 0) {
        await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
      }
      await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.deviceToken.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
      await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.subscription.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
      await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await app.prisma.tenant.deleteMany({ where: { slug: { startsWith: TENANT_SLUG_PREFIX } } });
  });
}

/** Admin audit and sensitive-read rows are written in onResponse hooks, which
 *  can land just after a response resolves: sweep them once more by the ids
 *  this file created, after a moment, so the last request cannot outrun the
 *  purge. */
async function sweepLateAuditRows(ids: string[], reason: string) {
  if (ids.length === 0) return;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await sys(async () => {
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] }, reason);
    await purgeSensitiveReadLogs(app.prisma, { OR: [{ actorUserId: { in: ids } }, { subjectId: { in: ids } }] }, reason);
  });
}

/** Every id this file's fixtures own right now (users, their stores and orders). */
async function fixtureIds(): Promise<string[]> {
  return sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const vendors = await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } });
    const orders = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendors.map((v) => v.id) } }] }, select: { id: true } });
    return [...ids, ...vendors.map((v) => v.id), ...orders.map((o) => o.id)];
  });
}

let redisKeysBefore = new Set<string>();
async function allRedisKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    for (const k of batch) keys.add(k);
  } while (cursor !== '0');
  return keys;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app, true);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await purgeFixtures();
  redisKeysBefore = await allRedisKeys();
  await sys(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'Gold5 Accounts Tenant B', slug: TENANT_B } }));
}, 60_000);

afterAll(async () => {
  // Movers left online would be offered another file's work.
  const online = await sys(() => app.prisma.rider.findMany({ where: { user: { phone: { startsWith: PHONE_PREFIX } }, isOnline: true }, select: { userId: true } }));
  for (const r of online) {
    const session = await sys(() => app.prisma.session.findFirst({ where: { userId: r.userId }, select: { token: true } }));
    if (session) await call('POST', '/api/v1/rider/go-offline', session.token, {});
  }
  const owned = await fixtureIds();
  await purgeFixtures();
  await sweepLateAuditRows(owned, 'test-cleanup:gold-5-accounts late audit rows');
  const now = await allRedisKeys();
  const added = [...now].filter((k) => !redisKeysBefore.has(k));
  if (added.length > 0) await app.redis.del(...added);
  await app.close();
}, 60_000);

describe('GOLD-5 · ADMIN-05 — suspend, ban and reinstate', () => {
  let ops: Actor;
  let opsB: Actor;
  let customer: Actor;
  let store: Awaited<ReturnType<typeof makeStore>>;
  let asha: Awaited<ReturnType<typeof makeRider>>;
  let bola: Awaited<ReturnType<typeof makeRider>>;
  let o1 = '';

  beforeAll(async () => {
    ops = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Omari' });
    opsB = await makeUser(['ADMIN'], 'ADMIN', { admin: true, tenantId: TENANT_B, firstName: 'Beatrix' });
    customer = await makeUser(['CUSTOMER'], 'CUSTOMER', { firstName: 'Celeste' });
    store = await makeStore('Gold5 Account Kitchen');
    asha = await makeRider('Asha', NEAR);
    bola = await makeRider('Bola', FAR);
  }, 60_000);

  it('an ISSUED OFFER meets a suspension: the card is retracted, the order re-offered to the next mover, who takes it; the suspended mover is refused everywhere', async () => {
    o1 = await placeAcceptedOrder(customer, store);
    expect(await offerOwner(o1)).toBe(asha.riderId); // the nearer mover holds the live card
    const card = (await call('GET', '/api/v1/rider/offers/current', asha.token)).json().data.offer as { orderId: string; offerAttemptId: string };
    expect(card.orderId).toBe(o1);

    const reason = 'Reported for riding without a helmet twice this week';
    const suspended = await app.inject({ method: 'PUT', url: `/api/v1/admin/users/${asha.userId}/suspend`, payload: { reason }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(suspended.statusCode, suspended.body).toBe(200);
    const user = await userRow(asha.userId);
    expect(user.status).toBe('SUSPENDED');
    const r = await riderRow(asha.riderId);
    expect({ online: r.isOnline, available: r.isAvailable, owner: r.locationSessionId }).toEqual({ online: false, available: false, owner: null });
    const trail = await sys(() => app.prisma.auditLog.findMany({ where: { entityId: asha.userId, action: 'SUSPEND_USER' } }));
    expect(trail.map((t) => ({ by: t.userId, changes: t.changes }))).toEqual([{ by: ops.userId, changes: { previousStatus: 'ACTIVE', reason } }]);
    const told = await sys(() => app.prisma.notification.findMany({ where: { userId: asha.userId, title: 'Account Suspended' } }));
    expect(told.map((n) => n.body)).toEqual([reason]);

    // The card moved on: retracted from the suspended mover, offered to the next.
    expect(await offerOwner(o1)).toBe(bola.riderId);
    // REVOCATION: the suspended mover's still-signed token opens nothing, and
    // a late tap on the old card cannot claim the order.
    const late = await call('POST', '/api/v1/rider/offers/accept', asha.token, { orderId: o1, offerAttemptId: card.offerAttemptId });
    expect(late.statusCode).toBe(401);
    for (const [method, url] of [['GET', '/api/v1/rider/offers/current'], ['POST', '/api/v1/rider/go-online'], ['GET', '/api/v1/customer/orders']] as const) {
      expect((await call(method, url, asha.token, method === 'POST' ? { latitude: NEAR.lat, longitude: NEAR.lng } : undefined)).statusCode, `${method} ${url}`).toBe(401);
    }
    expect(await sys(() => app.prisma.session.count({ where: { userId: asha.userId } }))).toBe(1); // suspension is not a ban

    const offered = (await call('GET', '/api/v1/rider/offers/current', bola.token)).json().data.offer as { orderId: string; offerAttemptId: string };
    expect(offered.orderId).toBe(o1);
    const taken = await call('POST', '/api/v1/rider/offers/accept', bola.token, { orderId: o1, offerAttemptId: offered.offerAttemptId });
    expect(taken.statusCode, taken.body).toBe(200);
    const assigned = await orderRow(o1);
    expect({ status: assigned.status, rider: assigned.riderId }).toEqual({ status: 'RIDER_ASSIGNED', rider: bola.riderId });
  });

  it('an ACTIVE JOB refuses suspension and changes nothing; the operator’s cancel releases the mover and the suspension then lands', async () => {
    expect(o1, 'the offer test assigned the order').not.toBe('');
    const reason = 'Customer complaint about rudeness at the door';
    const refused = await app.inject({ method: 'PUT', url: `/api/v1/admin/users/${bola.userId}/suspend`, payload: { reason }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('ACTIVE_JOB');
    expect((await userRow(bola.userId)).status).toBe('ACTIVE');
    const busy = await riderRow(bola.riderId);
    expect({ online: busy.isOnline, owner: busy.locationSessionId !== null }).toEqual({ online: true, owner: true });
    expect((await orderRow(o1))).toMatchObject({ status: 'RIDER_ASSIGNED', riderId: bola.riderId });
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: bola.userId, action: 'SUSPEND_USER' } }))).toBe(0);

    // The operator resolves the job first: the order is cancelled and the mover freed.
    const cancel = await app.inject({ method: 'PUT', url: `/api/v1/admin/orders/${o1}/cancel`, payload: { reason: 'Store closed early; releasing the rider before a suspension' }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((await orderRow(o1)).status).toBe('CANCELLED');
    const freed = await app.inject({ method: 'PUT', url: `/api/v1/admin/users/${bola.userId}/suspend`, payload: { reason }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(freed.statusCode, freed.body).toBe(200);
    expect((await userRow(bola.userId)).status).toBe('SUSPENDED');
    const retired = await riderRow(bola.riderId);
    expect({ online: retired.isOnline, available: retired.isAvailable, owner: retired.locationSessionId }).toEqual({ online: false, available: false, owner: null });
  });

  it('the wrong parties are refused and a duplicate suspension is an honest 400; nothing moves', async () => {
    const before = await userRow(asha.userId);
    expect((await call('PUT', `/api/v1/admin/users/${asha.userId}/unsuspend`, customer.token, { reason: 'A customer trying to restore a rider' })).statusCode).toBe(403);
    expect((await call('PUT', `/api/v1/admin/users/${customer.userId}/suspend`, store.owner.token, { reason: 'A store trying to suspend a customer' })).statusCode).toBe(403);
    expect((await admin({ method: 'PUT', url: `/api/v1/admin/users/${asha.userId}/unsuspend`, token: opsB.token, payload: {} })).statusCode).toBe(404);
    expect((await admin({ method: 'PUT', url: `/api/v1/admin/users/${customer.userId}/suspend`, token: opsB.token, payload: {} })).statusCode).toBe(404);
    const noReason = await app.inject({ method: 'PUT', url: `/api/v1/admin/users/${asha.userId}/unsuspend`, payload: {}, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(noReason.statusCode).toBe(400);
    const again = await admin({ method: 'PUT', url: `/api/v1/admin/users/${asha.userId}/suspend`, token: ops.token, payload: {} });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('ALREADY_SUSPENDED');
    const after = await userRow(asha.userId);
    expect({ status: after.status, updatedAt: after.updatedAt }).toEqual({ status: before.status, updatedAt: before.updatedAt });
    expect((await userRow(customer.userId)).status).toBe('ACTIVE');
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: asha.userId, action: { in: ['SUSPEND_USER', 'UNSUSPEND_USER'] } } }))).toBe(1);
  });

  it('REINSTATEMENT restores the account, never the supply: the same session works again, but work arrives only after GO', async () => {
    const restored = await admin({ method: 'PUT', url: `/api/v1/admin/users/${asha.userId}/unsuspend`, token: ops.token, payload: {} });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await userRow(asha.userId)).status).toBe('ACTIVE');
    const r = await riderRow(asha.riderId);
    expect({ online: r.isOnline, available: r.isAvailable, owner: r.locationSessionId }).toEqual({ online: false, available: false, owner: null });
    expect((await sys(() => app.prisma.notification.findMany({ where: { userId: asha.userId, title: 'Account Restored' } }))).map((n) => n.body)).toEqual(['Your account has been reinstated. Welcome back!']);
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: asha.userId, action: 'UNSUSPEND_USER', userId: ops.userId } }))).toBe(1);

    // The same token opens the app again…
    const current = await call('GET', '/api/v1/rider/offers/current', asha.token);
    expect(current.statusCode).toBe(200);
    expect(current.json().data.offer).toBeNull();
    // …but a new order is not offered to a mover who has not tapped GO.
    const o2 = await placeAcceptedOrder(customer, store);
    expect(await offerOwner(o2)).toBeNull();
    // GO, then the operator's retry offers it — to her.
    const go = await call('POST', '/api/v1/rider/go-online', asha.token, { latitude: NEAR.lat, longitude: NEAR.lng });
    expect(go.statusCode, go.body).toBe(200);
    const retry = await admin({ method: 'POST', url: `/api/v1/admin/orders/${o2}/retry-dispatch`, token: ops.token, payload: {} });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(await offerOwner(o2)).toBe(asha.riderId);

    const twice = await admin({ method: 'PUT', url: `/api/v1/admin/users/${asha.userId}/unsuspend`, token: ops.token, payload: {} });
    expect(twice.statusCode).toBe(400);
    expect(twice.json().error.code).toBe('NOT_SUSPENDED');
    const off = await call('POST', '/api/v1/rider/go-offline', asha.token, {});
    expect(off.statusCode, off.body).toBe(200);
  });

  it('a BAN is a global revocation — sessions die, devices go silent — and permanent; an ADMIN cannot ban another admin', async () => {
    const target = await makeUser(['CUSTOMER'], 'CUSTOMER', { firstName: 'Tobias' });
    const device = `ExponentPushToken[g5ban${nanoid(16)}]`;
    expect((await call('POST', '/api/v1/customer/notifications/devices', target.token, { token: device, platform: 'ios' })).statusCode).toBe(200);
    const reason = 'Confirmed fraud: three chargebacks with fake receipts';
    const banned = await app.inject({ method: 'PUT', url: `/api/v1/admin/users/${target.userId}/ban`, payload: { reason }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(banned.statusCode, banned.body).toBe(200);
    expect((await userRow(target.userId)).status).toBe('BANNED');
    expect(await sys(() => app.prisma.session.count({ where: { userId: target.userId } }))).toBe(0);
    expect((await sys(() => app.prisma.deviceToken.findUniqueOrThrow({ where: { token: device } }))).isActive).toBe(false);
    expect((await call('GET', '/api/v1/customer/orders', target.token)).statusCode).toBe(401);
    const trail = await sys(() => app.prisma.auditLog.findMany({ where: { entityId: target.userId, action: 'BAN_USER' } }));
    expect(trail.map((t) => ({ by: t.userId, changes: t.changes }))).toEqual([{ by: ops.userId, changes: { previousStatus: 'ACTIVE', reason } }]);
    // Permanent: the reinstatement door does not open for a ban, and a repeat is refused.
    const unban = await admin({ method: 'PUT', url: `/api/v1/admin/users/${target.userId}/unsuspend`, token: ops.token, payload: {} });
    expect(unban.statusCode).toBe(400);
    expect(unban.json().error.code).toBe('NOT_SUSPENDED');
    const rebanned = await admin({ method: 'PUT', url: `/api/v1/admin/users/${target.userId}/ban`, token: ops.token, payload: {} });
    expect(rebanned.statusCode).toBe(400);
    expect(rebanned.json().error.code).toBe('ALREADY_BANNED');
    expect((await userRow(target.userId)).status).toBe('BANNED');

    const colleague = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Cyril' });
    const peer = await admin({ method: 'PUT', url: `/api/v1/admin/users/${colleague.userId}/ban`, token: ops.token, payload: {} });
    expect(peer.statusCode).toBe(403);
    expect((await userRow(colleague.userId)).status).toBe('ACTIVE');
    expect(await sys(() => app.prisma.session.count({ where: { userId: colleague.userId } }))).toBe(1);
  });

  it('a suspended STORE refuses new orders and cannot work existing ones; approval cannot reinstate it without its checklist', async () => {
    const shopper = await makeUser(['CUSTOMER'], 'CUSTOMER', { firstName: 'Samir' });
    await fillCart(shopper, store);
    const pendingPlaced = await checkout(shopper);
    expect(pendingPlaced.statusCode, pendingPlaced.body).toBe(200);
    const pendingId = (pendingPlaced.json().data.orders as Array<{ id: string }>)[0]!.id;
    const other = await makeUser(['CUSTOMER'], 'CUSTOMER', { firstName: 'Nia' });
    await fillCart(other, store); // a cart holding the store's item, before the suspension

    const reason = 'Food safety inspection failed; closed pending re-inspection';
    const suspend = await app.inject({ method: 'PUT', url: `/api/v1/admin/vendors/${store.vendorId}/suspend`, payload: { reason }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(suspend.statusCode, suspend.body).toBe(200);
    const vendor = await sys(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: store.vendorId } }));
    expect({ status: vendor.status, accepting: vendor.acceptingOrders, source: vendor.suspensionSource }).toEqual({ status: 'SUSPENDED', accepting: false, source: 'ADMIN' });
    expect((await sys(() => app.prisma.auditLog.findMany({ where: { entityId: store.vendorId, action: 'SUSPEND_VENDOR' } }))).map((t) => ({ by: t.userId, reason: (t.changes as Record<string, unknown>)['reason'] }))).toEqual([{ by: ops.userId, reason }]);
    expect((await sys(() => app.prisma.notification.findMany({ where: { userId: store.owner.userId, title: 'Vendor Suspended' } }))).map((n) => n.body)).toEqual([reason]);

    // New orders are refused, from an empty cart and from a full one.
    const add = await call('POST', '/api/v1/customer/cart/items', shopper.token, { vendorId: store.vendorId, itemId: store.itemId, quantity: 1 });
    expect(add.statusCode).toBe(400);
    expect(add.json().error.code).toBe('VENDOR_UNAVAILABLE');
    const ordersBefore = await sys(() => app.prisma.order.count({ where: { vendorId: store.vendorId } }));
    const placed = await checkout(other);
    expect(placed.statusCode).toBe(400);
    expect(placed.json().error.code).toBe('VENDOR_CLOSED');
    expect(await sys(() => app.prisma.order.count({ where: { vendorId: store.vendorId } }))).toBe(ordersBefore);
    // The store cannot drive the order it already had.
    const accept = await call('PUT', `/api/v1/vendor/orders/${pendingId}/accept`, store.owner.token, {});
    expect(accept.statusCode).toBe(403);
    expect(accept.json().error.code).toBe('VENDOR_SUSPENDED');
    expect((await orderRow(pendingId)).status).toBe('PENDING');
    // …and cannot lift the operator's suspension itself.
    const reopen = await call('PUT', '/api/v1/vendor/vendor/toggle-orders', store.owner.token, {});
    expect(reopen.statusCode).toBe(409);
    expect(reopen.json().error.code).toBe('VENDOR_NOT_ACTIVE');
    const still = await sys(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: store.vendorId } }));
    expect({ status: still.status, accepting: still.acceptingOrders }).toEqual({ status: 'SUSPENDED', accepting: false });

    // Reinstatement confirms evidence; it cannot substitute for it.
    const approve = await admin({ method: 'PUT', url: `/api/v1/admin/vendors/${store.vendorId}/approve`, token: ops.token, payload: {} });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error.code).toBe('CHECKLIST_INCOMPLETE');
    expect((await sys(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: store.vendorId } }))).status).toBe('SUSPENDED');
  });
});

// ---------------------------------------------------------------------------
// G5-F4 — an ADMIN can permanently ban the SUPER_ADMIN
// ---------------------------------------------------------------------------
//
// admin.routes.ts `PUT /users/:id/ban` guards "banning other admins unless
// SUPER_ADMIN" with `user.roles.includes('ADMIN')`. A SUPER_ADMIN's roles
// (the seeded founder's are ['SUPER_ADMIN', 'CUSTOMER']) do not contain
// 'ADMIN', so an ordinary ADMIN passes the guard, bans the platform owner,
// deletes every one of their sessions — and there is no unban route. The
// fixtures are made in beforeAll, so this can only fail on the ban itself.
describe('GOLD-5 · ADMIN-05 — G5-F4', () => {
  let ops: Actor;
  let founder: Actor;

  beforeAll(async () => {
    ops = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Orla' });
    founder = await makeUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { admin: true, firstName: 'Faye' });
    expect((await userRow(founder.userId)).status).toBe('ACTIVE');
  });

  it.fails('[G5-F4] an ADMIN cannot ban the SUPER_ADMIN, and the owner keeps their sessions', async () => {
    const ban = await admin({ method: 'PUT', url: `/api/v1/admin/users/${founder.userId}/ban`, token: ops.token, payload: {} });
    expect(ban.statusCode).toBe(403);
    expect((await userRow(founder.userId)).status).toBe('ACTIVE');
    expect(await sys(() => app.prisma.session.count({ where: { userId: founder.userId } }))).toBe(1);
  });
});
