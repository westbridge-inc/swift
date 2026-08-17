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
import { authRoutes } from '../modules/auth/auth.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicUploads } from '../utils/public-uploads';

// ---------------------------------------------------------------------------
// Mandatory signup selfie (master plan §3). Failure paths first: every
// transact surface (orders, rides, go-online) refuses a selfie-less account
// with SELFIE_REQUIRED; the upload only accepts real camera images; the
// stored avatar is publicly served; profile PUT can no longer write avatar.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const CENTRAL = { lat: 6.81, lng: -58.155 };
const SOUTH = { lat: 6.755, lng: -58.155 };
const UPLOAD_DIR = path.join(os.tmpdir(), `swift-selfie-uploads-${nanoid(6)}`);

let app: FastifyInstance;

const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(
  roles: UserRole[],
  activeRole: UserRole,
  opts: { selfie?: boolean } = {},
) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200177${String(seq).padStart(2, '0')}`,
      firstName: 'Selfie',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      ...(opts.selfie ? { selfieCapturedAt: new Date(), avatar: '/uploads/avatars/seed.jpg' } : {}),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'selfie-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

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

const REAL_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

function postSelfie(token: string, filename = 'selfie.png', mime = 'image/png', content = REAL_PNG) {
  const { payload, contentType } = multipartBody(filename, mime, content);
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/selfie',
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
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: createdUserIds } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('POST /auth/selfie — the only writer of the public photo', () => {
  it('rejects an unauthenticated upload', async () => {
    const res = await postSelfie('not-a-token');
    expect(res.statusCode).toBe(401);
  });

  it('stores a real image, sets avatar + selfieCapturedAt, and serves it publicly', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await postSelfie(u.token);
    expect(res.statusCode).toBe(200);

    const { user } = res.json().data;
    expect(user.avatar).toContain('/uploads/avatars/');
    expect(user.selfieCapturedAt).toBeTruthy();

    const db = await app.prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(db.avatar).toBe(user.avatar);
    expect(db.selfieCapturedAt).toBeTruthy();

    // The avatar is the person's PUBLIC photo — no auth, no signed URL.
    const img = await app.inject({ method: 'GET', url: user.avatar });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
  });

  it('rejects a disallowed declared type outright', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await postSelfie(u.token, 'doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_IMAGE_TYPE');
  });

  it('rejects content that does not match an image format (spoofed mime)', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await postSelfie(u.token, 'evil.png', 'image/png', Buffer.from('#!/bin/sh\necho nope\n'.repeat(4)));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_IMAGE');
  });

  it('profile PUT can no longer write avatar (camera path is the only writer)', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER', { selfie: true });
    const before = await app.prisma.user.findUniqueOrThrow({ where: { id: u.userId } });

    const res = await inject('PUT', '/api/v1/customer/profile', { avatar: 'https://evil.example/spoof.jpg' }, u.token);
    expect(res.statusCode).toBe(200); // unknown keys are simply ignored

    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(after.avatar).toBe(before.avatar);
  });
});

describe('Transact gates refuse a selfie-less account', () => {
  it('ride request → 403 SELFIE_REQUIRED; passes once the selfie exists', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
    // Rides also demand L2 (own coverage in trust-tiers.test.ts) — isolate the selfie gate here.
    await app.prisma.user.update({ where: { id: u.userId }, data: { trustLevel: 'L2' } });
    const body = {
      pickup: CENTRAL, dropoff: SOUTH,
      pickupAddress: 'Selfie Street 1', dropoffAddress: 'Selfie Street 2',
    };

    const blocked = await inject('POST', '/api/v1/rides/request', body, u.token);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('SELFIE_REQUIRED');

    await postSelfie(u.token);
    const allowed = await inject('POST', '/api/v1/rides/request', body, u.token);
    expect(allowed.statusCode).toBe(201);
  });

  it('checkout → 403 SELFIE_REQUIRED with a full cart; passes once the selfie exists', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.address.create({
      data: {
        userId: u.userId, label: 'Home', addressLine1: '9 Selfie Close',
        city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.8, longitude: -58.15, isDefault: true,
      },
    });

    // A real cart so the request reaches the account gates
    const vendorOwner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER', { selfie: true });
    const owner = await app.prisma.vendorOwner.create({ data: { userId: vendorOwner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: owner.id,
        name: `Selfie Vendor ${seq}`, slug: `selfie-vendor-${seq}-${nanoid(4)}`,
        vendorType: 'RESTAURANT', phone: `+59200178${String(seq).padStart(2, '0')}`,
        addressLine1: '1 Gate Street', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.8, longitude: -58.15,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      },
    });
    const category = await app.prisma.category.create({
      data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 },
    });
    const item = await app.prisma.item.create({
      data: { vendorId: vendor.id, categoryId: category.id, name: 'Gate Burger', basePrice: 1500 },
    });
    const added = await inject('POST', '/api/v1/customer/cart/items',
      { vendorId: vendor.id, itemId: item.id, quantity: 1 }, u.token);
    expect([200, 201]).toContain(added.statusCode);

    const blocked = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, u.token);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('SELFIE_REQUIRED');

    await postSelfie(u.token);
    const allowed = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, u.token);
    expect(allowed.statusCode).toBe(200);
  });

  it('rider go-online → 403 SELFIE_REQUIRED even with documents verified', async () => {
    const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
    await app.prisma.rider.create({
      data: { userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true },
    });

    const blocked = await inject('POST', '/api/v1/rider/go-online', {}, u.token);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('SELFIE_REQUIRED');

    await postSelfie(u.token);
    const allowed = await inject('POST', '/api/v1/rider/go-online', {
      latitude: 6.8013,
      longitude: -58.1551,
    }, u.token);
    expect(allowed.statusCode).toBe(200);
  });

  it('driver go-online → 403 SELFIE_REQUIRED even with documents verified', async () => {
    const u = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
    await app.prisma.driver.create({
      data: {
        userId: u.userId,
        vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
        vehicleColor: 'Silver', licensePlate: `SF-${seq}`,
        driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
        documentsVerified: true,
      },
    });

    const blocked = await inject('POST', '/api/v1/driver/go-online', {}, u.token);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('SELFIE_REQUIRED');
  });

  it('GET /customer/profile exposes selfieCapturedAt so the app can gate', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const before = await inject('GET', '/api/v1/customer/profile', undefined, u.token);
    expect(before.json().data.selfieCapturedAt).toBeNull();

    await postSelfie(u.token);
    const after = await inject('GET', '/api/v1/customer/profile', undefined, u.token);
    expect(after.json().data.selfieCapturedAt).toBeTruthy();
  });
});
