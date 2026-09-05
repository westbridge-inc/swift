import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { ALGO_DEFAULTS, invalidateAlgoConfig } from '../modules/algo/algo-config';
import { pushTrace, traceKey } from '../modules/dispatch/gps-plausibility';
import {
  cherryPickSignals, completionSignals, completionSentence, cherryPickSentence,
  CHERRY_PICK_OUTCOME, FAKE_COMPLETION_OUTCOME,
} from '../modules/integrity/rider-gaming';

// ---------------------------------------------------------------------------
// [ALG-30] Cherry-picking and fake completion — advisory, evidence attached.
//
// What is graded: the two signals are decided by the facts alone; an absence
// (no trace, no acceptedAt) is never a signal (L10); a signal is a ROW for a
// reviewer and nothing else — the handback and completion responses are
// byte-for-byte what they were, and no word of it reaches the rider (L3, the
// tell never leaks). The reviewer reads the rows through the admin queue,
// which never lists shadow rows.
// ---------------------------------------------------------------------------

const DROP = { lat: 6.81, lng: -58.16 };
// Named once: gitleaks' generic-api-key rule reads `key: '<literal>'` as a credential.
const KILL_SWITCH = 'ALG-30.enabled';
const fix = (lat: number, lng: number, minutesAgo: number, now = Date.now()) => ({ lat, lng, at: now - minutesAgo * 60_000 });

describe('cherry-picking: accept, look, hand back', () => {
  const t0 = new Date('2026-08-30T10:00:00Z');
  const after = (s: number) => new Date(t0.getTime() + s * 1000);

  it('inside the window is the signal; the boundary is inclusive', () => {
    expect(cherryPickSignals({ acceptedAt: t0, handedBackAt: after(30), windowS: 90 })).toEqual({ signals: ['QUICK_HANDBACK'], secondsAfterAccept: 30 });
    expect(cherryPickSignals({ acceptedAt: t0, handedBackAt: after(90), windowS: 90 })).toEqual({ signals: ['QUICK_HANDBACK'], secondsAfterAccept: 90 });
  });

  it('outside the window is nothing', () => {
    expect(cherryPickSignals({ acceptedAt: t0, handedBackAt: after(91), windowS: 90 })).toEqual({ signals: [], secondsAfterAccept: 91 });
  });

  it('no acceptedAt is an absence, never a signal (L10)', () => {
    expect(cherryPickSignals({ acceptedAt: null, handedBackAt: after(5), windowS: 90 })).toEqual({ signals: [], secondsAfterAccept: null });
  });

  it('the defaults are the Kerb §5.3 numbers, and the switch is on', () => {
    expect(ALGO_DEFAULTS['gaming.cherryWindowS']).toBe(90);
    expect(ALGO_DEFAULTS['ALG-30.enabled']).toBe(true);
  });
});

describe('fake completion: a DELIVERED with nothing behind it', () => {
  const near = [fix(DROP.lat + 0.001, DROP.lng, 3), fix(DROP.lat + 0.002, DROP.lng + 0.001, 1)];
  const far = [fix(DROP.lat + 0.045, DROP.lng, 3), fix(DROP.lat + 0.05, DROP.lng, 1)];

  it('fixes near the drop: nothing to see', () => {
    const a = completionSignals({ drop: DROP, radiusKm: 0.75, trace: near, declared: null, mockFlagAt: null });
    expect(a.signals).toEqual([]);
    expect(a.nearestFixKm).toBeLessThan(0.75);
    expect(a.fixesInWindow).toBe(2);
  });

  it('every fix far from the drop is the signal, with the nearest distance as evidence', () => {
    const a = completionSignals({ drop: DROP, radiusKm: 0.75, trace: far, declared: null, mockFlagAt: null });
    expect(a.signals).toEqual(['NO_FIX_NEAR_DROP']);
    expect(a.nearestFixKm).toBeGreaterThan(4);
  });

  it('an EMPTY trace is an absence, never a signal (L10) — a dead background task is not fraud', () => {
    const a = completionSignals({ drop: DROP, radiusKm: 0.75, trace: [], declared: null, mockFlagAt: null });
    expect(a.signals).toEqual([]);
    expect(a.nearestFixKm).toBeNull();
  });

  it('a handover declared from far away is its own signal, measured', () => {
    const a = completionSignals({ drop: DROP, radiusKm: 0.75, trace: near, declared: { lat: DROP.lat + 0.03, lng: DROP.lng }, mockFlagAt: null });
    expect(a.signals).toEqual(['DECLARED_FAR']);
    expect(a.declaredKm).toBeGreaterThan(3);
  });

  it('a recent mock-location flag counts, on its own', () => {
    const a = completionSignals({ drop: DROP, radiusKm: 0.75, trace: near, declared: null, mockFlagAt: new Date() });
    expect(a.signals).toEqual(['MOCK_LOCATION_RECENT']);
  });

  it('no drop coordinates: nothing can be measured, so nothing is said', () => {
    expect(completionSignals({ drop: null, radiusKm: 0.75, trace: far, declared: { lat: 0, lng: 0 }, mockFlagAt: null }).signals).toEqual([]);
  });
});

