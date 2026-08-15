import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { AuthService } from '../modules/auth/auth.service';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { startOfDayGY } from '../utils/time-gy';

const DAY = 24 * 60 * 60 * 1000;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
const redisKeys = new Set<string>();
const phoneBase = 592_750_000_000 + Math.floor(Math.random() * 100_000_000);
let sequence = 0;
let app: FastifyInstance;

async function makeUser(activeRole: UserRole, roles: UserRole[] = [activeRole]) {
  sequence += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + sequence}`,
      firstName: 'Revocation',
      lastName: `User${sequence}`,
      roles,
      activeRole,
      status: 'ACTIVE',
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(user.id);
  const session = await app.prisma.session.create({
    data: {
      userId: user.id,
      token: `revocation-access-${nanoid(24)}`,
      refreshToken: `revocation-refresh-${nanoid(32)}`,
      deviceId: `revocation-device-${sequence}`,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { user, session };
}

async function makeOrder(
  customerId: string,
  status: OrderStatus,
  options: {
    orderType?: 'FOOD_DELIVERY' | 'COURIER' | 'TAXI';
    riderId?: string;
    driverId?: string;
    acceptedAt?: Date;
    preparingAt?: Date;
    readyAt?: Date;
    subtotalBase?: number;
    ridePinVerified?: boolean;
    ridePinVerifiedAt?: Date;
  } = {},
) {
  const subtotal = options.subtotalBase ?? 1_000;
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `REV-${nanoid(12)}`,
      orderType: options.orderType ?? 'FOOD_DELIVERY',
      customerId,
      status,
      fulfillment: 'DELIVERY',
      pickupAddress: '1 Water Street',
      pickupLat: 6.801,
      pickupLng: -58.155,
      deliveryAddress: '2 Main Street',
      deliveryLat: 6.812,
      deliveryLng: -58.164,
      subtotalBase: subtotal,
      subtotalMarkup: 0,
      subtotalCustomer: subtotal,
      deliveryFee: options.orderType === 'TAXI' ? 0 : 500,
      totalAmount: options.orderType === 'TAXI' ? 2_000 : subtotal + 500,
      paymentMethod: 'CASH',
      ...(options.orderType === 'TAXI' ? { taxiFareTotal: 2_000 } : {}),
      ...(options.riderId ? { riderId: options.riderId } : {}),
      ...(options.driverId ? { driverId: options.driverId } : {}),
      ...(options.acceptedAt ? { acceptedAt: options.acceptedAt } : {}),
      ...(options.preparingAt ? { preparingAt: options.preparingAt } : {}),
      ...(options.readyAt ? { readyAt: options.readyAt } : {}),
      ...(options.ridePinVerified !== undefined ? { ridePinVerified: options.ridePinVerified } : {}),
      ...(options.ridePinVerifiedAt ? { ridePinVerifiedAt: options.ridePinVerifiedAt } : {}),
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

async function trackRedis(...keys: string[]) {
  for (const key of keys) redisKeys.add(key);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['JWT_SECRET'] = process.env['JWT_SECRET'] || 'revocation-test-secret-at-least-32-bytes';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();

  await makeUser('SUPER_ADMIN', ['SUPER_ADMIN']);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (redisKeys.size > 0) await app.redis.del(...redisKeys);
  if (createdOrderIds.length > 0) {
    await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  if (createdUserIds.length > 0) {
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('session revocation retires mover supply without stranding physical custody', () => {
  it('removes an idle rider offer and closes online hours after the DB commit', async () => {
    const customer = await makeUser('CUSTOMER', ['CUSTOMER']);
    const mover = await makeUser('MOVER', ['MOVER', 'CUSTOMER']);
    const rider = await app.prisma.rider.create({
      data: {
        userId: mover.user.id,
        riderType: 'DELIVERY',
        vehicleType: 'MOTORCYCLE',
        documentsVerified: true,
        isOnline: true,
        isAvailable: true,
        locationSessionId: mover.session.id,
      },
    });
    const order = await makeOrder(customer.user.id, 'ACCEPTED');
    const offer = `dispatch:offer:${order.id}`;
    const moverOffer = `dispatch:mover-offer:${rider.id}`;
    const declined = `dispatch:declined:${order.id}`;
    const onlineSince = `rider:online_since:${rider.id}`;
    const onlineMs = `rider:online_ms:${rider.id}:${startOfDayGY().toISOString().slice(0, 10)}`;
    await trackRedis(offer, moverOffer, declined, onlineSince, onlineMs);
    await Promise.all([
      app.redis.set(offer, rider.id, 'EX', 60),
      app.redis.set(moverOffer, order.id, 'EX', 60),
      app.redis.set(onlineSince, String(Date.now() - 1_500)),
    ]);
    vi.spyOn(DispatchService.prototype, 'dispatchOrder').mockResolvedValue({});

    await new AuthService(app).logout(mover.session.id, mover.user.id);

    const [profile, session, liveOffer, reverseOffer, openHours, accumulated] = await Promise.all([
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } }),
      app.prisma.session.findUnique({ where: { id: mover.session.id } }),
      app.redis.get(offer),
      app.redis.get(moverOffer),
      app.redis.get(onlineSince),
      app.redis.get(onlineMs),
    ]);
    expect(session).toBeNull();
    expect({
      online: profile.isOnline,
      available: profile.isAvailable,
      owner: profile.locationSessionId,
    }).toEqual({ online: false, available: false, owner: null });
    expect(liveOffer).toBeNull();
    expect(reverseOffer).toBeNull();
    expect(openHours).toBeNull();
    expect(Number(accumulated)).toBeGreaterThan(0);
  });

  it('atomically releases a pre-pickup delivery, restores its prep milestone, float, and dispatchability', async () => {
    const customer = await makeUser('CUSTOMER', ['CUSTOMER']);
    const mover = await makeUser('MOVER', ['MOVER', 'CUSTOMER']);
    const rider = await app.prisma.rider.create({
      data: {
        userId: mover.user.id,
        riderType: 'DELIVERY',
        vehicleType: 'MOTORCYCLE',
        documentsVerified: true,
        isOnline: true,
        isAvailable: false,
        locationSessionId: mover.session.id,
        floatLimit: 10_000,
        committedFloat: 1_000,
      },
    });
    const order = await makeOrder(customer.user.id, 'RIDER_EN_ROUTE_PICKUP', {
      riderId: rider.id,
      acceptedAt: new Date(Date.now() - 10_000),
      preparingAt: new Date(Date.now() - 5_000),
      subtotalBase: 1_000,
    });
    await app.prisma.rider.update({ where: { id: rider.id }, data: { currentOrderId: order.id } });
    const redispatch = vi.spyOn(DispatchService.prototype, 'retryDispatch').mockResolvedValue({});

    await new AuthService(app).logout(mover.session.id, mover.user.id);

    const [freshOrder, profile, log, notice] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } }),
      app.prisma.orderStatusLog.findFirst({ where: { orderId: order.id, changedBy: 'system:session-revocation' } }),
      app.prisma.notification.findFirst({ where: { userId: customer.user.id, title: 'Finding you another rider' } }),
    ]);
    expect({ status: freshOrder.status, riderId: freshOrder.riderId }).toEqual({ status: 'PREPARING', riderId: null });
    expect({
      currentOrderId: profile.currentOrderId,
      committedFloat: Number(profile.committedFloat),
      online: profile.isOnline,
      available: profile.isAvailable,
      owner: profile.locationSessionId,
    }).toEqual({ currentOrderId: null, committedFloat: 0, online: false, available: false, owner: null });
    expect(log?.status).toBe('PREPARING');
    expect(notice).not.toBeNull();
    expect(redispatch).toHaveBeenCalledWith(order.id);
  });

  it('atomically releases a taxi before pickup and starts a replacement search', async () => {
    const customer = await makeUser('CUSTOMER', ['CUSTOMER']);
    const mover = await makeUser('MOVER', ['MOVER', 'CUSTOMER']);
    const driver = await app.prisma.driver.create({
      data: {
        userId: mover.user.id,
        vehicleMake: 'Toyota',
        vehicleModel: 'Allion',
        vehicleYear: 2021,
        vehicleColor: 'Silver',
        licensePlate: `REV-${nanoid(6)}`,
        driverLicenseUrl: 'storage://test/license',
        vehicleInsuranceUrl: 'storage://test/insurance',
        documentsVerified: true,
        isOnline: true,
        isAvailable: false,
        locationSessionId: mover.session.id,
      },
    });
    const order = await makeOrder(customer.user.id, 'DRIVER_ARRIVED', {
      orderType: 'TAXI',
      driverId: driver.id,
      acceptedAt: new Date(Date.now() - 5_000),
    });
    await app.prisma.driver.update({ where: { id: driver.id }, data: { currentRideId: order.id } });
    const redispatch = vi.spyOn(DispatchService.prototype, 'retryDispatch').mockResolvedValue({});

    await new AuthService(app).logout(mover.session.id, mover.user.id);

    const [freshOrder, profile, log] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } }),
      app.prisma.orderStatusLog.findFirst({ where: { orderId: order.id, changedBy: 'system:session-revocation' } }),
    ]);
    expect({ status: freshOrder.status, driverId: freshOrder.driverId, acceptedAt: freshOrder.acceptedAt })
      .toEqual({ status: 'PENDING', driverId: null, acceptedAt: null });
    expect({
      currentRideId: profile.currentRideId,
      online: profile.isOnline,
      available: profile.isAvailable,
      owner: profile.locationSessionId,
    }).toEqual({ currentRideId: null, online: false, available: false, owner: null });
    expect(log?.status).toBe('PENDING');
    expect(redispatch).toHaveBeenCalledWith(order.id);
  });

  it('preserves DRIVER_ARRIVED after verified handoff during the start window', async () => {
    const customer = await makeUser('CUSTOMER', ['CUSTOMER']);
    const mover = await makeUser('MOVER', ['MOVER', 'CUSTOMER']);
    const driver = await app.prisma.driver.create({
      data: {
        userId: mover.user.id,
        vehicleMake: 'Toyota',
        vehicleModel: 'Allion',
        vehicleYear: 2021,
        vehicleColor: 'Silver',
        licensePlate: `REV-${nanoid(6)}`,
        driverLicenseUrl: 'storage://test/license',
        vehicleInsuranceUrl: 'storage://test/insurance',
        documentsVerified: true,
        isOnline: true,
        isAvailable: false,
        locationSessionId: mover.session.id,
      },
    });
    const verifiedAt = new Date();
    const order = await makeOrder(customer.user.id, 'DRIVER_ARRIVED', {
      orderType: 'TAXI',
      driverId: driver.id,
      acceptedAt: new Date(Date.now() - 5_000),
      ridePinVerified: true,
      ridePinVerifiedAt: verifiedAt,
    });
    await app.prisma.driver.update({ where: { id: driver.id }, data: { currentRideId: order.id } });
    await trackRedis(`ops_page:mover_session_ended:${order.id}`);
    const redispatch = vi.spyOn(DispatchService.prototype, 'retryDispatch');

    await new AuthService(app).logout(mover.session.id, mover.user.id);

    const [freshOrder, profile] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } }),
    ]);
    expect({
      status: freshOrder.status,
      driverId: freshOrder.driverId,
      ridePinVerified: freshOrder.ridePinVerified,
      ridePinVerifiedAt: freshOrder.ridePinVerifiedAt,
    }).toEqual({
      status: 'DRIVER_ARRIVED',
      driverId: driver.id,
      ridePinVerified: true,
      ridePinVerifiedAt: verifiedAt,
    });
    expect({
      currentRideId: profile.currentRideId,
      online: profile.isOnline,
      available: profile.isAvailable,
      owner: profile.locationSessionId,
    }).toEqual({ currentRideId: order.id, online: false, available: false, owner: null });
    expect(redispatch).not.toHaveBeenCalled();
  });

  it('preserves a delivery already in the rider custody and pages operations immediately', async () => {
    const customer = await makeUser('CUSTOMER', ['CUSTOMER']);
    const mover = await makeUser('MOVER', ['MOVER', 'CUSTOMER']);
    const rider = await app.prisma.rider.create({
      data: {
        userId: mover.user.id,
        riderType: 'DELIVERY',
        vehicleType: 'MOTORCYCLE',
        documentsVerified: true,
        isOnline: true,
        isAvailable: false,
        locationSessionId: mover.session.id,
      },
    });
    const order = await makeOrder(customer.user.id, 'PICKED_UP', { riderId: rider.id });
    await app.prisma.rider.update({ where: { id: rider.id }, data: { currentOrderId: order.id } });
    await trackRedis(`ops_page:mover_session_ended:${order.id}`);

    await new AuthService(app).logout(mover.session.id, mover.user.id);

    const [freshOrder, profile, customerNotice, opsNotice] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } }),
      app.prisma.notification.findFirst({ where: { userId: customer.user.id, title: 'Your rider went offline' } }),
      app.prisma.notification.findFirst({ where: { title: 'Rider signed out with order in custody' } }),
    ]);
    expect({ status: freshOrder.status, riderId: freshOrder.riderId })
      .toEqual({ status: 'PICKED_UP', riderId: rider.id });
    expect({
      currentOrderId: profile.currentOrderId,
      online: profile.isOnline,
      available: profile.isAvailable,
      owner: profile.locationSessionId,
    }).toEqual({ currentOrderId: order.id, online: false, available: false, owner: null });
    expect(customerNotice).not.toBeNull();
    expect(opsNotice).not.toBeNull();
  });

  it('never auto-reassigns a taxi passenger already in the vehicle', async () => {
    const customer = await makeUser('CUSTOMER', ['CUSTOMER']);
    const mover = await makeUser('MOVER', ['MOVER', 'CUSTOMER']);
    const driver = await app.prisma.driver.create({
      data: {
        userId: mover.user.id,
        vehicleMake: 'Toyota',
        vehicleModel: 'Premio',
        vehicleYear: 2020,
        vehicleColor: 'Black',
        licensePlate: `REV-${nanoid(6)}`,
        driverLicenseUrl: 'storage://test/license',
        vehicleInsuranceUrl: 'storage://test/insurance',
        documentsVerified: true,
        isOnline: true,
        isAvailable: false,
        locationSessionId: mover.session.id,
      },
    });
    const order = await makeOrder(customer.user.id, 'RIDE_IN_PROGRESS', {
      orderType: 'TAXI',
      driverId: driver.id,
      acceptedAt: new Date(Date.now() - 60_000),
    });
    await app.prisma.driver.update({ where: { id: driver.id }, data: { currentRideId: order.id } });
    await trackRedis(`ops_page:mover_session_ended:${order.id}`);
    const redispatch = vi.spyOn(DispatchService.prototype, 'retryDispatch');

    await new AuthService(app).logout(mover.session.id, mover.user.id);

    const [freshOrder, profile, customerNotice, opsNotice] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } }),
      app.prisma.notification.findFirst({ where: { userId: customer.user.id, title: 'Your driver went offline' } }),
      app.prisma.notification.findFirst({ where: { title: 'Driver signed out with passenger aboard' } }),
    ]);
    expect({ status: freshOrder.status, driverId: freshOrder.driverId })
      .toEqual({ status: 'RIDE_IN_PROGRESS', driverId: driver.id });
    expect({
      currentRideId: profile.currentRideId,
      online: profile.isOnline,
      available: profile.isAvailable,
      owner: profile.locationSessionId,
    }).toEqual({ currentRideId: order.id, online: false, available: false, owner: null });
    expect(redispatch).not.toHaveBeenCalled();
    expect(customerNotice).not.toBeNull();
    expect(opsNotice).not.toBeNull();
  });
});
