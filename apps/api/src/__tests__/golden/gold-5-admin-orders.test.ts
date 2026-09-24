import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { sweepFoodAge, FOOD_TOO_OLD_PAID_HELD_OUTCOME, ALGO_ID as RESCUE_ALGO } from '../../modules/dispatch/rescue';
import { NotificationService } from '../../modules/notification/notification.service';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../../lib/audit-immutability';
import { recordDispatchQueue } from '../helpers/dispatch-queue';

// ---------------------------------------------------------------------------
// GOLD-5 · ADMIN-02 / ADMIN-03 — the operator's order desk, through the REAL
// mounted customer, vendor, rider and admin routes as real sessions, on real
// orders placed through the real checkout, asserted on durable rows:
//
//   ADMIN-02  a PAID direct-MMG order waits ready with no rider past the
//             food-age cutoff; the worker's own sweep HOLDS it (never cancels
//             paid money) and pages ops; the held queue shows it; customers,
//             stores and another tenant's admin are refused the doors; retry
//             answers ORDER_HELD_FOR_REVIEW and a rider cannot grab it; the
//             release waives the cutoff durably, re-dispatches, a later sweep
//             does not re-hold it, the online rider is offered it and accepts;
//             a second release is an honest 409.
//   ADMIN-03  an admin cancel records a refund OBLIGATION, never a refund;
//             closing it is a C4 money action: a stated reason, then a second
//             admin — the requester cannot approve themself, a spent approval
//             cannot be re-used, an approval cannot be re-aimed at another
//             body — and the settle is checked against the obligation: a
//             wrong amount is refused (the approval is burnt, nothing moves),
//             the exact amount closes it once, a duplicate is refused, one
//             handover reference cannot settle two orders, and every settled
//             refund reconciles to one obligation, one payment, one status
//             line and one audit record.
//   G5-F5     [it.fails] the second admin approves blind: the approvals
//             queue never shows the amount or the handover reference.
//
// Two-person approvals use two named admins: the requester and a DIFFERENT
// approver, both halves proved. Dispatch runs through the suite's acknowledged
// route→worker double (helpers/dispatch-queue.ts); the food-age sweep is the
// worker's own sweepFoodAge with the worker's dependencies. The one aging
// input moved is the order's readyAt (the cutoff is 45 minutes of real time).
//
// Fixture range: +5920355nnn (this file only; audited range-aware).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920355';
const FIXTURE = 'gold5-admin-orders-fixture';
const TENANT_SLUG_PREFIX = 'gold5-orders-';
const TENANT_B = `${TENANT_SLUG_PREFIX}${nanoid(6).toLowerCase()}`;
const STORE_AT = { lat: 6.80131, lng: -58.15512 };
const HOME_AT = { lat: 6.80455, lng: -58.15533 };
const PAY_HOST = 'pay.example.com';
const REASON = { 'x-swift-reason': 'GOLD-5 golden journey: an operator acting on a live order' };

let app: FastifyInstance;
let seq = 0;
let windowStart: Date | null = null;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; phone: string };

async function makeUser(roles: UserRole[], activeRole: UserRole, opts: { tenantId?: string; admin?: boolean; firstName?: string } = {}): Promise<Actor> {
  seq += 1;
  const phone = `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone, firstName: opts.firstName ?? 'Gold5', lastName: `Ops${seq}`, roles, activeRole,
      tenantId: opts.tenantId ?? 'swift-default',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(opts.admin && { admin: { create: { permissions: ['*'] } } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `gold5-orders-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, phone };
}

async function makeStore(name: string, opts: { mmg?: boolean } = {}) {
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vendorOwner = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name, slug: `gold5-orders-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: owner.phone, addressLine1: '1 Golden Desk Way', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE_AT.lat, longitude: STORE_AT.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 10,
      ...(opts.mmg ? { mmgPayUrl: `https://${PAY_HOST}/pay/gold5-${nanoid(8).toLowerCase()}` } : {}),
    },
  }));
  const category = await sys(() => app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains', sortOrder: 0 } }));
  const item = await sys(() => app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Chicken curry', basePrice: 2200, isAvailable: true } }));
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

/** A real order through the mounted cart and checkout routes. */
async function placeOrder(customer: Actor, store: { vendorId: string; itemId: string }, paymentMethod: 'CASH' | 'MOBILE_MONEY' = 'CASH') {
  const address = await sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: `${seq} Golden Desk Street`, city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME_AT.lat, longitude: HOME_AT.lng, isDefault: true },
  }));
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: store.vendorId, itemId: store.itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBeLessThan(300);
  const addressed = await call('PUT', '/api/v1/customer/cart/address', customer.token, { addressId: address.id });
  expect(addressed.statusCode, addressed.body).toBe(200);
  const checkout = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod }, { 'idempotency-key': `gold5-orders-${nanoid(12)}` });
  expect(checkout.statusCode, checkout.body).toBe(200);
  const orders = checkout.json().data.orders as Array<{ id: string; orderNumber: string; totalAmount: unknown }>;
  expect(orders).toHaveLength(1);
  return { orderId: orders[0]!.id, orderNumber: orders[0]!.orderNumber };
}

