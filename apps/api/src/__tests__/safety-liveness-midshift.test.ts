import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { LivenessService, assertShiftLiveness } from '../modules/safety/liveness.service';

// Identity Assurance M5b — §7.2 random mid-shift checks + §7.3 "this isn't
// my driver". The mid-shift prompt/deadline is DB state enforced by a CAS
// sweep (restart-proof); the report is the account-sharing kill shot: one tap
// releases the ride, LOCKS the driver (a lock holds even with the liveness
// flag off — it is a safety action, not a feature cost), and pages ops.

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_760_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Mid', lastName: `U${seq}`,
      roles, activeRole: roles[0]!,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      avatar: 'https://cdn.test/avatars/reference-face.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...extra,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'mid', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

async function makeDriver(extra: Record<string, unknown> = {}) {
  const u = await makeUser(['MOVER']);
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `MID ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      isOnline: true, isAvailable: true,
      ...extra,
    },
  });
  return { ...u, driver };
}

async function makeRider(extra: Record<string, unknown> = {}) {
  const u = await makeUser(['MOVER']);
  const rider = await app.prisma.rider.create({
    data: { userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', isOnline: true, isAvailable: true, ...extra },
  });
  return { ...u, rider };
}

async function makeRide(driverId: string, customerId: string, status: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `MID-${nanoid(8)}`,
      orderType: 'TAXI', customerId, driverId,
      status: status as never, fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0,
      totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
    },
  });
  orderIds.push(order.id);
  return order;
}

const svc = () => new LivenessService(app.prisma, app.io);
const driverRow = (id: string) => app.prisma.driver.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['LIVENESS_REQUIRED'];
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

afterAll(async () => {
  delete process.env['LIVENESS_REQUIRED'];
  delete process.env['LIVENESS_MIDSHIFT_PER_WEEK'];
  await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await app.prisma.livenessCheck.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('§7.2 random mid-shift checks', () => {
  it('dormant with the flag off — nobody is prompted, nobody enforced', async () => {
    delete process.env['LIVENESS_REQUIRED'];
    const { driver } = await makeDriver({ livenessPromptDeadlineAt: new Date(Date.now() - 60_000) });
    expect(await svc().midshiftSweep()).toEqual({ prompted: 0, enforced: 0 });
    expect((await driverRow(driver.id)).isOnline).toBe(true); // even an expired prompt is not enforced while off
  });

  it('prompts idle online movers (never mid-trip, never locked) and stamps a DB deadline', async () => {
    process.env['LIVENESS_REQUIRED'] = '1';
    process.env['LIVENESS_MIDSHIFT_PER_WEEK'] = '10000000'; // p = 1: selection is deterministic
    try {
      const idle = await makeDriver();
      const busy = await makeDriver({ currentRideId: 'ride-busy' });
      const locked = await makeDriver({ livenessLockedAt: new Date() });
      await svc().midshiftSweep(new Date(), 300_000);

      expect((await driverRow(idle.driver.id)).livenessPromptDeadlineAt).not.toBeNull();
      expect((await driverRow(busy.driver.id)).livenessPromptDeadlineAt).toBeNull(); // §7.2: never while a trip is in progress
      expect((await driverRow(locked.driver.id)).livenessPromptDeadlineAt).toBeNull();
      const prompt = await app.prisma.notification.findFirst({ where: { userId: idle.userId, type: 'SAFETY', title: 'Safety check-in' } });
      expect(prompt).not.toBeNull();

      // A passing check ANSWERS the prompt — deadline cleared.
      await svc().check({ userId: idle.userId, profile: 'DRIVER', selfieUrl: 'https://cdn.test/liveness/auto-approve.jpg' });
      expect((await driverRow(idle.driver.id)).livenessPromptDeadlineAt).toBeNull();
    } finally {
      delete process.env['LIVENESS_REQUIRED'];
      delete process.env['LIVENESS_MIDSHIFT_PER_WEEK'];
    }
  });

  it('a missed deadline forces the mover offline until a fresh PASS (rider side)', async () => {
    process.env['LIVENESS_REQUIRED'] = '1';
    process.env['LIVENESS_MIDSHIFT_PER_WEEK'] = '0.0000001'; // selection ~never; this tick only enforces
    try {
      const r = await makeRider({
        lastLivenessPassAt: new Date(), // was fresh — missing the prompt still voids it
        livenessPromptDeadlineAt: new Date(Date.now() - 60_000),
      });
      const res = await svc().midshiftSweep(new Date(), 300_000);
      expect(res.enforced).toBeGreaterThanOrEqual(1);
      const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.rider.id } });
      expect(after.isOnline).toBe(false);
      expect(after.isAvailable).toBe(false);
      expect(after.lastLivenessPassAt).toBeNull(); // must PASS again to return
      expect(after.livenessPromptDeadlineAt).toBeNull();
      const note = await app.prisma.notification.findFirst({ where: { userId: r.userId, title: 'Identity check missed' } });
      expect(note).not.toBeNull();
    } finally {
      delete process.env['LIVENESS_REQUIRED'];
      delete process.env['LIVENESS_MIDSHIFT_PER_WEEK'];
    }
  });
});

describe('§7.3 "this isn\'t my driver"', () => {
  it('one tap: ride released to re-dispatch, driver locked + offline, ops paged, both parties told', async () => {
    const admin = await makeUser(['ADMIN']);
    const passenger = await makeUser(['CUSTOMER']);
    const d = await makeDriver();
    const ride = await makeRide(d.driver.id, passenger.userId, 'DRIVER_ARRIVED');
    await app.prisma.driver.update({ where: { id: d.driver.id }, data: { currentRideId: ride.id } });
    // The impostor-flagged driver burned the PIN budget — release must rotate
    // + zero it for the replacement [REPORT-014 F-014-12].
    await app.prisma.order.update({ where: { id: ride.id }, data: { ridePin: '999111', ridePinAttempts: 5 } });

    const enqueued: string[] = [];
    const result = await svc().reportNotMyDriver(passenger.userId, ride.id, async (id) => { enqueued.push(id) });
    expect(result.reDispatched).toBe(true);
    expect(enqueued).toEqual([ride.id]);

    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('PENDING');
    expect(order.driverId).toBeNull();
    expect(order.ridePin).not.toBe('999111'); // rotated [F-014-12]
    expect(order.ridePinAttempts).toBe(0);
    const driver = await driverRow(d.driver.id);
    expect(driver.livenessLockedAt).not.toBeNull(); // the kill shot
    expect(driver.isOnline).toBe(false);
    expect(driver.currentRideId).toBeNull();
    // The lock holds even with the liveness feature OFF.
    delete process.env['LIVENESS_REQUIRED'];
    expect(() => assertShiftLiveness(driver)).toThrow(/contact support/i);

    const log = await app.prisma.orderStatusLog.findFirst({ where: { orderId: ride.id, changedBy: 'system:not-my-driver' } });
    expect(log).not.toBeNull();
    // §7.3 → §8: the report IS an S1 IncidentCase — the case machine owns the
    // ops page, the interim suspension, and the driver's due-process notice.
    const kase = await app.prisma.incidentCase.findFirst({ where: { orderId: ride.id, category: 'IDENTITY_MISMATCH' } });
    expect(kase).not.toBeNull();
    expect(kase!.severity).toBe('S1');
    expect(kase!.subjectUserId).toBe(d.userId);
    expect(await app.prisma.notification.findFirst({ where: { userId: admin.userId, title: { contains: kase!.caseNumber } } })).not.toBeNull();
    expect(await app.prisma.notification.findFirst({ where: { userId: passenger.userId, title: 'Finding you another driver' } })).not.toBeNull();
    const driverNote = await app.prisma.notification.findFirst({ where: { userId: d.userId, title: 'Account suspended pending review' } });
    expect(driverNote).not.toBeNull();
    expect(driverNote!.body).not.toContain(passenger.userId); // reporter never leaks

    // Second tap: honest idempotence, no second lock/release.
    const again = await svc().reportNotMyDriver(passenger.userId, ride.id);
    expect(again.alreadyHandled).toBe(true);
  });

  it('in-progress or PIN-verified custody is SOS territory; strangers see nothing', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const stranger = await makeUser(['CUSTOMER']);
    const d = await makeDriver();
    const aboard = await makeRide(d.driver.id, passenger.userId, 'RIDE_IN_PROGRESS');
    await expect(svc().reportNotMyDriver(passenger.userId, aboard.id)).rejects.toThrow(/SOS/i);
    await expect(svc().reportNotMyDriver(stranger.userId, aboard.id)).rejects.toThrow(/not found/i);

    const verified = await makeRide(d.driver.id, passenger.userId, 'DRIVER_ARRIVED');
    await app.prisma.order.update({
      where: { id: verified.id },
      data: { ridePinVerified: true, ridePinVerifiedAt: new Date() },
    });
    await expect(svc().reportNotMyDriver(passenger.userId, verified.id)).rejects.toThrow(/SOS/i);
    const untouched = await app.prisma.order.findUniqueOrThrow({ where: { id: verified.id } });
    expect({ status: untouched.status, driverId: untouched.driverId })
      .toEqual({ status: 'DRIVER_ARRIVED', driverId: d.driver.id });
  });
});
