import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import os from 'node:os';
import path from 'node:path';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { driverRoutes } from '../modules/driver/driver.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicUploads } from '../utils/public-uploads';

// ---------------------------------------------------------------------------
// Trust visibility on tracking (master plan §3.3 + §5): movers upload a PUBLIC
// vehicle photo; ride + delivery tracking payloads carry photo/vehicle/plate
// so the customer sees who and what is coming.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_DIR = path.join(os.tmpdir(), `swift-vehicle-uploads-${nanoid(6)}`);

let app: FastifyInstance;
const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200278${String(seq).padStart(2, '0')}`,
      firstName: 'Trust',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      avatar: '/uploads/avatars/trust.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'trust-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

const REAL_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

function multipartBody(filename: string, mime: string, content: Buffer) {
  const boundary = `----swift${nanoid(8)}`;
  const head = Buffer.from(
    `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function postPhoto(url: string, token: string, content = REAL_PNG, mime = 'image/png') {
  const { payload, contentType } = multipartBody('car.png', mime, content);
  return app.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'content-type': contentType, authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['UPLOAD_DIR'] = UPLOAD_DIR;

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerPublicUploads(app, UPLOAD_DIR);
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('Vehicle photo uploads (public trees)', () => {
  it('driver uploads a car photo → stored publicly, set on the profile', async () => {
    const u = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
    await app.prisma.driver.create({
      data: {
        userId: u.userId,
        vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2021,
        vehicleColor: 'White', licensePlate: `HT-${seq}`,
        driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
      },
    });

    const res = await postPhoto('/api/v1/driver/vehicle-photo', u.token);
    expect(res.statusCode).toBe(200);
    const url = res.json().data.vehiclePhotoUrl as string;
    expect(url).toContain('/uploads/vehicles/');

    // The photo is public — the customer's app loads it with no auth.
    const img = await app.inject({ method: 'GET', url });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
  });

  it('rider uploads a delivery-vehicle photo the same way', async () => {
    const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
    await app.prisma.rider.create({
      data: { userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', licensePlate: `CG-${seq}` },
    });

    const res = await postPhoto('/api/v1/rider/vehicle-photo', u.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.vehiclePhotoUrl).toContain('/uploads/vehicles/');
  });

  it('rejects spoofed image content', async () => {
    const u = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
    await app.prisma.driver.create({
      data: {
        userId: u.userId,
        vehicleMake: 'Toyota', vehicleModel: 'Premio', vehicleYear: 2020,
        vehicleColor: 'Black', licensePlate: `HS-${seq}`,
        driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
      },
    });
    const res = await postPhoto('/api/v1/driver/vehicle-photo', u.token, Buffer.from('#!/bin/sh\nnope\n'.repeat(4)));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_IMAGE');
  });
});

describe('Tracking payloads carry the trust fields', () => {
  it('ride detail exposes the driver photo, car photo, vehicle and plate', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const du = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
    const driver = await app.prisma.driver.create({
      data: {
        userId: du.userId,
        vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2021,
        vehicleColor: 'Silver', licensePlate: `HV-${seq}`,
        vehiclePhotoUrl: '/uploads/vehicles/test/car.png',
        driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
      },
    });
    const ride = await app.prisma.order.create({
      data: {
        orderNumber: `TRUST-${nanoid(8)}`,
        orderType: 'TAXI',
        customerId: customer.userId,
        driverId: driver.id,
        status: 'DRIVER_ASSIGNED',
        deliveryAddress: 'B', deliveryLat: 6.75, deliveryLng: -58.15,
        pickupAddress: 'A', pickupLat: 6.81, pickupLng: -58.155,
        subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500,
        deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${ride.id}`,
      headers: { authorization: `Bearer ${customer.token}` },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data.driver;
    expect(d.vehiclePhotoUrl).toBe('/uploads/vehicles/test/car.png');
    expect(d.licensePlate).toContain('HV-');
    expect(d.user.avatar).toBe('/uploads/avatars/trust.jpg');
  });

  it('delivery order detail exposes the rider photo, vehicle and plate', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const ru = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
    const rider = await app.prisma.rider.create({
      data: {
        userId: ru.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
        vehicleMake: 'Honda', vehicleModel: 'Wave', vehicleColor: 'Red',
        licensePlate: `CG-${seq}`, vehiclePhotoUrl: '/uploads/vehicles/test/bike.png',
      },
    });
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `TRUSTD-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: customer.userId,
        riderId: rider.id,
        status: 'PICKED_UP',
        deliveryAddress: 'Home', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
        deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/orders/${order.id}`,
      headers: { authorization: `Bearer ${customer.token}` },
    });
    expect(res.statusCode).toBe(200);
    const r = res.json().data.rider;
    expect(r.avatar).toBe('/uploads/avatars/trust.jpg');
    expect(r.vehicleMake).toBe('Honda');
    expect(r.licensePlate).toContain('CG-');
    expect(r.vehiclePhotoUrl).toBe('/uploads/vehicles/test/bike.png');
    expect(r.vehicleType).toBe('MOTORCYCLE');
  });
});
