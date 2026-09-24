import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { safetyRoutes } from '../../modules/safety/safety.routes';
import { registerErrorHandler } from '../../middleware/error-handler';
import { GuardianService } from '../../modules/safety/guardian.service';
import { tripShareDigest } from '../../modules/safety/trip-share.service';

// ---------------------------------------------------------------------------
// GOLD-4 · SAFE-02 — trip share + Trip Guardian golden journey, through the
// REAL mounted safety routes as real role sessions, asserted on durable rows:
//   · a passenger shares a live taxi trip; the unauthenticated public read
//     serves exactly the narrow payload and nothing private
//   · revocation closes the link; neither a stranger nor the trip's own driver
//     can mint or revoke the passenger's link
//   · stale links read as one indistinguishable null: past the mint ceiling,
//     unknown, or past the end of the trip (which first stops showing where
//     the driver is) — and an ended trip cannot be shared again
//   · the REAL guardian ladder raises the check-in on an overdue ride; OK
//     de-escalates it, NEED_HELP mints an immediate ACTIVE SOS and pages ops;
//     neither a stranger nor the driver can answer the passenger's check-in
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
const createdSosAlertIds: string[] = [];
let seq = 0;
// This file's own fixture range (+59202418nnn): audited against every phone
// literal, purge prefix and random phone range under apps/api/src.
const PHONE_PREFIX = '+59202418';
const SWEEP_CURSOR = 'gold4-safe02';

type Actor = { userId: string; token: string };

async function makeUserWithSession(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await runWithoutTenant(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName,
      lastName: `Safe02U${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await runWithoutTenant(() => app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'gold4-safe02',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  }));
  return { userId: user.id, token };
}

function post(url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: 'POST',
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

function del(url: string, token: string) {
  return app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${token}` } });
}

function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

/** The unauthenticated public read — its own caller bucket so one file's views
 *  never eat another file's per-minute allowance. */
function publicGet(token: string) {
  return app.inject({ method: 'GET', url: `/api/v1/safety/public/trip/${token}`, remoteAddress: '10.43.0.4' });
}

async function makeDriver(user: Actor, plate: string, vehicle: { make: string; model: string; color: string }, fix: { lat: number; lng: number }) {
  const driver = await runWithoutTenant(() => app.prisma.driver.create({
    data: {
      userId: user.userId,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: 2019,
      vehicleColor: vehicle.color,
      licensePlate: plate,
      driverLicenseUrl: 'storage://test/licence.jpg',
      vehicleInsuranceUrl: 'storage://test/insurance.jpg',
      currentLat: fix.lat,
      currentLng: fix.lng,
      lastLocationUpdate: new Date(),
      totalRides: 500,
      createdAt: new Date(Date.now() - 90 * DAY),
    },
  }));
  return driver.id;
}

/** Taxi-ride scaffolding in its RIDE_IN_PROGRESS state (the dispatch + PIN
 *  ceremony that gets it there is GOLD-3's journey). An OVERDUE ride — picked
 *  up two hours ago on a 20-minute plan — is what the guardian's overdue
 *  detector flags, so the real ladder raises the soft check-in by itself. */
async function makeRide(driverId: string, customerId: string, marker: string, opts: { overdue: boolean }) {
  const order = await runWithoutTenant(() => app.prisma.order.create({
    data: {
      orderNumber: `G4S2-${marker}-${nanoid(8)}`,
      orderType: 'TAXI',
      customerId,
      driverId,
      status: 'RIDE_IN_PROGRESS',
      fulfillment: 'DELIVERY',
      pickupAddress: 'Stabroek Market',
      pickupLat: 6.8045,
      pickupLng: -58.1622,
      deliveryAddress: '123 Secret Street, Georgetown',
      deliveryLat: 6.8145,
      deliveryLng: -58.1522,
      subtotalBase: 1500,
      subtotalMarkup: 0,
      subtotalCustomer: 1500,
      deliveryFee: 0,
      totalAmount: 1500,
      taxiFareTotal: 1500,
      paymentMethod: 'CASH',
      pickedUpAt: new Date(Date.now() - (opts.overdue ? 2 * 3600_000 : 10 * 60_000)),
      taxiDuration: opts.overdue ? 20 : 60,
    },
  }));
  createdOrderIds.push(order.id);
  return order;
}

