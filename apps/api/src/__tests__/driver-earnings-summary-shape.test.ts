import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// SWIFT-080 (contract drift, realized). /driver/earnings/summary must return
// each window (today/thisWeek/thisMonth/allTime) as { total, count } — the SAME
// shape /rider/earnings/summary returns and the shared mover EarningsScreen +
// MoverAccountScreen read (`.today.total`, `.today.count`). The driver route
// used to return each window as a bare Number, so a DRIVER's Today / This-month
// / All-time tiles silently rendered $0. Same screen, role-dependent shape.
// This is the missing test that let the drift hide.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
let userId: string;
let driverId: string;

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
  await app.register(driverRoutes, { prefix: '/driver' });
  await app.ready();

  const u = await app.prisma.user.create({
    data: {
      phone: `+59200803${String(Math.floor(Math.random() * 90) + 10)}`,
      firstName: 'Earn', lastName: 'Shape',
      roles: ['DRIVER', 'CUSTOMER'] as UserRole[], activeRole: 'DRIVER',
      isPhoneVerified: true,
    },
  });
  userId = u.id;
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.id,
      vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2021,
      vehicleColor: 'Silver', licensePlate: `ES-${nanoid(4)}`,
      rideClass: 'ECONOMY', documentsVerified: true,
      driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
    },
  });
  driverId = driver.id;
  // Two earnings today → today.total = 500, today.count = 2.
  await app.prisma.earning.createMany({
    data: [
      { driverId, orderId: `es-${nanoid(8)}`, type: 'TAXI_FARE' as never, amount: 300, status: 'PENDING' as never },
      { driverId, orderId: `es-${nanoid(8)}`, type: 'TAXI_FARE' as never, amount: 200, status: 'PENDING' as never },
    ],
  });
  token = app.jwt.sign({ userId: u.id, role: 'DRIVER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'es', deviceType: 'test', expiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
  });
});

afterAll(async () => {
  await app.prisma.earning.deleteMany({ where: { driverId } });
  await app.prisma.session.deleteMany({ where: { userId } });
  await app.prisma.driver.deleteMany({ where: { id: driverId } });
  await app.prisma.user.deleteMany({ where: { id: userId } });
  await app.close();
});

describe('GET /driver/earnings/summary — window shape contract (SWIFT-080)', () => {
  it('returns every window as { total, count }, not a bare number (driver tiles were $0)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/driver/earnings/summary',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: Record<string, { total: number; count: number }> };

    // The bug: `today` was a number → the client's `.today.total` read undefined → $0.
    expect(typeof data['today']).toBe('object');
    expect(data['today']).toMatchObject({ total: 500, count: 2 });

    for (const w of ['today', 'thisWeek', 'thisMonth', 'allTime'] as const) {
      expect(typeof data[w]!.total).toBe('number');
      expect(typeof data[w]!.count).toBe('number');
    }
    // all-time is a superset of today's two.
    expect(data['allTime']!.total).toBeGreaterThanOrEqual(500);
    expect(data['allTime']!.count).toBeGreaterThanOrEqual(2);
  });
});
