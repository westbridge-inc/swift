import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { driverRoutes } from '../modules/driver/driver.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { testPhone } from './helpers/fixture-ids';

// [BUG-HUNT F08] One job is one job. A delivery with a tip has two Earning rows, and the tile said "2 jobs" beside a
// history listing one. The money still adds every row. Synthetic data only.
let app: FastifyInstance;
const userIds: string[] = [];
let rider: { id: string; token: string };
let driver: { id: string; token: string };

async function makeUser(first: string, role: UserRole) {
  const user = await app.prisma.user.create({ data: { phone: testPhone(), firstName: first, lastName: 'Jobs', roles: [role, 'CUSTOMER'] as UserRole[], activeRole: role, isPhoneVerified: true } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'jobs', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

const summary = async (who: 'rider' | 'driver', token: string) => {
  const res = await app.inject({ method: 'GET', url: `/${who}/earnings/summary`, headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as Record<string, { total: number; count: number }>;
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/rider' });
  await app.register(driverRoutes, { prefix: '/driver' });
  await app.ready();
  const r = await makeUser('Rider', 'RIDER');
  const riderRow = await app.prisma.rider.create({ data: { userId: r.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  rider = { id: riderRow.id, token: r.token };
  const d = await makeUser('Driver', 'DRIVER');
  const driverRow = await app.prisma.driver.create({ data: {
    userId: d.userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2021, vehicleColor: 'Silver', licensePlate: `OJ-${nanoid(4)}`, rideClass: 'ECONOMY',
    driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
  } });
  driver = { id: driverRow.id, token: d.token };
  const delivery = `oj-${nanoid(8)}`;
  const second = `oj-${nanoid(8)}`;
  const ride = `oj-${nanoid(8)}`;
  await app.prisma.earning.createMany({ data: [
    { riderId: rider.id, orderId: delivery, type: 'DELIVERY_FEE' as never, amount: 500, status: 'PENDING' as never },
    { riderId: rider.id, orderId: delivery, type: 'TIP' as never, amount: 200, status: 'PENDING' as never },
    { riderId: rider.id, orderId: second, type: 'DELIVERY_FEE' as never, amount: 300, status: 'PENDING' as never },
    { driverId: driver.id, orderId: ride, type: 'TAXI_FARE' as never, amount: 900, status: 'PENDING' as never },
    { driverId: driver.id, orderId: ride, type: 'TIP' as never, amount: 100, status: 'PENDING' as never },
  ] });
}, 60_000);

afterAll(async () => {
  await app.prisma.earning.deleteMany({ where: { OR: [{ riderId: rider.id }, { driverId: driver.id }] } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { id: rider.id } });
  await app.prisma.driver.deleteMany({ where: { id: driver.id } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[BUG-HUNT F08] one job is one job', () => {
  it.each(['today', 'thisWeek', 'thisMonth', 'allTime'])('a rider, %s: a delivery with a tip is one job, and the money counts both', async (window) => {
    expect((await summary('rider', rider.token))[window]).toEqual({ total: 1000, count: 2 });
  });

  it.each(['today', 'thisWeek', 'thisMonth', 'allTime'])('a driver, %s: a ride with a tip is one job', async (window) => {
    expect((await summary('driver', driver.token))[window]).toEqual({ total: 1000, count: 1 });
  });
});
