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
// [E16-B · S2] A COURIER parcel may enter DELIVERED only with the door-photo
// proof recorded through the courier proof path (proof-photo → proof).
//
// Before: PUT /rider/orders/:id/delivered closed a sender-pays courier job
// whose fee was already collected at pickup — and an MMG-paid job — with no
// door photo; POST /rider/orders/:id/handover {outcome:'paid'} closed a
// receiver-pays cash courier job the same way. The canonical transition seam
// now refuses every COURIER → DELIVERED move unless the proof URL being
// recorded in that same transition (or already durably on the row) equals the
// URL the server issued at /proof-photo. Food deliveries are untouched.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_DIR = path.join(os.tmpdir(), `swift-courier-proof-gate-${nanoid(6)}`);

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+592037${String(seq).padStart(4, '0')}`,
      firstName: 'E16B',
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
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'e16b', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeRider(userId: string) {
  return app.prisma.rider.create({
    data: { userId, riderType: 'COURIER', vehicleType: 'MOTORCYCLE', documentsVerified: true },
  });
}

async function makeCourierOrder(
  customerId: string,
  riderId: string,
  opts: {
    status: 'ARRIVED' | 'EN_ROUTE_DELIVERY';
    paymentMethod: 'CASH' | 'MOBILE_MONEY';
    paymentStatus: 'CAPTURED' | 'PENDING';
    courierPayer?: 'SENDER' | 'RECIPIENT';
  },
) {
  return app.prisma.order.create({
    data: {
      orderNumber: `E16B-${nanoid(8)}`,
      orderType: 'COURIER',
      customerId,
      riderId,
      status: opts.status,
      fulfillment: 'DELIVERY',
      pickupAddress: '12 Sender Street', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: '34 Recipient Avenue', deliveryLat: 6.81, deliveryLng: -58.16,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 500, totalAmount: 1500,
      paymentMethod: opts.paymentMethod,
      paymentStatus: opts.paymentStatus,
      ...(opts.courierPayer ? { courierPayer: opts.courierPayer } : {}),
    },
  });
}

async function makeFoodOrder(customerId: string, riderId: string) {
  return app.prisma.order.create({
    data: {
      orderNumber: `E16B-FOOD-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      riderId,
      status: 'ARRIVED',
      fulfillment: 'DELIVERY',
      pickupAddress: '12 Sender Street', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: '34 Recipient Avenue', deliveryLat: 6.81, deliveryLng: -58.16,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 300, totalAmount: 1300,
      paymentMethod: 'CASH',
      paymentStatus: 'CAPTURED',
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

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

function postPhoto(url: string, token: string) {
  const { payload, contentType } = multipartBody('proof.png', 'image/png', REAL_PNG);
  return app.inject({ method: 'POST', url, payload, headers: { 'content-type': contentType, authorization: `Bearer ${token}` } });
}

