import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { riderRoutes } from '../modules/rider/rider.routes';
import { OrderService } from '../modules/order/order.service';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicUploads } from '../utils/public-uploads';

// ---------------------------------------------------------------------------
// [E16] Courier pickup custody proof.
//
// PICKED_UP is the rider's claim to physically hold someone else's parcel, so
// a courier proves it: photograph the parcel at the pickup (the server issues
// the URL and records who it issued it to), then confirm pickup with exactly
// that URL and a GPS fix. The generic rider leg refuses the bare tap for a
// courier, and the canonical transition seam refuses any courier PICKED_UP
// whose row has no bound proof, so in-transit and the courier's direct
// PICKED_UP → DELIVERED path both sit behind the proof. Red on main: the bare
// tap answers 200 with no durable custody evidence and the proof routes 404.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_DIR = path.join(os.tmpdir(), `swift-courier-pickup-proof-${nanoid(6)}`);
const PICKUP_GPS = { lat: 6.81, lng: -58.155 };

let app: FastifyInstance;
let orders: OrderService;
let seq = 0;
// Fixture block +592036xxxx: a well-formed Guyana number that no fixed number,
// seed or random generator in apps/api can produce (the +5920… forms elsewhere
// are fixed blocks +59200…/+592013…; the random +592 draws start 1–9, carry a
// 13-digit timestamp, or are 8 nanoid characters). Keyed so cleanup also
// clears a crashed run's leftovers.
const PHONE_PREFIX = '+592036';
const phoneBase = 5_920_360_000;

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (userIds.length === 0) return;
  await app.prisma.order.deleteMany({ where: { OR: [{ customerId: { in: userIds } }, { rider: { userId: { in: userIds } } }] } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

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

async function makeCourierOrder(
  customerId: string,
  riderId: string,
  status: OrderStatus = 'RIDER_ARRIVED_PICKUP',
  payer: 'SENDER' | 'RECIPIENT' = 'RECIPIENT',
) {
  return app.prisma.order.create({
    data: {
      orderNumber: `PKP-${nanoid(8)}`, orderType: 'COURIER', customerId, riderId, status, fulfillment: 'DELIVERY',
      pickupAddress: 'a', pickupLat: PICKUP_GPS.lat, pickupLng: PICKUP_GPS.lng, deliveryAddress: 'b', deliveryLat: 6.82, deliveryLng: -58.16,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500,
      paymentMethod: 'CASH', courierPayer: payer, courierTrackingToken: nanoid(16),
    },
  });
}

/** A courier at the pickup, with its sender, rider and mover session. */
async function atPickup(status: OrderStatus = 'RIDER_ARRIVED_PICKUP', payer: 'SENDER' | 'RECIPIENT' = 'RECIPIENT') {
  const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await makeRider(mover.userId);
  const order = await makeCourierOrder(sender.userId, rider.id, status, payer);
  return { sender, mover, rider, order };
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
  const { payload, contentType } = multipartBody('parcel.png', mime, content);
  return app.inject({ method: 'POST', url, payload, headers: { 'content-type': contentType, authorization: `Bearer ${token}` } });
}

const uploadPickupPhoto = (orderId: string, token: string, content = REAL_PNG, mime = 'image/png') =>
  postPhoto(`/api/v1/courier/order/${orderId}/pickup-proof-photo`, token, content, mime);

const confirmPickup = (orderId: string, token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/courier/order/${orderId}/pickup-proof`, headers: { authorization: `Bearer ${token}` }, payload });

const riderLeg = (orderId: string, slug: string, token: string) =>
  app.inject({ method: 'PUT', url: `/api/v1/rider/orders/${orderId}/${slug}`, headers: { authorization: `Bearer ${token}` } });

const pickupColumns = {
  status: true,
  pickedUpAt: true,
  courierPickupProofIssuedUrl: true,
  courierPickupProofIssuedRiderId: true,
  courierPickupProofPhotoUrl: true,
  courierPickupProofLat: true,
  courierPickupProofLng: true,
} as const;

const pickupRow = (id: string) => app.prisma.order.findUniqueOrThrow({ where: { id }, select: pickupColumns });
const pickedUpLogs = (orderId: string) => app.prisma.orderStatusLog.count({ where: { orderId, status: 'PICKED_UP' } });

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
  orders = new OrderService(app.prisma, app.io);
  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('[E16] the bare pickup tap no longer takes custody of a parcel', () => {
  it('refuses the generic picked-up leg for a courier and changes nothing', async () => {
    const { mover, order } = await atPickup();

    const res = await riderLeg(order.id, 'picked-up', mover.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PICKUP_PROOF_REQUIRED');

    const after = await pickupRow(order.id);
    expect({ status: after.status, pickedUpAt: after.pickedUpAt }).toEqual({ status: 'RIDER_ARRIVED_PICKUP', pickedUpAt: null });
    expect(await pickedUpLogs(order.id)).toBe(0);
  });

  it('a caller that skips the proof cannot mint a courier PICKED_UP at the canonical seam', async () => {
    const { mover, order } = await atPickup();
    const bindWith = (data: { courierPickupProofPhotoUrl: string; courierPickupProofLat?: number; courierPickupProofLng?: number }) =>
      orders.transitionOrderAtomically({
        orderId: order.id,
        target: 'PICKED_UP',
        allowedFrom: ['RIDER_ARRIVED_PICKUP'],
        changedBy: mover.userId,
        note: 'a caller that binds its own proof',
        withinTransaction: async (tx) => { await tx.order.update({ where: { id: order.id }, data }); },
      });

    await expect(orders.updateStatus(order.id, 'PICKED_UP', mover.userId, 'a caller that skipped the pickup proof'))
      .rejects.toMatchObject({ code: 'PICKUP_PROOF_REQUIRED' });
    // Even with a genuine photo issued to this rider, the seam checks the bind
    // on the row as it commits, and a refused hook's writes roll back: a
    // different url is not the proof, and neither is the right url without GPS.
    const issuedUrl = (await uploadPickupPhoto(order.id, mover.token)).json().data.url as string;
    await expect(bindWith({ courierPickupProofPhotoUrl: `${issuedUrl}.forged.png`, courierPickupProofLat: 6.81, courierPickupProofLng: -58.155 }))
      .rejects.toMatchObject({ code: 'PICKUP_PROOF_REQUIRED' });
    await expect(bindWith({ courierPickupProofPhotoUrl: issuedUrl }))
      .rejects.toMatchObject({ code: 'PICKUP_PROOF_REQUIRED' });
    expect(await pickupRow(order.id)).toMatchObject({
      status: 'RIDER_ARRIVED_PICKUP', pickedUpAt: null, courierPickupProofIssuedUrl: issuedUrl, courierPickupProofPhotoUrl: null, courierPickupProofLat: null,
    });
    expect(await pickedUpLogs(order.id)).toBe(0);

    // The guard is about the proof, not the caller: a bound proof passes.
    await expect(bindWith({ courierPickupProofPhotoUrl: issuedUrl, courierPickupProofLat: 6.81, courierPickupProofLng: -58.155 }))
      .resolves.toMatchObject({ order: { status: 'PICKED_UP' } });
    expect(await pickedUpLogs(order.id)).toBe(1);
  });

  it('leaves the food rider path exactly as it was: the bare pickup tap still works for a store order', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await makeRider(mover.userId);
    const vendor = await app.prisma.vendor.findFirst({ select: { id: true } });
    if (!vendor) throw new Error('no vendor in the test database');
    const food = await app.prisma.order.create({
      data: {
        orderNumber: `PKP-F-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: customer.userId, vendorId: vendor.id, riderId: rider.id,
        status: 'RIDER_ARRIVED_PICKUP', deliveryAddress: 'b', deliveryLat: 6.82, deliveryLng: -58.16,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500,
        paymentMethod: 'CASH', paymentStatus: 'CAPTURED',
      },
    });

    const res = await riderLeg(food.id, 'picked-up', mover.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('PICKED_UP');
  });
});