describe('the reviewer sentence', () => {
  it('is one sentence under the AlgoDecision cap, in prose — no signal tokens', () => {
    const a = completionSignals({
      drop: DROP, radiusKm: 0.75,
      trace: [fix(DROP.lat + 0.045, DROP.lng, 3)], declared: { lat: DROP.lat + 0.03, lng: DROP.lng }, mockFlagAt: new Date(),
    });
    const s = completionSentence(a, { radiusKm: 0.75, windowMinutes: 10, mockMinutesAgo: 12 });
    expect(s).toMatch(/^Completion needs a look: no position within 0\.75 km of the drop in the 10 min before \(1 fixes, nearest [\d.]+ km\); the handover position was [\d.]+ km from the drop; a mock location provider was flagged 12 min earlier\.$/);
    expect(s.length).toBeLessThanOrEqual(240);
    expect(s).not.toMatch(/NO_FIX_NEAR_DROP|DECLARED_FAR|MOCK_LOCATION_RECENT|fraud/i);
  });

  it('a long handback reason is trimmed so the sentence stays under the cap', () => {
    const s = cherryPickSentence({ secondsAfterAccept: 20, windowS: 90, handbacks24h: 3, quickHandbacks24h: 2, basket: 2000, legKm: 1.57, reason: 'x'.repeat(300) });
    expect(s.length).toBeLessThanOrEqual(240);
    expect(s).toMatch(/^Handed back 20 s after accepting \(window 90 s\): 3 handbacks in 24 h, 2 quick; basket 2000, leg 1\.57 km; reason “x{57}…”\.$/);
  });
});

