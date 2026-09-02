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
import { NotificationService } from '../modules/notification/notification.service';
import { drainCheckinDeliveries, scanCheckinDeliveries, backfillCheckinDeliveries } from '../modules/safety/guardian-delivery';
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
  await app.prisma.notification.deleteMany({ where: { data: { path: ['sessionId'], string_contains: '' }, title: { contains: 'not delivered' } } }).catch(() => {});
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
// [S-06] Guardian L2/L3 state commits before notification delivery.
//
// The register's red test: fail the passenger / driver send after the CAS,
// restart — delivery retries, and the no-delivery policy is deterministic.
// Around it: the deadline HOLDS while the hard prompt is undelivered (ops
// paged once per cycle), the deadline runs from DELIVERY, FAILED is an
// explicit policy and the rollback holds instead, a prompt for a cycle that
// is over is skipped, the backfill and scan see asks with no rows, two
// workers deliver each row once.
// ---------------------------------------------------------------------------

const notifications = () => new NotificationService(app.prisma, io);
const rowsOf = (sessionId: string) => app.prisma.guardianCheckinDelivery.findMany({ where: { sessionId }, orderBy: [{ level: 'asc' }, { recipient: 'asc' }] });
const cycleOf = async (orderId: string) => ((await session(orderId)).deviationState as { checkinCycle?: { id: string } }).checkinCycle?.id ?? null;
const eventsOf = async (orderId: string) => (((await session(orderId)).deviationState as { events?: Array<{ kind: string }> }).events ?? []).map((e) => e.kind);
const asksFor = (userId: string, kind: string) => app.prisma.notification.count({ where: { userId, data: { path: ['kind'], equals: kind } } });
const undeliveredPages = (sessionId: string) => app.prisma.notification.count({ where: { data: { path: ['sessionId'], equals: sessionId }, title: { contains: 'not delivered' } } });
const sosCountFor = (sessionId: string) => app.prisma.sosAlert.count({ where: { clientIdempotencyKey: `guardian:${sessionId}` } });
const dying = () => { const s = new GuardianService(app.prisma, io); s.observer = { afterAsk: async () => { throw new Error('process died'); } }; return s; };
const healthy = () => new GuardianService(app.prisma, io);

/** A ride with a latched anomaly, swept once so its session exists. */
async function anomalousRide(t0: number) {
  const passenger = await makeUser(['CUSTOMER']);
  const driverUser = await makeDriver();
  const ride = await makeRide(driverUser.driver.id, passenger.userId, new Date(t0));
  await healthy().sweep(new Date(t0));
  const s = await session(ride.id);
  await latchFlag(s.id, 'longStop', new Date(t0 + 60_000));
  return { passenger, driverUser, ride, sessionId: s.id, l2At: t0 + 120_000, l3At: t0 + 120_000 + 181_000 };
}

