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
import { resetDevChannelLog } from '../providers/notifications/channels';

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


// ---------------------------------------------------------------------------
// [S-04] A stale early driver confirmation can suppress a later real SOS.
//
// The register's red test: confirm while MONITORING, then begin a new L2/L3
// cycle; passenger non-response must escalate. And a response to a previous
// cycle cannot absolve the next. Around it: the current cycle's nonce
// de-escalates and is recorded with actor/device/time and ops are paged; a
// nonce is one-time; a legacy unbound value is cleared and ignored; the
// rollback switch refuses driver de-escalation outright.
// ---------------------------------------------------------------------------

/** Latch an anomaly WITHOUT wiping the rest of the state (the cycle facts). */
const latchFlagKeep = async (sessionId: string, kind: string, at: Date) => {
  const row = await app.prisma.tripSafetySession.findUniqueOrThrow({ where: { id: sessionId } });
  const state = (row.deviationState as Record<string, unknown> | null) ?? {};
  await app.prisma.tripSafetySession.update({ where: { id: sessionId }, data: { deviationState: { ...state, flags: { [kind]: at.toISOString() } } as never } });
};
const driverAsk = async (driverUserId: string) => {
  const ask = await app.prisma.notification.findFirstOrThrow({ where: { userId: driverUserId, data: { path: ['kind'], equals: 'guardian_driver_confirm' } }, orderBy: { createdAt: 'desc' } });
  return ask.data as { cycleId: string; nonce: string; respondBy: string };
};
const stateOf = async (orderId: string) => ((await session(orderId)).deviationState as Record<string, unknown>);
const sosCountFor = (sessionId: string) => app.prisma.sosAlert.count({ where: { clientIdempotencyKey: `guardian:${sessionId}` } });
const confirm = (token: string, body: Record<string, unknown>) => post('/api/v1/safety/guardian/driver-confirm', body, token);

/** Open a session, latch, climb to L3 (CHECKIN_PENDING). Returns the times. */
async function climbToHardCheck(driverId: string, passengerUserId: string, t0: number) {
  const ride = await makeRide(driverId, passengerUserId, new Date(t0));
  await sweep(new Date(t0));
  const s = await session(ride.id);
  await latchFlag(s.id, 'longStop', new Date(t0 + 60_000));
  await sweep(new Date(t0 + 120_000)); // L2
  const l3At = t0 + 120_000 + 181_000;
  await sweep(new Date(l3At)); // L3
  expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');
  return { ride, sessionId: s.id, l3At, deadlineTick: l3At + 121_000 };
}

