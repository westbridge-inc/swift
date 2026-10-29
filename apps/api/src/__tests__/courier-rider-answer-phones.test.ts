/**
 * [F20 · 28 Oct 2026] The assigned courier rider's custody-step answers
 * (pickup proof, delivery proof, cash delivery proof, return, return proof)
 * follow the O-1 counterpart-phone rule like the rider's live-order read does:
 * with the call bridge on, a bridge-aware client (and, once old apps are
 * retired, every client) is sent no parcel-recipient number. With the bridge
 * off (the launch default) the answer is exactly what it was.
 *
 * Asserted on the SERIALIZED body, with a REAL recipient number on the row:
 * a null number would serialize to nothing and pass with the full row returned.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import os from 'node:os';
import path from 'node:path';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import courierRoutes from '../modules/courier/courier.routes';
import { courierRiderAnswer } from '../modules/courier/courier-rider-answer';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicUploads } from '../utils/public-uploads';
import { REAL_PNG } from './helpers/real-image';
import { testPhone } from './helpers/fixture-ids';

const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_DIR = path.join(os.tmpdir(), `swift-courier-answer-${nanoid(6)}`);
const BRIDGE = { 'x-swift-call-bridge': '1' };
const GPS = { lat: 6.81, lng: -58.155 };

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const phone = testPhone();
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Answer', lastName: `U${seq}`, roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'f20', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, phone };
}

type Mover = { userId: string; token: string; riderId: string };
async function makeMover(): Promise<Mover> {
  const u = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: { userId: u.userId, riderType: 'COURIER', vehicleType: 'MOTORCYCLE', documentsVerified: true },
  });
  return { userId: u.userId, token: u.token, riderId: rider.id };
}

let sender: { userId: string; token: string; phone: string };

/** A parcel this mover holds, carrying a REAL recipient number. */
async function parcel(mover: Mover, status: OrderStatus, extra: Record<string, unknown> = {}) {
  const recipient = testPhone();
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `ANS-${nanoid(8)}`, orderType: 'COURIER', customerId: sender.userId, riderId: mover.riderId, status, fulfillment: 'DELIVERY',
      pickupAddress: '12 Sender Street', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: '34 Recipient Avenue', deliveryLat: GPS.lat, deliveryLng: GPS.lng,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500,
      paymentMethod: 'CASH', courierPayer: 'SENDER', paymentStatus: 'CAPTURED',
      courierRecipientName: 'Recipient', courierRecipientPhone: recipient,
      ...extra,
    } as never,
  });
  orderIds.push(order.id);
  await app.prisma.rider.update({ where: { id: mover.riderId }, data: { currentOrderId: order.id } });
  return { id: order.id, recipient };
}

function postJson(url: string, token: string, body: Record<string, unknown>, headers: Record<string, string>) {
  return app.inject({ method: 'POST', url, payload: body, headers: { ...headers, 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

function postReturnProof(url: string, token: string, headers: Record<string, string>) {
  const boundary = `----swift${nanoid(8)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="lat"\r\n\r\n${GPS.lat}\r\n--${boundary}\r\ncontent-disposition: form-data; name="lng"\r\n\r\n${GPS.lng}\r\n`),
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="return.png"\r\ncontent-type: image/png\r\n\r\n`),
    REAL_PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: 'POST', url, payload, headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` } });
}

/** The real photo step: the server issues the proof (and binds it) exactly as for the phone. */
async function issuedDoorPhoto(orderId: string, token: string) {
  const boundary = `----swift${nanoid(8)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="door.png"\r\ncontent-type: image/png\r\n\r\n`),
    REAL_PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({ method: 'POST', url: `/api/v1/courier/order/${orderId}/proof-photo`, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.url as string;
}

/** Each custody step: set the parcel up where the step starts, take the step, answer the response. */
type Step = { name: string; status: string; run: (headers: Record<string, string>) => Promise<{ res: Awaited<ReturnType<typeof postJson>>; recipient: string }> };
const STEPS: Step[] = [
  {
    name: 'POST /courier/order/:id/pickup-proof', status: 'PICKED_UP',
    run: async (headers) => {
      const mover = await makeMover();
      const url = `https://uploads.test/courier-proof/${nanoid(6)}/pickup/p.png`;
      const p = await parcel(mover, 'RIDER_ARRIVED_PICKUP', { courierPickupProofIssuedUrl: url, courierPickupProofIssuedRiderId: mover.riderId, paymentStatus: 'PENDING' });
      return { res: await postJson(`/api/v1/courier/order/${p.id}/pickup-proof`, mover.token, { proofPhotoUrl: url, gps: GPS }, headers), recipient: p.recipient };
    },
  },
  {
    name: 'POST /courier/order/:id/proof (fee collected at pickup)', status: 'DELIVERED',
    run: async (headers) => {
      const mover = await makeMover();
      const p = await parcel(mover, 'ARRIVED');
      const url = await issuedDoorPhoto(p.id, mover.token);
      return { res: await postJson(`/api/v1/courier/order/${p.id}/proof`, mover.token, { proofPhotoUrl: url }, headers), recipient: p.recipient };
    },
  },
  {
    name: 'POST /courier/order/:id/proof (recipient pays at the door)', status: 'DELIVERED',
    run: async (headers) => {
      const mover = await makeMover();
      const p = await parcel(mover, 'ARRIVED', { courierPayer: 'RECIPIENT', paymentStatus: 'PENDING' });
      const url = await issuedDoorPhoto(p.id, mover.token);
      await app.prisma.rider.update({ where: { id: mover.riderId }, data: { currentLat: GPS.lat, currentLng: GPS.lng, lastLocationUpdate: new Date() } });
      return { res: await postJson(`/api/v1/courier/order/${p.id}/proof`, mover.token, { proofPhotoUrl: url, outcome: 'paid', gps: GPS }, headers), recipient: p.recipient };
    },
  },
  {
    name: 'POST /courier/order/:id/return', status: 'RETURNING',
    run: async (headers) => {
      const mover = await makeMover();
      const p = await parcel(mover, 'ARRIVED');
      return { res: await postJson(`/api/v1/courier/order/${p.id}/return`, mover.token, { reason: 'Nobody at the address', gps: GPS }, headers), recipient: p.recipient };
    },
  },
  {
    name: 'POST /courier/order/:id/return-proof', status: 'RETURNED',
    run: async (headers) => {
      const mover = await makeMover();
      const p = await parcel(mover, 'RETURNING');
      return { res: await postReturnProof(`/api/v1/courier/order/${p.id}/return-proof`, mover.token, headers), recipient: p.recipient };
    },
  },
];

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
  sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
});

