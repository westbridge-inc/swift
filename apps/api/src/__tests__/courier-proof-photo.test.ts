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
import courierRoutes from '../modules/courier/courier.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicUploads } from '../utils/public-uploads';

// ---------------------------------------------------------------------------
// SWIFT-AUD-D8-02 — the assigned rider can capture a proof-of-delivery photo.
// The photo upload endpoint returns a public URL that /proof then consumes;
// it's hostile-input hardened (mime + magic-byte) and rider-scoped so one rider
// can't attach a photo to another's job.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_DIR = path.join(os.tmpdir(), `swift-courier-proof-${nanoid(6)}`);

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
const phoneBase = 592_820_000_000 + Math.floor(Math.random() * 100_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Prf',
      lastName: `U${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'prf', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeRider(userId: string) {
  return app.prisma.rider.create({
    data: { userId, riderType: 'COURIER', vehicleType: 'MOTORCYCLE', documentsVerified: true },
  });
}

async function makeCourierOrder(customerId: string, riderId: string) {
  return app.prisma.order.create({
    data: {
      orderNumber: `PRF-${nanoid(8)}`, orderType: 'COURIER', customerId, riderId, status: 'PICKED_UP', fulfillment: 'DELIVERY',
      pickupAddress: 'a', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'b', deliveryLat: 6.81, deliveryLng: -58.16,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500, paymentMethod: 'CASH',
    },
  });
}

const REAL_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function multipartBody(filename: string, mime: string, content: Buffer) {
  const boundary = `----swift${nanoid(8)}`;
  const head = Buffer.from(
    `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function postPhoto(url: string, token: string, content = REAL_PNG, mime = 'image/png') {
  const { payload, contentType } = multipartBody('proof.png', mime, content);
  return app.inject({ method: 'POST', url, payload, headers: { 'content-type': contentType, authorization: `Bearer ${token}` } });
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
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('D8-02 — courier proof-of-delivery photo upload', () => {
  it('accepts a real image from the assigned rider and returns a public url', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);

    const res = await postPhoto(`/api/v1/courier/order/${order.id}/proof-photo`, moverUser.token);
    expect(res.statusCode).toBe(200);
    const url = res.json().data.url as string;
    expect(url).toContain('courier-proof/');
  });

  it('rejects a spoofed Content-Type whose bytes are not an image (magic-byte sniff)', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);

    const res = await postPhoto(`/api/v1/courier/order/${order.id}/proof-photo`, moverUser.token, Buffer.from('#!/bin/sh\nrm -rf /'), 'image/png');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_IMAGE');
  });

  it('refuses a rider who is not the one assigned to the job', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const owner = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const ownerRider = await makeRider(owner.userId);
    const order = await makeCourierOrder(sender.userId, ownerRider.id);

    const intruder = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    await makeRider(intruder.userId);
    const res = await postPhoto(`/api/v1/courier/order/${order.id}/proof-photo`, intruder.token);
    expect(res.statusCode).toBe(404);
  });
});