async function orderFacts(orderId: string) {
  const order = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  return {
    status: order.status,
    payment: order.paymentStatus,
    deliveredAt: order.deliveredAt,
    proof: order.courierProofPhotoUrl,
    issued: order.courierProofIssuedUrl,
    earnings: await app.prisma.earning.count({ where: { orderId } }),
  };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
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
  const riders = await app.prisma.rider.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } });
  const rows = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: createdUserIds } }, { riderId: { in: riders.map((r) => r.id) } }] },
    select: { id: true },
  });
  const ids = rows.map((o) => o.id);
  await app.prisma.reimbursementClaim.deleteMany({ where: { orderId: { in: ids } } });
  await app.prisma.strike.deleteMany({ where: { orderId: { in: ids } } });
  await app.prisma.earning.deleteMany({ where: { orderId: { in: ids } } });
  await app.prisma.rider.updateMany({ where: { userId: { in: createdUserIds } }, data: { currentOrderId: null } }).catch(() => {});
  await app.prisma.order.deleteMany({ where: { id: { in: ids } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('[E16-B] a courier job enters DELIVERED only with the door photo recorded', () => {
  it('refuses the bare delivered call on a sender-pays job whose fee is already collected, and writes nothing', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(mover.userId);
    const order = await makeCourierOrder(sender.userId, rider.id, { status: 'ARRIVED', paymentMethod: 'CASH', paymentStatus: 'CAPTURED', courierPayer: 'SENDER' });

    const res = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, {}, mover.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DELIVERY_PROOF_REQUIRED');

    // The refusal is durable: still ARRIVED, no deliveredAt, no proof, no earnings.
    expect(await orderFacts(order.id)).toMatchObject({
      status: 'ARRIVED', payment: 'CAPTURED', deliveredAt: null, proof: null, issued: null, earnings: 0,
    });
  });

  it('[DS145 D3] a door photo issued to a replaced rider does not deliver for the rider who now holds the job', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const first = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const firstRider = await makeRider(first.userId);
    const second = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const secondRider = await makeRider(second.userId);
    // The first rider's proof is durably on the row (issued to them, recorded
    // as that exact URL), then the job is reassigned to the second rider.
    const order = await makeCourierOrder(sender.userId, secondRider.id, { status: 'ARRIVED', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    const url = `/uploads/courier-proof/${order.id}/delivery/first-rider.png`;
    await app.prisma.order.update({ where: { id: order.id }, data: { courierProofIssuedUrl: url, courierProofIssuedRiderId: firstRider.id, courierProofPhotoUrl: url } });

    const res = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, {}, second.token);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('DELIVERY_PROOF_REQUIRED');
    expect(await orderFacts(order.id)).toMatchObject({ status: 'ARRIVED', deliveredAt: null, earnings: 0 });
  });

  it('refuses the same bare delivered call from EN_ROUTE_DELIVERY', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(mover.userId);
    const order = await makeCourierOrder(sender.userId, rider.id, { status: 'EN_ROUTE_DELIVERY', paymentMethod: 'CASH', paymentStatus: 'CAPTURED', courierPayer: 'SENDER' });

    const res = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, {}, mover.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DELIVERY_PROOF_REQUIRED');
    expect(await orderFacts(order.id)).toMatchObject({
      status: 'EN_ROUTE_DELIVERY', deliveredAt: null, proof: null, earnings: 0,
    });
  });

  it('refuses the bare delivered call on an MMG-paid courier job', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(mover.userId);
    const order = await makeCourierOrder(sender.userId, rider.id, { status: 'ARRIVED', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', courierPayer: 'SENDER' });

    const res = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, {}, mover.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DELIVERY_PROOF_REQUIRED');
    expect(await orderFacts(order.id)).toMatchObject({
      status: 'ARRIVED', payment: 'CAPTURED', deliveredAt: null, proof: null, earnings: 0,
    });
  });

  it('refuses the paid handover on a receiver-pays cash courier job without the proof, and rolls the capture back', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(mover.userId);
    const order = await makeCourierOrder(sender.userId, rider.id, { status: 'ARRIVED', paymentMethod: 'CASH', paymentStatus: 'PENDING', courierPayer: 'RECIPIENT' });

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, { outcome: 'paid', gps: { lat: 6.81, lng: -58.16 } }, mover.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DELIVERY_PROOF_REQUIRED');

    // The capture was staged in the same transaction as the refused terminal:
    // everything rolls back — still ARRIVED, fee still uncollected, no earnings.
    expect(await orderFacts(order.id)).toMatchObject({
      status: 'ARRIVED', payment: 'PENDING', deliveredAt: null, proof: null, earnings: 0,
    });
  });

  it('still completes the legitimate proof-photo → proof path, recording the server-issued photo', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(mover.userId);
    const order = await makeCourierOrder(sender.userId, rider.id, { status: 'ARRIVED', paymentMethod: 'CASH', paymentStatus: 'CAPTURED', courierPayer: 'SENDER' });

    const photo = await postPhoto(`/api/v1/courier/order/${order.id}/proof-photo`, mover.token);
    expect(photo.statusCode).toBe(200);
    const url = photo.json().data.url as string;
    expect(url).toContain('courier-proof/');

    const proof = await inject('POST', `/api/v1/courier/order/${order.id}/proof`, { proofPhotoUrl: url }, mover.token);
    expect(proof.statusCode).toBe(200);
    expect(proof.json().data.status).toBe('DELIVERED');

    const facts = await orderFacts(order.id);
    expect(facts).toMatchObject({ status: 'DELIVERED', deliveredAt: expect.any(Date), proof: url, issued: url, earnings: 1 });
    expect(await app.prisma.earning.findFirst({ where: { orderId: order.id, type: 'COURIER_FEE' } })).not.toBeNull();
  });

  it('leaves a FOOD delivery on the bare delivered call exactly as before', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(mover.userId);
    const order = await makeFoodOrder(customer.userId, rider.id);

    const res = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, {}, mover.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('DELIVERED');

    const facts = await orderFacts(order.id);
    expect(facts).toMatchObject({ status: 'DELIVERED', deliveredAt: expect.any(Date), earnings: 1 });
    expect(await app.prisma.earning.findFirst({ where: { orderId: order.id, type: 'DELIVERY_FEE' } })).not.toBeNull();
  });

  // [DS145 D4] Preservation, not red-first: getOwnedOrder refuses before the gate.
  it('[preservation] still refuses a rider who is not assigned the courier job (wrong-party)', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const owner = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const ownerRider = await makeRider(owner.userId);
    const order = await makeCourierOrder(sender.userId, ownerRider.id, { status: 'ARRIVED', paymentMethod: 'CASH', paymentStatus: 'CAPTURED', courierPayer: 'SENDER' });

    const intruder = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    await makeRider(intruder.userId);
    const res = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, {}, intruder.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_YOUR_ORDER');
    expect(await orderFacts(order.id)).toMatchObject({ status: 'ARRIVED', deliveredAt: null, earnings: 0 });
  });
});
