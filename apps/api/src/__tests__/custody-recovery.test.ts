import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { reserveRiderLeg } from '../modules/dispatch/concurrency-policy';
import { FloatService } from '../modules/dispatch/float.service';
import { invalidateAlgoConfig } from '../modules/algo/algo-config';
import { OrderService } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { recoverStrandedDeliveries } from '../modules/dispatch/delivery-watchdog';
import { escalateOverdueCases } from '../modules/custody/custody-recovery';
import { CUSTODY_CASE_ENTITY, partyCaseView } from '../modules/custody/custody-case';

// ---------------------------------------------------------------------------
// [AF-MOB-006 · S0] AFTER PICKUP, A DELIVERY THAT GOES WRONG HAS AN OWNER.
//
// On main before this lane the only answer was a 409 that said "Call support":
// the goods (and, on cash, the float the rider fronted the store) sat with a
// rider and nothing recorded who owned the problem, by when, or how it ended.
//
// The spec's red tests, each one here:
//   - a post-pickup generic handback is ALWAYS rejected (and now names the
//     recovery report instead of a dead end);
//   - each incident creates ONE owned recovery case (rider report, watchdog,
//     a started return), visible to the rider, the customer, the store and ops;
//   - a second mover cannot collect before the atomic transfer;
//   - the transfer proof: a mismatched code burns an attempt and changes
//     nothing, a used code cannot be replayed, an offline retry is idempotent,
//     and the lockout pages humans;
//   - return and relay timeouts page humans.
// ---------------------------------------------------------------------------

const GEO = { lat: 6.8013, lng: -58.1553 };
const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
const REASON = 'Rider reported a breakdown on the East Bank road after pickup';

let app: FastifyInstance;
const createdUserIds: string[] = [];
const sessionIds: string[] = [];
let vendorId: string;
let vendorToken = '';
let adminToken = '';
let adminUserId = '';
let seq = 0;