describe('[E16] the pickup photo is issued by the server, to the assigned rider, at the pickup', () => {
  it('accepts a real photo from the assigned rider and records the issued url and rider', async () => {
    const { mover, rider, order } = await atPickup();

    const res = await uploadPickupPhoto(order.id, mover.token);
    expect(res.statusCode, res.body).toBe(200);
    const url = res.json().data.url as string;
    expect(url).toContain(`courier-proof/${order.id}/pickup/`);

    const row = await pickupRow(order.id);
    expect(row).toMatchObject({ status: 'RIDER_ARRIVED_PICKUP', courierPickupProofIssuedUrl: url, courierPickupProofIssuedRiderId: rider.id, courierPickupProofPhotoUrl: null });
  });

  it('rejects a spoofed Content-Type whose bytes are not an image, and issues nothing', async () => {
    const { mover, order } = await atPickup();

    const res = await uploadPickupPhoto(order.id, mover.token, Buffer.from('#!/bin/sh\nrm -rf /'), 'image/png');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_IMAGE');
    expect((await pickupRow(order.id)).courierPickupProofIssuedUrl).toBeNull();
  });

  it('refuses a rider who is not the one assigned to the job', async () => {
    const { mover, rider, order } = await atPickup();
    const intruder = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    await makeRider(intruder.userId);

    const res = await uploadPickupPhoto(order.id, intruder.token);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect((await pickupRow(order.id)).courierPickupProofIssuedUrl).toBeNull();
    // The same route serves the assigned rider, so the 404 above is the
    // rider-scoped refusal, not an absent route (which also answers 404).
    const owner = await uploadPickupPhoto(order.id, mover.token);
    expect(owner.statusCode, owner.body).toBe(200);
    expect((await pickupRow(order.id)).courierPickupProofIssuedRiderId).toBe(rider.id);
  });

  it('refuses a pickup photo before the rider is at the pickup', async () => {
    const { mover, order } = await atPickup('RIDER_EN_ROUTE_PICKUP');

    const res = await uploadPickupPhoto(order.id, mover.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_AT_PICKUP');
    expect((await pickupRow(order.id)).courierPickupProofIssuedUrl).toBeNull();
  });

  it('refuses a pickup photo on a FAILED job, and writes nothing', async () => {
    const { mover, order } = await atPickup('FAILED');

    const res = await uploadPickupPhoto(order.id, mover.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_IN_TRANSIT');
    expect(await pickupRow(order.id)).toMatchObject({
      courierPickupProofIssuedUrl: null,
      courierPickupProofIssuedRiderId: null,
      courierPickupProofPhotoUrl: null,
      courierPickupProofLat: null,
      courierPickupProofLng: null,
    });
  });
});

describe('[E16] pickup is confirmed only with the issued photo and a location', () => {
  it('the issued photo + GPS take custody: PICKED_UP with durable photo, place, time, log and notice', async () => {
    const { sender, mover, order } = await atPickup();
    const up = await uploadPickupPhoto(order.id, mover.token);
    expect(up.statusCode, up.body).toBe(200);
    const issuedUrl = up.json().data.url as string;

    const res = await confirmPickup(order.id, mover.token, { proofPhotoUrl: issuedUrl, gps: PICKUP_GPS });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('PICKED_UP');

    // Durable state, not just the status code: the bound photo, the rider's
    // location, the server-side custody time, the log note and the sender's notice.
    const fresh = await pickupRow(order.id);
    expect(fresh.status).toBe('PICKED_UP');
    expect(fresh.courierPickupProofPhotoUrl).toBe(issuedUrl);
    expect(fresh.courierPickupProofLat).toBe(6.81);
    expect(fresh.courierPickupProofLng).toBe(-58.155);
    expect(fresh.pickedUpAt).not.toBeNull();

    const log = await app.prisma.orderStatusLog.findFirst({ where: { orderId: order.id, status: 'PICKED_UP' }, orderBy: { createdAt: 'desc' } });
    expect(log?.note).toContain('pickup photo');
    expect(log?.note).toContain('gps:6.81000,-58.15500');

    const notices = await app.prisma.notification.findMany({ where: { userId: sender.userId } });
    expect(notices.some((n) => {
      const data = n.data as { orderId?: string; status?: string } | null;
      return data?.orderId === order.id && data?.status === 'PICKED_UP';
    })).toBe(true);
  });

  it('refuses a fabricated pickup-proof URL that the server never issued', async () => {
    const { mover, order } = await atPickup();

    const res = await confirmPickup(order.id, mover.token, {
      proofPhotoUrl: `https://evil.example/courier-proof/${order.id}/pickup/fake.png`,
      gps: PICKUP_GPS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PICKUP_PROOF_NOT_ISSUED');
    expect(await pickupRow(order.id)).toMatchObject({ status: 'RIDER_ARRIVED_PICKUP', pickedUpAt: null, courierPickupProofPhotoUrl: null });
    expect(await pickedUpLogs(order.id)).toBe(0);
  });

  it('binds exactly the issued photo: a url that merely contains its folder is refused', async () => {
    const { mover, order } = await atPickup();
    const issuedUrl = (await uploadPickupPhoto(order.id, mover.token)).json().data.url as string;

    const res = await confirmPickup(order.id, mover.token, { proofPhotoUrl: `${issuedUrl}?v=2`, gps: PICKUP_GPS });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PICKUP_PROOF_NOT_ISSUED');
    expect(await pickupRow(order.id)).toMatchObject({ status: 'RIDER_ARRIVED_PICKUP', pickedUpAt: null, courierPickupProofPhotoUrl: null });
    expect(await pickedUpLogs(order.id)).toBe(0);
  });

  it('refuses the confirmation without a GPS fix, even with the issued photo', async () => {
    const { mover, order } = await atPickup();
    const issuedUrl = (await uploadPickupPhoto(order.id, mover.token)).json().data.url as string;

    const res = await confirmPickup(order.id, mover.token, { proofPhotoUrl: issuedUrl });
    expect(res.statusCode).toBe(400);
    expect(await pickupRow(order.id)).toMatchObject({ status: 'RIDER_ARRIVED_PICKUP', pickedUpAt: null, courierPickupProofPhotoUrl: null });
    expect(await pickedUpLogs(order.id)).toBe(0);
  });

  it('a photo issued to the previous rider cannot be bound by the rider the job moved to', async () => {
    const { mover: first, order } = await atPickup();
    const firstUrl = (await uploadPickupPhoto(order.id, first.token)).json().data.url as string;
    const second = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const secondRider = await makeRider(second.userId);
    await app.prisma.order.update({ where: { id: order.id }, data: { riderId: secondRider.id } });

    const res = await confirmPickup(order.id, second.token, { proofPhotoUrl: firstUrl, gps: PICKUP_GPS });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PICKUP_PROOF_NOT_ISSUED');
    expect(await pickupRow(order.id)).toMatchObject({ status: 'RIDER_ARRIVED_PICKUP', courierPickupProofPhotoUrl: null });
  });

  it('once the parcel is taken, its pickup evidence cannot be replaced or re-confirmed', async () => {
    const { mover, order } = await atPickup();
    const issuedUrl = (await uploadPickupPhoto(order.id, mover.token)).json().data.url as string;
    expect((await confirmPickup(order.id, mover.token, { proofPhotoUrl: issuedUrl, gps: PICKUP_GPS })).statusCode).toBe(200);
    const bound = await pickupRow(order.id);

    const again = await uploadPickupPhoto(order.id, mover.token);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_PICKED_UP');
    const reconfirm = await confirmPickup(order.id, mover.token, { proofPhotoUrl: issuedUrl, gps: { lat: 6.9, lng: -58.2 } });
    expect(reconfirm.statusCode).toBe(409);
    expect(reconfirm.json().error.code).toBe('ALREADY_PICKED_UP');

    expect(await pickupRow(order.id)).toEqual(bound);
    expect(await pickedUpLogs(order.id)).toBe(1);
  });

  it('in-transit follows the proof: en-route-delivery is reachable after PICKED_UP', async () => {
    const { mover, order } = await atPickup();
    const issuedUrl = (await uploadPickupPhoto(order.id, mover.token)).json().data.url as string;
    expect((await confirmPickup(order.id, mover.token, { proofPhotoUrl: issuedUrl, gps: PICKUP_GPS })).statusCode).toBe(200);

    const res = await riderLeg(order.id, 'en-route-delivery', mover.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('EN_ROUTE_DELIVERY');
  });
});

describe('[E16] the whole courier run still completes, with both proofs on the record', () => {
  it('assigned → at pickup → fee collected → pickup photo → in transit → door photo → DELIVERED', async () => {
    const { mover, order } = await atPickup('RIDER_ASSIGNED', 'SENDER');
    for (const slug of ['en-route-pickup', 'arrived-pickup']) {
      const step = await riderLeg(order.id, slug, mover.token);
      expect(step.statusCode, `${slug}: ${step.body}`).toBe(200);
    }
    const collect = await app.inject({
      method: 'POST', url: `/api/v1/courier/order/${order.id}/collect`,
      headers: { authorization: `Bearer ${mover.token}` }, payload: { outcome: 'paid', gps: PICKUP_GPS },
    });
    expect(collect.statusCode, collect.body).toBe(200);

    const pickupUrl = (await uploadPickupPhoto(order.id, mover.token)).json().data.url as string;
    const picked = await confirmPickup(order.id, mover.token, { proofPhotoUrl: pickupUrl, gps: PICKUP_GPS });
    expect(picked.statusCode, picked.body).toBe(200);
    for (const slug of ['en-route-delivery', 'arrived']) {
      const step = await riderLeg(order.id, slug, mover.token);
      expect(step.statusCode, `${slug}: ${step.body}`).toBe(200);
    }
    const doorPhoto = await postPhoto(`/api/v1/courier/order/${order.id}/proof-photo`, mover.token);
    expect(doorPhoto.statusCode, doorPhoto.body).toBe(200);
    const doorUrl = doorPhoto.json().data.url as string;
    const delivered = await app.inject({
      method: 'POST', url: `/api/v1/courier/order/${order.id}/proof`,
      headers: { authorization: `Bearer ${mover.token}` }, payload: { proofPhotoUrl: doorUrl },
    });
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect(delivered.json().data.status).toBe('DELIVERED');

    const done = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true, pickedUpAt: true, courierPickupProofPhotoUrl: true, courierProofPhotoUrl: true },
    });
    expect(done).toMatchObject({ status: 'DELIVERED', courierPickupProofPhotoUrl: pickupUrl, courierProofPhotoUrl: doorUrl });
    expect(done.pickedUpAt).not.toBeNull();
    expect(pickupUrl).not.toBe(doorUrl);
  });
});

describe('[E16] who can see the pickup photo', () => {
  it('the sender sees it on their job detail; the public tracking link never carries it', async () => {
    const { sender, mover, order } = await atPickup();
    const issuedUrl = (await uploadPickupPhoto(order.id, mover.token)).json().data.url as string;
    expect((await confirmPickup(order.id, mover.token, { proofPhotoUrl: issuedUrl, gps: PICKUP_GPS })).statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/courier/order/${order.id}`, headers: { authorization: `Bearer ${sender.token}` } });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data.courierPickupProofPhotoUrl).toBe(issuedUrl);

    const track = await app.inject({ method: 'GET', url: `/api/v1/courier/track/${order.courierTrackingToken}` });
    expect(track.statusCode, track.body).toBe(200);
    expect(track.json().data.status).toBe('PICKED_UP');
    expect(track.body).not.toContain('/pickup/');
    expect(Object.keys(track.json().data)).not.toContain('courierPickupProofPhotoUrl');
  });
});
