import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import courierRoutes from '../modules/courier/courier.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicUploads } from '../utils/public-uploads';

// ---------------------------------------------------------------------------
// [E17] Courier return-to-sender after custody is no longer "call support only"
// inside the app: the assigned mover starts a support-visible RETURNING state
// (reason + GPS, a SupportTicket, the sender notified), and a return proof
// photo closes it as RETURNED — terminal, rider released, no earnings minted.
// A returning parcel stays in custody: the sender still cannot cancel it.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_DIR = path.join(os.tmpdir(), `swift-courier-return-${nanoid(6)}`);

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
// +5924002xxx: verified unused in the repo. All other test phone bases are
// 12-digit blocks (e.g. 592_400_000_000 + random offset) that CAN produce
// 12-digit strings but never a 10-digit Guyana-form number, so this block is
// collision-free against every static literal and every random generator.
const phoneBase = 5_924_002_000;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Ret',
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
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'e17', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeRider(userId: string) {
  return app.prisma.rider.create({
    data: { userId, riderType: 'COURIER', vehicleType: 'MOTORCYCLE', documentsVerified: true },
  });
}

/** A sender-pays parcel the rider already holds, fee captured at pickup. */
async function makeCourierOrder(customerId: string, riderId: string, status: OrderStatus = 'ARRIVED') {
  return app.prisma.order.create({
    data: {
      orderNumber: `RET-${nanoid(8)}`, orderType: 'COURIER', customerId, riderId, status, fulfillment: 'DELIVERY',
      pickupAddress: '12 Sender Street', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: '34 Recipient Avenue', deliveryLat: 6.81, deliveryLng: -58.155,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500,
      paymentMethod: 'CASH', courierPayer: 'SENDER', paymentStatus: 'CAPTURED',
    },
  });
}

const REAL_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function multipartReturnBody(lat: string, lng: string, content: Buffer, mime = 'image/png') {
  const boundary = `----swift${nanoid(8)}`;
  const parts = [
    `--${boundary}\r\ncontent-disposition: form-data; name="lat"\r\n\r\n${lat}\r\n`,
    `--${boundary}\r\ncontent-disposition: form-data; name="lng"\r\n\r\n${lng}\r\n`,
  ];
  const head = Buffer.from(parts.join(''));
  const file = Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="return.png"\r\ncontent-type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, file, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function postReturnProof(url: string, token: string, lat = '6.81', lng = '-58.155', content = REAL_PNG, mime = 'image/png') {
  const { payload, contentType } = multipartReturnBody(lat, lng, content, mime);
  return app.inject({ method: 'POST', url, payload, headers: { 'content-type': contentType, authorization: `Bearer ${token}` } });
}

/** [DS202 D1] The real phone order — the photo FIRST, the location after — delivered
 *  the way a network delivers it: the photo part is complete (its closing boundary
 *  seen) before the location fields arrive, 50 ms later. A handler that reads the
 *  fields the moment the file ends sees none of them. */
function postReturnProofFileFirstChunked(url: string, token: string, lat = '6.81', lng = '-58.155') {
  const boundary = `----swift${nanoid(8)}`;
  const first = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="return.png"\r\ncontent-type: image/png\r\n\r\n`),
    REAL_PNG,
    Buffer.from(`\r\n--${boundary}\r\n`),
  ]);
  const second = Buffer.from(
    `content-disposition: form-data; name="lat"\r\n\r\n${lat}\r\n--${boundary}\r\ncontent-disposition: form-data; name="lng"\r\n\r\n${lng}\r\n--${boundary}--\r\n`,
  );
  const stream = new Readable({ read() {} });
  stream.push(first);
  setTimeout(() => { stream.push(second); stream.push(null); }, 50);
  return app.inject({
    method: 'POST', url, payload: stream,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` },
  });
}