async function session(userId: string, role: string, label: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  const s = await app.prisma.session.create({
    data: { userId, token, refreshToken: nanoid(32), authMethod: 'OTP', deviceId: `cr-${label}-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3600_000) },
  });
  sessionIds.push(s.id);
  return { token, sessionId: s.id };
}

async function makeRider(opts: { floatLimit?: number } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+5920038${String(seq).padStart(3, '0')}${String(Date.now()).slice(-2)}`,
      firstName: `Relay${seq}`, lastName: 'Rider',
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER' as UserRole,
      countryCode: 'GY', isPhoneVerified: true, status: 'ACTIVE',
    },
  });
  createdUserIds.push(user.id);
  const { token, sessionId } = await session(user.id, 'MOVER', `r${seq}`);
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id, riderType: 'BOTH', vehicleType: 'MOTORCYCLE',
      documentsVerified: true, isOnline: true, isAvailable: true,
      locationSessionId: sessionId, currentLat: GEO.lat, currentLng: GEO.lng, lastLocationUpdate: new Date(),
      floatLimit: opts.floatLimit ?? 40_000,
    },
  });
  return { user, rider, token };
}

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+5920039${String(seq).padStart(3, '0')}${String(Date.now()).slice(-2)}`,
      firstName: 'Cust', lastName: `Cr${seq}`,
      roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER' as UserRole,
      countryCode: 'GY', isPhoneVerified: true, status: 'ACTIVE',
    },
  });
  createdUserIds.push(user.id);
  const { token } = await session(user.id, 'CUSTOMER', `c${seq}`);
  return { user, token };
}

/** A CASH food order already in the rider's bag, with the float committed the
 *  way a real claim commits it. */
async function orderInCustody(opts: { riderId: string; customerId: string; status?: string; orderType?: string; subtotal?: number }) {
  const subtotal = opts.subtotal ?? 3000;
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `CR-${RUN}-${nanoid(6)}`,
      orderType: (opts.orderType ?? 'FOOD_DELIVERY') as never, fulfillment: 'DELIVERY',
      customerId: opts.customerId, vendorId,
      status: 'RIDER_ASSIGNED',
      paymentMethod: 'CASH',
      subtotalBase: subtotal, subtotalMarkup: 0, subtotalCustomer: subtotal,
      deliveryFee: 500, serviceFee: 0, taxAmount: 0, tipAmount: 0, discount: 0, totalAmount: subtotal + 500,
      deliveryAddress: '7 Recovery Road', deliveryLat: GEO.lat + 0.004, deliveryLng: GEO.lng + 0.004,
      riderId: opts.riderId, acceptedAt: new Date(), readyAt: new Date(), pickedUpAt: new Date(),
    },
  });
  expect(await reserveRiderLeg(app.prisma, opts.riderId, order.id, 2)).toBe(true);
  expect(await new FloatService(app.prisma).commit(app.prisma, opts.riderId, subtotal)).toBe(true);
  await app.prisma.order.update({ where: { id: order.id }, data: { status: (opts.status ?? 'EN_ROUTE_DELIVERY') as never } });
  return order;
}

const as = (token: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const report = (token: string, orderId: string, reason = 'VEHICLE_BREAKDOWN') =>
  as(token, 'POST', `/api/v1/rider/orders/${orderId}/recovery`, { reason, note: 'chain snapped', gps: GEO });

const openCases = (orderId: string) => runWithoutTenant(() => app.prisma.custodyRecoveryCase.findMany({
  where: { orderId, resolvedAt: null },
}), 'test:custody-recovery');

const trail = (caseId: string) => runWithoutTenant(() => app.prisma.auditLog.findMany({
  where: { entity: CUSTODY_CASE_ENTITY, entityId: caseId }, orderBy: { createdAt: 'asc' },
}), 'test:custody-recovery');

/** A rider report, then operations directs a relay and names the relay rider. */
async function relayArranged() {
  const holder = await makeRider();
  const relay = await makeRider();
  const customer = await makeCustomer();
  const order = await orderInCustody({ riderId: holder.rider.id, customerId: customer.user.id });
  const opened = await report(holder.token, order.id);
  expect(opened.statusCode).toBe(201);
  const caseId = opened.json().data.caseId as string;
  const direct = await as(adminToken, 'POST', `/api/v1/admin/custody-cases/${caseId}/direct`, { outcome: 'RELAY_REQUIRED', reason: REASON });
  expect(direct.statusCode, direct.body).toBe(200);
  // The console sends the stated reason in the x-swift-reason header (its one
  // transport), so the relay is named that way here; the body form is used above.
  const named = await as(adminToken, 'POST', `/api/v1/admin/custody-cases/${caseId}/relay`, { riderId: relay.rider.id }, { 'x-swift-reason': REASON });
  expect(named.statusCode, named.body).toBe(200);
  expect(named.json().data.state).toBe('TRANSFER_IN_PROGRESS');
  const view = await as(holder.token, 'GET', `/api/v1/rider/orders/${order.id}/recovery`);
  const code = view.json().data.transferCode as string;
  expect(code).toMatch(/^\d{6}$/);
  return { holder, relay, customer, order, caseId, code };
}

const transfer = (token: string, caseId: string, code: string, headers: Record<string, string> = {}) =>
  as(token, 'POST', `/api/v1/rider/recovery/${caseId}/transfer`, { code, gps: { lat: GEO.lat + 0.001, lng: GEO.lng } }, headers);

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  invalidateAlgoConfig();

  const vendor = await runWithoutTenant(() => app.prisma.vendor.findFirst({
    where: { status: 'ACTIVE', owner: { user: { status: 'ACTIVE' } } },
    select: { id: true, owner: { select: { userId: true } } },
  }), 'test:custody-recovery');
  if (!vendor?.owner) throw new Error('seeded ACTIVE vendor with an owner required');
  vendorId = vendor.id;
  vendorToken = (await session(vendor.owner.userId, 'VENDOR', 'vendor')).token;

  const admin = await app.prisma.user.create({
    data: {
      phone: `+5920037${String(Date.now()).slice(-5)}`, firstName: 'Ops', lastName: `Owner${RUN}`,
      roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
      admin: { create: { permissions: ['*'] } },
    },
  });
  createdUserIds.push(admin.id);
  adminUserId = admin.id;
  adminToken = (await session(admin.id, 'SUPER_ADMIN', 'admin')).token;
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.order.deleteMany({ where: { orderNumber: { startsWith: `CR-${RUN}-` } } });
    await app.prisma.session.deleteMany({ where: { id: { in: sessionIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
  }, 'test-cleanup:custody-recovery');
  await app.close();
});

describe('[AF-MOB-006] the custody line holds, and it is no longer a dead end', () => {
  it('a post-pickup handback is always refused, changes nothing, and names the recovery report', async () => {
    const customer = await makeCustomer();
    for (const status of ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED']) {
      const holder = await makeRider();
      const order = await orderInCustody({ riderId: holder.rider.id, customerId: customer.user.id, status });
      const res = await as(holder.token, 'POST', `/api/v1/rider/orders/${order.id}/handback`, { reason: 'vehicle broke down' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CUSTODY');
      expect(res.json().error.details.recovery.path).toBe(`/api/v1/rider/orders/${order.id}/recovery`);
      const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(fresh.status).toBe(status);
      expect(fresh.riderId).toBe(holder.rider.id);
    }
  });

  it('before pickup there is nothing to recover: the report refuses and points at the handback', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderInCustody({ riderId: holder.rider.id, customerId: customer.user.id, status: 'RIDER_EN_ROUTE_PICKUP' });
    const res = await report(holder.token, order.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_IN_CUSTODY');
    expect(await openCases(order.id)).toHaveLength(0);
  });
});

describe('[AF-MOB-006] each incident creates ONE owned case, visible to everyone it concerns', () => {
  it('the holder report opens one SUPPORT_HOLD case with a deadline; a second report returns the same case', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderInCustody({ riderId: holder.rider.id, customerId: customer.user.id });

    const first = await report(holder.token, order.id);
    expect(first.statusCode).toBe(201);
    const data = first.json().data;
    expect(data).toMatchObject({ created: true, state: 'SUPPORT_HOLD', open: true, youHoldTheGoods: true, transferCode: null });
    expect(new Date(data.deadlineAt).getTime()).toBeGreaterThan(Date.now());

    const again = await report(holder.token, order.id, 'CRASH');
    expect(again.statusCode).toBe(200);
    expect(again.json().data.caseId).toBe(data.caseId);
    const open = await openCases(order.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.reason).toBe('VEHICLE_BREAKDOWN');
    expect(open[0]!.holderRiderId).toBe(holder.rider.id);

    // The trail records the opening, with the rider as the actor.
    const rows = await trail(data.caseId);
    expect(rows.map((r) => r.action)).toEqual(['CUSTODY_CASE_OPENED']);
    expect(rows[0]!.userId).toBe(holder.user.id);

    // Operations was paged, scoped to the order.
    const page = await runWithoutTenant(() => app.prisma.notification.findFirst({
      where: { userId: adminUserId, data: { path: ['caseId'], equals: data.caseId } },
    }), 'test:custody-recovery');
    expect(page?.data).toMatchObject({ kind: 'ops_custody_case', event: 'opened', orderId: order.id });

    // The order, its float and its rider are untouched: a case is not a release.
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.riderId).toBe(holder.rider.id);
    expect(fresh.status).toBe('EN_ROUTE_DELIVERY');
    expect(Number((await app.prisma.rider.findUniqueOrThrow({ where: { id: holder.rider.id } })).committedFloat)).toBe(3000);

    // The customer and the store see the case in plain words.
    const c = await as(customer.token, 'GET', `/api/v1/customer/orders/${order.id}`);
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().data.custodyRecovery).toMatchObject({ caseId: data.caseId, state: 'SUPPORT_HOLD', open: true });
    expect(c.json().data.custodyRecovery.body).toMatch(/Swift support has taken this on/);
    const v = await as(vendorToken, 'GET', `/api/v1/vendor/orders/${order.id}`);
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().data.custodyRecovery).toMatchObject({ caseId: data.caseId, state: 'SUPPORT_HOLD' });

    // And operations reads it — never with a transfer code in it.
    const list = await as(adminToken, 'GET', '/api/v1/admin/custody-cases');
    expect(list.statusCode, list.body).toBe(200);
    const row = list.json().data.find((k: { id: string }) => k.id === data.caseId);
    expect(row).toMatchObject({ state: 'SUPPORT_HOLD', ownerUserId: null });
    expect(row).not.toHaveProperty('transferCode');
  });

  it('a rider who does not hold the order cannot report on it, or read its case', async () => {
    const holder = await makeRider();
    const stranger = await makeRider();
    const customer = await makeCustomer();
    const order = await orderInCustody({ riderId: holder.rider.id, customerId: customer.user.id });
    expect((await report(stranger.token, order.id)).statusCode).toBe(404);
    await report(holder.token, order.id);
    expect((await as(stranger.token, 'GET', `/api/v1/rider/orders/${order.id}/recovery`)).statusCode).toBe(404);
  });

  it('a rider gone dark with the goods opens the case through the watchdog — once, however often it sweeps', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderInCustody({ riderId: holder.rider.id, customerId: customer.user.id, status: 'PICKED_UP' });
    await app.prisma.rider.update({ where: { id: holder.rider.id }, data: { lastLocationUpdate: new Date(Date.now() - 60 * 60_000) } });
    const enqueue = async () => {};
    const first = await recoverStrandedDeliveries(app.prisma, app.redis, app.io, enqueue);
    expect(first.flagged).toContain(order.id);
    await recoverStrandedDeliveries(app.prisma, app.redis, app.io, enqueue);
    const open = await openCases(order.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ reason: 'MOVER_SIGNAL_LOST', state: 'SUPPORT_HOLD', openedBy: null, holderRiderId: holder.rider.id });
    // Custody never auto-releases.
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).riderId).toBe(holder.rider.id);
  });
});

describe('[AF-MOB-006] a second mover cannot collect before the atomic transfer', () => {
  it('the named relay rider is refused at every rider door while the holder keeps custody', async () => {
    const { holder, relay, order, caseId } = await relayArranged();
    for (const [method, url, payload] of [
      ['PUT', `/api/v1/rider/orders/${order.id}/picked-up`, {}],
      ['PUT', `/api/v1/rider/orders/${order.id}/arrived`, {}],
      ['PUT', `/api/v1/rider/orders/${order.id}/delivered`, {}],
      ['POST', `/api/v1/rider/orders/${order.id}/handover`, { outcome: 'paid', gps: GEO }],
      ['POST', `/api/v1/rider/orders/${order.id}/recovery`, { reason: 'OTHER' }],
    ] as const) {
      const res = await as(relay.token, method, url, payload);
      expect([403, 404], `${method} ${url} -> ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    }
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.riderId).toBe(holder.rider.id);
    expect(fresh.status).toBe('EN_ROUTE_DELIVERY');

    // The relay rider's task names where to meet and what to bring — never the
    // customer, the address, or the code.
    const tasks = await as(relay.token, 'GET', '/api/v1/rider/recovery/relays');
    const task = tasks.json().data.find((t: { caseId: string }) => t.caseId === caseId);
    expect(task).toMatchObject({ floatToBring: 3000, holder: { firstName: holder.user.firstName } });
    expect(JSON.stringify(task)).not.toMatch(/Recovery Road|transferCode/);
    // The holder sees the code; the relay rider's view of the holder's order does not exist.
    expect((await as(relay.token, 'GET', `/api/v1/rider/orders/${order.id}/recovery`)).statusCode).toBe(404);
  });

  it('a mismatched code burns an attempt in its own commit and moves nothing', async () => {
    const { holder, relay, order, caseId, code } = await relayArranged();
    const wrong = code === '000000' ? '111111' : '000000';
    const res = await transfer(relay.token, caseId, wrong);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TRANSFER_CODE');
    const kase = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(kase.transferAttempts).toBe(1);
    expect(kase.state).toBe('TRANSFER_IN_PROGRESS');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).riderId).toBe(holder.rider.id);
    expect((await trail(caseId)).map((r) => r.action)).toContain('CUSTODY_CASE_TRANSFER_CODE_FAILED');
    // The failed attempt is never written with the real code.
    expect(JSON.stringify(await trail(caseId))).not.toContain(code);
    expect(Number((await app.prisma.rider.findUniqueOrThrow({ where: { id: relay.rider.id } })).committedFloat)).toBe(0);
  });

  it('the verified handoff moves the holder, the leg and the float in one commit — and the code cannot be replayed', async () => {
    const { holder, relay, order, caseId, code } = await relayArranged();
    const key = `cr-transfer-${nanoid(10)}`;
    const ok = await transfer(relay.token, caseId, code, { 'idempotency-key': key });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data).toMatchObject({ caseId, orderId: order.id, state: 'TRANSFERRED' });

    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.riderId).toBe(relay.rider.id);
    expect(fresh.status).toBe('EN_ROUTE_DELIVERY');
    const a = await app.prisma.rider.findUniqueOrThrow({ where: { id: holder.rider.id } });
    const b = await app.prisma.rider.findUniqueOrThrow({ where: { id: relay.rider.id } });
    expect(Number(a.committedFloat)).toBe(0);
    expect(a.currentOrderId).toBeNull();
    expect(Number(b.committedFloat)).toBe(3000);
    expect(b.currentOrderId).toBe(order.id);

    const kase = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(kase).toMatchObject({ state: 'TRANSFERRED', holderRiderId: relay.rider.id, transferCode: null });
    expect(kase.resolvedAt).not.toBeNull();
    const verified = (await trail(caseId)).find((r) => r.action === 'CUSTODY_CASE_STATE_CHANGED' && (r.changes as { to?: string }).to === 'TRANSFERRED');
    expect(verified?.changes).toMatchObject({ fromRiderId: holder.rider.id, toRiderId: relay.rider.id, floatMoved: 3000 });
    const log = await app.prisma.orderStatusLog.findFirst({ where: { orderId: order.id, note: { startsWith: 'Custody handed to a relay rider' } } });
    expect(log?.changedBy).toBe(relay.user.id);

    // An offline retry with the same key gets the original answer, not a second attempt.
    const retry = await transfer(relay.token, caseId, code, { 'idempotency-key': key });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().replayed).toBe(true);
    // A replay of the used code without the key is refused: the handoff is over.
    const replay = await transfer(relay.token, caseId, code);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('TRANSFER_NOT_PENDING');

    // The case is now the relay rider's to read (they hold the order), and it
    // speaks to them; the old holder can no longer read it.
    const nowHeld = await as(relay.token, 'GET', `/api/v1/rider/orders/${order.id}/recovery`);
    expect(nowHeld.json().data).toMatchObject({ state: 'TRANSFERRED', youHoldTheGoods: true, transferCode: null });
    expect(nowHeld.json().data.instruction).toMatch(/handed this order to you/);
    expect((await as(holder.token, 'GET', `/api/v1/rider/orders/${order.id}/recovery`)).statusCode).toBe(404);
    // The old holder has no door left; the new holder has the ordinary one.
    expect((await as(holder.token, 'PUT', `/api/v1/rider/orders/${order.id}/arrived`, {})).statusCode).toBe(403);
    expect((await as(relay.token, 'PUT', `/api/v1/rider/orders/${order.id}/arrived`, {})).statusCode).toBe(200);
  });

  it('after the shared limit of wrong codes the handoff locks and operations is paged', async () => {
    const { relay, caseId, code } = await relayArranged();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) expect((await transfer(relay.token, caseId, wrong)).statusCode).toBe(400);
    const locked = await transfer(relay.token, caseId, code);
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('MAX_ATTEMPTS');
    const page = await runWithoutTenant(() => app.prisma.notification.findFirst({
      where: { userId: adminUserId, data: { path: ['caseId'], equals: caseId } }, orderBy: { createdAt: 'desc' },
    }), 'test');
    expect(page?.data).toMatchObject({ event: 'transfer_locked' });
  });

  it('a return cannot start while a relay rider is on the way: it is refused and nothing moves', async () => {
    const { order, caseId } = await relayArranged();
    const res = await as(adminToken, 'POST', `/api/v1/admin/custody-cases/${caseId}/direct`, { outcome: 'RETURN_REQUIRED', reason: REASON });
    expect(res.statusCode).toBe(409);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('EN_ROUTE_DELIVERY');
    const kase = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(kase.state).toBe('TRANSFER_IN_PROGRESS');
  });

  it('a declined relay goes back to RELAY_REQUIRED, the code dies with it, and operations is paged', async () => {
    const { relay, caseId, code } = await relayArranged();
    const res = await as(relay.token, 'POST', `/api/v1/rider/recovery/${caseId}/decline`, { reason: 'tyre puncture' });
    expect(res.statusCode, res.body).toBe(200);
    const kase = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(kase).toMatchObject({ state: 'RELAY_REQUIRED', transferCode: null, relayRiderId: null });
    expect((await transfer(relay.token, caseId, code)).statusCode).toBe(404);
  });
});

