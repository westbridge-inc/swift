import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { GuardianService } from '../modules/safety/guardian.service';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';

// Trip Guardian M4c — the graduated check-in ladder (§5.3, self-test §14-E):
// L2 soft check-in → L3 hard check-in with a server deadline → L4 auto-SOS.
// The full climb is driven with scripted GPS through FRESH GuardianService
// instances per tick (worker-restart proof); responses go through the real
// authed routes. Scripted timestamps sit in the PAST so the ladder's deadline
// arithmetic works against real-clock responses.

let app: FastifyInstance;
const emits: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
const io = {
  to: (room: string) => ({ emit: (event: string, payload: Record<string, unknown>) => { emits.push({ room, event, payload }) } }),
} as unknown as Server;
const sweep = (now: Date) => new GuardianService(app.prisma, io).sweep(now);

const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_720_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Ladder',
      lastName: `U${seq}`,
      roles,
      activeRole: roles[0]!,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...extra,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'grd', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

async function makeDriver() {
  const u = await makeUser(['MOVER']);
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `LDR ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      totalRides: 500, createdAt: new Date(Date.now() - 90 * 86_400_000),
    },
  });
  return { ...u, driver };
}

const PICKUP = { lat: 6.8, lng: -58.15 };
const DEST = { lat: 6.82, lng: -58.13 };
const MIDWAY = { lat: 6.81, lng: -58.14 };

async function makeRide(driverId: string, customerId: string, pickedUpAt: Date) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `LDR-${nanoid(8)}`,
      orderType: 'TAXI',
      customerId,
      driverId,
      status: 'RIDE_IN_PROGRESS',
      fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: 'B', deliveryLat: DEST.lat, deliveryLng: DEST.lng,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0,
      totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
      pickedUpAt, taxiDuration: 60,
    },
  });
  orderIds.push(order.id);
  return order;
}

const putFix = (driverId: string, at: Date, pos: { lat: number; lng: number }) =>
  app.prisma.driver.update({ where: { id: driverId }, data: { currentLat: pos.lat, currentLng: pos.lng, lastLocationUpdate: at } });

const session = (orderId: string) => app.prisma.tripSafetySession.findUniqueOrThrow({ where: { orderId } });

/** Latch an anomaly directly (detector→flag chemistry is proven in the sweep
 *  suite; here the subject is the ladder that CONSUMES the latch). */
const latchFlag = (sessionId: string, kind: string, at: Date) =>
  app.prisma.tripSafetySession.update({
    where: { id: sessionId },
    data: { deviationState: { flags: { [kind]: at.toISOString() } } as never },
  });

const post = (url: string, payload: unknown, token?: string) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

beforeEach(() => { resetDevChannelLog(); emits.length = 0; });

afterAll(async () => {
  delete process.env['GUARDIAN_AUTONOTIFY_CONTACTS'];
  await app.prisma.tripSafetySession.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.sosAlert.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { counterpartyUserId: { in: userIds } }] } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('the full ladder climb — deviation → L2 → L3 → L4 auto-SOS (§14-E)', () => {
  it('every rung is DB state, survives worker restarts, and the timeout SOS spares the contacts', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    await app.prisma.emergencyContact.create({ data: { userId: passenger.userId, name: 'Mom', phoneE164: `+${phoneBase + 900}`, priority: 1, verifiedAt: new Date() } });
    const { driver } = await makeDriver();
    const t0 = Date.now() - 3_600_000; // scripted past — real-clock responses stay "after"
    const ride = await makeRide(driver.id, passenger.userId, new Date(t0));

    // Scripted GPS: converge, then sustained divergence (same chemistry the
    // sweep suite proves) — the flag and the L2 ask land on the same tick.
    await putFix(driver.id, new Date(t0), MIDWAY);
    await sweep(new Date(t0));
    await putFix(driver.id, new Date(t0 + 60_000), PICKUP);
    await sweep(new Date(t0 + 60_000));
    await putFix(driver.id, new Date(t0 + 180_000), { lat: 6.795, lng: -58.155 });
    await sweep(new Date(t0 + 180_000));

    // L2 — soft ask: DB rung + minimal push (§15 wording) + order-room card.
    let s = await session(ride.id);
    expect(s.status).toBe('MONITORING');
    expect(s.checkinRequestedAt).not.toBeNull();
    const softPush = await app.prisma.notification.findFirst({ where: { userId: passenger.userId, type: 'SAFETY' } });
    expect(softPush?.title).toBe('Safety check-in');
    expect(softPush?.body).not.toMatch(/emergency|danger|abduct/i); // push is not a secure channel
    expect(emits.find((e) => e.event === 'guardian:checkin' && e.room === `order:${ride.id}`)?.payload['level']).toBe('SOFT');

    // L3 — soft ask unanswered past the wait → hard check-in with deadline.
    await sweep(new Date(t0 + 180_000 + 181_000));
    s = await session(ride.id);
    expect(s.status).toBe('CHECKIN_PENDING');
    expect(s.checkinDeadlineAt).not.toBeNull();
    const driverPrompt = await app.prisma.notification.findFirst({ where: { userId: (await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).userId, type: 'SAFETY' } });
    expect(driverPrompt?.title).toBe('Trip status check'); // low-key driver-side prompt
    expect(emits.filter((e) => e.event === 'guardian:checkin').at(-1)?.payload['level']).toBe('HARD');

    // L4 — deadline passes, neither party responded → auto-SOS.
    resetDevChannelLog();
    await sweep(new Date(t0 + 180_000 + 181_000 + 121_000));
    s = await session(ride.id);
    expect(s.status).toBe('CLOSED');
    expect(s.closeReason).toBe('ESCALATED');
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({
      // [F-026-17] the key is unique PER ACTOR now — the guardian escalation
      // belongs to the passenger whose check-in lapsed.
      where: { actorUserId_clientIdempotencyKey: { actorUserId: passenger.userId, clientIdempotencyKey: `guardian:${s.id}` } },
    });
    expect(s.escalatedToSosId).toBe(alert.id);
    expect(alert.status).toBe('ACTIVE'); // immediate — no grace on a server-decided emergency
    expect(alert.triggerSource).toBe('CHECKIN_TIMEOUT');
    expect(alert.actorUserId).toBe(passenger.userId);
    expect(alert.counterpartyUserId).toBe((await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).userId);
    // §5.3 L4: the server GUESSED — ops is paged, the war-room fires, but the
    // contacts are NOT auto-SMSed by default (false alarms erode the feature).
    expect(devChannelLog.filter((e) => e.channel === 'sms')).toHaveLength(0);
    expect((alert.deliveryReceipts as Record<string, unknown>)['contacts']).toBe('skipped:guardian-default');
    // [F-027-16/18] Published to the alert's OWN tenant room plus the
    // platform room (SUPER_ADMIN only) — never a bare shared room that would
    // hand another tenant's admins this person's role, order and coordinates.
    expect(emits.find((e) => e.event === 'sos:active')?.room)
      .toEqual([`ops:war-room:${alert.tenantId}`, 'ops:war-room']);

    // Crash-retry idempotency: a tick that died mid-escalation re-runs it —
    // the idempotency key pins exactly ONE alert, the session re-closes.
    await app.prisma.tripSafetySession.update({ where: { id: s.id }, data: { status: 'ESCALATING' } });
    await sweep(new Date());
    expect(await app.prisma.sosAlert.count({ where: { clientIdempotencyKey: `guardian:${s.id}` } })).toBe(1);
    expect((await session(ride.id)).status).toBe('CLOSED');
  });
});

describe('check-in responses (§5.3)', () => {
  it('"Yes, all good" de-escalates, re-arms the detectors, and holds a cooldown against nagging', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const { driver } = await makeDriver();
    const t0 = Date.now() - 1_800_000;
    const ride = await makeRide(driver.id, passenger.userId, new Date(t0));
    await sweep(new Date(t0));
    let s = await session(ride.id);
    await latchFlag(s.id, 'overdue', new Date(t0 + 60_000));
    await sweep(new Date(t0 + 120_000)); // → L2
    expect((await session(ride.id)).checkinRequestedAt).not.toBeNull();

    const res = await post('/api/v1/safety/guardian/checkin', { response: 'OK' }, passenger.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.escalated).toBe(false);
    s = await session(ride.id);
    expect(s.status).toBe('MONITORING');
    expect(s.checkinRespondedAt).not.toBeNull();
    expect(s.checkinRequestedAt).toBeNull();
    expect((s.deviationState as { flags?: Record<string, string> }).flags?.['overdue']).toBeUndefined(); // latch cleared

    // The soft wait passing changes nothing now — no pending ask, no anomaly.
    await sweep(new Date(t0 + 400_000));
    expect((await session(ride.id)).status).toBe('MONITORING');

    // Even a re-latched anomaly inside the cooldown must not re-prompt.
    await app.prisma.tripSafetySession.update({ where: { id: s.id }, data: { deviationState: { flags: { overdue: new Date().toISOString() }, lastCheckinClearedAtMs: Date.now() } as never } });
    await sweep(new Date(Date.now() + 1_000));
    expect((await session(ride.id)).checkinRequestedAt).toBeNull();
  });

  it('"I need help" is a human asking — full SOS, contacts INCLUDED, session escalated', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const contactPhone = `+${phoneBase + 901}`;
    await app.prisma.emergencyContact.create({ data: { userId: passenger.userId, name: 'Dad', phoneE164: contactPhone, priority: 1, verifiedAt: new Date() } });
    const { driver } = await makeDriver();
    const ride = await makeRide(driver.id, passenger.userId, new Date(Date.now() - 600_000));
    await sweep(new Date(Date.now() - 600_000));

    const res = await post('/api/v1/safety/guardian/checkin', { response: 'NEED_HELP' }, passenger.token);
    expect(res.statusCode).toBe(200);
    const { sosAlertId } = res.json().data;
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: sosAlertId } });
    expect(alert.triggerSource).toBe('GUARDIAN_ESCALATION');
    expect(alert.status).toBe('ACTIVE');
    expect(devChannelLog.find((e) => e.channel === 'sms' && e.to === contactPhone)).toBeTruthy();
    const s = await session(ride.id);
    expect(s.status).toBe('CLOSED');
    expect(s.closeReason).toBe('ESCALATED');
    expect(s.escalatedToSosId).toBe(sosAlertId);
  });

  it('a responsive driver at the deadline blocks the auto-SOS — the flat-tire case', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const driverUser = await makeDriver();
    const t0 = Date.now() - 1_800_000;
    const ride = await makeRide(driverUser.driver.id, passenger.userId, new Date(t0));
    await sweep(new Date(t0));
    const s = await session(ride.id);
    await latchFlag(s.id, 'longStop', new Date(t0 + 60_000));
    await sweep(new Date(t0 + 120_000)); // L2
    await sweep(new Date(t0 + 120_000 + 181_000)); // L3
    expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');

    const confirm = await post('/api/v1/safety/guardian/driver-confirm', {}, driverUser.token);
    expect(confirm.statusCode).toBe(200);

    await sweep(new Date(t0 + 120_000 + 181_000 + 121_000)); // deadline tick
    const after = await session(ride.id);
    expect(after.status).toBe('MONITORING'); // de-escalated, still watching
    expect(after.checkinRequestedAt).toBeNull(); // re-armed
    expect(await app.prisma.sosAlert.count({ where: { clientIdempotencyKey: `guardian:${s.id}` } })).toBe(0);
  });

  it('authz: no open session → 404; no token → 401', async () => {
    const stranger = await makeUser(['CUSTOMER']);
    expect((await post('/api/v1/safety/guardian/checkin', { response: 'OK' }, stranger.token)).statusCode).toBe(404);
    expect((await post('/api/v1/safety/guardian/checkin', { response: 'OK' })).statusCode).toBe(401);
  });

  it('GUARDIAN_AUTONOTIFY_CONTACTS=1 flips the L4 default — timeout SOS then DOES text contacts', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const contactPhone = `+${phoneBase + 902}`;
    await app.prisma.emergencyContact.create({ data: { userId: passenger.userId, name: 'Sis', phoneE164: contactPhone, priority: 1, verifiedAt: new Date() } });
    const { driver } = await makeDriver();
    const ride = await makeRide(driver.id, passenger.userId, new Date(Date.now() - 600_000));
    await sweep(new Date(Date.now() - 600_000));
    const s = await session(ride.id);
    await app.prisma.tripSafetySession.update({ where: { id: s.id }, data: { status: 'ESCALATING' } }); // post-crash state

    process.env['GUARDIAN_AUTONOTIFY_CONTACTS'] = '1';
    try {
      await sweep(new Date());
    } finally {
      delete process.env['GUARDIAN_AUTONOTIFY_CONTACTS'];
    }
    expect(devChannelLog.find((e) => e.channel === 'sms' && e.to === contactPhone)).toBeTruthy();
    expect((await session(ride.id)).closeReason).toBe('ESCALATED');
  });
});

// ---------------------------------------------------------------------------
// THE CHECK-IN CARD HAD EXACTLY ONE DOOR, AND IT WAS THE WRONG ONE.
//
// The card that asks "Everything OK on your trip?" was raised only by the
// `guardian:checkin` socket event, handled by whichever screen was mounted and
// listening. A passenger whose app was backgrounded or killed when it fired —
// which is exactly the case the PUSH exists for — missed it, and nothing ever
// raised it again. They were left holding a notification they could not answer.
//
// Two things made that unrecoverable rather than merely awkward:
//
//   · the push tapped through to `Delivery`, the customer ORDER-TRACKING
//     screen. A ride renders on `Taxi`. The generic "any payload with an
//     orderId" branch swallowed it, so the one person being asked whether they
//     are safe arrived somewhere that could not ask them.
//
//   · on a HARD check-in the silence has a SERVER DEADLINE, and L4 escalates
//     when it passes. A passenger who tried to answer and could not find the
//     card is recorded by the ladder as a passenger who never answered.
//
// So the phone can now ASK. This grades that read at every rung, including the
// endings — because the failure a "show the prompt" flag on the notification
// would have introduced is a card raised for a check-in already answered.
// ---------------------------------------------------------------------------
const getJson = (url: string, token?: string) =>
  app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) } });

async function rideAtSoftCheckin() {
  const passenger = await makeUser(['CUSTOMER']);
  const { driver } = await makeDriver();
  const t0 = Date.now() - 3_600_000;
  const ride = await makeRide(driver.id, passenger.userId, new Date(t0));
  await putFix(driver.id, new Date(t0), MIDWAY);
  await sweep(new Date(t0));
  await putFix(driver.id, new Date(t0 + 60_000), PICKUP);
  await sweep(new Date(t0 + 60_000));
  await putFix(driver.id, new Date(t0 + 180_000), { lat: 6.795, lng: -58.155 });
  await sweep(new Date(t0 + 180_000));
  return { passenger, driver, ride, t0 };
}

describe('a passenger can ASK whether a check-in is waiting (not only be told)', () => {
  it('reports the SOFT ask, with the trip it belongs to', async () => {
    const { passenger, ride } = await rideAtSoftCheckin();
    // Precondition: the ladder really is at L2 (guards the whole test).
    expect((await session(ride.id)).checkinRequestedAt).not.toBeNull();

    const res = await getJson('/api/v1/safety/guardian/checkin', passenger.token);

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data, 'a check-in is outstanding — the passenger must be able to learn that').not.toBeNull();
    expect(data.level).toBe('SOFT');
    expect(data.orderId).toBe(ride.id);
    // SOFT has no deadline; only L3 sets one. Inventing one would be a clock
    // the passenger is judged against that the server never set.
    expect(data.deadlineAt).toBeNull();
  });

  it('reports the HARD ask WITH the server deadline', async () => {
    const { passenger, ride, t0 } = await rideAtSoftCheckin();
    await sweep(new Date(t0 + 180_000 + 181_000));
    expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');

    const data = (await getJson('/api/v1/safety/guardian/checkin', passenger.token)).json().data;

    expect(data.level).toBe('HARD');
    // The deadline is the SERVER's own timestamp, echoed — this is the clock
    // the ladder escalates on, so the screen must not compute its own.
    const s = await session(ride.id);
    expect(data.deadlineAt).toBe(s.checkinDeadlineAt!.toISOString());
  });

  it('goes quiet the moment it is answered — no stale card', async () => {
    // THE REASON THIS IS A SERVER READ. A flag riding on the notification
    // would re-raise the card every time a passenger tapped an old push,
    // asking someone to confirm they are safe about a trip already resolved.
    const { passenger, ride } = await rideAtSoftCheckin();
    expect((await getJson('/api/v1/safety/guardian/checkin', passenger.token)).json().data).not.toBeNull();

    const answered = await post('/api/v1/safety/guardian/checkin', { response: 'OK' }, passenger.token);
    expect(answered.statusCode).toBe(200);

    expect(
      (await getJson('/api/v1/safety/guardian/checkin', passenger.token)).json().data,
      'the check-in was answered; nothing is waiting',
    ).toBeNull();
    expect((await session(ride.id)).checkinRequestedAt).toBeNull();
  });

  it('says null on a monitored trip with no ask outstanding', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const { driver } = await makeDriver();
    const t0 = Date.now() - 3_600_000;
    const ride = await makeRide(driver.id, passenger.userId, new Date(t0));
    await putFix(driver.id, new Date(t0), MIDWAY);
    await sweep(new Date(t0));
    expect((await session(ride.id)).status).toBe('MONITORING');

    expect(
      (await getJson('/api/v1/safety/guardian/checkin', passenger.token)).json().data,
      'a screen must be able to learn "no", not only "yes"',
    ).toBeNull();
  });

  it('is scoped to the caller — another passenger sees nothing of this trip', async () => {
    const { passenger } = await rideAtSoftCheckin();
    const stranger = await makeUser(['CUSTOMER']);

    expect((await getJson('/api/v1/safety/guardian/checkin', passenger.token)).json().data).not.toBeNull();
    expect(
      (await getJson('/api/v1/safety/guardian/checkin', stranger.token)).json().data,
      'the session is resolved from the authenticated user id; there is no id to tamper with',
    ).toBeNull();
  });

  it('requires authentication', async () => {
    expect((await getJson('/api/v1/safety/guardian/checkin')).statusCode).toBe(401);
  });

  it('agrees with the route that accepts the answer', async () => {
    // If the read and the write resolved different sessions, a passenger could
    // be shown a card that 404s when they tap it.
    const { passenger } = await rideAtSoftCheckin();
    const shown = (await getJson('/api/v1/safety/guardian/checkin', passenger.token)).json().data;

    const answered = await post('/api/v1/safety/guardian/checkin', { response: 'OK' }, passenger.token);

    expect(answered.statusCode).toBe(200);
    expect(shown.sessionId).toBe((await session(shown.orderId)).id);
  });
});
