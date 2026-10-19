/**
 * [COORD 18 Oct, option S] A person's own rider / driver / provider row, as the person gets it back, never
 * carries the live averageRating/totalRatings (they move with each single rating): the whole-groups figure
 * replaces them at the very keys builds 9-12 read (the mover account screen draws profile.averageRating).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { servicesRoutes } from '../modules/services/services.routes';
import { clearShownRatingCache } from '../modules/rating/rating-groups';
import { wordFreeTag } from './helpers/fixture-ids';

const DAY = 86_400_000;
let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
const vendorIds: string[] = [];
const MARK = wordFreeTag(8);
let seq = 0;
const phoneBase = 592_760_000_000 + Math.floor(Math.random() * 9_000_000);

async function user(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const u = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Shown', lastName: `U${seq}`, roles, activeRole, isPhoneVerified: true,
    ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'shown-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { id: u.id, token };
}

/** Six final ratings (past the 7-day edit window): one whole group of 5 (scores 3) and one more (a 1). */
async function sixRatings(rateeId: string, type: 'CUSTOMER_TO_RIDER' | 'CUSTOMER_TO_DRIVER' | 'CUSTOMER_TO_PROVIDER') {
  const customer = await user(['CUSTOMER'], 'CUSTOMER');
  const owner = await user(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const v = await app.prisma.vendor.create({ data: {
    ownerId: vo.id, name: `Shown ${MARK}`, slug: `shown-${MARK}-${seq}`, vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
    addressLine1: '1 Shown Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
  } });
  vendorIds.push(v.id);
  for (const [i, score] of [3, 3, 3, 3, 3, 1].entries()) {
    const o = await app.prisma.order.create({ data: {
      orderNumber: `SHN-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', customerId: customer.id, vendorId: v.id, status: 'DELIVERED',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 900, subtotalMarkup: 0, subtotalCustomer: 900, deliveryFee: 0, totalAmount: 900, paymentMethod: 'CASH',
    } });
    orderIds.push(o.id);
    const createdAt = new Date(Date.now() - 20 * DAY + i * 60_000);
    await app.prisma.rating.create({ data: { orderId: o.id, raterId: customer.id, rateeId, type, score, createdAt, editableUntil: new Date(createdAt.getTime() + 7 * DAY) } });
  }
}

const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.ready();
  clearShownRatingCache();
}, 30_000);

afterAll(async () => {
  await app.prisma.rating.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[option S] a person never gets their own live rating totals back', () => {
  it('GET /rider/profile: the top-level and stats figures are the whole groups (5 ratings at 3), not the live row (41 at 4.9)', async () => {
    const r = await user(['RIDER'], 'RIDER');
    await app.prisma.rider.create({ data: { userId: r.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', averageRating: 4.9, totalRatings: 41 } });
    await sixRatings(r.id, 'CUSTOMER_TO_RIDER');
    const res = await get('/api/v1/rider/profile', r.token);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect({ averageRating: data.averageRating, totalRatings: data.totalRatings }).toEqual({ averageRating: 3, totalRatings: 5 });
    expect({ averageRating: data.stats.averageRating, totalRatings: data.stats.totalRatings }).toEqual({ averageRating: 3, totalRatings: 5 });
  });

  it('GET /driver/profile: the same', async () => {
    const d = await user(['DRIVER'], 'DRIVER');
    await app.prisma.driver.create({ data: {
      userId: d.id, vehicleType: 'CAR', documentsVerified: false, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'Silver',
      licensePlate: `SH ${MARK}${seq}`, driverLicenseUrl: 'test/lic', vehicleInsuranceUrl: 'test/ins', averageRating: 4.9, totalRatings: 41,
    } });
    await sixRatings(d.id, 'CUSTOMER_TO_DRIVER');
    const res = await get('/api/v1/driver/profile', d.token);
    expect(res.statusCode, res.body).toBe(200);
    expect({ averageRating: res.json().data.averageRating, totalRatings: res.json().data.totalRatings }).toEqual({ averageRating: 3, totalRatings: 5 });
  });

  it('GET /services/providers/me: the same', async () => {
    const p = await user(['CUSTOMER'], 'CUSTOMER'); // a provider is a person with a provider profile
    await app.prisma.serviceProvider.create({ data: { userId: p.id, trade: 'PLUMBER', averageRating: 4.9, totalRatings: 41 } });
    await sixRatings(p.id, 'CUSTOMER_TO_PROVIDER');
    const res = await get('/api/v1/services/providers/me', p.token);
    expect(res.statusCode, res.body).toBe(200);
    expect({ averageRating: res.json().data.averageRating, totalRatings: res.json().data.totalRatings }).toEqual({ averageRating: 3, totalRatings: 5 });
  });
});