describe('[AF-MOB-006] a return is owned from start to finish', () => {
  it('operations directs a return (order RETURNING), the store confirms it (RETURNED), the case resolves and the rider is freed', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderInCustody({ riderId: holder.rider.id, customerId: customer.user.id });
    const caseId = (await report(holder.token, order.id, 'RECIPIENT_ABSENT')).json().data.caseId as string;

    const noReason = await as(adminToken, 'POST', `/api/v1/admin/custody-cases/${caseId}/direct`, { outcome: 'RETURN_REQUIRED' });
    expect(noReason.statusCode).toBe(400); // C3: a decision about someone else's goods states why

    const direct = await as(adminToken, 'POST', `/api/v1/admin/custody-cases/${caseId}/direct`, { outcome: 'RETURN_REQUIRED', reason: REASON });
    expect(direct.statusCode, direct.body).toBe(200);
    expect(direct.json().data.state).toBe('RETURN_REQUIRED');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('RETURNING');
    let kase = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(kase.ownerUserId).toBe(adminUserId); // the deciding operator owns it

    const v = await as(vendorToken, 'GET', `/api/v1/vendor/orders/${order.id}`);
    expect(v.json().data.custodyRecovery).toMatchObject({ state: 'RETURN_REQUIRED', headline: 'Order coming back to you' });
    // Owner ruling (4 Oct): on a returned cash order the store gives the rider
    // back the cash they fronted — both sides are told the same number.
    expect(v.json().data.custodyRecovery.body).toContain('Give the rider back the GY$3,000 cash they paid you');
    const held = await as(holder.token, 'GET', `/api/v1/rider/orders/${order.id}/recovery`);
    expect(held.json().data.instruction).toContain('the store gives you back the GY$3,000 cash you paid for it');

    const received = await as(vendorToken, 'POST', `/api/v1/vendor/orders/${order.id}/recovery/return-received`, {});
    expect(received.statusCode, received.body).toBe(200);
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('RETURNED');
    kase = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(kase.state).toBe('RETURNED');
    expect(kase.resolvedAt).not.toBeNull();
    const r = await app.prisma.rider.findUniqueOrThrow({ where: { id: holder.rider.id } });
    expect(Number(r.committedFloat)).toBe(0);
    expect(r.currentOrderId).toBeNull();
    const actions = (await trail(caseId)).map((t) => t.action);
    expect(actions).toEqual(expect.arrayContaining(['CUSTODY_CASE_OPENED', 'CUSTODY_CASE_DIRECTED', 'CUSTODY_CASE_RETURN_CONFIRMED']));
  });

  it('a return started on the order itself opens its case: no RETURNING without an owner', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderInCustody({ riderId: holder.rider.id, customerId: customer.user.id });
    const service = new OrderService(app.prisma, app.io, undefined, undefined, app.redis);
    await service.transitionOrderAtomically({
      orderId: order.id, target: 'RETURNING', allowedFrom: ['EN_ROUTE_DELIVERY'], expectedRiderId: holder.rider.id,
      changedBy: holder.user.id, note: 'cannot deliver — recipient absent',
    });
    const open = await openCases(order.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ state: 'RETURN_REQUIRED', reason: 'RETURN_STARTED', holderRiderId: holder.rider.id });
  });

  it('when the holder finishes after all, the open case resolves as DELIVERED in the same commit', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderInCustody({ riderId: holder.rider.id, customerId: customer.user.id, status: 'ARRIVED' });
    const caseId = (await report(holder.token, order.id, 'RECIPIENT_ABSENT')).json().data.caseId as string;
    await app.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'CAPTURED' } });
    const service = new OrderService(app.prisma, app.io, undefined, undefined, app.redis);
    await service.transitionOrderAtomically({
      orderId: order.id, target: 'DELIVERED', allowedFrom: ['ARRIVED'], expectedRiderId: holder.rider.id,
      changedBy: holder.user.id, note: 'Delivery completed',
    });
    const kase = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(kase.state).toBe('DELIVERED');
    expect(kase.resolvedAt).not.toBeNull();
  });
});