// ── Admin: a stated reason (ADM-006), and two people for money (ADM-005) ──

function admin(options: InjectOptions & { token: string }) {
  const { token, headers, ...rest } = options;
  return app.inject({ ...rest, headers: { ...(headers as Record<string, string> | undefined), ...REASON, authorization: `Bearer ${token}` } });
}

/** Ask, approve as a DIFFERENT admin (the requester's own attempt refused),
 *  and re-issue carrying the approval. */
async function withApproval(requester: Actor, approver: Actor, options: InjectOptions) {
  const ask = await admin({ ...options, token: requester.token });
  expect(ask.statusCode, ask.body).toBe(202);
  expect(ask.json().error.code).toBe('APPROVAL_REQUIRED');
  const approvalId = ask.json().error.details.approvalId as string;
  const self = await admin({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, token: requester.token, payload: { approve: true } });
  expect(self.statusCode).toBe(403);
  const decided = await admin({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, token: approver.token, payload: { approve: true, note: 'Checked against the handover slip' } });
  expect(decided.statusCode, decided.body).toBe(200);
  expect(decided.json().data).toEqual({ id: approvalId, status: 'APPROVED' });
  const done = await admin({ ...options, token: requester.token, headers: { ...(options.headers as Record<string, string> | undefined), 'x-swift-approval': approvalId } });
  return { res: done, approvalId };
}

const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const approvalRow = (id: string) => sys(() => app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id } }));

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
      await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: [...orderIds, ...ids] } }] }, 'test-cleanup:gold-5-admin-orders fixtures');
      await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: ids } }, 'test-cleanup:gold-5-admin-orders fixture reads');
      await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
      await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
      await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds] } } });
      await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
      await app.prisma.batchEvaluation.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
      await app.prisma.earning.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
      if (orderIds.length > 0) {
        await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
      }
      await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
      await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
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
  vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', PAY_HOST);
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
  const dbNow = (await app.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0]!.now;
  windowStart = new Date(Math.min(dbNow.getTime(), Date.now()) - 2_000);
  redisKeysBefore = await allRedisKeys();
  await sys(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'Gold5 Desk Tenant B', slug: TENANT_B } }));
}, 60_000);

afterAll(async () => {
  const owned = await fixtureIds();
  await purgeFixtures();
  await sweepLateAuditRows(owned, 'test-cleanup:gold-5-orders late audit rows');
  // Ops pages carry only their kind on the tracking row; files run one at a
  // time, so this file's are the ones of its kinds inside its window.
  if (windowStart) {
    await sys(() => app.prisma.alertDelivery.deleteMany({ where: { kind: 'ADMIN_OPS', subjectId: { in: ['ops_food_too_old'] }, sentAt: { gte: windowStart! } } }));
  }
  const now = await allRedisKeys();
  const added = [...now].filter((k) => !redisKeysBefore.has(k));
  if (added.length > 0) await app.redis.del(...added);
  await app.close();
  vi.unstubAllEnvs();
}, 60_000);

// ---------------------------------------------------------------------------
// ADMIN-02 — held order → release → re-dispatch → rider accepts
// ---------------------------------------------------------------------------