/** One tick of the REAL guardian sweep (open sessions for live taxi rides,
 *  run the detectors and the ladder). A dedicated cursor key isolates this
 *  file's persisted cursors from every other suite. */
const sweep = () => new GuardianService(app.prisma, app.io, { cursorKey: SWEEP_CURSOR }).sweep(new Date());
const sessionOf = (orderId: string) => runWithoutTenant(() => app.prisma.tripSafetySession.findUniqueOrThrow({ where: { orderId } }));
const shareRow = (token: string) => runWithoutTenant(() => app.prisma.tripShareToken.findUniqueOrThrow({ where: { tokenDigest: tripShareDigest(token) } }));
async function mint(orderId: string, actor: Actor): Promise<string> {
  const res = await post(`/api/v1/safety/trips/${orderId}/share`, {}, actor.token);
  expect(res.statusCode).toBe(200);
  return (res.json().data as { token: string }).token;
}

let asha: Actor; // passenger on trip 1
let nia: Actor; // passenger on the stale-link trip, then trip 2
let deo: Actor; // driver of trip 1
let ravi: Actor; // driver of the stale-link trip and trip 2
let kofi: Actor; // a stranger to every trip
let deoDriverId: string;
let raviDriverId: string;
let order1Id: string;
let session1Id: string;