describe('[AF-MOB-006] timeouts page humans', () => {
  it('an overdue case pages operations once per deadline, counts the escalation and re-arms', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderInCustody({ riderId: holder.rider.id, customerId: customer.user.id });
    const caseId = (await report(holder.token, order.id)).json().data.caseId as string;
    await runWithoutTenant(() => app.prisma.custodyRecoveryCase.update({
      where: { id: caseId }, data: { deadlineAt: new Date(Date.now() - 60_000) },
    }), 'test');

    const deps = { prisma: app.prisma, io: app.io, notifications: new NotificationService(app.prisma, app.io) };
    const first = await escalateOverdueCases(deps);
    expect(first).toContain(caseId);
    const second = await escalateOverdueCases(deps);
    expect(second).not.toContain(caseId);

    const kase = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(kase.escalationCount).toBe(1);
    expect(kase.lastEscalatedAt).not.toBeNull();
    expect(kase.deadlineAt.getTime()).toBeGreaterThan(Date.now());
    const pages = await runWithoutTenant(() => app.prisma.notification.findMany({
      where: { userId: adminUserId, data: { path: ['caseId'], equals: caseId } },
    }), 'test');
    expect(pages.filter((p) => (p.data as { event?: string }).event === 'overdue')).toHaveLength(1);
    expect((await trail(caseId)).map((r) => r.action)).toContain('CUSTODY_CASE_ESCALATED');
  });

  it('a relay that is not completed by its deadline pages humans too', async () => {
    const { caseId } = await relayArranged();
    await runWithoutTenant(() => app.prisma.custodyRecoveryCase.update({
      where: { id: caseId }, data: { deadlineAt: new Date(Date.now() - 1000) },
    }), 'test');
    const escalated = await escalateOverdueCases({ prisma: app.prisma, io: app.io, notifications: new NotificationService(app.prisma, app.io) });
    expect(escalated).toContain(caseId);
  });
});