describe('GOLD-5 · ADMIN-02 — held orders, retry dispatch and the food-age hold', () => {
  let ops: Actor;
  let opsB: Actor;
  let customer: Actor;
  let store: Awaited<ReturnType<typeof makeStore>>;
  let rider: Actor;
  let riderId = '';
  let order = { orderId: '', orderNumber: '' };

  beforeAll(async () => {
    ops = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Opal' });
    opsB = await makeUser(['ADMIN'], 'ADMIN', { admin: true, tenantId: TENANT_B, firstName: 'Bert' });
    customer = await makeUser(['CUSTOMER'], 'CUSTOMER', { firstName: 'Carmen' });
    store = await makeStore('Gold5 Held Kitchen', { mmg: true });

    // A real direct-MMG order: placed, the store attests the payment landed
    // (CLAIMED), accepts, cooks and marks it ready — and no rider is online.
    order = await placeOrder(customer, store, 'MOBILE_MONEY');
    const confirmed = await call('POST', `/api/v1/vendor/orders/${order.orderId}/confirm-payment`, store.owner.token, { reference: `MMG${nanoid(10).replace(/[^A-Za-z0-9]/g, '7').toUpperCase()}` });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    for (const step of ['accept', 'preparing', 'ready']) {
      const res = await call('PUT', `/api/v1/vendor/orders/${order.orderId}/${step}`, store.owner.token, {});
      expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
    }
    const ready = await orderRow(order.orderId);
    expect({ status: ready.status, payment: ready.paymentMethod, paid: ready.paymentStatus, rider: ready.riderId, held: ready.foodAgeHeldAt })
      .toEqual({ status: 'READY_FOR_PICKUP', payment: 'MOBILE_MONEY', paid: 'CLAIMED', rider: null, held: null });
    expect(ready.readyAt).not.toBeNull();

    // The one aging input: the food has been ready for 50 minutes (cutoff 45).
    await sys(() => app.prisma.order.update({ where: { id: order.orderId }, data: { readyAt: new Date(Date.now() - 50 * 60_000) } }));
  }, 60_000);

  it('the worker’s sweep HOLDS the paid order (never cancels it), pages ops and tells both parties the truth', async () => {
    const sweepStart = Date.now();
    const aged = await sweepFoodAge({ prisma: app.prisma, redis: app.redis, io: app.io, notifications: new NotificationService(app.prisma, app.io) });
    const sweepEnd = Date.now();
    expect(aged.retired).not.toContain(order.orderId);
    expect(aged.held).toContain(order.orderId);

    const held = await orderRow(order.orderId);
    expect({ status: held.status, cancelledAt: held.cancelledAt, paid: held.paymentStatus, rider: held.riderId }).toEqual({ status: 'READY_FOR_PICKUP', cancelledAt: null, paid: 'CLAIMED', rider: null });
    expect(held.foodAgeHeldAt!.getTime()).toBeGreaterThanOrEqual(sweepStart - 1_000);
    expect(held.foodAgeHeldAt!.getTime()).toBeLessThanOrEqual(sweepEnd + 1_000);
    const decisions = await sys(() => app.prisma.algoDecision.findMany({ where: { algo: RESCUE_ALGO, subjectType: 'ORDER', subjectId: order.orderId } }));
    expect(decisions.map((d) => d.outcome)).toEqual([FOOD_TOO_OLD_PAID_HELD_OUTCOME]);
    const note = await sys(() => app.prisma.orderStatusLog.findMany({ where: { orderId: order.orderId, changedBy: 'system' } }));
    expect(note).toHaveLength(1);
    expect(note[0]!.note).toContain('HELD for review, not cancelled');

    // The ops page reached this tenant's admin, and is claimed once.
    const pages = await sys(() => app.prisma.notification.findMany({ where: { userId: ops.userId, AND: [{ data: { path: ['kind'], equals: 'ops_food_too_old' } }, { data: { path: ['orderId'], equals: order.orderId } }] } }));
    expect(pages.map((p) => ({ title: p.title, held: (p.data as Record<string, unknown>)['held'] }))).toEqual([{ title: 'Paid MMG order too old to deliver — held for review, NOT cancelled', held: true }]);
    expect(await app.redis.exists(`ops_page:food_too_old_paid:${order.orderId}`)).toBe(1);
    // Another tenant's admin is not paged with this order.
    expect(await sys(() => app.prisma.notification.count({ where: { userId: opsB.userId } }))).toBe(0);
    // Both parties are told it was NOT cancelled.
    const told = await sys(() => app.prisma.notification.findMany({ where: { userId: { in: [customer.userId, store.owner.userId] }, dedupeKey: { startsWith: 'food-too-old-paid:' } }, orderBy: { dedupeKey: 'asc' } }));
    expect(told.map((n) => ({ to: n.userId, key: n.dedupeKey, title: n.title, held: (n.data as Record<string, unknown>)['held'] }))).toEqual([
      { to: customer.userId, key: `food-too-old-paid:customer:${order.orderId}`, title: 'We couldn’t find a rider in time', held: true },
      { to: store.owner.userId, key: `food-too-old-paid:vendor:${order.orderId}`, title: 'No rider found — the customer has already paid', held: true },
    ]);
    expect(told[0]!.body).toContain('it was NOT cancelled automatically');
    expect(told[1]!.body).toContain('it is NOT cancelled');

    // A second tick changes nothing: one decision, one note, one page, one notice each.
    await sweepFoodAge({ prisma: app.prisma, redis: app.redis, io: app.io, notifications: new NotificationService(app.prisma, app.io) });
    expect(await sys(() => app.prisma.algoDecision.count({ where: { algo: RESCUE_ALGO, subjectId: order.orderId } }))).toBe(1);
    expect(await sys(() => app.prisma.orderStatusLog.count({ where: { orderId: order.orderId, changedBy: 'system' } }))).toBe(1);
    expect(await sys(() => app.prisma.notification.count({ where: { userId: ops.userId, data: { path: ['orderId'], equals: order.orderId } } }))).toBe(1);
    expect(await sys(() => app.prisma.notification.count({ where: { dedupeKey: { startsWith: 'food-too-old-paid:' }, userId: { in: [customer.userId, store.owner.userId] } } }))).toBe(2);

    const queue = await admin({ method: 'GET', url: '/api/v1/admin/orders/held', token: ops.token });
    expect(queue.statusCode, queue.body).toBe(200);
    const row = (queue.json().data as Array<{ id: string; paymentStatus: string; readyMinutes: number }>).find((o) => o.id === order.orderId);
    expect(row).toBeDefined();
    expect(row!.paymentStatus).toBe('CLAIMED');
    expect(row!.readyMinutes).toBeGreaterThanOrEqual(50);
    expect(row!.readyMinutes).toBeLessThanOrEqual(52);
    const other = await admin({ method: 'GET', url: '/api/v1/admin/orders/held', token: opsB.token });
    expect((other.json().data as Array<{ id: string }>).map((o) => o.id)).not.toContain(order.orderId);
  });

  it('the doors are shut to everyone but this tenant’s ops: customer, store, rider and another tenant’s admin are refused; retry is honest', async () => {
    rider = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER', { firstName: 'Rayan' });
    riderId = (await sys(() => app.prisma.rider.create({ data: { userId: rider.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000 } }))).id;
    const go = await call('POST', '/api/v1/rider/go-online', rider.token, { latitude: STORE_AT.lat, longitude: STORE_AT.lng });
    expect(go.statusCode, go.body).toBe(200);

    const before = await orderRow(order.orderId);
    for (const who of [customer, store.owner, rider]) {
      expect((await call('POST', `/api/v1/admin/orders/${order.orderId}/food-age-hold/release`, who.token, { decision: 'DELIVER_ANYWAY' })).statusCode).toBe(403);
      expect((await call('POST', `/api/v1/admin/orders/${order.orderId}/retry-dispatch`, who.token, {})).statusCode).toBe(403);
    }
    expect((await admin({ method: 'POST', url: `/api/v1/admin/orders/${order.orderId}/food-age-hold/release`, token: opsB.token, payload: { decision: 'DELIVER_ANYWAY' } })).statusCode).toBe(404);
    // The rider cannot grab a held order off the board.
    const grab = await call('POST', `/api/v1/rider/orders/${order.orderId}/accept`, rider.token, {});
    expect(grab.statusCode).toBe(409);
    expect(grab.json().error.code).toBe('ORDER_HELD_FOR_REVIEW');
    // Retry names the door that exists instead of pretending.
    const retry = await admin({ method: 'POST', url: `/api/v1/admin/orders/${order.orderId}/retry-dispatch`, token: ops.token, payload: {} });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe('ORDER_HELD_FOR_REVIEW');
    // The other exit is refused, not faked.
    const close = await admin({ method: 'POST', url: `/api/v1/admin/orders/${order.orderId}/food-age-hold/release`, token: ops.token, payload: { decision: 'CLOSE_STORE_REFUNDED' } });
    expect(close.statusCode).toBe(409);
    expect(close.json().error.code).toBe('NOT_AVAILABLE_YET');

    const after = await orderRow(order.orderId);
    expect({ held: after.foodAgeHeldAt, waived: after.foodAgeWaivedAt, rider: after.riderId, status: after.status, updatedAt: after.updatedAt })
      .toEqual({ held: before.foodAgeHeldAt, waived: null, rider: null, status: 'READY_FOR_PICKUP', updatedAt: before.updatedAt });
    expect(await app.redis.get(`dispatch:offer:${order.orderId}`)).toBeNull();
  });

  it('the release waives the cutoff durably and re-dispatches; a later sweep does not re-hold it; the online rider takes the offer; a second release is an honest 409', async () => {
    expect(riderId, 'the doors test brought the rider online').not.toBe('');
    const before = Date.now();
    const release = await admin({ method: 'POST', url: `/api/v1/admin/orders/${order.orderId}/food-age-hold/release`, token: ops.token, payload: { decision: 'DELIVER_ANYWAY' } });
    expect(release.statusCode, release.body).toBe(200);
    expect(release.json().data).toMatchObject({ released: true, decision: 'DELIVER_ANYWAY' });

    const released = await orderRow(order.orderId);
    expect({ held: released.foodAgeHeldAt, waivedBy: released.foodAgeWaivedBy, status: released.status }).toEqual({ held: null, waivedBy: ops.userId, status: 'READY_FOR_PICKUP' });
    expect(released.foodAgeWaivedAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(released.foodAgeWaivedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    const opsNote = await sys(() => app.prisma.orderStatusLog.findMany({ where: { orderId: order.orderId, changedBy: ops.userId } }));
    expect(opsNote.map((n) => n.note)).toEqual(['Food-age hold released by an operator: deliver anyway — the cutoff is waived for this order and it goes back to dispatch.']);
    expect(await app.redis.exists(`ops_page:food_too_old_paid:${order.orderId}`)).toBe(0);
    const trail = await sys(() => app.prisma.auditLog.findMany({ where: { entityId: order.orderId, action: 'RELEASE_FOOD_AGE_HOLD' } }));
    expect(trail.map((t) => t.userId)).toEqual([ops.userId]);

    // The re-dispatch offered it to the one online rider.
    const card = await app.redis.get(`dispatch:offer:${order.orderId}`);
    expect(card?.split(':')[0]).toBe(riderId);

    // The waiver is durable: the next sweep tick leaves the order alone.
    const tick = await sweepFoodAge({ prisma: app.prisma, redis: app.redis, io: app.io, notifications: new NotificationService(app.prisma, app.io) });
    expect(tick.held).not.toContain(order.orderId);
    expect(tick.retired).not.toContain(order.orderId);
    expect((await orderRow(order.orderId)).foodAgeHeldAt).toBeNull();

    const current = await call('GET', '/api/v1/rider/offers/current', rider.token);
    expect(current.statusCode).toBe(200);
    const offer = current.json().data.offer as { orderId: string; offerAttemptId: string };
    expect(offer.orderId).toBe(order.orderId);
    expect(offer.offerAttemptId).toBe(card!.split(':')[1]);
    const accept = await call('POST', '/api/v1/rider/offers/accept', rider.token, { orderId: order.orderId, offerAttemptId: offer.offerAttemptId });
    expect(accept.statusCode, accept.body).toBe(200);
    expect(accept.json().data).toMatchObject({ orderId: order.orderId, status: 'RIDER_ASSIGNED' });
    const assigned = await orderRow(order.orderId);
    expect({ status: assigned.status, rider: assigned.riderId, held: assigned.foodAgeHeldAt }).toEqual({ status: 'RIDER_ASSIGNED', rider: riderId, held: null });

    const again = await admin({ method: 'POST', url: `/api/v1/admin/orders/${order.orderId}/food-age-hold/release`, token: ops.token, payload: { decision: 'DELIVER_ANYWAY' } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ORDER_NOT_HELD');
    const unchanged = await orderRow(order.orderId);
    expect({ status: unchanged.status, rider: unchanged.riderId, waivedBy: unchanged.foodAgeWaivedBy, waivedAt: unchanged.foodAgeWaivedAt }).toEqual({ status: 'RIDER_ASSIGNED', rider: riderId, waivedBy: ops.userId, waivedAt: released.foodAgeWaivedAt });
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: order.orderId, action: 'RELEASE_FOOD_AGE_HOLD' } }))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ADMIN-03 — admin cancel → refund obligation → two-person settlement
// ---------------------------------------------------------------------------

describe('GOLD-5 · ADMIN-03 — admin cancel and refund settlement', () => {
  let ops: Actor;
  let approver: Actor;
  let customer: Actor;
  let store: Awaited<ReturnType<typeof makeStore>>;
  let o1 = { orderId: '', orderNumber: '' };
  let o2 = { orderId: '', orderNumber: '' };
  let owed1 = 0;
  const ref = (label: string) => `CASH-G5-${label}-${nanoid(10).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase()}`;
  const settle = (orderId: string, reference: string, amount: number | string) =>
    ({ method: 'PUT' as const, url: `/api/v1/admin/orders/${orderId}/refund-settled`, payload: { reference, amount } });

  beforeAll(async () => {
    ops = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Olu' });
    approver = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Anya' });
    customer = await makeUser(['CUSTOMER'], 'CUSTOMER', { firstName: 'Chandra' });
    store = await makeStore('Gold5 Refund Kitchen');
    o1 = await placeOrder(customer, store);
    const accepted = await call('PUT', `/api/v1/vendor/orders/${o1.orderId}/accept`, store.owner.token, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    o2 = await placeOrder(customer, store);
    owed1 = Number((await orderRow(o1.orderId)).totalAmount);
    expect(owed1).toBeGreaterThan(0);
  }, 60_000);

  it('a cancel with no stated reason is refused and changes nothing; the cancel records an OBLIGATION, never a refund', async () => {
    const bare = await app.inject({ method: 'PUT', url: `/api/v1/admin/orders/${o1.orderId}/cancel`, payload: { refund: true }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(bare.statusCode).toBe(400);
    const template = await app.inject({ method: 'PUT', url: `/api/v1/admin/orders/${o1.orderId}/cancel`, payload: { refund: true, reason: 'Cancelled by admin' }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(template.statusCode).toBe(400);
    expect((await orderRow(o1.orderId)).status).toBe('ACCEPTED');

    const reason = 'The store lost power and cannot cook this order';
    const cancelAt = Date.now();
    const cancel = await app.inject({ method: 'PUT', url: `/api/v1/admin/orders/${o1.orderId}/cancel`, payload: { refund: true, reason }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json().data).toEqual({ orderId: o1.orderId, status: 'CANCELLED', refundOwed: String((await orderRow(o1.orderId)).totalAmount) });

    const row = await orderRow(o1.orderId);
    expect({ status: row.status, by: row.cancelledBy, why: row.cancellationReason, owedBy: row.refundOwedById, paid: row.refundPaidAmount, ref: row.refundRef, settledAt: row.refundSettledAt })
      .toEqual({ status: 'CANCELLED', by: ops.userId, why: reason, owedBy: ops.userId, paid: null, ref: null, settledAt: null });
    expect(Number(row.refundOwedAmount)).toBe(owed1);
    expect(row.refundOwedAt!.getTime()).toBeGreaterThanOrEqual(cancelAt - 1_000);
    expect(row.refundOwedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    const log = await sys(() => app.prisma.orderStatusLog.findMany({ where: { orderId: o1.orderId, status: 'CANCELLED' } }));
    expect(log.map((l) => ({ by: l.changedBy, note: l.note }))).toEqual([{ by: ops.userId, note: reason }]);
    const told = await sys(() => app.prisma.notification.findMany({ where: { userId: customer.userId, title: 'Order Cancelled' } }));
    expect(told.map((n) => n.body)).toEqual([`Your order ${o1.orderNumber} has been cancelled. Any cash you paid will be refunded — our team will follow up.`]);
    const trail = await sys(() => app.prisma.auditLog.findMany({ where: { entityId: o1.orderId, action: 'CANCEL_ORDER' } }));
    expect(trail.map((t) => ({ by: t.userId, changes: t.changes }))).toEqual([{ by: ops.userId, changes: { reason, refund: true, previousStatus: 'ACCEPTED' } }]);
  });

  it('settling is a C4 money action: the ask waits for a SECOND admin, the requester cannot approve it, and nothing moves meanwhile', async () => {
    const reference = ref('WAIT');
    const ask = await admin({ ...settle(o1.orderId, reference, owed1), token: ops.token });
    expect(ask.statusCode).toBe(202);
    expect(ask.json().error.code).toBe('APPROVAL_REQUIRED');
    const approvalId = ask.json().error.details.approvalId as string;
    const pending = await approvalRow(approvalId);
    expect({ status: pending.status, action: pending.action, cls: pending.cls, capability: pending.capability, entity: pending.entityId, by: pending.requestedBy, reason: pending.reason })
      .toEqual({ status: 'PENDING', action: 'PUT /orders/:id/refund-settled', cls: 'C4', capability: 'order.refund.settle', entity: o1.orderId, by: ops.userId, reason: REASON['x-swift-reason'] });

    // The requester's own approval is refused, as is a customer's; a missing reason is refused before anything.
    expect((await admin({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, token: ops.token, payload: { approve: true } })).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/admin/approvals/${approvalId}/decide`, customer.token, { approve: true })).statusCode).toBe(403);
    const noReason = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, payload: { approve: true }, headers: { authorization: `Bearer ${approver.token}`, 'content-type': 'application/json' } });
    expect(noReason.statusCode).toBe(400);
    // Re-issuing before anyone approved is refused.
    const early = await admin({ ...settle(o1.orderId, reference, owed1), token: ops.token, headers: { 'x-swift-approval': approvalId } });
    expect(early.statusCode).toBe(403);
    expect((await approvalRow(approvalId)).status).toBe('PENDING');
    const row = await orderRow(o1.orderId);
    expect({ status: row.status, ref: row.refundRef, paid: row.refundPaidAmount }).toEqual({ status: 'CANCELLED', ref: null, paid: null });
    // …and the second admin can still reject it, which closes it for good.
    const rejected = await admin({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, token: approver.token, payload: { approve: false, note: 'No handover slip attached' } });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().data).toEqual({ id: approvalId, status: 'REJECTED' });
    expect((await admin({ ...settle(o1.orderId, reference, owed1), token: ops.token, headers: { 'x-swift-approval': approvalId } })).statusCode).toBe(403);
    expect((await orderRow(o1.orderId)).refundRef).toBeNull();
  });

  it('a wrong amount is refused against the obligation and burns its approval; an approval cannot be re-aimed at another body', async () => {
    const wrong = await withApproval(ops, approver, settle(o1.orderId, ref('SHORT'), owed1 - 100));
    expect(wrong.res.statusCode).toBe(409);
    expect(wrong.res.json().error.code).toBe('REFUND_AMOUNT_MISMATCH');
    expect((await approvalRow(wrong.approvalId)).status).toBe('APPLIED');
    let row = await orderRow(o1.orderId);
    expect({ status: row.status, ref: row.refundRef, paid: row.refundPaidAmount, settledAt: row.refundSettledAt }).toEqual({ status: 'CANCELLED', ref: null, paid: null, settledAt: null });
    // The spent approval cannot be spent again.
    const reuse = await admin({ ...settle(o1.orderId, ref('SHORT'), owed1 - 100), token: ops.token, headers: { 'x-swift-approval': wrong.approvalId } });
    expect(reuse.statusCode).toBe(403);

    // An approval for one reference cannot carry a different one.
    const ask = await admin({ ...settle(o1.orderId, ref('SEEN'), owed1), token: ops.token });
    const approvalId = ask.json().error.details.approvalId as string;
    expect((await admin({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, token: approver.token, payload: { approve: true } })).statusCode).toBe(200);
    const reaimed = await admin({ ...settle(o1.orderId, ref('SWAPPED'), owed1), token: ops.token, headers: { 'x-swift-approval': approvalId } });
    expect(reaimed.statusCode).toBe(403);
    expect((await approvalRow(approvalId)).status).toBe('APPROVED');
    row = await orderRow(o1.orderId);
    expect({ status: row.status, ref: row.refundRef, paid: row.refundPaidAmount }).toEqual({ status: 'CANCELLED', ref: null, paid: null });
  });

  it('the exact amount closes the obligation ONCE; a duplicate is refused; one handover cannot settle two orders; the books reconcile', async () => {
    const reference = ref('PAID');
    const before = Date.now();
    const paid = await withApproval(ops, approver, settle(o1.orderId, reference, owed1));
    expect(paid.res.statusCode, paid.res.body).toBe(200);
    const row = await orderRow(o1.orderId);
    expect({ status: row.status, ref: row.refundRef, by: row.refundSettledById }).toEqual({ status: 'REFUNDED', ref: reference, by: ops.userId });
    expect(Number(row.refundPaidAmount)).toBe(owed1);
    expect(row.refundSettledAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row.refundSettledAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect((await approvalRow(paid.approvalId)).status).toBe('APPLIED');

    // A second settle of the same order: approved by a second person, then refused by the obligation.
    const dup = await withApproval(ops, approver, settle(o1.orderId, ref('AGAIN'), owed1));
    expect(dup.res.statusCode).toBe(400);
    expect(dup.res.json().error.code).toBe('NO_REFUND_DUE');
    const still = await orderRow(o1.orderId);
    expect({ ref: still.refundRef, paid: Number(still.refundPaidAmount), settledAt: still.refundSettledAt }).toEqual({ ref: reference, paid: owed1, settledAt: row.refundSettledAt });

    // A second order, cancelled with a refund: the SAME handover reference is refused.
    const cancel2 = await app.inject({ method: 'PUT', url: `/api/v1/admin/orders/${o2.orderId}/cancel`, payload: { refund: true, reason: 'The customer reported a duplicate order by mistake' }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(cancel2.statusCode, cancel2.body).toBe(200);
    const owed2 = Number((await orderRow(o2.orderId)).refundOwedAmount);
    const reused = await withApproval(ops, approver, settle(o2.orderId, reference, owed2));
    expect(reused.res.statusCode).toBe(409);
    expect(reused.res.json().error.code).toBe('REFUND_REF_ALREADY_USED');
    expect((await orderRow(o2.orderId)).status).toBe('CANCELLED');
    const reference2 = ref('PAID2');
    const paid2 = await withApproval(ops, approver, settle(o2.orderId, reference2, owed2));
    expect(paid2.res.statusCode, paid2.res.body).toBe(200);

    // RECONCILIATION: every settled refund is one obligation, one payment of
    // exactly that amount, one REFUNDED line, one audit record with the diff.
    for (const [orderId, owed, handover] of [[o1.orderId, owed1, reference], [o2.orderId, owed2, reference2]] as const) {
      const o = await orderRow(orderId);
      expect({ status: o.status, owed: Number(o.refundOwedAmount), paid: Number(o.refundPaidAmount), ref: o.refundRef }).toEqual({ status: 'REFUNDED', owed, paid: owed, ref: handover });
      expect(await sys(() => app.prisma.orderStatusLog.count({ where: { orderId, status: 'REFUNDED' } }))).toBe(1);
      const audits = await sys(() => app.prisma.auditLog.findMany({ where: { entityId: orderId, action: 'ADMIN PUT /api/v1/admin/orders/:id/refund-settled' } }));
      expect(audits).toHaveLength(1);
      const changes = audits[0]!.changes as { reason: string; changed: Record<string, { from: unknown; to: unknown }> };
      expect(audits[0]!.userId).toBe(ops.userId);
      expect(changes.reason).toBe(REASON['x-swift-reason']);
      expect(changes.changed['status']).toEqual({ from: 'CANCELLED', to: 'REFUNDED' });
      expect(changes.changed['refundRef']).toEqual({ from: null, to: handover });
      expect(Number(changes.changed['refundPaidAmount']!.to)).toBe(owed);
      // The operator's view agrees with the row.
      const view = await admin({ method: 'GET', url: `/api/v1/admin/orders/${orderId}`, token: ops.token });
      expect(view.statusCode).toBe(200);
      expect({ status: view.json().data.status, ref: view.json().data.refundRef, paid: Number(view.json().data.refundPaidAmount) }).toEqual({ status: 'REFUNDED', ref: handover, paid: owed });
    }
    // Every approval spent on a real act was spent exactly once.
    const approvals = await sys(() => app.prisma.privilegedApproval.findMany({ where: { requestedBy: ops.userId, action: 'PUT /orders/:id/refund-settled' } }));
    expect(approvals.every((a) => a.approvedBy === null || a.approvedBy === approver.userId)).toBe(true);
    expect(approvals.filter((a) => a.status === 'APPLIED')).toHaveLength(5); // wrong amount, paid, duplicate, reused ref, paid2

    // A terminal order cannot be cancelled again, and its money does not move.
    const recancel = await app.inject({ method: 'PUT', url: `/api/v1/admin/orders/${o1.orderId}/cancel`, payload: { refund: true, reason: 'Trying to cancel a refunded order again' }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(recancel.statusCode).toBe(400);
    expect(recancel.json().error.code).toBe('INVALID_STATUS');
    const final = await orderRow(o1.orderId);
    expect({ owed: Number(final.refundOwedAmount), paid: Number(final.refundPaidAmount), ref: final.refundRef }).toEqual({ owed: owed1, paid: owed1, ref: reference });
  });
});

// ---------------------------------------------------------------------------
// G5-F5 — the second admin approves blind
// ---------------------------------------------------------------------------
//
// admin-approval.ts resolveApproval stores the ask as action + route + entity
// id + reason + a SHA-256 fingerprint of the body. GET /admin/approvals lists
// exactly those rows. The approver is asked to authorise "PUT
// /orders/:id/refund-settled" on an order id, and is never shown the amount
// or the handover reference that the fingerprint binds them to (for a
// settlement file: not a single row or total). The ask is made in beforeAll,
// so this can only fail on what the approver's queue shows.
describe('GOLD-5 · ADMIN-03 — G5-F5', () => {
  let approver: Actor;
  let approvalId = '';
  let reference = '';
  let owed = 0;
  let entry: { id: string; isOwnRequest: boolean } | undefined;

  beforeAll(async () => {
    const ops = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Osei' });
    approver = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Ama' });
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER', { firstName: 'Cleon' });
    const store = await makeStore('Gold5 Blind Kitchen');
    const order = await placeOrder(customer, store);
    const cancel = await app.inject({ method: 'PUT', url: `/api/v1/admin/orders/${order.orderId}/cancel`, payload: { refund: true, reason: 'The store ran out of the ordered dish' }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(cancel.statusCode, cancel.body).toBe(200);
    owed = Number((await orderRow(order.orderId)).refundOwedAmount);
    reference = `CASH-G5-BLIND-${nanoid(10).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase()}`;
    const ask = await admin({ method: 'PUT', url: `/api/v1/admin/orders/${order.orderId}/refund-settled`, token: ops.token, payload: { reference, amount: owed } });
    expect(ask.statusCode).toBe(202);
    approvalId = ask.json().error.details.approvalId as string;
    // The approver's queue lists the ask, as someone else's.
    const queue = await admin({ method: 'GET', url: '/api/v1/admin/approvals', token: approver.token });
    expect(queue.statusCode).toBe(200);
    entry = (queue.json().data as Array<{ id: string; isOwnRequest: boolean }>).find((a) => a.id === approvalId);
    expect(entry).toBeDefined();
    expect(entry!.isOwnRequest).toBe(false);
  }, 60_000);

  it.fails('[G5-F5] the approver’s queue shows the amount and the handover reference they are asked to approve', async () => {
    const shown = JSON.stringify(entry);
    expect(shown).toContain(reference);
    expect(shown).toMatch(new RegExp(`\\b${owed}\\b`));
  });
});