afterEach(() => {
  delete process.env['CALL_RELAY'];
  delete process.env['COUNTERPART_PHONES_TO_OLD_APPS'];
});

afterAll(async () => {
  // Handover photo proofs are retained evidence (the database refuses their
  // delete), so a parcel that has one stays behind with its parties, as in the
  // other courier proof suites; every number came from testPhone(), so nothing
  // collides. Everything else is removed.
  const kept = new Set((await app.prisma.handoverPhotoProof.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true } })).map((p) => p.orderId));
  const gone = orderIds.filter((id) => !kept.has(id));
  await app.prisma.rider.updateMany({ where: { userId: { in: userIds } }, data: { currentOrderId: null } });
  if (gone.length) {
    await app.prisma.supportTicket.deleteMany({ where: { orderId: { in: gone } } });
    await app.prisma.orderStatusLog.deleteMany({ where: { orderId: { in: gone } } }).catch(() => undefined);
    await app.prisma.order.deleteMany({ where: { id: { in: gone } } });
  }
  await app.close();
});

describe('[F20] CALL_RELAY on: a bridge-aware courier rider is sent no recipient number by any custody step', () => {
  for (const step of STEPS) {
    it(`${step.name}: absent with the bridge header`, async () => {
      process.env['CALL_RELAY'] = '1';
      const { res, recipient } = await step.run(BRIDGE);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data?.status).toBe(step.status);
      expect(res.payload.includes(recipient), `${step.name} sent the recipient's number`).toBe(false);
      expect(res.payload.includes(sender.phone), `${step.name} sent the sender's number`).toBe(false);
    });
  }
});

describe('[F20 · O-1 retirement] CALL_RELAY on + COUNTERPART_PHONES_TO_OLD_APPS=0: no client is sent it', () => {
  for (const step of STEPS) {
    it(`${step.name}: absent without the header once retired`, async () => {
      process.env['CALL_RELAY'] = '1';
      process.env['COUNTERPART_PHONES_TO_OLD_APPS'] = '0';
      const { res, recipient } = await step.run({});
      expect(res.statusCode, res.body).toBe(200);
      expect(res.payload.includes(recipient), `${step.name} sent the recipient's number`).toBe(false);
    });
  }
});

describe('[F20 · launch default] CALL_RELAY off: the answer is exactly what it was', () => {
  for (const step of STEPS) {
    it(`${step.name}: the recipient key and number are still there (installed builds unchanged)`, async () => {
      const { res, recipient } = await step.run({});
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data?.courierRecipientPhone).toBe(recipient);
    });
  }
});

describe('[F20] the answer shape, on a full row as the cash rail\'s lost-answer retry reads it', () => {
  const ROW_RECIPIENT = testPhone();
  const ROW_SENDER = testPhone();
  const fullRow = () => ({
    id: 'o1', status: 'DELIVERED', courierRecipientPhone: ROW_RECIPIENT, ridePin: '246813', pickupCode: '975310',
    pickupCodeAttempts: 1, mmgNumberSnapshot: '+5926000000', mmgPayUrlSnapshot: 'https://pay.test/x',
    customer: { id: 'c1', phone: ROW_SENDER, countryCode: 'GY', trustLevel: 'L2', createdAt: new Date(0) },
  });

  it('never carries a handover code, the MMG snapshot, or the sender\'s account facts, bridge on or off', () => {
    for (const relayOn of [false, true]) {
      if (relayOn) process.env['CALL_RELAY'] = '1'; else delete process.env['CALL_RELAY'];
      const body = JSON.stringify(courierRiderAnswer({ headers: BRIDGE }, fullRow()));
      for (const key of ['ridePin', 'pickupCode', 'pickupCodeAttempts', 'mmgNumberSnapshot', 'mmgPayUrlSnapshot', 'trustLevel', 'countryCode', 'createdAt']) {
        expect(body.includes(`"${key}"`), `${key} (relay ${relayOn ? 'on' : 'off'})`).toBe(false);
      }
      expect(body.includes(ROW_SENDER), `sender phone (relay ${relayOn ? 'on' : 'off'})`).toBe(false);
      expect(JSON.parse(body).customer).toEqual({ id: 'c1', firstName: null });
    }
  });

  it('the recipient number follows the O-1 rule: kept with the bridge off, gone for a bridge-aware client with it on', () => {
    expect(courierRiderAnswer({ headers: BRIDGE }, fullRow()).courierRecipientPhone).toBe(ROW_RECIPIENT);
    process.env['CALL_RELAY'] = '1';
    expect(courierRiderAnswer({ headers: BRIDGE }, fullRow()).courierRecipientPhone).toBeNull();
  });
});