describe('over HTTP: a row for the reviewer, nothing for the rider', () => {
  const PHONE_PREFIX = '+59200664';
  const DAY = 24 * 60 * 60 * 1000;
  const PICKUP = { lat: 6.8, lng: -58.15 };
  let app: FastifyInstance;
  let customerId: string;
  let vendorId: string;
  let founderToken: string;
  let adminToken: string;
  const riderIds: string[] = [];

  async function purge() {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (!ids.length) return;
    const riders = await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectType: 'RIDER', subjectId: { in: riders.map((r) => r.id) } } });
    for (const r of riders) await app.redis.del(traceKey('RIDER', r.id));
    await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  let seq = 10;
  async function makeRider() {
    seq += 1;
    const user = await app.prisma.user.create({
      data: {
        phone: `${PHONE_PREFIX}${seq}`, firstName: 'Game', lastName: `Rider${seq}`,
        roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole], activeRole: 'RIDER' as UserRole,
        isPhoneVerified: true, selfieCapturedAt: new Date(),
      },
    });
    const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
    const session = await app.prisma.session.create({
      data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'gaming', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    });
    const rider = await app.prisma.rider.create({
      data: {
        userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true,
        floatLimit: 1_000_000, isOnline: true, isAvailable: true, locationSessionId: session.id,
        currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date(),
        averageRating: 5, acceptanceRate: 100,
      },
    });
    riderIds.push(rider.id);
    return { userId: user.id, riderId: rider.id, token };
  }

  async function makeOrder(opts: { riderId: string; status: string; acceptedAt?: Date; paymentMethod?: 'CASH' | 'MOBILE_MONEY'; paymentStatus?: 'PENDING' | 'CAPTURED' }) {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `GM-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId,
        status: opts.status as any, fulfillment: 'DELIVERY', riderId: opts.riderId, acceptedAt: opts.acceptedAt ?? null,
        pickupAddress: 'Store', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
        deliveryAddress: 'Home', deliveryLat: DROP.lat, deliveryLng: DROP.lng,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500,
        paymentMethod: opts.paymentMethod ?? 'MOBILE_MONEY', paymentStatus: opts.paymentStatus ?? 'CAPTURED',
        ridePin: '123456',
      },
    });
    await app.prisma.rider.update({ where: { id: opts.riderId }, data: { currentOrderId: order.id, isAvailable: false } });
    return order;
  }

  const post = (url: string, token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${token}` } });
  const put = (url: string, token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url, payload, headers: { authorization: `Bearer ${token}` } });
  const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  const rows = (riderId: string) => app.prisma.algoDecision.findMany({ where: { algo: 'ALG-30', subjectId: riderId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'development';
    process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
    process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(authPlugin);
    await app.register(socketPlugin);
    await app.register(riderRoutes, { prefix: '/api/v1/rider' });
    await app.register(adminRoutes, { prefix: '/api/v1/admin' });
    await app.ready();
    await purge();

    const customer = await app.prisma.user.create({
      data: { phone: `${PHONE_PREFIX}02`, firstName: 'Game', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date() },
    });
    customerId = customer.id;
    const ownerUser = await app.prisma.user.create({
      data: { phone: `${PHONE_PREFIX}03`, firstName: 'Game', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() },
    });
    const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
    vendorId = (await app.prisma.vendor.create({
      data: {
        ownerId: owner.id, name: 'Game Diner', slug: `game-diner-${nanoid(5)}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}04`,
        addressLine1: '1 Game St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: PICKUP.lat, longitude: PICKUP.lng,
      },
    })).id;

    const founder = await app.prisma.user.create({
      data: { phone: `${PHONE_PREFIX}01`, firstName: 'Game', lastName: 'Founder', roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true, selfieCapturedAt: new Date(), admin: { create: { permissions: ['*'] } } },
    });
    founderToken = app.jwt.sign({ userId: founder.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: founder.id, token: founderToken, refreshToken: nanoid(40), deviceId: 'gaming', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const admin = await app.prisma.user.create({
      data: { phone: `${PHONE_PREFIX}05`, firstName: 'Game', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, selfieCapturedAt: new Date(), admin: { create: { permissions: ['*'] } } },
    });
    adminToken = app.jwt.sign({ userId: admin.id, role: 'ADMIN', jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: admin.id, token: adminToken, refreshToken: nanoid(40), deviceId: 'gaming', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  });

  afterAll(async () => {
    await app.prisma.algoConfig.deleteMany({ where: { key: KILL_SWITCH, updatedBy: 'rider-gaming.test' } });
    invalidateAlgoConfig();
    await purge();
    await app.close();
  });

  it('a handback 20 s after accepting writes the row with the evidence — and the response is exactly what it was', async () => {
    const r = await makeRider();
    const order = await makeOrder({ riderId: r.riderId, status: 'RIDER_ASSIGNED', acceptedAt: new Date(Date.now() - 20_000) });
    const res = await post(`/api/v1/rider/orders/${order.id}/handback`, r.token, { reason: 'too far for the money' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.data).sort()).toEqual(['orderId', 'status']);
    expect(JSON.stringify(body)).not.toMatch(/cherry|suspect|flag|ALG-30/i);

    const [row] = await rows(r.riderId);
    expect(row?.outcome).toBe(CHERRY_PICK_OUTCOME);
    expect(row?.shadow).toBe(false);
    const inputs = row!.inputs as Record<string, unknown>;
    expect(inputs['signals']).toEqual(['QUICK_HANDBACK']);
    expect(inputs['secondsAfterAccept']).toBeGreaterThanOrEqual(20);
    expect(inputs['secondsAfterAccept']).toBeLessThanOrEqual(25);
    expect(inputs['windowS']).toBe(90);
    expect(inputs['basket']).toBe(2000);
    expect(inputs['legKm']).toBeGreaterThan(1);
    expect(inputs['handbacks24h']).toBe(1);
    expect(inputs['quickHandbacks24h']).toBe(1);
    expect(inputs['orderId']).toBe(order.id);
    expect(row!.sentence).toMatch(/^Handed back \d+ s after accepting \(window 90 s\): 1 handbacks in 24 h, 1 quick; basket 2000, leg [\d.]+ km; reason “too far for the money”\.$/);
  });

  it('a second quick handback is clustered: the counts are the evidence the reviewer reads', async () => {
    const r = await makeRider();
    const a = await makeOrder({ riderId: r.riderId, status: 'RIDER_ASSIGNED', acceptedAt: new Date(Date.now() - 10_000) });
    expect((await post(`/api/v1/rider/orders/${a.id}/handback`, r.token, { reason: 'small basket' })).statusCode).toBe(200);
    const b = await makeOrder({ riderId: r.riderId, status: 'RIDER_EN_ROUTE_PICKUP', acceptedAt: new Date(Date.now() - 40_000) });
    expect((await post(`/api/v1/rider/orders/${b.id}/handback`, r.token, { reason: 'small basket again' })).statusCode).toBe(200);
    const all = await rows(r.riderId);
    expect(all.map((x) => x.outcome)).toEqual([CHERRY_PICK_OUTCOME, CHERRY_PICK_OUTCOME]);
    const second = all[1]!.inputs as Record<string, unknown>;
    expect(second['handbacks24h']).toBe(2);
    expect(second['quickHandbacks24h']).toBe(2);
  });

  it('a handback ten minutes in is a handback, not a signal — no row', async () => {
    const r = await makeRider();
    const order = await makeOrder({ riderId: r.riderId, status: 'RIDER_EN_ROUTE_PICKUP', acceptedAt: new Date(Date.now() - 10 * 60_000) });
    expect((await post(`/api/v1/rider/orders/${order.id}/handback`, r.token, { reason: 'bike trouble' })).statusCode).toBe(200);
    expect(await rows(r.riderId)).toEqual([]);
  });

  it('the kill switch: off means no assessment and no row, and the handback still works', async () => {
    const latest = await app.prisma.algoConfig.findFirst({ where: { tenantId: 'swift-default', key: KILL_SWITCH }, orderBy: { version: 'desc' } });
    await app.prisma.algoConfig.create({ data: { tenantId: 'swift-default', key: KILL_SWITCH, value: false, version: (latest?.version ?? 0) + 1, updatedBy: 'rider-gaming.test' } });
    invalidateAlgoConfig();
    try {
      const r = await makeRider();
      const order = await makeOrder({ riderId: r.riderId, status: 'RIDER_ASSIGNED', acceptedAt: new Date(Date.now() - 5_000) });
      expect((await post(`/api/v1/rider/orders/${order.id}/handback`, r.token, { reason: 'switch is off' })).statusCode).toBe(200);
      expect(await rows(r.riderId)).toEqual([]);
    } finally {
      await app.prisma.algoConfig.deleteMany({ where: { key: KILL_SWITCH, updatedBy: 'rider-gaming.test' } });
      invalidateAlgoConfig();
    }
  });

  it('a PIN completion with every recent fix 5 km from the drop writes the row; the rider sees a normal delivery', async () => {
    const r = await makeRider();
    const order = await makeOrder({ riderId: r.riderId, status: 'ARRIVED', acceptedAt: new Date(Date.now() - 30 * 60_000) });
    const key = traceKey('RIDER', r.riderId);
    await pushTrace(app.redis, key, { lat: DROP.lat + 0.045, lng: DROP.lng, at: new Date(Date.now() - 4 * 60_000) });
    await pushTrace(app.redis, key, { lat: DROP.lat + 0.05, lng: DROP.lng, at: new Date(Date.now() - 60_000) });
    const res = await put(`/api/v1/rider/orders/${order.id}/delivered`, r.token, { ridePin: '123456' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('DELIVERED');
    // Generated ids are random base36 and can spell anything (a CI run minted
    // `cmto4fake…`); grade the words the rider could read, not the ids.
    expect(JSON.stringify(res.json()).replace(/\bc[a-z0-9]{24}\b/g, '')).not.toMatch(/fake|suspect|flag|ALG-30/i);
    const [row] = await rows(r.riderId);
    expect(row?.outcome).toBe(FAKE_COMPLETION_OUTCOME);
    const inputs = row!.inputs as Record<string, unknown>;
    expect(inputs['signals']).toEqual(['NO_FIX_NEAR_DROP']);
    expect(inputs['fixesInWindow']).toBe(2);
    expect(inputs['nearestFixKm']).toBeGreaterThan(4);
    expect(inputs['radiusKm']).toBe(0.75);
    expect(row!.sentence).toMatch(/^Completion needs a look: no position within 0\.75 km of the drop in the 10 min before \(2 fixes, nearest [\d.]+ km\)\.$/);
  });

  it('a PIN completion with a fix at the door writes nothing; so does one with NO trace at all (L10)', async () => {
    const r = await makeRider();
    const atDoor = await makeOrder({ riderId: r.riderId, status: 'ARRIVED', acceptedAt: new Date(Date.now() - 30 * 60_000) });
    await pushTrace(app.redis, traceKey('RIDER', r.riderId), { lat: DROP.lat + 0.001, lng: DROP.lng, at: new Date(Date.now() - 60_000) });
    expect((await put(`/api/v1/rider/orders/${atDoor.id}/delivered`, r.token, { ridePin: '123456' })).statusCode).toBe(200);
    expect(await rows(r.riderId)).toEqual([]);

    await app.redis.del(traceKey('RIDER', r.riderId));
    const silent = await makeOrder({ riderId: r.riderId, status: 'EN_ROUTE_DELIVERY', acceptedAt: new Date(Date.now() - 30 * 60_000) });
    expect((await put(`/api/v1/rider/orders/${silent.id}/delivered`, r.token, { ridePin: '123456' })).statusCode).toBe(200);
    expect(await rows(r.riderId)).toEqual([]);
  });

  it('a cash handover declared 3 km from the drop is measured from the declared position; the payment still lands', async () => {
    const r = await makeRider();
    const order = await makeOrder({ riderId: r.riderId, status: 'ARRIVED', acceptedAt: new Date(Date.now() - 30 * 60_000), paymentMethod: 'CASH', paymentStatus: 'PENDING' });
    const res = await post(`/api/v1/rider/orders/${order.id}/handover`, r.token, { outcome: 'paid', gps: { lat: DROP.lat + 0.03, lng: DROP.lng } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('DELIVERED');
    expect(res.json().data.claim).toBeNull();
    const [row] = await rows(r.riderId);
    expect(row?.outcome).toBe(FAKE_COMPLETION_OUTCOME);
    const inputs = row!.inputs as Record<string, unknown>;
    // The trace is empty here: an absence, so NO_FIX_NEAR_DROP is NOT raised — only the declared distance is.
    expect(inputs['signals']).toEqual(['DECLARED_FAR']);
    expect(inputs['declaredKm']).toBeGreaterThan(3);
    expect(inputs['fixesInWindow']).toBe(0);
  });

  it('a mock-location flag from ALG-15 minutes earlier counts against a completion, on its own', async () => {
    const r = await makeRider();
    await app.prisma.algoDecision.create({
      data: {
        algo: 'ALG-15', subjectType: 'RIDER', subjectId: r.riderId, outcome: 'FLAGGED',
        sentence: 'Position needs a look: the device reported a mock location provider.',
        inputs: { signals: ['MOCK_PROVIDER'] }, createdAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    const order = await makeOrder({ riderId: r.riderId, status: 'ARRIVED', acceptedAt: new Date(Date.now() - 30 * 60_000) });
    await pushTrace(app.redis, traceKey('RIDER', r.riderId), { lat: DROP.lat + 0.001, lng: DROP.lng, at: new Date(Date.now() - 60_000) });
    expect((await put(`/api/v1/rider/orders/${order.id}/delivered`, r.token, { ridePin: '123456' })).statusCode).toBe(200);
    const [row] = await rows(r.riderId);
    expect(row?.outcome).toBe(FAKE_COMPLETION_OUTCOME);
    expect((row!.inputs as Record<string, unknown>)['signals']).toEqual(['MOCK_LOCATION_RECENT']);
    expect(row!.sentence).toMatch(/a mock location provider was flagged [45] min earlier\.$/);
  });

  it('the reviewer reads the queue — founder only, filtered, newest first, never a shadow row', async () => {
    const r = await makeRider();
    const order = await makeOrder({ riderId: r.riderId, status: 'RIDER_ASSIGNED', acceptedAt: new Date(Date.now() - 15_000) });
    expect((await post(`/api/v1/rider/orders/${order.id}/handback`, r.token, { reason: 'queue check' })).statusCode).toBe(200);
    await app.prisma.algoDecision.create({
      data: { algo: 'ALG-30', subjectType: 'RIDER', subjectId: r.riderId, outcome: 'WOULD_FLAG', sentence: 'Shadow science, not a case.', inputs: {}, shadow: true },
    });

    const res = await get(`/api/v1/admin/integrity/flags?algo=ALG-30&subjectId=${r.riderId}`, founderToken);
    expect(res.statusCode).toBe(200);
    const { flags, windowDays } = res.json().data;
    expect(windowDays).toBe(7);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ algo: 'ALG-30', subjectType: 'RIDER', subjectId: r.riderId, outcome: CHERRY_PICK_OUTCOME });
    expect(flags[0].inputs.signals).toEqual(['QUICK_HANDBACK']);
    expect(typeof flags[0].sentence).toBe('string');

    expect((await get('/api/v1/admin/integrity/flags?algo=nope', founderToken)).statusCode).toBe(400);
    expect((await get('/api/v1/admin/integrity/flags', adminToken)).statusCode).toBe(403);
  });
});
