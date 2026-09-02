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
import { LivenessService, scanNotMyDriverDecisions, repairNotMyDriverDecisions } from '../modules/safety/liveness.service';
import { intakeFingerprint } from '../modules/safety/incident.service';
import { drainCheckoutOutbox, dispatchCommandDedupeKey, type CheckoutOutboxRuntime } from '../modules/order/checkout-outbox';
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
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
  await app.prisma.legalHold.deleteMany({ where: { caseId: { in: caseIds } } }).catch(() => {});
  await app.prisma.incidentCase.deleteMany({ where: { id: { in: caseIds } } }).catch(() => {});
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
// [S-13] Not-my-driver notification failure can prevent redispatch and
// incident creation.
//
// The register's red test: fail the notification after the database
// transaction; a restart must produce one incident and one dispatch command.
// Around it: a death inside the decision leaves nothing (no split); the second
// tap is idempotent; the inline fast path and the outbox drainer publish the
// same job once; decisions lacking either artifact are found and repaired;
// the rollback opens the case and touches no authority.
// ---------------------------------------------------------------------------

const caseIds: string[] = [];
const fingerprint = (orderId: string) => intakeFingerprint({ type: 'LIVENESS_NOT_MY_DRIVER', id: orderId });
const caseFor = (orderId: string) => app.prisma.incidentCase.findUnique({ where: { sourceFingerprint: fingerprint(orderId) } });
const commandFor = (orderId: string) => app.prisma.orderOutbox.findUnique({ where: { dedupeKey: dispatchCommandDedupeKey(orderId, 'not-my-driver') } });
const orderOf = (id: string) => app.prisma.order.findUniqueOrThrow({ where: { id } });
const driverOf = (id: string) => app.prisma.driver.findUniqueOrThrow({ where: { id } });
type Add = { name: string; data: Record<string, unknown>; opts?: Record<string, unknown> };
const fakeQueues = () => { const adds: Add[] = []; const q = { add: async (name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => { adds.push({ name, data, opts }); return {}; } }; return { adds, runtime: { prisma: app.prisma, queues: { orderQueue: q, notificationQueue: q, dispatchQueue: q }, log: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as CheckoutOutboxRuntime }; };
const liveness = () => new LivenessService(app.prisma, io);
const brokenNotifications = (svc: LivenessService) => { (svc as unknown as { notifications: { send: () => Promise<string> } }).notifications = { send: async () => { throw new Error('push provider down'); } }; return svc; };

/** A ride whose driver is en route — the not-my-driver window. */
async function enRouteRide() {
  const passenger = await makeUser(['CUSTOMER']);
  const driverUser = await makeDriver();
  const ride = await makeRide(driverUser.driver.id, passenger.userId, new Date());
  await app.prisma.order.update({ where: { id: ride.id }, data: { status: 'DRIVER_EN_ROUTE', pickedUpAt: null, ridePinVerified: false } });
  return { passenger, driverUser, ride };
}

describe('[S-13] the register’s red test: the notification fails after the commit', () => {
  it('the ride is released, the driver locked, the case and the dispatch command exist; a restart publishes exactly one dispatch job', async () => {
    const { passenger, driverUser, ride } = await enRouteRide();
    const res = await brokenNotifications(liveness()).reportNotMyDriver(passenger.userId, ride.id);
    expect(res).toMatchObject({ reDispatched: true, sosAvailable: true });
    const order = await orderOf(ride.id);
    expect(order.status).toBe('PENDING'); expect(order.driverId).toBeNull();
    expect((await driverOf(driverUser.driver.id)).livenessLockedAt).not.toBeNull();
    const kase = await caseFor(ride.id);
    expect(kase).not.toBeNull(); caseIds.push(kase!.id);
    expect(kase!.subjectUserId).toBe(driverUser.userId);
    const cmd = await commandFor(ride.id);
    expect(cmd).toMatchObject({ kind: 'dispatch-order', queue: 'dispatch', processedAt: null });
    // the worker restarts
    const { adds, runtime } = fakeQueues();
    expect(await drainCheckoutOutbox(runtime, { orderIds: [ride.id] })).toMatchObject({ processed: 1, failed: 0 });
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({ name: 'dispatch-order', data: { orderId: ride.id, reason: 'not-my-driver' }, opts: { jobId: cmd!.id } });
    expect(await drainCheckoutOutbox(runtime, { orderIds: [ride.id] })).toMatchObject({ processed: 0 });
    expect(adds).toHaveLength(1);
    expect(await app.prisma.incidentCase.count({ where: { sourceFingerprint: fingerprint(ride.id) } })).toBe(1);
    // the second tap is idempotent
    expect(await liveness().reportNotMyDriver(passenger.userId, ride.id)).toMatchObject({ alreadyHandled: true });
    expect(await app.prisma.orderOutbox.count({ where: { orderId: ride.id, kind: 'dispatch-order' } })).toBe(1);
  });

  it('a death inside the decision leaves nothing: driver still assigned and unlocked, no case, no command', async () => {
    const { passenger, driverUser, ride } = await enRouteRide();
    const svc = liveness();
    svc.observer = { beforeCommit: async () => { throw new Error('process died'); } };
    await expect(svc.reportNotMyDriver(passenger.userId, ride.id)).rejects.toThrow('process died');
    const order = await orderOf(ride.id);
    expect(order.status).toBe('DRIVER_EN_ROUTE'); expect(order.driverId).toBe(driverUser.driver.id);
    expect((await driverOf(driverUser.driver.id)).livenessLockedAt).toBeNull();
    expect(await caseFor(ride.id)).toBeNull();
    expect(await commandFor(ride.id)).toBeNull();
  });

  it('the inline fast path publishes the same job the drainer would, and marks the command done so it is never published twice', async () => {
    const { passenger, ride } = await enRouteRide();
    const inline: Array<{ orderId: string; jobId: string }> = [];
    await liveness().reportNotMyDriver(passenger.userId, ride.id, async (orderId, jobId) => { inline.push({ orderId, jobId }); });
    const cmd = (await commandFor(ride.id))!;
    caseIds.push((await caseFor(ride.id))!.id);
    expect(inline).toEqual([{ orderId: ride.id, jobId: cmd.id }]);
    expect(cmd.processedAt).not.toBeNull();
    const { adds, runtime } = fakeQueues();
    expect(await drainCheckoutOutbox(runtime, { orderIds: [ride.id] })).toMatchObject({ processed: 0 });
    expect(adds).toHaveLength(0);
  });
});

describe('[S-13] operations and the rollback', () => {
  it('a decision lacking its case and its command is found and repaired', async () => {
    const { passenger, driverUser, ride } = await enRouteRide();
    // the old split: the release happened, nothing else did
    await app.prisma.order.update({ where: { id: ride.id }, data: { status: 'PENDING', driverId: null } });
    await app.prisma.orderStatusLog.create({ data: { orderId: ride.id, status: 'PENDING', changedBy: 'system:not-my-driver', note: 'legacy decision' } });
    void driverUser; void passenger;
    const scan = await scanNotMyDriverDecisions(app.prisma);
    expect(scan.missingCase).toContain(ride.id); expect(scan.missingDispatch).toContain(ride.id);
    const fixed = await repairNotMyDriverDecisions(app.prisma, io);
    expect(fixed.repaired).toContain(ride.id);
    const kase = await caseFor(ride.id); expect(kase).not.toBeNull(); caseIds.push(kase!.id);
    expect(kase!.summary).toContain('REPAIRED');
    expect(await commandFor(ride.id)).not.toBeNull();
    const after = await scanNotMyDriverDecisions(app.prisma);
    expect(after.missingCase).not.toContain(ride.id); expect(after.missingDispatch).not.toContain(ride.id);
  });

  it('the rollback: the report opens the durable case and pages ops, but releases nothing, locks nothing, dispatches nothing', async () => {
    const { passenger, driverUser, ride } = await enRouteRide();
    process.env['NOT_MY_DRIVER_AUTHORITY_KILL'] = '1';
    let res;
    try { res = await liveness().reportNotMyDriver(passenger.userId, ride.id); } finally { delete process.env['NOT_MY_DRIVER_AUTHORITY_KILL']; }
    expect(res).toMatchObject({ reDispatched: false, manualReview: true, sosAvailable: true });
    const order = await orderOf(ride.id);
    expect(order.status).toBe('DRIVER_EN_ROUTE'); expect(order.driverId).toBe(driverUser.driver.id);
    expect((await driverOf(driverUser.driver.id)).livenessLockedAt).toBeNull();
    const kase = await caseFor(ride.id); expect(kase).not.toBeNull(); caseIds.push(kase!.id);
    expect(kase!.summary).toContain('DISABLED');
    expect(await commandFor(ride.id)).toBeNull();
  });
});