function postJson(url: string, token: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
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
  await app.prisma.supportTicket.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.rider.updateMany({ where: { userId: { in: createdUserIds } }, data: { currentOrderId: null } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('[E17] courier return-to-sender after custody', () => {
  it('the mover starts a return: RETURNING with reason + GPS, a support ticket, and the sender notified', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);
    await app.prisma.rider.update({ where: { id: rider.id }, data: { currentOrderId: order.id, isAvailable: false } });

    const res = await postJson(`/api/v1/courier/order/${order.id}/return`, moverUser.token, {
      reason: 'Recipient unreachable', gps: { lat: 6.81, lng: -58.155 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('RETURNING');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.courierReturnReason).toBe('Recipient unreachable');
    expect(after.courierReturnRequestedAt).not.toBeNull();
    expect(after.status).toBe('RETURNING');

    const ticket = await app.prisma.supportTicket.findFirst({ where: { orderId: order.id } });
    expect(ticket).toMatchObject({
      userId: moverUser.userId,
      category: 'ORDER_ISSUE',
      subject: 'Courier return-to-sender requested',
    });

    expect(await app.prisma.notification.count({
      where: { userId: sender.userId, title: 'Parcel coming back' },
    })).toBe(1);
    const log = await app.prisma.orderStatusLog.findFirst({ where: { orderId: order.id, status: 'RETURNING' } });
    expect(log?.note).toContain('cannot deliver — Recipient unreachable');
    expect(log?.note).toContain('gps:6.81000,-58.15500');
    // The return leg mints no earnings and touches no money.
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(0);
    expect(after.paymentStatus).toBe('CAPTURED');
  });

  it('the sender still cannot cancel a parcel on its way back — custody survives the return', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);
    await app.prisma.rider.update({ where: { id: rider.id }, data: { currentOrderId: order.id, isAvailable: false } });
    await postJson(`/api/v1/courier/order/${order.id}/return`, moverUser.token, { reason: 'Recipient unreachable' });

    const cancel = await postJson(`/api/v1/courier/order/${order.id}/cancel`, sender.token, { reason: 'Changed my mind' });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error.code).toBe('PARCEL_IN_CUSTODY');
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('RETURNING');
    expect(after.cancelledAt).toBeNull();
  });

  it('the return photo closes the return: RETURNED, rider released, sender notified, no earnings', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);
    await app.prisma.rider.update({ where: { id: rider.id }, data: { currentOrderId: order.id, isAvailable: false } });
    await postJson(`/api/v1/courier/order/${order.id}/return`, moverUser.token, { reason: 'Recipient refused the parcel' });

    const before = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    const proof = await postReturnProof(`/api/v1/courier/order/${order.id}/return-proof`, moverUser.token);
    expect(proof.statusCode).toBe(200);
    expect(proof.json().data.status).toBe('RETURNED');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('RETURNED');
    expect(after.courierReturnProofPhotoUrl).toContain('courier-proof/');
    expect(after.courierReturnedAt).not.toBeNull();
    const released = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(released.currentOrderId).toBeNull();
    expect(released.isAvailable).toBe(true);
    const log = await app.prisma.orderStatusLog.findFirst({ where: { orderId: order.id, status: 'RETURNED' } });
    expect(log?.note).toContain('return proof captured — gps:6.81000,-58.15500');
    expect(await app.prisma.notification.count({ where: { userId: sender.userId, title: 'Parcel returned' } })).toBe(1);
    // [DS202 D2] A return is not a delivery: the rider's delivery count does
    // not move (the earnings count below is 0 by construction — no fixture
    // mints one — so it is not the proof on its own).
    expect(released.totalDeliveries).toBe(before.totalDeliveries);
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('the return photo closes the return when the phone sends the photo FIRST and the location after (DS202 D1)', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);
    await app.prisma.rider.update({ where: { id: rider.id }, data: { currentOrderId: order.id, isAvailable: false } });
    await postJson(`/api/v1/courier/order/${order.id}/return`, moverUser.token, { reason: 'Nobody at the address' });

    const proof = await postReturnProofFileFirstChunked(`/api/v1/courier/order/${order.id}/return-proof`, moverUser.token);
    expect(proof.statusCode, proof.body).toBe(200);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('RETURNED');
    const log = await app.prisma.orderStatusLog.findFirst({ where: { orderId: order.id, status: 'RETURNED' } });
    expect(log?.note).toContain('gps:6.81000,-58.15500');
  });

  it('a second return path is independent — facts never bleed across orders', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const first = await makeCourierOrder(sender.userId, rider.id);
    const second = await makeCourierOrder(sender.userId, rider.id, 'EN_ROUTE_DELIVERY');
    await app.prisma.rider.update({ where: { id: rider.id }, data: { currentOrderId: first.id, isAvailable: false } });

    await postJson(`/api/v1/courier/order/${first.id}/return`, moverUser.token, { reason: 'Recipient unreachable' });
    await postJson(`/api/v1/courier/order/${second.id}/return`, moverUser.token, { reason: 'Wrong or incomplete address' });

    const one = await app.prisma.order.findUniqueOrThrow({ where: { id: first.id } });
    const two = await app.prisma.order.findUniqueOrThrow({ where: { id: second.id } });
    expect([one.status, two.status]).toEqual(['RETURNING', 'RETURNING']);
    expect(one.courierReturnReason).toBe('Recipient unreachable');
    expect(two.courierReturnReason).toBe('Wrong or incomplete address');
    expect(one.courierReturnProofPhotoUrl).toBeNull();
  });

  it('refuses return from a non-assigned rider, before custody, and without a return in flight', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id, 'RIDER_ARRIVED_PICKUP');
    await app.prisma.rider.update({ where: { id: rider.id }, data: { currentOrderId: order.id, isAvailable: false } });

    // Pre-custody: a return is custody-bound, like proof.
    const early = await postJson(`/api/v1/courier/order/${order.id}/return`, moverUser.token, { reason: 'Too early' });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('NOT_IN_CUSTODY');

    // In custody but no return started yet: the proof must be refused.
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'ARRIVED' } });
    const before = await postReturnProof(`/api/v1/courier/order/${order.id}/return-proof`, moverUser.token);
    expect(before.statusCode).toBe(409);
    expect(before.json().error.code).toBe('NOT_RETURNING');
    // [DS202 D4] Refused before anything is stored: no orphan return photo.
    expect(existsSync(path.join(UPLOAD_DIR, 'courier-proof', order.id, 'return'))).toBe(false);

    // A mover who is not the assigned rider cannot touch the return at all.
    const intruder = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    await makeRider(intruder.userId);
    const foreign = await postJson(`/api/v1/courier/order/${order.id}/return`, intruder.token, { reason: 'Not mine' });
    expect(foreign.statusCode).toBe(404);
  });

  it('hostile return-proof uploads are refused and write nothing', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const moverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(moverUser.userId);
    const order = await makeCourierOrder(sender.userId, rider.id);
    await app.prisma.rider.update({ where: { id: rider.id }, data: { currentOrderId: order.id, isAvailable: false } });
    await postJson(`/api/v1/courier/order/${order.id}/return`, moverUser.token, { reason: 'Recipient unreachable' });

    // Spoofed mime whose bytes are not an image.
    const spoof = await postReturnProof(`/api/v1/courier/order/${order.id}/return-proof`, moverUser.token, '6.81', '-58.155', Buffer.from('#!/bin/sh\nrm -rf /'), 'image/png');
    expect(spoof.statusCode).toBe(400);
    expect(spoof.json().error.code).toBe('BAD_IMAGE');

    // Missing GPS fields.
    const noGps = await postReturnProof(`/api/v1/courier/order/${order.id}/return-proof`, moverUser.token, '', '');
    expect(noGps.statusCode).toBe(400);
    expect(noGps.json().error.code).toBe('INVALID_POINT');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('RETURNING');
    expect(after.courierReturnProofPhotoUrl).toBeNull();
    expect(after.courierReturnedAt).toBeNull();
  });
});
