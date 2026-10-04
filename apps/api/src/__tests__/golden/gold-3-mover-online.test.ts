import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { customAlphabet, nanoid } from 'nanoid';
import { PrismaClient, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { riderRoutes } from '../../modules/rider/rider.routes';
import courierRoutes from '../../modules/courier/courier.routes';
import { registerErrorHandler } from '../../middleware/error-handler';
import { makeDispatchService } from '../../modules/dispatch/dispatch.service';
import { riderStackingCapacity } from '../../modules/dispatch/concurrency-policy';
import * as algoStore from '../../modules/algo/algo-config';
import { assertFixtureReferences, lockFixtureParents } from '../helpers/cleanup-parents';
import { trackMessageInserts } from '../helpers/insert-ownership';
import { proveMessageRefusal, provePeerOrderRefusal } from '../helpers/cleanup-race';
import { recordDispatchQueue } from '../helpers/dispatch-queue';

const { invalidateAlgoConfig } = algoStore;

// ---------------------------------------------------------------------------
// GOLD-3 · RIDE-01 — a delivery mover goes online and streams a live location.
//
// Through the REAL mounted rider + courier routes as real device sessions,
// asserted on durable rows:
//   · going online needs a selfie and verified documents; a verified mover's
//     GO records the owning device session, the fix and the online flags
//   · the location stream: a fix inside the 10s database window is accepted
//     but not written; the first fix after it lands durably
//   · a background kill and relaunch on a second device rotates the stream
//     owner — the old device's late fix is refused and cannot overwrite
//   · going offline ends the stream: a late fix is an honest OFFLINE no-op
//   · a mover whose fix went stale is never offered work: the job waits and
//     the sender is told. The moment one phone reports a fresh fix, the
//     re-dispatch offers the job to THAT mover — past a nearer mover whose fix
//     is still stale, which proves staleness (not distance) kept both out
//
// Where a clock must pass, the one input that ages is moved: the route's own
// debounce stamp (10s write window) and the mover's last-fix time (phone gone
// quiet). Both are states the system reaches on its own by waiting.
//
// NOT asserted here (reported, G3-F3): the open-board entrance ignores fix
// freshness — a stale mover can still list and board-grab a job.
//
// Dispatch runs through the suite's acknowledged route→worker double
// (helpers/dispatch-queue.ts): `dispatch-order` executes the worker's own
// processor body (DispatchService.dispatchOrder) and delayed jobs are
// recorded, so a recorded re-dispatch is driven the way the worker would.
//
// Fixture range: +5920331 plus a run-unique numeric suffix.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = `+5920331${customAlphabet('0123456789', 4)()}`;
const FIXTURE = 'gold3-ride01-fixture';
// A quiet corner of Georgetown; fixes are 5-decimal literals so a round trip
// through float8 is exact.
const PICKUP = { lat: 6.79321, lng: -58.15874 };
const DROP = { lat: 6.77412, lng: -58.15311 };
const FIX_A = { latitude: 6.79335, longitude: -58.15862 };
const FIX_B = { latitude: 6.79402, longitude: -58.15797 };
const FIX_C = { latitude: 6.79444, longitude: -58.15751 };
const FIX_LATE = { latitude: 6.80111, longitude: -58.14999 };
/** The route's own database-write window (rider.routes.ts, PUT /location). */
const DB_WRITE_WINDOW_MS = 10_000;

let app: FastifyInstance;
let messageInserts: ReturnType<typeof trackMessageInserts>;
let jobs: ReturnType<typeof recordDispatchQueue>;
let seq = 0;
/** Every mover this file made — each test's supply is retired afterwards so
 *  no test's dispatch pass can offer to another test's mover. */
const movers: Array<{ riderId: string; device: Device }> = [];
const userIds: string[] = [];
const createdOrderIds: string[] = [];
let restoreCapacityRead: (() => void) | undefined;
let ownCapacityReads = 0;
const peerCapacityClient = new PrismaClient();
let peerCapacityBefore: number;
const peerTenant = `gold3-peer-${nanoid(16)}`;
let peerConfigId: string;
let sharedConfigBefore: unknown;
const sharedCapacityRows = () => peerCapacityClient.algoConfig.findMany({ where: { tenantId: 'swift-default', key: 'stacking.riderCapacity' }, orderBy: { id: 'asc' } });

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Device = { token: string; sessionId: string };

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole, opts: { selfie?: boolean } = {}) {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName,
      lastName: `Ride01U${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: opts.selfie === false ? null : new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  userIds.push(user.id);
  return { userId: user.id, device: await login(user.id, activeRole, `ride01-${seq}-a`) };
}

/** A real, live database session + JWT for one device — the authority that GO
 *  binds the location stream to. (The OTP login itself is AUTH-01's journey.) */
async function login(userId: string, role: UserRole, deviceId: string): Promise<Device> {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { token, sessionId: session.id };
}

/** A mover profile (onboarding is its own journey), created OFFLINE: every
 *  test brings it online through the real route. */
async function makeMover(firstName: string, opts: { selfie?: boolean; verified?: boolean } = {}) {
  const u = await makeUser(firstName, ['RIDER', 'CUSTOMER'], 'RIDER', { selfie: opts.selfie });
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: u.userId,
      riderType: 'BOTH',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: opts.verified !== false,
      floatLimit: 1_000_000,
    },
  }));
  const mover = { ...u, riderId: rider.id };
  movers.push(mover);
  return mover;
}

/** Retire this file's free supply through the real route (a mover mid-job is
 *  not available to dispatch anyway, and go-offline refuses it). */
async function retireSupply() {
  for (const m of movers) {
    const row = await riderRow(m.riderId);
    if (!row.isOnline || row.currentOrderId) continue;
    const off = await call('POST', '/api/v1/rider/go-offline', m.device.token);
    expect(off.statusCode, off.body).toBe(200);
  }
}

async function call(method: 'GET' | 'POST' | 'PUT', url: string, token?: string, payload?: unknown) {
  const result = await app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (method === 'POST' && url === '/api/v1/courier/order' && result.statusCode === 201) {
    const id = result.json().data?.orderId;
    if (typeof id !== 'string') throw new Error('GOLD-3 courier order returned no id');
    createdOrderIds.push(id);
  }
  return result;
}

const riderRow = (riderId: string) => sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id: riderId } }));
const debounceKey = (riderId: string) => `rider:location_db_ts:${riderId}`;
const offerKey = (orderId: string) => `dispatch:offer:${orderId}`;

/** The 10s database-write window elapses. The route decides from exactly one
 *  input — the stamp IT wrote at the last persisted fix — so moving that stamp
 *  back by the window is the only thing the passage of time changes. */
async function letDbWindowElapse(riderId: string) {
  const stamp = await app.redis.get(debounceKey(riderId));
  expect(stamp, 'the route stamped its last database write').not.toBeNull();
  await app.redis.set(debounceKey(riderId), String(Number(stamp) - DB_WRITE_WINDOW_MS - 1_000));
}

async function goOnline(mover: { device: Device }, fix = FIX_A) {
  const res = await call('POST', '/api/v1/rider/go-online', mover.device.token, fix);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().data).toEqual({ isOnline: true, isAvailable: true });
}

const COURIER_BODY = {
  pickup: PICKUP,
  dropoff: DROP,
  pickupAddress: '14 Ride01 Street, Georgetown',
  dropoffAddress: '9 Ride01 Road, Georgetown',
  packageSize: 'SMALL' as const,
  speed: 'STANDARD' as const,
  recipientName: 'Ride Zero One',
  recipientPhone: `${PHONE_PREFIX}999`,
};

async function purgeFixtures() {
  await sys(async () => {
    const ids = [...userIds];
    if (ids.length === 0) return;
    const orderIds = [...createdOrderIds];
    let riderIds: string[] = [];
    await app.prisma.$transaction(async (tx) => {
      const parents = await lockFixtureParents(tx, ids);
      riderIds = parents.riderIds;
      await assertFixtureReferences(tx, 'GOLD-3', ids, parents, orderIds, [...messageInserts.notificationIds]);
      if (await tx.subscription.count({ where: { vendorId: { in: parents.vendorIds } } })) throw new Error('Foreign vendor subscriptions block fixture cleanup');
      await tx.alertDelivery.deleteMany({ where: { id: { in: [...messageInserts.alertIds] } } });
      await tx.notification.deleteMany({ where: { id: { in: [...messageInserts.notificationIds] } } });
      await tx.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds] } } });
      await tx.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
      await tx.earning.deleteMany({ where: { orderId: { in: orderIds } } });
      await tx.order.deleteMany({ where: { id: { in: orderIds } } });
      await tx.session.deleteMany({ where: { userId: { in: ids } } });
      await tx.rider.deleteMany({ where: { id: { in: riderIds } } });
      await tx.customer.deleteMany({ where: { userId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });
    }, { timeout: 30_000 });
    await purgeRedis([...ids, ...riderIds, ...orderIds]);
  });
}

/** Redis bookkeeping keyed by this file's ids (debounce stamps, online-hours,
 *  offer epochs, idempotency) — removed so a re-run starts clean. */
async function purgeRedis(ids: string[]) {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(/[:]/).some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

beforeAll(async () => {
  invalidateAlgoConfig('swift-default', 'stacking.riderCapacity');
  peerCapacityBefore = await riderStackingCapacity(peerCapacityClient);
  const peerConfig = await peerCapacityClient.algoConfig.create({ data: { tenantId: peerTenant, key: 'stacking.riderCapacity', value: 1, version: 1, updatedBy: FIXTURE } });
  peerConfigId = peerConfig.id;
  expect(await algoStore.algoValue(peerCapacityClient, 'stacking.riderCapacity', peerTenant)).toBe(1);
  sharedConfigBefore = await sharedCapacityRows();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  // The production composition root gives every request a fresh tenant store
  // before auth (app.ts) — replicated here.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  jobs = recordDispatchQueue(app, true);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
  messageInserts = trackMessageInserts(app.prisma);
  // Intercept only this client's capacity read at the existing config seam.
  // No shared DB version, no cache entry, no dispatch/claim replacement. All
  // other keys, tenants and clients still execute the production reader.
  const readConfig = algoStore.algoValue;
  const capacityRead = vi.spyOn(algoStore, 'algoValue').mockImplementation(((prisma, key, tenantId = 'swift-default') => {
    if (prisma === app.prisma && key === 'stacking.riderCapacity' && tenantId === 'swift-default') {
      ownCapacityReads += 1;
      return Promise.resolve(3);
    }
    return readConfig(prisma, key, tenantId);
  }) as typeof algoStore.algoValue);
  restoreCapacityRead = () => capacityRead.mockRestore();

});

afterAll(async () => {
  await purgeFixtures();
  messageInserts.restore();
  restoreCapacityRead?.();
  expect(await sharedCapacityRows()).toEqual(sharedConfigBefore);
  invalidateAlgoConfig('swift-default', 'stacking.riderCapacity');
  await app.close();
  if (peerConfigId) await peerCapacityClient.algoConfig.delete({ where: { id: peerConfigId } });
  invalidateAlgoConfig(peerTenant, 'stacking.riderCapacity');
  await peerCapacityClient.$disconnect();
});

afterEach(async () => {
  await retireSupply();
});

describe('GOLD-3 · RIDE-01 — go online + live location', () => {
  it('keeps the peer capacity-one reader unchanged while the harness gets capacity three', async () => {
    expect(await algoStore.algoValue(peerCapacityClient, 'stacking.riderCapacity', peerTenant)).toBe(1);
    expect(await riderStackingCapacity(app.prisma)).toBe(3);
    invalidateAlgoConfig('swift-default', 'stacking.riderCapacity');
    expect(await riderStackingCapacity(peerCapacityClient)).toBe(peerCapacityBefore);
    expect(await sharedCapacityRows()).toEqual(sharedConfigBefore);
  });

  it('only a verified mover with a selfie goes online; GO records the owning device session, the fix and the flags', async () => {
    const customer = await makeUser('Cora', ['CUSTOMER'], 'CUSTOMER');
    const noSelfie = await makeMover('Nell', { selfie: false });
    const unverified = await makeMover('Uri', { verified: false });
    const mover = await makeMover('Maya');
    const presence = async (riderId: string) => {
      const r = await riderRow(riderId);
      return { online: r.isOnline, available: r.isAvailable, owner: r.locationSessionId, lat: r.currentLat, lng: r.currentLng, at: r.lastLocationUpdate, updatedAt: r.updatedAt };
    };
    const beforeRefusals = { noSelfie: await presence(noSelfie.riderId), unverified: await presence(unverified.riderId) };
    // A never-online profile: offline, no stream owner, no fix.
    expect(beforeRefusals.noSelfie).toMatchObject({ online: false, owner: null, lat: null, lng: null, at: null });
    expect(beforeRefusals.unverified).toMatchObject({ online: false, owner: null, lat: null, lng: null, at: null });

    // A customer account has no mover profile to put online.
    const notMover = await call('POST', '/api/v1/rider/go-online', customer.device.token, FIX_A);
    expect(notMover.statusCode).toBe(403);
    expect(notMover.json().error.code).toBe('FORBIDDEN');

    const selfie = await call('POST', '/api/v1/rider/go-online', noSelfie.device.token, FIX_A);
    expect(selfie.statusCode).toBe(403);
    expect(selfie.json().error.code).toBe('SELFIE_REQUIRED');

    const docs = await call('POST', '/api/v1/rider/go-online', unverified.device.token, FIX_A);
    expect(docs.statusCode).toBe(403);
    expect(docs.json().error.code).toBe('VERIFICATION_REQUIRED');

    // The refused movers are exactly as they were — not a column moved.
    expect(await presence(noSelfie.riderId)).toEqual(beforeRefusals.noSelfie);
    expect(await presence(unverified.riderId)).toEqual(beforeRefusals.unverified);

    const before = Date.now();
    await goOnline(mover, FIX_A);
    const after = Date.now();

    const row = await riderRow(mover.riderId);
    expect(row.isOnline).toBe(true);
    expect(row.isAvailable).toBe(true);
    expect(row.locationSessionId).toBe(mover.device.sessionId);
    expect({ lat: row.currentLat, lng: row.currentLng }).toEqual({ lat: FIX_A.latitude, lng: FIX_A.longitude });
    expect(row.lastLocationUpdate!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.lastLocationUpdate!.getTime()).toBeLessThanOrEqual(after);
    const account = await sys(() => app.prisma.user.findUniqueOrThrow({ where: { id: mover.userId } }));
    expect(account.lastMoverRole).toBe('RIDER');
    // GO stamps the database-write window the stream is debounced against.
    const stamp = Number(await app.redis.get(debounceKey(mover.riderId)));
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  it('a fix inside the 10s window is accepted but not written; the first fix after it lands durably', async () => {
    const mover = await makeMover('Lior');
    await goOnline(mover, FIX_A);
    const online = await riderRow(mover.riderId);

    const early = await call('PUT', '/api/v1/rider/location', mover.device.token, FIX_B);
    expect(early.statusCode).toBe(200);
    expect(early.json()).toEqual({ success: true });
    const unchanged = await riderRow(mover.riderId);
    expect({ lat: unchanged.currentLat, lng: unchanged.currentLng, at: unchanged.lastLocationUpdate })
      .toEqual({ lat: FIX_A.latitude, lng: FIX_A.longitude, at: online.lastLocationUpdate });

    await letDbWindowElapse(mover.riderId);
    const before = Date.now();
    const next = await call('PUT', '/api/v1/rider/location', mover.device.token, FIX_C);
    const after = Date.now();
    expect(next.statusCode).toBe(200);
    expect(next.json()).toEqual({ success: true });
    const written = await riderRow(mover.riderId);
    expect({ lat: written.currentLat, lng: written.currentLng }).toEqual({ lat: FIX_C.latitude, lng: FIX_C.longitude });
    expect(written.lastLocationUpdate!.getTime()).toBeGreaterThanOrEqual(before);
    expect(written.lastLocationUpdate!.getTime()).toBeLessThanOrEqual(after);
    expect(written.locationSessionId).toBe(mover.device.sessionId);
  });

  it('a background kill and relaunch rotates the stream owner: the old device is refused and cannot overwrite the new fix', async () => {
    const mover = await makeMover('Remi');
    await goOnline(mover, FIX_A);

    // The OS killed the app; the mover relaunches and logs in on a new device
    // session, which wins GO and becomes the stream's owner.
    const relaunched = await login(mover.userId, 'RIDER', 'ride01-relaunch');
    const go = await call('POST', '/api/v1/rider/go-online', relaunched.token, FIX_B);
    expect(go.statusCode, go.body).toBe(200);
    const rotated = await riderRow(mover.riderId);
    expect(rotated.locationSessionId).toBe(relaunched.sessionId);
    expect({ lat: rotated.currentLat, lng: rotated.currentLng }).toEqual({ lat: FIX_B.latitude, lng: FIX_B.longitude });

    // The old device's queued fix arrives late — past the write window, so the
    // ONLY thing that can keep it out is the ownership check.
    await letDbWindowElapse(mover.riderId);
    const stale = await call('PUT', '/api/v1/rider/location', mover.device.token, FIX_LATE);
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toEqual({ success: true, data: { accepted: false, reason: 'SESSION_REPLACED' } });
    const kept = await riderRow(mover.riderId);
    expect({ owner: kept.locationSessionId, lat: kept.currentLat, lng: kept.currentLng, at: kept.lastLocationUpdate })
      .toEqual({ owner: relaunched.sessionId, lat: FIX_B.latitude, lng: FIX_B.longitude, at: rotated.lastLocationUpdate });

    // The relaunched device keeps streaming.
    const fresh = await call('PUT', '/api/v1/rider/location', relaunched.token, FIX_C);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toEqual({ success: true });
    const streamed = await riderRow(mover.riderId);
    expect({ lat: streamed.currentLat, lng: streamed.currentLng }).toEqual({ lat: FIX_C.latitude, lng: FIX_C.longitude });
  });

  it('going offline ends the stream: a late fix is an honest OFFLINE no-op and nothing is written', async () => {
    const mover = await makeMover('Odi');
    await goOnline(mover, FIX_A);

    const off = await call('POST', '/api/v1/rider/go-offline', mover.device.token);
    expect(off.statusCode).toBe(200);
    expect(off.json().data).toEqual({ isOnline: false, isAvailable: false });
    const offline = await riderRow(mover.riderId);
    expect({ online: offline.isOnline, available: offline.isAvailable, owner: offline.locationSessionId })
      .toEqual({ online: false, available: false, owner: null });

    await letDbWindowElapse(mover.riderId);
    const late = await call('PUT', '/api/v1/rider/location', mover.device.token, FIX_LATE);
    expect(late.statusCode).toBe(200);
    expect(late.json()).toEqual({ success: true, data: { accepted: false, reason: 'OFFLINE' } });
    const after = await riderRow(mover.riderId);
    expect({ lat: after.currentLat, lng: after.currentLng, at: after.lastLocationUpdate, owner: after.locationSessionId })
      .toEqual({ lat: FIX_A.latitude, lng: FIX_A.longitude, at: offline.lastLocationUpdate, owner: null });
  });

  it('a stale fix is never offered work; after the phone reports a fresh fix the re-dispatch offers the job to that mover and only them', async () => {
    const sender = await makeUser('Sade', ['CUSTOMER'], 'CUSTOMER');
    // Two movers, both online. The NEARER one's fix goes stale and stays stale.
    const stale = await makeMover('Stan');
    const mover = await makeMover('Mira');
    await goOnline(stale, { latitude: PICKUP.lat, longitude: PICKUP.lng });
    await goOnline(mover, FIX_B);

    // Both phones stop reporting. Five minutes of silence is past dispatch's
    // 90s freshness window and inside the 15-minute stale-movers sweep, so both
    // are still flagged online. (Time travel on the one column that ages.)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);
    await sys(() => app.prisma.rider.updateMany({ where: { id: { in: [stale.riderId, mover.riderId] } }, data: { lastLocationUpdate: fiveMinutesAgo } }));

    const capacityReadsBefore = ownCapacityReads;
    const jobsBefore = jobs.length;
    const created = await call('POST', '/api/v1/courier/order', sender.device.token, COURIER_BODY);
    expect(created.statusCode, created.body).toBe(201);
    const orderId = created.json().data.orderId as string;

    // The route handed the job to dispatch; the worker's pass found no fresh
    // mover, told the sender honestly, and scheduled ONE delayed re-dispatch.
    const newJobs = jobs.slice(jobsBefore);
    expect(newJobs.map((j) => ({ name: j.name, orderId: j.data.orderId, delay: j.options.delay ?? 0 })))
      .toEqual([
        { name: 'dispatch-order', orderId, delay: 0 },
        { name: 'dispatch-order', orderId, delay: 90_000 },
      ]);
    expect(await app.redis.get(offerKey(orderId))).toBeNull();
    const waiting = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: orderId } }));
    expect({ status: waiting.status, rider: waiting.riderId }).toEqual({ status: 'READY_FOR_PICKUP', rider: null });
    const told = await sys(() => app.prisma.notification.findMany({ where: { userId: sender.userId }, select: { title: true, data: true } }));
    expect(told.map((n) => n.title)).toEqual(['Still looking for a mover']);

    // Neither stale mover holds a card, and neither can take one.
    for (const m of [stale, mover]) {
      const current = await call('GET', '/api/v1/rider/offers/current', m.device.token);
      expect(current.statusCode).toBe(200);
      expect(current.json().data.offer).toBeNull();
      const steal = await call('POST', '/api/v1/rider/offers/accept', m.device.token, { orderId });
      expect(steal.statusCode).toBe(409);
      expect(steal.json().error.code).toBe('OFFER_EXPIRED');
    }

    // Mira's phone comes back and reports a fresh fix.
    await letDbWindowElapse(mover.riderId);
    const pingFrom = Date.now();
    const ping = await call('PUT', '/api/v1/rider/location', mover.device.token, FIX_C);
    const pingBy = Date.now();
    expect(ping.statusCode).toBe(200);
    const refreshed = await riderRow(mover.riderId);
    expect({ lat: refreshed.currentLat, lng: refreshed.currentLng }).toEqual({ lat: FIX_C.latitude, lng: FIX_C.longitude });
    expect(refreshed.lastLocationUpdate!.getTime()).toBeGreaterThanOrEqual(pingFrom);
    expect(refreshed.lastLocationUpdate!.getTime()).toBeLessThanOrEqual(pingBy);
    expect((await riderRow(stale.riderId)).lastLocationUpdate).toEqual(fiveMinutesAgo);

    // The recorded re-dispatch runs exactly as the worker runs it.
    const result = await makeDispatchService(app).dispatchOrder(orderId);
    expect(result).toEqual({ offered: mover.riderId });
    const live = await app.redis.get(offerKey(orderId));
    expect(live!.split(':')[0]).toBe(mover.riderId);
    const card = await call('GET', '/api/v1/rider/offers/current', mover.device.token);
    expect(card.json().data.offer.orderId).toBe(orderId);
    expect((await call('GET', '/api/v1/rider/offers/current', stale.device.token)).json().data.offer).toBeNull();
    expect(await sys(() => app.prisma.alertDelivery.count({ where: { kind: 'MOVER_OFFER', subjectId: orderId } }))).toBe(1);
    expect(await sys(() => app.prisma.alertDelivery.count({ where: { kind: 'MOVER_OFFER', subjectId: orderId, recipientId: mover.userId } }))).toBe(1);

    // The still-stale mover cannot take the card that is not theirs.
    const theft = await call('POST', '/api/v1/rider/offers/accept', stale.device.token, { orderId });
    expect(theft.statusCode).toBe(409);
    expect(theft.json().error.code).toBe('OFFER_EXPIRED');

    // The card names its attempt, as the app sends it: only an accept that names
    // one is acknowledged against a generated card [AX358].
    const offerAttemptId = card.json().data.offer.offerAttemptId as string;
    expect(offerAttemptId).toBe(live!.split(':')[1]);
    const acceptedFrom = Date.now();
    const accept = await call('POST', '/api/v1/rider/offers/accept', mover.device.token, { orderId, offerAttemptId });
    const acceptedBy = Date.now();
    expect(accept.statusCode, accept.body).toBe(200);
    expect(accept.json().data.status).toBe('RIDER_ASSIGNED');

    const [order, won, left, assigned, alert] = await Promise.all([
      sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: orderId } })),
      riderRow(mover.riderId),
      riderRow(stale.riderId),
      sys(() => app.prisma.orderStatusLog.count({ where: { orderId, status: 'RIDER_ASSIGNED' } })),
      sys(() => app.prisma.alertDelivery.findFirstOrThrow({ where: { kind: 'MOVER_OFFER', subjectId: orderId } })),
    ]);
    expect({ status: order.status, rider: order.riderId }).toEqual({ status: 'RIDER_ASSIGNED', rider: mover.riderId });
    expect(ownCapacityReads, 'real dispatch and accept traversed the private config read').toBeGreaterThan(capacityReadsBefore);
    // This client reads stacking capacity three, so one live leg
    // still leaves room: the winner stays available for another leg.
    expect(await riderStackingCapacity(app.prisma)).toBe(3);
    expect({ pointer: won.currentOrderId, available: won.isAvailable }).toEqual({ pointer: orderId, available: true });
    expect({ pointer: left.currentOrderId, available: left.isAvailable }).toEqual({ pointer: null, available: true });
    expect(assigned).toBe(1);
    expect(alert.recipientId).toBe(mover.userId);
    expect(alert.acknowledgedAt!.getTime()).toBeGreaterThanOrEqual(acceptedFrom);
    expect(alert.acknowledgedAt!.getTime()).toBeLessThanOrEqual(acceptedBy);
    expect(await app.redis.get(offerKey(orderId))).toBeNull();

    // A double tap on the consumed card changes nothing — and, being the
    // winner's own tap, it is answered with the job they already hold, not a
    // refusal that reads as losing it [DISPATCH 1/3 · B3].
    const again = await call('POST', '/api/v1/rider/offers/accept', mover.device.token, { orderId });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data).toMatchObject({ orderId, status: 'RIDER_ASSIGNED' });
    expect(await sys(() => app.prisma.orderStatusLog.count({ where: { orderId, status: 'RIDER_ASSIGNED' } }))).toBe(1);
  });
});

it('atomically refuses existing and lock-scheduled late peer orders referencing a GOLD3 rider', async () => {
  const mover = await makeMover('Cleanup');
  await provePeerOrderRefusal(app.prisma, purgeFixtures, { table: 'riders', id: mover.riderId, userId: mover.userId });
});

it('owns GOLD3 messages only after successful inserts and refuses existing and late peer notices atomically', async () => {
  const user = await makeUser('Cleanup messages', ['CUSTOMER'], 'CUSTOMER');
  const order = await sys(() => app.prisma.order.create({ data: { customerId: user.userId, orderNumber: `G3MSG-${nanoid(16)}`, orderType: 'COURIER', fulfillment: 'DELIVERY', status: 'PENDING',
    deliveryAddress: 'Fixture Lane', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 1200, totalAmount: 1200, paymentMethod: 'CASH' } }));
  createdOrderIds.push(order.id);
  await retireSupply();
  await proveMessageRefusal(app.prisma, purgeFixtures, user.userId, order.id);
  movers.length = 0;
});
