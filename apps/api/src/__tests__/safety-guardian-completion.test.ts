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

// Trip Guardian M4d — §5.4 completion sanity (a ride "completed" far from its
// destination is a post-trip review item), the §5.1 enhanced-monitoring
// opt-in endpoints, and the ops guardian board.

let app: FastifyInstance;
const emits: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
const io = {
  to: (room: string) => ({ emit: (event: string, payload: Record<string, unknown>) => { emits.push({ room, event, payload }) } }),
} as unknown as Server;
const sweep = (now: Date) => new GuardianService(app.prisma, io).sweep(now);

const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_730_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Sanity',
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
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'san', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

async function makeDriver() {
  const u = await makeUser(['MOVER']);
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `SAN ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      totalRides: 500, createdAt: new Date(Date.now() - 90 * 86_400_000),
    },
  });
  return { ...u, driver };
}

const PICKUP = { lat: 6.8, lng: -58.15 };
const DEST = { lat: 6.82, lng: -58.13 };

async function makeRide(driverId: string, customerId: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SAN-${nanoid(8)}`,
      orderType: 'TAXI',
      customerId,
      driverId,
      status: 'RIDE_IN_PROGRESS',
      fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: 'B', deliveryLat: DEST.lat, deliveryLng: DEST.lng,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0,
      totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
      pickedUpAt: new Date(Date.now() - 600_000), taxiDuration: 60,
    },
  });
  orderIds.push(order.id);
  return order;
}

const putFix = (driverId: string, at: Date, pos: { lat: number; lng: number }) =>
  app.prisma.driver.update({ where: { id: driverId }, data: { currentLat: pos.lat, currentLng: pos.lng, lastLocationUpdate: at } });

const session = (orderId: string) => app.prisma.tripSafetySession.findUniqueOrThrow({ where: { orderId } });

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

beforeEach(() => { emits.length = 0; });

afterAll(async () => {
  await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await app.prisma.tripSafetySession.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('§5.4 completion sanity', () => {
  it('a ride "completed" far from its destination is flagged to ops — one that arrived is not', async () => {
    const admin = await makeUser(['ADMIN']);
    const passenger = await makeUser(['CUSTOMER']);
    const { driver } = await makeDriver();
    const t0 = Date.now() - 900_000;

    // FAR case: last consumed fix ~1.5 km from the destination, then "complete".
    const far = await makeRide(driver.id, passenger.userId);
    await putFix(driver.id, new Date(t0), { lat: 6.81, lng: -58.14 });
    await sweep(new Date(t0));
    await app.prisma.order.update({ where: { id: far.id }, data: { status: 'COMPLETED' } });
    await sweep(new Date(t0 + 30_000));

    const sFar = await session(far.id);
    expect(sFar.status).toBe('CLOSED');
    expect(sFar.closeReason).toBe('TRIP_COMPLETED');
    const flag = (sFar.deviationState as { completionFlag?: { distM: number } }).completionFlag;
    expect(flag).toBeTruthy();
    expect(flag!.distM).toBeGreaterThan(750);
    expect(emits.find((e) => e.event === 'guardian:completion-flag')?.room).toBe('ops:war-room');
    // §5.4 → §8: the post-trip flag is now an S3 auto-case; the case machine
    // owns the ops page (kind incident_new).
    const kase = await app.prisma.incidentCase.findFirst({ where: { orderId: far.id, category: 'COMPLETION_ANOMALY' } });
    expect(kase).not.toBeNull();
    expect(kase!.severity).toBe('S3');
    expect(kase!.intake).toBe('SYSTEM_AUTO');
    expect(await app.prisma.notification.findFirst({ where: { userId: admin.userId, title: { contains: kase!.caseNumber } } })).not.toBeNull();

    // ARRIVED case: last fix ~30 m from the destination → silence.
    emits.length = 0;
    const near = await makeRide(driver.id, passenger.userId);
    await putFix(driver.id, new Date(t0 + 60_000), { lat: 6.8201, lng: -58.1302 });
    await sweep(new Date(t0 + 60_000));
    await app.prisma.order.update({ where: { id: near.id }, data: { status: 'COMPLETED' } });
    await sweep(new Date(t0 + 90_000));

    const sNear = await session(near.id);
    expect(sNear.closeReason).toBe('TRIP_COMPLETED');
    expect((sNear.deviationState as { completionFlag?: unknown }).completionFlag).toBeUndefined();
    expect(emits.find((e) => e.event === 'guardian:completion-flag')).toBeUndefined();
  });
});

describe('§5.1 enhanced-monitoring opt-in', () => {
  it('the toggle is the user\'s own choice — set, read back, and never anyone else\'s', async () => {
    const user = await makeUser(['CUSTOMER']);
    const put = await app.inject({ method: 'PUT', url: '/api/v1/safety/monitoring-preference', payload: { enabled: true }, headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` } });
    expect(put.statusCode).toBe(200);
    expect(put.json().data.enhancedSafetyMonitoring).toBe(true);

    const get = await app.inject({ method: 'GET', url: '/api/v1/safety/monitoring-preference', headers: { authorization: `Bearer ${user.token}` } });
    expect(get.json().data.enhancedSafetyMonitoring).toBe(true);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).enhancedSafetyMonitoring).toBe(true);

    const anon = await app.inject({ method: 'PUT', url: '/api/v1/safety/monitoring-preference', payload: { enabled: true }, headers: { 'content-type': 'application/json' } });
    expect(anon.statusCode).toBe(401);
  });
});

describe('ops guardian board', () => {
  it('ops list live sessions risk-first; non-ops are refused', async () => {
    const admin = await makeUser(['ADMIN']);
    const passenger = await makeUser(['CUSTOMER'], { enhancedSafetyMonitoring: true });
    const { driver } = await makeDriver();
    const ride = await makeRide(driver.id, passenger.userId);
    await sweep(new Date());

    const res = await app.inject({ method: 'GET', url: '/api/v1/safety/guardian?status=live', headers: { authorization: `Bearer ${admin.token}` } });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ orderId: string; status: string }>;
    expect(rows.find((r) => r.orderId === ride.id)?.status).toBe('MONITORING');

    const forbidden = await app.inject({ method: 'GET', url: '/api/v1/safety/guardian', headers: { authorization: `Bearer ${passenger.token}` } });
    expect(forbidden.statusCode).toBe(403);
  });
});