describe('[AF-MOB-006] a return tells each party the truth about the money', () => {
  const kase = { id: 'c1', state: 'RETURN_REQUIRED' as const, updatedAt: new Date(), ownerUserId: 'ops' };
  it('MMG: the store refunds the customer directly, and the copy says Swift never holds order money', () => {
    const mmg = { orderType: 'FOOD_DELIVERY', paymentMethod: 'MOBILE_MONEY', subtotalBase: 3000 };
    expect(partyCaseView(kase, 'CUSTOMER', mmg)!.body).toContain('the store refunds you directly — Swift never holds order money');
    expect(partyCaseView(kase, 'VENDOR', mmg)!.body).toContain('refund them directly — Swift never holds order money');
    expect(partyCaseView({ ...kase, state: 'RETURNED' }, 'CUSTOMER', mmg)!.body).toContain('Swift never holds order money');
  });
  it('cash: the customer is promised nothing they did not pay; the store owes the rider the fronted cash', () => {
    const cash = { orderType: 'FOOD_DELIVERY', paymentMethod: 'CASH', subtotalBase: 2500 };
    expect(partyCaseView(kase, 'CUSTOMER', cash)!.body).not.toMatch(/refund/i);
    expect(partyCaseView(kase, 'VENDOR', cash)!.body).toContain('Give the rider back the GY$2,500 cash');
  });
  it('a courier parcel goes back to its sender with no store money in the sentence', () => {
    const parcel = { orderType: 'COURIER', paymentMethod: 'CASH', subtotalBase: 0 };
    expect(partyCaseView(kase, 'CUSTOMER', parcel)!.body).toBe('Your order could not be delivered and is on its way back to you.');
  });
});

