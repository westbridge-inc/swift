import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { earningsSummaryContract, earningsTodayContract } from '../contracts/earnings';

// ---------------------------------------------------------------------------
// SWIFT-080: the mover earnings endpoints feed the SAME screens for both roles,
// so the rider and driver responses must satisfy ONE contract. This is the
// regression net for the class of bug that shipped driver tiles at $0 (#408):
// every earnings response is parsed through its schema, for BOTH roles.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let riderToken: string;
let driverToken: string;
const userIds: string[] = [];
let riderId = '';
let driverId = '';

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
  await app.register(riderRoutes, { prefix: '/rider' });
  await app.register(driverRoutes, { prefix: '/driver' });
  await app.ready();

  const mkUser = async (n: string) => {
    const u = await app.prisma.user.create({
      data: {
        phone: `+59200804${String(Math.floor(Math.random() * 90) + 10)}`,
        firstName: n, lastName: 'Contract',
        roles: ['DRIVER', 'RIDER', 'CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER',
        isPhoneVerified: true,
      },
    });
    userIds.push(u.id);
    return u;
  };
  const session = async (userId: string, role: string) => {
    const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId, token, refreshToken: nanoid(48), deviceId: 'ec', deviceType: 'test', expiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
    });
    return token;
  };

  const rUser = await mkUser('Rida');
  const rider = await app.prisma.rider.create({ data: { userId: rUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  riderId = rider.id;
  riderToken = await session(rUser.id, 'RIDER');
  await app.prisma.earning.createMany({
    data: [
      { riderId, orderId: `ec-r-${nanoid(6)}`, type: 'DELIVERY_FEE' as never, amount: 700, status: 'PENDING' as never },
      { riderId, orderId: `ec-r-${nanoid(6)}`, type: 'TIP' as never, amount: 300, status: 'PENDING' as never },
    ],
  });

  const dUser = await mkUser('Driva');
  const driver = await app.prisma.driver.create({
    data: {
      userId: dUser.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2021,
      vehicleColor: 'Silver', licensePlate: `EC-${nanoid(4)}`, rideClass: 'ECONOMY', documentsVerified: true,
      driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
    },
  });
  driverId = driver.id;
  driverToken = await session(dUser.id, 'DRIVER');
  await app.prisma.earning.createMany({
    data: [
      { driverId, orderId: `ec-d-${nanoid(6)}`, type: 'TAXI_FARE' as never, amount: 1500, status: 'PENDING' as never },
    ],
  });
});

afterAll(async () => {
  if (riderId) await app.prisma.earning.deleteMany({ where: { riderId } });
  if (driverId) await app.prisma.earning.deleteMany({ where: { driverId } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  if (riderId) await app.prisma.rider.deleteMany({ where: { id: riderId } });
  if (driverId) await app.prisma.driver.deleteMany({ where: { id: driverId } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

describe('SWIFT-080: mover earnings responses satisfy ONE contract for both roles', () => {
  it('rider /earnings/summary matches the summary contract', async () => {
    const res = await get('/rider/earnings/summary', riderToken);
    expect(res.statusCode).toBe(200);
    const parsed = earningsSummaryContract.safeParse(res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('driver /earnings/summary matches the SAME summary contract (the #408 drift class)', async () => {
    const res = await get('/driver/earnings/summary', driverToken);
    expect(res.statusCode).toBe(200);
    const parsed = earningsSummaryContract.safeParse(res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('rider /earnings/today matches the today contract', async () => {
    const res = await get('/rider/earnings/today', riderToken);
    expect(res.statusCode).toBe(200);
    const parsed = earningsTodayContract.safeParse(res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('driver /earnings/today matches the SAME today contract', async () => {
    const res = await get('/driver/earnings/today', driverToken);
    expect(res.statusCode).toBe(200);
    const parsed = earningsTodayContract.safeParse(res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('the contract REJECTS the pre-#408 drift (a bare-number window) — proving the net has teeth', () => {
    const preFix = { success: true as const, data: { today: 500, thisWeek: 500, thisMonth: 500, allTime: 500, pendingPayout: 0 } };
    expect(earningsSummaryContract.safeParse(preFix).success).toBe(false);
  });
});