describe('[S-04] a driver confirmation answers one hard-check cycle, once', () => {
  it('the register’s red test: a tap during ordinary MONITORING is refused, and a later unanswered hard check still escalates', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const driverUser = await makeDriver();
    const t0 = Date.now() - 1_800_000;
    const ride = await makeRide(driverUser.driver.id, passenger.userId, new Date(t0));
    await sweep(new Date(t0));
    const s = await session(ride.id);
    expect(s.status).toBe('MONITORING');
    const early = await confirm(driverUser.token, { cycleId: 'anything', nonce: 'anything' });
    expect(early.statusCode).toBe(409);
    expect(early.json().error?.code ?? early.json().code).toBe('NO_HARD_CHECK_PENDING');
    expect(((await stateOf(ride.id))['events'] as Array<{ kind: string }>).some((e) => e.kind === 'DRIVER_CONFIRM_REFUSED')).toBe(true);
    // an unscoped body is not even a confirmation
    expect((await confirm(driverUser.token, {})).statusCode).toBe(400);

    await latchFlagKeep(s.id, 'longStop', new Date(t0 + 60_000));
    await sweep(new Date(t0 + 120_000)); // L2
    await sweep(new Date(t0 + 120_000 + 181_000)); // L3
    expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');
    await sweep(new Date(t0 + 120_000 + 181_000 + 121_000)); // deadline: nobody answered
    const after = await session(ride.id);
    expect(after.status).not.toBe('MONITORING');
    expect(await sosCountFor(s.id)).toBe(1);
  });

  it('the current cycle’s nonce de-escalates, is recorded with actor / device / time, and ops are paged', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const driverUser = await makeDriver();
    const t0 = Date.now() - 1_800_000;
    const { ride, sessionId, deadlineTick } = await climbToHardCheck(driverUser.driver.id, passenger.userId, t0);
    const ask = await driverAsk(driverUser.userId);
    expect(ask.cycleId).toBeTruthy(); expect(ask.nonce).toHaveLength(32);
    expect(((await stateOf(ride.id))['checkinCycle'] as { id: string }).id).toBe(ask.cycleId);
    const ok = await confirm(driverUser.token, { cycleId: ask.cycleId, nonce: ask.nonce, deviceId: 'phone-1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ recorded: true, cycleId: ask.cycleId });
    const recorded = (await stateOf(ride.id))['driverConfirm'] as { cycleId: string; actorUserId: string; deviceId: string; atMs: number };
    expect(recorded).toMatchObject({ cycleId: ask.cycleId, actorUserId: driverUser.userId, deviceId: 'phone-1' });
    expect(recorded.atMs).toBeGreaterThan(0);
    // the nonce is spent
    expect((await confirm(driverUser.token, { cycleId: ask.cycleId, nonce: ask.nonce })).json().error?.code).toBe('CONFIRM_ALREADY_USED');
    await sweep(new Date(deadlineTick));
    const after = await session(ride.id);
    expect(after.status).toBe('MONITORING');
    expect(await sosCountFor(sessionId)).toBe(0);
    expect(await app.prisma.notification.count({ where: { data: { path: ['sessionId'], equals: sessionId }, title: { contains: 'passenger unanswered' } } })).toBeGreaterThanOrEqual(1);
  });

  it('a response to a previous cycle cannot absolve the next: the old cycle id is stale, the old nonce is wrong, and the deadline escalates', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const driverUser = await makeDriver();
    const t0 = Date.now() - 3_600_000;
    const { ride, sessionId, deadlineTick } = await climbToHardCheck(driverUser.driver.id, passenger.userId, t0);
    const askA = await driverAsk(driverUser.userId);
    expect((await confirm(driverUser.token, { cycleId: askA.cycleId, nonce: askA.nonce })).statusCode).toBe(200);
    await sweep(new Date(deadlineTick));
    expect((await session(ride.id)).status).toBe('MONITORING'); // cycle A stood down
    // cycle B, after the cooldown
    const t1 = deadlineTick + 700_000;
    await latchFlagKeep(sessionId, 'longStop', new Date(t1 - 60_000));
    await sweep(new Date(t1)); // L2
    await sweep(new Date(t1 + 181_000)); // L3
    expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');
    const askB = await driverAsk(driverUser.userId);
    expect(askB.cycleId).not.toBe(askA.cycleId);
    expect((await confirm(driverUser.token, { cycleId: askA.cycleId, nonce: askA.nonce })).json().error?.code).toBe('STALE_CONFIRM');
    expect((await confirm(driverUser.token, { cycleId: askB.cycleId, nonce: askA.nonce })).json().error?.code).toBe('BAD_CONFIRM_NONCE');
    await sweep(new Date(t1 + 181_000 + 121_000)); // deadline: cycle B unanswered
    expect((await session(ride.id)).status).not.toBe('MONITORING');
    expect(await sosCountFor(sessionId)).toBe(1);
  });

  it('a legacy unbound value (the old field, no cycle) is cleared at the deadline and absolves nothing', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const driverUser = await makeDriver();
    const t0 = Date.now() - 1_800_000;
    const { ride, sessionId, deadlineTick } = await climbToHardCheck(driverUser.driver.id, passenger.userId, t0);
    const state = await stateOf(ride.id);
    await app.prisma.tripSafetySession.update({ where: { id: sessionId }, data: { deviationState: { ...state, driverConfirmedAtMs: t0 + 5_000 } as never } });
    await sweep(new Date(deadlineTick));
    expect((await session(ride.id)).status).not.toBe('MONITORING');
    expect(await sosCountFor(sessionId)).toBe(1);
    const events = ((await stateOf(ride.id))['events'] as Array<{ kind: string }>).map((e) => e.kind);
    expect(events).toContain('STALE_DRIVER_CONFIRM_IGNORED');
  });

  it('the rollback switch refuses driver de-escalation outright: a valid confirmation is recorded, the auto-SOS still proceeds', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const driverUser = await makeDriver();
    const t0 = Date.now() - 1_800_000;
    const { ride, sessionId, deadlineTick } = await climbToHardCheck(driverUser.driver.id, passenger.userId, t0);
    const ask = await driverAsk(driverUser.userId);
    expect((await confirm(driverUser.token, { cycleId: ask.cycleId, nonce: ask.nonce })).statusCode).toBe(200);
    process.env['GUARDIAN_DRIVER_DEESCALATION_KILL'] = '1';
    try {
      await sweep(new Date(deadlineTick));
    } finally {
      delete process.env['GUARDIAN_DRIVER_DEESCALATION_KILL'];
    }
    expect((await session(ride.id)).status).not.toBe('MONITORING');
    expect(await sosCountFor(sessionId)).toBe(1);
    expect(((await stateOf(ride.id))['events'] as Array<{ kind: string }>).map((e) => e.kind)).toContain('DRIVER_DEESCALATION_KILLED');
  });
});