// ---------------------------------------------------------------------------
// [AF-MOB-006 · DS667] The handoff code's contract, hardened after review:
// one physical attempt burns one attempt (an idempotent retry of a refused
// code replays the refusal), the comparison is constant-time, the code dies
// with its deadline, and a relay rider is told when the handoff is called off.
// ---------------------------------------------------------------------------
describe('[AF-MOB-006 · DS667] the handoff code contract', () => {
  const relayNotices = (riderUserId: string, caseId: string) => runWithoutTenant(() => app.prisma.notification.findMany({
    where: { userId: riderUserId, data: { path: ['caseId'], equals: caseId } },
  }), 'test');

  it('a wrong code retried with the same Idempotency-Key replays the refusal and burns ONE attempt', async () => {
    const { relay, caseId, code } = await relayArranged();
    const wrong = code === '000000' ? '111111' : '000000';
    const key = `cr-wrong-${nanoid(10)}`;
    const first = await transfer(relay.token, caseId, wrong, { 'idempotency-key': key });
    expect(first.statusCode).toBe(400);
    expect(first.json().error.code).toBe('INVALID_TRANSFER_CODE');
    // The answer was lost; the phone retries the same request.
    const retry = await transfer(relay.token, caseId, wrong, { 'idempotency-key': key });
    expect(retry.statusCode).toBe(400);
    expect(retry.json().error.code).toBe('INVALID_TRANSFER_CODE');
    expect(retry.json().error.message).toBe(first.json().error.message);
    const kase = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(kase.transferAttempts).toBe(1);
    expect((await trail(caseId)).filter((r) => r.action === 'CUSTODY_CASE_TRANSFER_CODE_FAILED')).toHaveLength(1);
    // A NEW attempt (a new key) still counts, and the right code still works.
    expect((await transfer(relay.token, caseId, wrong, { 'idempotency-key': `cr-wrong-${nanoid(10)}` })).statusCode).toBe(400);
    expect((await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test')).transferAttempts).toBe(2);
    expect((await transfer(relay.token, caseId, code)).statusCode).toBe(200);
  });

  it('the code is compared in constant time', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'modules', 'custody', 'custody-recovery.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/timingSafeEqual\(/);
    expect(src).not.toMatch(/input\.code\s*!==?\s*kase\.transferCode|kase\.transferCode\s*!==?\s*input\.code/);
  });

  it('a code past its handoff deadline is refused, and moves nothing', async () => {
    const { holder, relay, order, caseId, code } = await relayArranged();
    await runWithoutTenant(() => app.prisma.custodyRecoveryCase.update({
      where: { id: caseId }, data: { deadlineAt: new Date(Date.now() - 1000), transferCodeExpiresAt: new Date(Date.now() - 1000) },
    }), 'test');
    const res = await transfer(relay.token, caseId, code);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TRANSFER_CODE_EXPIRED');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).riderId).toBe(holder.rider.id);
    const kase = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(kase.transferAttempts).toBe(0);
    // The holder is never shown a dead code: the card says it expired.
    const view = (await as(holder.token, 'GET', `/api/v1/rider/orders/${order.id}/recovery`)).json().data;
    expect(view).toMatchObject({ state: 'TRANSFER_IN_PROGRESS', transferCode: null, codeExpired: true, floatToCollect: 0 });
    expect(view.transferCodeExpiresAt).toBeTruthy();
    expect(view.instruction).toMatch(/handoff code expired/);
    // And an expired handoff is not on the relay rider's list.
    const tasks = (await as(relay.token, 'GET', '/api/v1/rider/recovery/relays')).json().data;
    expect(tasks.find((t: { caseId: string }) => t.caseId === caseId)).toBeUndefined();
  });

  it('a bumped case deadline can never revive an expired code: the code keys on its OWN expiry', async () => {
    // [Fable r2 S3] The escalation sweep (or any later step) re-arms the CASE
    // deadline. If the code's validity rode that deadline, a bump would bring a
    // dead code back to life. The code carries its own expiry, set when it is
    // minted and never moved.
    const { holder, relay, order, caseId, code } = await relayArranged();
    await runWithoutTenant(() => app.prisma.custodyRecoveryCase.update({
      where: { id: caseId },
      data: { transferCodeExpiresAt: new Date(Date.now() - 1000), deadlineAt: new Date(Date.now() + 3600_000) },
    }), 'test');
    const res = await transfer(relay.token, caseId, code);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TRANSFER_CODE_EXPIRED');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).riderId).toBe(holder.rider.id);
    const view = (await as(holder.token, 'GET', `/api/v1/rider/orders/${order.id}/recovery`)).json().data;
    expect(view).toMatchObject({ transferCode: null, codeExpired: true });
    const tasks = (await as(relay.token, 'GET', '/api/v1/rider/recovery/relays')).json().data;
    expect(tasks.find((t: { caseId: string }) => t.caseId === caseId)).toBeUndefined();
  });

  it('a handoff that is not the rider’s gets a sentence, never an internal id', async () => {
    const { caseId } = await relayArranged();
    const stranger = await makeRider();
    const res = await transfer(stranger.token, caseId, '123456');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('HANDOFF_NOT_FOUND');
    expect(res.json().error.message).not.toMatch(/RecoveryCase|with id/);
    const dec = await as(stranger.token, 'POST', `/api/v1/rider/recovery/${caseId}/decline`, {});
    expect(dec.statusCode).toBe(404);
    expect(dec.json().error.message).not.toMatch(/RecoveryCase|with id/);
  });

  it('when the handoff deadline escalates, the code dies, the relay rider is told, and a fresh name mints a fresh code', async () => {
    const { holder, relay, caseId, code } = await relayArranged();
    await runWithoutTenant(() => app.prisma.custodyRecoveryCase.update({
      where: { id: caseId }, data: { deadlineAt: new Date(Date.now() - 1000) },
    }), 'test');
    const escalated = await escalateOverdueCases({ prisma: app.prisma, io: app.io, notifications: new NotificationService(app.prisma, app.io) });
    expect(escalated).toContain(caseId);
    const kase = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(kase).toMatchObject({ state: 'RELAY_REQUIRED', transferCode: null, transferCodeExpiresAt: null, relayRiderId: null });
    expect((await relayNotices(relay.user.id, caseId)).map((n) => (n.data as { kind?: string }).kind)).toContain('custody_relay_cancelled');
    expect((await transfer(relay.token, caseId, code)).statusCode).toBe(404);
    // The holder no longer shows a code.
    expect((await as(holder.token, 'GET', `/api/v1/rider/orders/${kase.orderId}/recovery`)).json().data.transferCode).toBeNull();
    // Operations names the relay rider again: a fresh code.
    const named = await as(adminToken, 'POST', `/api/v1/admin/custody-cases/${caseId}/relay`, { riderId: relay.rider.id }, { 'x-swift-reason': REASON });
    expect(named.statusCode, named.body).toBe(200);
    const fresh = await runWithoutTenant(() => app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: caseId } }), 'test');
    expect(fresh.transferCode).toMatch(/^\d{6}$/);
    expect(fresh.transferAttempts).toBe(0);
    // The fresh code carries its own fresh expiry.
    expect(fresh.transferCodeExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('when operations calls the handoff off, the named relay rider is told', async () => {
    const { relay, caseId } = await relayArranged();
    const res = await as(adminToken, 'POST', `/api/v1/admin/custody-cases/${caseId}/direct`, { outcome: 'SUPPORT_HOLD' }, { 'x-swift-reason': REASON });
    expect(res.statusCode, res.body).toBe(200);
    const notices = await relayNotices(relay.user.id, caseId);
    expect(notices.map((n) => (n.data as { kind?: string }).kind)).toContain('custody_relay_cancelled');
  });
});
