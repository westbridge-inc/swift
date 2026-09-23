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
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicUploads } from '../utils/public-uploads';

// ---------------------------------------------------------------------------
// E16 — courier pickup custody proof.
//
// PICKED_UP is a physical-custody claim, so the assigned rider must prove it:
// upload the pickup photo (server-issued URL), then confirm pickup with that
// exact URL + GPS. The generic rider leg refuses the bare tap for couriers, so
// the proof is the only door into PICKED_UP — and therefore into in-transit and
// the courier's direct PICKED_UP → DELIVERED path. Red on main: the bare tap
// returns 200 with zero durable custody evidence, and the new routes 404.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_DIR = path.join(os.tmpdir(), `swift-courier-pickup-proof-${nanoid(6)}`);

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
// E16 fixture block: +5924001xx. Range-checked unused: no fixed number, seed or
// generator in apps/api/src/__tests__ or apps/mobile/src can produce it (the
// 592_400_000_000-based generators elsewhere cover +592400000000…+592899999999).
const phoneBase = 592_400_100;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Pkp',
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
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'pkp', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeRider(userId: string) {
  return app.prisma.rider.create({
    data: { userId, riderType: 'COURIER', vehicleType: 'MOTORCYCLE', documentsVerified: true },
  });
}

async function makeCourierOrder(customerId: string, riderId: string, status: 'RIDER_ARRIVED_PICKUP' | 'FAILED' = 'RIDER_ARRIVED_PICKUP') {
  return app.prisma.order.create({
    data: {
      orderNumber: `PKP-${nanoid(8)}`, orderType: 'COURIER', customerId, riderId, status, fulfillment: 'DELIVERY',
      pickupAddress: 'a', pickupLat: 6.81, pickupLng: -58.155, deliveryAddress: 'b', deliveryLat: 6.82, deliveryLng: -58.16,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500,
      paymentMethod: 'CASH', courierPayer: 'RECIPIENT',
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

function postPickupPhoto(url: string, token: string, content = REAL_PNG, mime = 'image/png') {
  const { payload, contentType } = multipartBody('pickup.png', mime, content);
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
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
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

describe('E16 — courier pickup custody proof', () => {
  it('refuses the bare generic picked-up tap for a courier: custody needs a photo', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/rider/orders/${order.id}/picked-up`,
      headers: { authorization: `Bearer ${moverUser.token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PICKUP_PROOF_REQUIRED');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('RIDER_ARRIVED_PICKUP');
    expect(after.pickedUpAt).toBeNull();
  });

  it('refuses a fabricated pickup-proof URL that the server never issued', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/courier/order/${order.id}/pickup-proof`,
      headers: { authorization: `Bearer ${moverUser.token}` },
      payload: { proofPhotoUrl: `https://evil.example/courier-proof/${order.id}/pickup/fake.png`, gps: { lat: 6.81, lng: -58.155 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PICKUP_PROOF_NOT_ISSUED');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('RIDER_ARRIVED_PICKUP');
    expect(after.pickedUpAt).toBeNull();
  });

  it('accepts a real pickup photo from the assigned rider and returns a public url', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);

    const res = await postPickupPhoto(`/api/v1/courier/order/${order.id}/pickup-proof-photo`, moverUser.token);
    expect(res.statusCode).toBe(200);
    const url = res.json().data.url as string;
    expect(url).toContain('courier-proof/');
  });

  it('the issued photo + GPS confirm pickup: PICKED_UP with durable custody evidence', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);

    const up = await postPickupPhoto(`/api/v1/courier/order/${order.id}/pickup-proof-photo`, moverUser.token);
    expect(up.statusCode).toBe(200);
    const issuedUrl = up.json().data.url as string;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/courier/order/${order.id}/pickup-proof`,
      headers: { authorization: `Bearer ${moverUser.token}` },
      payload: { proofPhotoUrl: issuedUrl, gps: { lat: 6.81, lng: -58.155 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('PICKED_UP');

    // Durable DB state, not just the status code: the bound photo, the rider's
    // location, the server-side custody time, the immutable log note, and the
    // customer's PICKED_UP notification.
    const fresh = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: {
        status: true,
        courierPickupProofPhotoUrl: true,
        courierPickupProofLat: true,
        courierPickupProofLng: true,
        pickedUpAt: true,
      },
    });
    expect(fresh.status).toBe('PICKED_UP');
    expect(fresh.courierPickupProofPhotoUrl).toBe(issuedUrl);
    expect(fresh.courierPickupProofLat).toBe(6.81);
    expect(fresh.courierPickupProofLng).toBe(-58.155);
    expect(fresh.pickedUpAt).not.toBeNull();

    const log = await app.prisma.orderStatusLog.findFirst({
      where: { orderId: order.id, status: 'PICKED_UP' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log).not.toBeNull();
    expect(log?.note).toContain('gps:6.81000,-58.15500');

    const notices = await app.prisma.notification.findMany({ where: { userId: sender.userId } });
    expect(notices.some((n) => (n.data as { orderId?: string; status?: string } | null)?.orderId === order.id
      && (n.data as { orderId?: string; status?: string } | null)?.status === 'PICKED_UP')).toBe(true);
  });

  it('in-transit is now reachable only through the proof: en-route-delivery follows PICKED_UP', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);

    const up = await postPickupPhoto(`/api/v1/courier/order/${order.id}/pickup-proof-photo`, moverUser.token);
    const issuedUrl = up.json().data.url as string;
    const proof = await app.inject({
      method: 'POST',
      url: `/api/v1/courier/order/${order.id}/pickup-proof`,
      headers: { authorization: `Bearer ${moverUser.token}` },
      payload: { proofPhotoUrl: issuedUrl, gps: { lat: 6.81, lng: -58.155 } },
    });
    expect(proof.statusCode).toBe(200);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/rider/orders/${order.id}/en-route-delivery`,
      headers: { authorization: `Bearer ${moverUser.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('EN_ROUTE_DELIVERY');
  });

  it('rejects a spoofed Content-Type whose bytes are not an image (magic-byte sniff)', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);

    const res = await postPickupPhoto(
      `/api/v1/courier/order/${order.id}/pickup-proof-photo`,
      moverUser.token,
      Buffer.from('#!/bin/sh\nrm -rf /'),
      'image/png',
    );
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
    const res = await postPickupPhoto(`/api/v1/courier/order/${order.id}/pickup-proof-photo`, intruder.token);
    expect(res.statusCode).toBe(404);
    // The code proves the ROUTE refused the rider (rider-scoped lookup), not
    // merely that the route was absent on pre-fix main — red either way.
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('refuses a pickup photo on a FAILED job, and writes nothing', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id, 'FAILED');

    const res = await postPickupPhoto(`/api/v1/courier/order/${order.id}/pickup-proof-photo`, moverUser.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_IN_TRANSIT');

    const after = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: {
        courierPickupProofIssuedUrl: true,
        courierPickupProofIssuedRiderId: true,
        courierPickupProofPhotoUrl: true,
        courierPickupProofLat: true,
        courierPickupProofLng: true,
      },
    });
    expect(after.courierPickupProofIssuedUrl).toBeNull();
    expect(after.courierPickupProofIssuedRiderId).toBeNull();
    expect(after.courierPickupProofPhotoUrl).toBeNull();
    expect(after.courierPickupProofLat).toBeNull();
    expect(after.courierPickupProofLng).toBeNull();
  });
});