describe('[S-06] the register’s red test: the send fails after the commit', () => {
  it('L2: the ask and its cycle are on the record, the delivery row is owed, nothing was sent; a restart delivers it exactly once', async () => {
    const t0 = Date.now() - 1_800_000;
    const { passenger, ride, sessionId, l2At } = await anomalousRide(t0);
    await dying().sweep(new Date(l2At)); // the throw is poison-isolated by the sweep; the commit stands
    const after = await session(ride.id);
    expect(after.checkinRequestedAt).not.toBeNull();
    const cycleId = await cycleOf(ride.id);
    expect(cycleId).toBeTruthy();
    const rows = await rowsOf(sessionId);
    expect(rows.map((r) => `${r.level}:${r.recipient}:${r.status}:${r.attempts}`)).toEqual(['SOFT:PASSENGER:PENDING:0']);
    expect(rows[0]!.cycleId).toBe(cycleId);
    expect(await asksFor(passenger.userId, 'guardian_checkin')).toBe(0);
    // the worker restarts
    const first = await drainCheckinDeliveries(app.prisma, notifications(), { sessionIds: [sessionId] });
    expect(first).toMatchObject({ delivered: 1, failed: 0 });
    expect(await asksFor(passenger.userId, 'guardian_checkin')).toBe(1);
    const sent = (await rowsOf(sessionId))[0]!;
    expect(sent).toMatchObject({ status: 'SENT', attempts: 1 });
    expect((sent.receipt as { notificationId: string }).notificationId).toBeTruthy();
    expect(await drainCheckinDeliveries(app.prisma, notifications(), { sessionIds: [sessionId] })).toMatchObject({ delivered: 0 });
    expect(await asksFor(passenger.userId, 'guardian_checkin')).toBe(1);
  });

  it('L3: both prompts are owed after the commit; the deadline HOLDS and pages ops once while undelivered; delivery moves the deadline; then the deadline runs', async () => {
    const t0 = Date.now() - 1_800_000;
    const { passenger, driverUser, ride, sessionId, l2At, l3At } = await anomalousRide(t0);
    await healthy().sweep(new Date(l2At));
    await dying().sweep(new Date(l3At));
    const pending = await session(ride.id);
    expect(pending.status).toBe('CHECKIN_PENDING');
    const oldDeadline = pending.checkinDeadlineAt!;
    expect((await rowsOf(sessionId)).map((r) => `${r.level}:${r.recipient}:${r.status}`).sort()).toEqual(['HARD:DRIVER:PENDING', 'HARD:PASSENGER:PENDING', 'SOFT:PASSENGER:SENT']);
    expect(await asksFor(driverUser.userId, 'guardian_driver_confirm')).toBe(0);
    // the deadline passes with the hard prompt undelivered: held, paged once
    await healthy().sweep(new Date(l3At + 121_000));
    expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');
    expect(await eventsOf(ride.id)).toContain('DEADLINE_HELD_UNDELIVERED');
    expect(await undeliveredPages(sessionId)).toBeGreaterThanOrEqual(1);
    const pagesAfterFirst = await undeliveredPages(sessionId);
    await healthy().sweep(new Date(l3At + 150_000));
    expect(await undeliveredPages(sessionId)).toBe(pagesAfterFirst);
    expect(await sosCountFor(sessionId)).toBe(0);
    // the worker delivers both prompts; the driver's nonce travelled and left the row
    const drained = await drainCheckinDeliveries(app.prisma, notifications(), { sessionIds: [sessionId] });
    expect(drained).toMatchObject({ delivered: 2, failed: 0 });
    expect(await asksFor(driverUser.userId, 'guardian_driver_confirm')).toBe(1);
    expect(await asksFor(passenger.userId, 'guardian_checkin')).toBe(2);
    const driverRow = (await rowsOf(sessionId)).find((r) => r.recipient === 'DRIVER')!;
    expect((driverRow.payload as { data: { nonce?: string } }).data.nonce).toBeUndefined();
    const ask = await app.prisma.notification.findFirstOrThrow({ where: { userId: driverUser.userId, data: { path: ['kind'], equals: 'guardian_driver_confirm' } } });
    expect((ask.data as { nonce: string }).nonce).toHaveLength(32);
    // the deadline now runs from DELIVERY: the old one is history
    const moved = await session(ride.id);
    expect(moved.checkinDeadlineAt!.getTime()).toBeGreaterThan(oldDeadline.getTime());
    expect(moved.checkinDeadlineAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    await healthy().sweep(new Date(oldDeadline.getTime() + 1000));
    expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');
    await healthy().sweep(new Date(Date.now() + 121_000));
    expect((await session(ride.id)).status).not.toBe('CHECKIN_PENDING');
    expect(await sosCountFor(sessionId)).toBe(1);
  });
});

describe('[S-06] the no-delivery policy is explicit and deterministic', () => {
  it('FAILED (every attempt exhausted): the deadline escalates and says why', async () => {
    const t0 = Date.now() - 1_800_000;
    const { ride, sessionId, l2At, l3At } = await anomalousRide(t0);
    await healthy().sweep(new Date(l2At));
    await dying().sweep(new Date(l3At));
    await app.prisma.guardianCheckinDelivery.updateMany({ where: { sessionId, level: 'HARD', recipient: 'PASSENGER' }, data: { status: 'FAILED', lastError: 'push provider down', attempts: 20 } });
    await healthy().sweep(new Date(l3At + 121_000));
    expect((await session(ride.id)).status).not.toBe('CHECKIN_PENDING');
    expect(await sosCountFor(sessionId)).toBe(1);
    expect(await eventsOf(ride.id)).toContain('DEADLINE_WITHOUT_DELIVERY');
  });

  it('the rollback switch: an undelivered prompt holds the deadline and pages ops — never an auto-SOS on silence', async () => {
    const t0 = Date.now() - 1_800_000;
    const { ride, sessionId, l2At, l3At } = await anomalousRide(t0);
    await healthy().sweep(new Date(l2At));
    await dying().sweep(new Date(l3At));
    await app.prisma.guardianCheckinDelivery.updateMany({ where: { sessionId, level: 'HARD', recipient: 'PASSENGER' }, data: { status: 'FAILED', lastError: 'push provider down', attempts: 20 } });
    process.env['GUARDIAN_CHECKIN_DELIVERY_KILL'] = '1';
    try {
      await healthy().sweep(new Date(l3At + 121_000));
    } finally {
      delete process.env['GUARDIAN_CHECKIN_DELIVERY_KILL'];
    }
    expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');
    expect(await sosCountFor(sessionId)).toBe(0);
    expect(await eventsOf(ride.id)).toContain('DEADLINE_HELD_UNDELIVERED');
    expect(await undeliveredPages(sessionId)).toBeGreaterThanOrEqual(1);
  });

  it('a prompt for a cycle that is over is skipped, never sent', async () => {
    const t0 = Date.now() - 1_800_000;
    const { passenger, ride, sessionId, l2At } = await anomalousRide(t0);
    await dying().sweep(new Date(l2At));
    expect((await rowsOf(sessionId))[0]!.status).toBe('PENDING');
    await healthy().respondToCheckin(passenger.userId, 'OK'); // all clear: the cycle ends
    expect(await cycleOf(ride.id)).toBeNull();
    const drained = await drainCheckinDeliveries(app.prisma, notifications(), { sessionIds: [sessionId] });
    expect(drained).toMatchObject({ delivered: 0, skipped: 1 });
    expect((await rowsOf(sessionId))[0]).toMatchObject({ status: 'SKIPPED' });
    expect(await asksFor(passenger.userId, 'guardian_checkin')).toBe(0);
  });

  it('the scan names a held deadline and an ask with no rows; the backfill stages the passenger row; two workers deliver it once', async () => {
    const t0 = Date.now() - 1_800_000;
    const { passenger, sessionId, l2At, l3At } = await anomalousRide(t0);
    await healthy().sweep(new Date(l2At));
    await dying().sweep(new Date(l3At));
    await app.prisma.guardianCheckinDelivery.deleteMany({ where: { sessionId } }); // pre-outbox history
    const scan = await scanCheckinDeliveries(app.prisma);
    expect(scan.askedWithoutRows).toContain(sessionId);
    expect(scan.deadlineWithoutDelivery.find((d) => d.sessionId === sessionId)).toMatchObject({ state: 'UNKNOWN' });
    const back = await backfillCheckinDeliveries(app.prisma);
    expect(back.backfilled).toContain(sessionId);
    expect((await rowsOf(sessionId)).map((r) => `${r.level}:${r.recipient}:${r.status}`)).toEqual(['HARD:PASSENGER:PENDING']);
    const slow = { beforeDeliver: async () => { await new Promise((r) => setTimeout(r, 150)); } };
    const [a, b] = await Promise.all([
      drainCheckinDeliveries(app.prisma, notifications(), { sessionIds: [sessionId], observer: slow }),
      drainCheckinDeliveries(app.prisma, notifications(), { sessionIds: [sessionId] }),
    ]);
    expect(a.delivered + b.delivered).toBe(1);
    expect(await asksFor(passenger.userId, 'guardian_checkin')).toBe(2); // the SOFT one from L2, the HARD one now
    const after = await scanCheckinDeliveries(app.prisma);
    expect(after.deadlineWithoutDelivery.some((d) => d.sessionId === sessionId)).toBe(false);
    expect(after.askedWithoutRows).not.toContain(sessionId);
  });
});