async function purgeFixtures() {
  await runWithoutTenant(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const userIds = [...new Set([...createdUserIds, ...users.map((u) => u.id)])];
    const orders = await app.prisma.order.findMany({
      where: { OR: [{ id: { in: createdOrderIds } }, { customerId: { in: userIds } }] },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);
    const alerts = await app.prisma.sosAlert.findMany({
      where: { OR: [{ id: { in: createdSosAlertIds } }, { actorUserId: { in: userIds } }, { orderId: { in: orderIds } }] },
      select: { id: true },
    });
    const alertIds = alerts.map((a) => a.id);
    if (alertIds.length) {
      // Ops pages also reach platform responders this file did not create —
      // remove exactly the inbox rows that reference this file's alerts.
      await app.prisma.notification.deleteMany({
        where: { OR: alertIds.map((id) => ({ data: { path: ['sosAlertId'], equals: id } })) },
      });
      await app.prisma.evidenceBundle.deleteMany({ where: { sosAlertId: { in: alertIds } } });
      await app.prisma.opsAlert.deleteMany({ where: { sosAlertId: { in: alertIds } } });
      await app.prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
    }
    if (orderIds.length) {
      await app.prisma.tripShareToken.deleteMany({ where: { orderId: { in: orderIds } } });
      await app.prisma.tripSafetySession.deleteMany({ where: { orderId: { in: orderIds } } });
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (userIds.length) {
      await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app.prisma.sweepCursor.deleteMany({
      where: { workType: { in: [`guardian.open:${SWEEP_CURSOR}`, `guardian.reconcile:${SWEEP_CURSOR}`] } },
    });
    createdUserIds.length = 0;
    createdOrderIds.length = 0;
    createdSosAlertIds.length = 0;
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  // The production composition root (app.ts) gives every request a fresh
  // tenant store before auth — replicate it.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();

  await purgeFixtures();

  asha = await makeUserWithSession('Asha', ['CUSTOMER'], 'CUSTOMER');
  nia = await makeUserWithSession('Nia', ['CUSTOMER'], 'CUSTOMER');
  deo = await makeUserWithSession('Deo', ['MOVER'], 'MOVER');
  ravi = await makeUserWithSession('Ravi', ['MOVER'], 'MOVER');
  kofi = await makeUserWithSession('Kofi', ['CUSTOMER'], 'CUSTOMER');
  deoDriverId = await makeDriver(deo, 'G4 0702', { make: 'Toyota', model: 'Allion', color: 'Silver' }, { lat: 6.8013, lng: -58.1553 });
  raviDriverId = await makeDriver(ravi, 'G4 0703', { make: 'Nissan', model: 'Tiida', color: 'White' }, { lat: 6.8031, lng: -58.1581 });

  // Trip 1: Asha's live, overdue ride. ONE tick of the real sweep opens its
  // guardian session and — because the overdue detector flags it — raises the
  // L2 soft check-in through the ladder.
  const order1 = await makeRide(deoDriverId, asha.userId, 'one', { overdue: true });
  order1Id = order1.id;
  await sweep();
  const session1 = await sessionOf(order1Id);
  session1Id = session1.id;
  expect(session1.passengerUserId).toBe(asha.userId);
  expect(session1.driverUserId).toBe(deo.userId);
  expect(session1.status).toBe('MONITORING');
  expect(session1.checkinRequestedAt).toBeInstanceOf(Date);
  expect((session1.deviationState as { flags?: { overdue?: string } }).flags?.overdue).toBeTruthy();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('GOLD-4 · SAFE-02 — share a trip, follow it publicly, revoke it', () => {
  it('the passenger shares; the public read serves only the narrow payload; only the passenger can mint or revoke; revocation closes the link', async () => {
    const share = await post(`/api/v1/safety/trips/${order1Id}/share`, {}, asha.token);
    expect(share.statusCode).toBe(200);
    const { token, url, expiresAt } = share.json().data as { token: string; url: string; expiresAt: string };
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
    expect(url).toContain(`/trip/${token}`);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Durable: only the digest is stored — the bearer secret never is.
    const row = await shareRow(token);
    expect(row.token).toBeNull();
    expect(row.orderId).toBe(order1Id);
    expect(row.createdByUserId).toBe(asha.userId);
    expect(row.revokedAt).toBeNull();

    // The UNAUTHENTICATED public read: first names, driver + vehicle, a live
    // fix, a human status — and NOTHING private.
    const view = await publicGet(token);
    expect(view.statusCode).toBe(200);
    const payload = view.json().data;
    expect(payload.passengerFirstName).toBe('Asha');
    expect(payload.status).toBe('Trip in progress');
    expect(payload.ended).toBe(false);
    expect(payload.driver.firstName).toBe('Deo');
    expect(payload.driver.plate).toBe('G4 0702');
    expect(payload.driver.vehicle).toBe('Silver Toyota Allion');
    expect(payload.location).toMatchObject({ lat: 6.8013, lng: -58.1553 });
    const flat = JSON.stringify(payload);
    for (const secret of ['Secret Street', 'Stabroek', 'Safe02', order1Id, asha.userId, deo.userId, deoDriverId, PHONE_PREFIX.slice(1)]) {
      expect(flat).not.toContain(secret);
    }

    // Neither a stranger nor the trip's own driver can mint the passenger's
    // share (404 by absence — nothing learned about the trip).
    expect((await post(`/api/v1/safety/trips/${order1Id}/share`, {}, kofi.token)).statusCode).toBe(404);
    expect((await post(`/api/v1/safety/trips/${order1Id}/share`, {}, deo.token)).statusCode).toBe(404);
    expect(await runWithoutTenant(() => app.prisma.tripShareToken.count({ where: { orderId: order1Id } }))).toBe(1);

    // Revocation by the sharer is durable and closes the public read.
    const revoke = await del(`/api/v1/safety/share/${token}`, asha.token);
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().data.revoked).toBe(true);
    expect((await shareRow(token)).revokedAt).toBeInstanceOf(Date);
    const afterRevoke = await publicGet(token);
    expect(afterRevoke.statusCode).toBe(404);
    expect(afterRevoke.json().error.code).toBe('SHARE_NOT_AVAILABLE');
  });

  it('a wrong-account revoke is refused and the link stays live; a link past its ceiling and an unknown token read as the same null', async () => {
    const tokenA = await mint(order1Id, asha);
    const strangerRevoke = await del(`/api/v1/safety/share/${tokenA}`, kofi.token);
    expect(strangerRevoke.statusCode).toBe(404);
    expect((await del(`/api/v1/safety/share/${tokenA}`, deo.token)).statusCode).toBe(404);
    expect((await shareRow(tokenA)).revokedAt).toBeNull();
    expect((await publicGet(tokenA)).statusCode).toBe(200);

    // Past the hard mint ceiling (moved onto the past rather than waited out).
    const tokenB = await mint(order1Id, asha);
    await runWithoutTenant(() => app.prisma.tripShareToken.update({
      where: { tokenDigest: tripShareDigest(tokenB) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    }));
    const stale = await publicGet(tokenB);
    expect(stale.statusCode).toBe(404);
    expect(stale.json().error.code).toBe('SHARE_NOT_AVAILABLE');

    // An unknown token is the same null — no oracle to probe.
    const unknown = await publicGet('x'.repeat(43));
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual(stale.json());
  });

  it('when the trip ends the link stops showing the driver’s position, dies after the grace window, and the ended trip cannot be shared again', async () => {
    const ride = await makeRide(raviDriverId, nia.userId, 'stale', { overdue: false });
    const token = await mint(ride.id, nia);
    const live = await publicGet(token);
    expect(live.statusCode).toBe(200);
    expect(live.json().data.location).toMatchObject({ lat: 6.8031, lng: -58.1581 });

    // The trip ends. (The completion ceremony is GOLD-3's journey; only its
    // durable outcome — the order's terminal state — is written here.)
    await runWithoutTenant(() => app.prisma.order.update({ where: { id: ride.id }, data: { status: 'COMPLETED', deliveredAt: new Date() } }));
    const ended = await publicGet(token);
    expect(ended.statusCode).toBe(200);
    expect(ended.json().data).toMatchObject({ ended: true, status: 'Trip completed', location: null });

    const reshare = await post(`/api/v1/safety/trips/${ride.id}/share`, {}, nia.token);
    expect(reshare.statusCode).toBe(409);
    expect(reshare.json().error.code).toBe('TRIP_OVER');

    // Past the end of the trip plus the grace window, the link is dead.
    const graceMinutes = Number(process.env['SHARE_GRACE_MINUTES'] ?? 60);
    await runWithoutTenant(() => app.prisma.order.update({
      where: { id: ride.id },
      data: { deliveredAt: new Date(Date.now() - (graceMinutes + 1) * 60_000) },
    }));
    const dead = await publicGet(token);
    expect(dead.statusCode).toBe(404);
    expect(dead.json().error.code).toBe('SHARE_NOT_AVAILABLE');
  });
});

describe('GOLD-4 · SAFE-02 — guardian check-in: OK de-escalates, NEED_HELP alerts', () => {
  it('the ladder’s check-in reaches the passenger; the passenger answers OK; neither a stranger nor the driver can answer it', async () => {
    // The ask is a durable, delivered obligation — not a flag on a row.
    const deliveries = await runWithoutTenant(() => app.prisma.guardianCheckinDelivery.findMany({ where: { sessionId: session1Id } }));
    expect(deliveries.map((d) => `${d.level}:${d.recipient}:${d.status}`)).toEqual(['SOFT:PASSENGER:SENT']);
    expect(deliveries[0]!.userId).toBe(asha.userId);
    const promptId = (deliveries[0]!.receipt as { notificationId: string }).notificationId;
    const prompt = await runWithoutTenant(() => app.prisma.notification.findUniqueOrThrow({ where: { id: promptId } }));
    expect(prompt.userId).toBe(asha.userId);
    expect(prompt.data).toMatchObject({ kind: 'guardian_checkin', level: 'SOFT', sessionId: session1Id, orderId: order1Id });

    const outstanding = await get('/api/v1/safety/guardian/checkin', asha.token);
    expect(outstanding.statusCode).toBe(200);
    expect(outstanding.json().data).toMatchObject({ sessionId: session1Id, orderId: order1Id, level: 'SOFT' });

    // Wrong accounts: the caller's own identity resolves the session, so a
    // stranger and the trip's DRIVER have nothing to read and nothing to
    // answer — and the passenger's check-in is still waiting afterwards.
    for (const other of [kofi, deo]) {
      expect((await get('/api/v1/safety/guardian/checkin', other.token)).json().data).toBeNull();
      expect((await post('/api/v1/safety/guardian/checkin', { response: 'OK' }, other.token)).statusCode).toBe(404);
    }
    const stillAsked = await sessionOf(order1Id);
    expect(stillAsked.checkinRequestedAt).toBeInstanceOf(Date);
    expect(stillAsked.checkinRespondedAt).toBeNull();

    const ok = await post('/api/v1/safety/guardian/checkin', { response: 'OK' }, asha.token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({ escalated: false, status: 'MONITORING' });
    const answered = await sessionOf(order1Id);
    expect(answered.status).toBe('MONITORING');
    expect(answered.checkinRequestedAt).toBeNull();
    expect(answered.checkinRespondedAt).toBeInstanceOf(Date);
    expect((await get('/api/v1/safety/guardian/checkin', asha.token)).json().data).toBeNull();

    // Nothing left to answer, and an OK never raised an alert.
    const twice = await post('/api/v1/safety/guardian/checkin', { response: 'OK' }, asha.token);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('NO_CHECKIN_PENDING');
    expect(await runWithoutTenant(() => app.prisma.sosAlert.count({ where: { orderId: order1Id } }))).toBe(0);
  });

  it('NEED_HELP mints an immediate ACTIVE SOS, pages ops, and hands the session over; the driver cannot raise or silence it', async () => {
    // Trip 2: Nia's overdue ride — the sweep opens its session and asks.
    const order2 = await makeRide(raviDriverId, nia.userId, 'two', { overdue: true });
    await sweep();
    const session2 = await sessionOf(order2.id);
    expect(session2.passengerUserId).toBe(nia.userId);
    expect(session2.checkinRequestedAt).toBeInstanceOf(Date);
    expect((await get('/api/v1/safety/guardian/checkin', nia.token)).json().data).toMatchObject({ sessionId: session2.id, level: 'SOFT' });

    // The driver answering on the passenger's behalf reaches nothing.
    expect((await post('/api/v1/safety/guardian/checkin', { response: 'NEED_HELP' }, ravi.token)).statusCode).toBe(404);
    expect((await post('/api/v1/safety/guardian/checkin', { response: 'OK' }, ravi.token)).statusCode).toBe(404);
    expect(await runWithoutTenant(() => app.prisma.sosAlert.count({ where: { orderId: order2.id } }))).toBe(0);
    expect((await sessionOf(order2.id)).checkinRespondedAt).toBeNull();

    const needHelp = await post('/api/v1/safety/guardian/checkin', { response: 'NEED_HELP' }, nia.token);
    expect(needHelp.statusCode).toBe(200);
    const escalated = needHelp.json().data as { escalated: boolean; sosAlertId: string };
    expect(escalated.escalated).toBe(true);
    createdSosAlertIds.push(escalated.sosAlertId);

    // A REAL alert: born ACTIVE (a human asked), bound to the trip, the
    // driver named as counterparty, idempotency pinned to the session.
    const alert = await runWithoutTenant(() => app.prisma.sosAlert.findUniqueOrThrow({ where: { id: escalated.sosAlertId } }));
    expect(alert.status).toBe('ACTIVE');
    expect(alert.triggerSource).toBe('GUARDIAN_ESCALATION');
    expect(alert.actorUserId).toBe(nia.userId);
    expect(alert.orderId).toBe(order2.id);
    expect(alert.counterpartyUserId).toBe(ravi.userId);
    expect(alert.clientIdempotencyKey).toBe(`guardian-help:${session2.id}`);
    expect(alert.tenantId).toBe('swift-default');

    // The session handed off exactly once, and nothing is left to answer.
    const closed = await sessionOf(order2.id);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closeReason).toBe('ESCALATED');
    expect(closed.escalatedToSosId).toBe(escalated.sosAlertId);
    expect(closed.checkinRespondedAt).toBeInstanceOf(Date);
    expect((await get('/api/v1/safety/guardian/checkin', nia.token)).json().data).toBeNull();

    // The escalation policy delivered inline: ops page, war-room emit, evidence.
    const rows = await runWithoutTenant(() => app.prisma.sosEscalation.findMany({ where: { sosAlertId: escalated.sosAlertId } }));
    expect(rows.map((r) => `${r.channel}:${r.status}`).sort()).toEqual([
      'EVIDENCE:SENT', 'OPS_PAGE:SENT', 'WAR_ROOM:SENT',
    ]);
    const page = await runWithoutTenant(() => app.prisma.opsAlert.findFirstOrThrow({ where: { sosAlertId: escalated.sosAlertId }, include: { recipients: true } }));
    expect(page.kind).toBe('SOS');
    expect(page.tenantId).toBe('swift-default');
    expect(page.acknowledgedAt).toBeNull();
    expect(page.recipients.length).toBeGreaterThan(0);
    // The counterparty (the driver) is never told.
    expect(await runWithoutTenant(() => app.prisma.notification.count({
      where: { userId: ravi.userId, data: { path: ['sosAlertId'], equals: escalated.sosAlertId } },
    }))).toBe(0);
  });
});
