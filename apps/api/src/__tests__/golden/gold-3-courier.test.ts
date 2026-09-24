import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import courierRoutes from '../../modules/courier/courier.routes';
import { riderRoutes } from '../../modules/rider/rider.routes';
import { registerErrorHandler } from '../../middleware/error-handler';
import { recordDispatchQueue } from '../helpers/dispatch-queue';

// ---------------------------------------------------------------------------
// GOLD-3 · COUR-01 / COUR-02 — the courier "Send" journey, through the REAL
// mounted courier + rider routes as real sessions, asserted on durable rows:
//
//   COUR-01  create at the quoted fee, which is also the seeded card's fee
//            worked by hand → the online courier is offered the job and
//            accepts the card → run to pickup → the sender's fee is
//            collected (once) → custody → run to the door → the delivery
//            photo is uploaded (a garbage file refused first, then a clean
//            retry) → the proof with the SERVER-ISSUED url closes the job with
//            one earning and a freed courier. The public tracking link serves
//            only a narrow payload, shows the courier while the parcel moves
//            and withholds the position once it is delivered. Strangers are
//            refused; the sender cannot cancel a parcel in custody.
//   E16      custody is photo-proven at pickup too (fixed).
//   COUR-02  a DELIVERY-only mover and a BICYCLE courier are never offered a
//            LARGE parcel and their board grabs are refused; the eligible
//            (farther) courier is offered it and takes it.
//
// Dispatch runs through the suite's acknowledged route→worker double
// (helpers/dispatch-queue.ts). Photos land in this file's own temp dir.
// Fixture range: +5920332nnn (this file only).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920332';
const FIXTURE = 'gold3-courier-fixture';
const PICKUP = { lat: 6.81462, lng: -58.13718 };
const DROP = { lat: 6.79875, lng: -58.12944 };

// The COUR-01 fee, worked by hand. GY's courier card is the seeded one: the
// platform config writes no courierRates for GY, and an absent column prices
// from the declared defaults — GYD 1,000 base, 300 per km, MEDIUM +500,
// STANDARD ×1. The priced distance, in the default (haversine) maps mode, is
// the great-circle distance × 1.3 for the road, canonicalised to 0.01 km
// [ALG-18]. Written out here and never imported, so a change to the card, the
// distance model or the formula moves the charge off this number and fails
// the journey — the estimate alone would move with the charge.
const GY_COURIER_CARD = { baseFee: 1000, perKm: 300, mediumSurcharge: 500, standardMultiplier: 1 };
function greatCircleKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
/** 2.55 km for PICKUP → DROP. */
const PRICED_KM = Math.round(greatCircleKm(PICKUP, DROP) * 1.3 * 100) / 100;
/** GYD 2,265 = (1,000 + 2.55 × 300 + 500) × 1. */
const EXPECTED_FEE = Math.round(
  (GY_COURIER_CARD.baseFee + PRICED_KM * GY_COURIER_CARD.perKm + GY_COURIER_CARD.mediumSurcharge) * GY_COURIER_CARD.standardMultiplier,
);
const UPLOAD_DIR = mkdtempSync(path.join(os.tmpdir(), 'swift-gold3-courier-'));

let app: FastifyInstance;
let seq = 0;
const movers: Array<{ riderId: string; token: string }> = [];

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName,
      lastName: `Cour${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `courier-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

/** A mover profile (onboarding is its own journey) brought online through
 *  the REAL go-online route at `fix`. */
async function makeMover(
  firstName: string,
  riderType: 'COURIER' | 'DELIVERY' | 'BOTH',
  vehicleType: 'BICYCLE' | 'MOTORCYCLE' | 'CAR',
  fix: { lat: number; lng: number },
) {
  const u = await makeUser(firstName, ['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: { userId: u.userId, riderType, vehicleType, documentsVerified: true, floatLimit: 1_000_000 },
  }));
  movers.push({ riderId: rider.id, token: u.token });
  const go = await call('POST', '/api/v1/rider/go-online', u.token, { latitude: fix.lat, longitude: fix.lng });
  expect(go.statusCode, go.body).toBe(200);
  return { ...u, riderId: rider.id, fix };
}

/** Retire this file's free supply through the real route after each test. */
async function retireSupply() {
  for (const m of movers) {
    const row = await sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id: m.riderId } }));
    if (!row.isOnline || row.currentOrderId) continue;
    const off = await call('POST', '/api/v1/rider/go-offline', m.token);
    expect(off.statusCode, off.body).toBe(200);
  }
}

function call(method: 'GET' | 'POST' | 'PUT', url: string, token?: string, payload?: unknown) {
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

/** Unauthenticated public tracking read, on its own caller bucket. */
function track(token: string) {
  return app.inject({ method: 'GET', url: `/api/v1/courier/track/${token}`, remoteAddress: '10.43.3.2' });
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

function postPhoto(orderId: string, token: string, content: Buffer = PNG, mime = 'image/png', route: 'proof-photo' | 'pickup-proof-photo' = 'proof-photo') {
  const boundary = `----gold3${nanoid(8)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="door.png"\r\ncontent-type: ${mime}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: `/api/v1/courier/order/${orderId}/${route}`,
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` },
  });
}

const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const logCount = (orderId: string, status: string) => sys(() => app.prisma.orderStatusLog.count({ where: { orderId, status: status as never } }));
const offerKey = (orderId: string) => `dispatch:offer:${orderId}`;

const ORDER_BODY = {
  pickup: PICKUP,
  dropoff: DROP,
  pickupAddress: '31 Sender Street, Georgetown',
  dropoffAddress: '7 Recipient Avenue, Georgetown',
  packageSize: 'MEDIUM' as const,
  packageDescription: 'Documents for Aunty Pat',
  speed: 'STANDARD' as const,
  recipientName: 'Aunty Pat',
  recipientPhone: `${PHONE_PREFIX}999`,
};

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { riderId: { in: riderIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.earning.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    if (orderIds.length > 0) {
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await purgeRedis([...ids, ...riderIds, ...orderIds]);
  });
}

async function purgeRedis(ids: string[]) {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(/[:]/).some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

beforeAll(async () => {
  // Photos go to this file's own directory — read by the storage provider when
  // the courier routes register below.
  vi.stubEnv('UPLOAD_DIR', UPLOAD_DIR);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app, true);
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
  vi.unstubAllEnvs();
  rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await retireSupply();
});

describe('GOLD-3 · COUR-01 — courier "Send": create → offer → collect → custody → proof → public track', () => {
  it('drives the parcel end to end with the sender, the courier and strangers each held to their part', async () => {
    const sender = await makeUser('Sonia', ['CUSTOMER'], 'CUSTOMER');
    const stranger = await makeUser('Stef', ['CUSTOMER'], 'CUSTOMER');
    const courier = await makeMover('Kofi', 'COURIER', 'MOTORCYCLE', { lat: 6.81488, lng: -58.13691 });
    const rival = await makeMover('Ravi', 'COURIER', 'MOTORCYCLE', { lat: 6.84519, lng: -58.11021 });
    // The rival is not on shift: offline, so dispatch cannot choose them.
    expect((await call('POST', '/api/v1/rider/go-offline', rival.token)).statusCode).toBe(200);

    // ── Create, at the quoted fee ────────────────────────────────────────────
    const quote = await call('POST', '/api/v1/courier/estimate', sender.token, { pickup: PICKUP, dropoff: DROP, packageSize: 'MEDIUM', speed: 'STANDARD' });
    expect(quote.statusCode).toBe(200);
    const created = await call('POST', '/api/v1/courier/order', sender.token, ORDER_BODY);
    expect(created.statusCode, created.body).toBe(201);
    const { orderId, trackingToken, fee } = created.json().data as { orderId: string; trackingToken: string; fee: number };
    expect(fee).toBe(quote.json().data.totalFee);
    expect(fee).toBeGreaterThan(0);
    // ...and absolutely: the seeded GY card applied to the fixture distance by
    // this file's own arithmetic (EXPECTED_FEE above). The check against the
    // estimate alone stays green when a regression moves both together.
    expect(fee).toBe(EXPECTED_FEE);

    const placed = await orderRow(orderId);
    expect({
      type: placed.orderType, status: placed.status, customer: placed.customerId, rider: placed.riderId,
      deliveryFee: Number(placed.deliveryFee), total: Number(placed.totalAmount), payer: placed.courierPayer,
      method: placed.paymentMethod, payment: placed.paymentStatus, held: placed.holdExpiresAt,
      recipient: placed.courierRecipientName, recipientPhone: placed.courierRecipientPhone, size: placed.courierPackageSize,
      pricedKm: Number(placed.billableKm), kmSource: placed.billableKmSource,
    }).toEqual({
      type: 'COURIER', status: 'READY_FOR_PICKUP', customer: sender.userId, rider: null,
      deliveryFee: fee, total: fee, payer: 'SENDER', method: 'CASH', payment: 'PENDING', held: null,
      recipient: 'Aunty Pat', recipientPhone: ORDER_BODY.recipientPhone, size: 'MEDIUM',
      // The distance the fee was priced from, frozen with its source [ALG-18].
      pricedKm: PRICED_KM, kmSource: 'haversine',
    });

    // ── The public link: narrow, and nobody on the parcel yet ────────────────
    const first = await track(trackingToken);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toEqual({
      orderNumber: placed.orderNumber,
      status: 'READY_FOR_PICKUP',
      courierRecipientName: 'Aunty Pat',
      pickupAddress: ORDER_BODY.pickupAddress,
      deliveryAddress: ORDER_BODY.dropoffAddress,
      estimatedDeliveryTime: placed.estimatedDeliveryTime,
      rider: null,
    });
    expect((await track('not-a-real-tracking-token')).statusCode).toBe(404);

    // ── Dispatch offered the online courier; the card is accepted ───────────
    expect((await app.redis.get(offerKey(orderId)))!.split(':')[0]).toBe(courier.riderId);
    const card = await call('GET', '/api/v1/rider/offers/current', courier.token);
    expect(card.json().data.offer.orderId).toBe(orderId);
    const accept = await call('POST', '/api/v1/rider/offers/accept', courier.token, { orderId });
    expect(accept.statusCode, accept.body).toBe(200);
    expect(accept.json().data.status).toBe('RIDER_ASSIGNED');
    expect((await orderRow(orderId)).riderId).toBe(courier.riderId);

    // ── Strangers are refused and change nothing ─────────────────────────────
    const own = await call('GET', `/api/v1/courier/order/${orderId}`, sender.token);
    expect({ status: own.statusCode, id: own.json().data.id }).toEqual({ status: 200, id: orderId });
    expect((await call('GET', `/api/v1/courier/order/${orderId}`, stranger.token)).statusCode).toBe(404);
    const strangerCancel = await call('POST', `/api/v1/courier/order/${orderId}/cancel`, stranger.token, {});
    expect(strangerCancel.statusCode).toBe(404);
    const strangerPhoto = await postPhoto(orderId, rival.token);
    expect(strangerPhoto.statusCode).toBe(404);
    const strangerCollect = await call('POST', `/api/v1/courier/order/${orderId}/collect`, rival.token, { outcome: 'paid', gps: PICKUP });
    expect(strangerCollect.statusCode).toBe(404);
    const untouched = await orderRow(orderId);
    expect({ status: untouched.status, rider: untouched.riderId, payment: untouched.paymentStatus, issued: untouched.courierProofIssuedUrl })
      .toEqual({ status: 'RIDER_ASSIGNED', rider: courier.riderId, payment: 'PENDING', issued: null });

    // ── Run to pickup ────────────────────────────────────────────────────────
    const enRoute = await call('PUT', `/api/v1/rider/orders/${orderId}/en-route-pickup`, courier.token, {});
    expect(enRoute.statusCode, enRoute.body).toBe(200);
    expect(enRoute.json().data.status).toBe('RIDER_EN_ROUTE_PICKUP');
    const atPickup = await call('PUT', `/api/v1/rider/orders/${orderId}/arrived-pickup`, courier.token, {});
    expect(atPickup.statusCode, atPickup.body).toBe(200);
    expect(atPickup.json().data.status).toBe('RIDER_ARRIVED_PICKUP');
    // The arrival claim is written down beside the courier's OWN streamed fix.
    const arrival = await sys(() => app.prisma.orderStatusLog.findFirstOrThrow({ where: { orderId, status: 'RIDER_ARRIVED_PICKUP' } }));
    expect(arrival.note).toMatch(/^Rider reported arriving at pickup — gps:6\.81488,-58\.13691 \(\d+ m from the pickup, fix \d+s old\)$/);

    // The tracking link shows the courier moving.
    const moving = await track(trackingToken);
    expect(moving.json().data.status).toBe('RIDER_ARRIVED_PICKUP');
    expect(moving.json().data.rider).toMatchObject({ currentLat: 6.81488, currentLng: -58.13691, user: { firstName: 'Kofi' } });
    expect(Object.keys(moving.json().data.rider).sort()).toEqual(['currentLat', 'currentLng', 'lastLocationUpdate', 'user']);
    expect(Object.keys(moving.json().data.rider.user)).toEqual(['firstName']);

    // ── The sender pays at pickup — recorded once ────────────────────────────
    const collect = await call('POST', `/api/v1/courier/order/${orderId}/collect`, courier.token, { outcome: 'paid', gps: PICKUP });
    expect(collect.statusCode, collect.body).toBe(200);
    expect(collect.json().data).toEqual({ orderId, status: 'RIDER_ARRIVED_PICKUP', paymentStatus: 'CAPTURED', collected: true });
    const collectedLog = { orderId, note: { startsWith: 'cash collected from sender — gps:6.81462,-58.13718' } };
    expect(await sys(() => app.prisma.orderStatusLog.count({ where: collectedLog }))).toBe(1);
    const retap = await call('POST', `/api/v1/courier/order/${orderId}/collect`, courier.token, { outcome: 'paid', gps: PICKUP });
    expect(retap.statusCode).toBe(200);
    expect(retap.json().data).toEqual({ orderId, status: 'RIDER_ARRIVED_PICKUP', paymentStatus: 'CAPTURED', collected: true });
    expect(await sys(() => app.prisma.orderStatusLog.count({ where: collectedLog }))).toBe(1);

    // ── Custody, proven (E16): the bare tap is refused; the parcel is photographed
    // at the pickup and confirmed with that server-issued photo and the courier's GPS.
    // The sender can no longer cancel a parcel the courier holds. ────────────
    const bareTap = await call('PUT', `/api/v1/rider/orders/${orderId}/picked-up`, courier.token, {});
    expect(bareTap.statusCode).toBe(409);
    expect(bareTap.json().error.code).toBe('PICKUP_PROOF_REQUIRED');
    const pickupPhoto = await postPhoto(orderId, courier.token, PNG, 'image/png', 'pickup-proof-photo');
    expect(pickupPhoto.statusCode, pickupPhoto.body).toBe(200);
    const picked = await call('POST', `/api/v1/courier/order/${orderId}/pickup-proof`, courier.token, { proofPhotoUrl: pickupPhoto.json().data.url, gps: PICKUP });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(picked.json().data.status).toBe('PICKED_UP');
    const lateCancel = await call('POST', `/api/v1/courier/order/${orderId}/cancel`, sender.token, { reason: 'changed my mind' });
    expect(lateCancel.statusCode).toBe(409);
    expect(lateCancel.json().error.code).toBe('PARCEL_IN_CUSTODY');
    const held = await orderRow(orderId);
    expect({ status: held.status, rider: held.riderId, cancelledAt: held.cancelledAt }).toEqual({ status: 'PICKED_UP', rider: courier.riderId, cancelledAt: null });
    expect((await sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id: courier.riderId } }))).currentOrderId).toBe(orderId);
    expect(await logCount(orderId, 'CANCELLED')).toBe(0);

    // ── To the door ──────────────────────────────────────────────────────────
    const toDoor = await call('PUT', `/api/v1/rider/orders/${orderId}/en-route-delivery`, courier.token, {});
    expect(toDoor.statusCode, toDoor.body).toBe(200);
    const atDoor = await call('PUT', `/api/v1/rider/orders/${orderId}/arrived`, courier.token, {});
    expect(atDoor.statusCode, atDoor.body).toBe(200);
    expect(atDoor.json().data.status).toBe('ARRIVED');

    // ── The delivery photo: a garbage upload is refused; the retry is clean ──
    const noPhoto = await call('POST', `/api/v1/courier/order/${orderId}/proof`, courier.token, { proofPhotoUrl: `/uploads/courier-proof/${orderId}/guess.png` });
    expect(noPhoto.statusCode).toBe(400);
    expect(noPhoto.json().error.code).toBe('PROOF_NOT_ISSUED');
    const garbage = await postPhoto(orderId, courier.token, Buffer.from('definitely not an image at all'), 'image/png');
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json().error.code).toBe('BAD_IMAGE');
    expect((await orderRow(orderId)).courierProofIssuedUrl).toBeNull();

    const uploaded = await postPhoto(orderId, courier.token);
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const proofUrl = uploaded.json().data.url as string;
    expect(proofUrl).toMatch(new RegExp(`^/uploads/courier-proof/${orderId}/[A-Za-z0-9_-]{16}\\.png$`));
    const issued = await orderRow(orderId);
    expect({ url: issued.courierProofIssuedUrl, by: issued.courierProofIssuedRiderId }).toEqual({ url: proofUrl, by: courier.riderId });
    const onDisk = path.join(UPLOAD_DIR, proofUrl.replace(/^\/uploads\//, ''));
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk).subarray(0, 8)).toEqual(PNG.subarray(0, 8));

    // A foreign url — even one naming the folder — was never issued.
    const forged = await call('POST', `/api/v1/courier/order/${orderId}/proof`, courier.token, {
      proofPhotoUrl: `https://evil.invalid/x?u=/uploads/courier-proof/${orderId}/fake.png`,
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error.code).toBe('PROOF_NOT_ISSUED');
    expect((await orderRow(orderId)).status).toBe('ARRIVED');

    // ── Proof closes the job: one commit, one earning, a freed courier ──────
    const proof = await call('POST', `/api/v1/courier/order/${orderId}/proof`, courier.token, { proofPhotoUrl: proofUrl });
    expect(proof.statusCode, proof.body).toBe(200);
    expect(proof.json().data.status).toBe('DELIVERED');

    const [delivered, rider, earnings, deliveredLogs, notices] = await Promise.all([
      orderRow(orderId),
      sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id: courier.riderId } })),
      sys(() => app.prisma.earning.findMany({ where: { orderId } })),
      logCount(orderId, 'DELIVERED'),
      sys(() => app.prisma.notification.findMany({ where: { userId: sender.userId, title: 'Parcel delivered' } })),
    ]);
    expect({ status: delivered.status, payment: delivered.paymentStatus, photo: delivered.courierProofPhotoUrl })
      .toEqual({ status: 'DELIVERED', payment: 'CAPTURED', photo: proofUrl });
    expect(delivered.deliveredAt).not.toBeNull();
    expect(earnings.map((e) => ({ type: e.type, amount: Number(e.amount), rider: e.riderId })))
      .toEqual([{ type: 'COURIER_FEE', amount: fee, rider: courier.riderId }]);
    expect({ pointer: rider.currentOrderId, available: rider.isAvailable, total: rider.totalDeliveries })
      .toEqual({ pointer: null, available: true, total: 1 });
    expect(deliveredLogs).toBe(1);
    expect(notices).toHaveLength(1);

    // A double tap after the close pays nobody twice.
    const again = await call('POST', `/api/v1/courier/order/${orderId}/proof`, courier.token, { proofPhotoUrl: proofUrl });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('NOT_IN_TRANSIT');
    const after = await orderRow(orderId);
    expect(after.deliveredAt).toEqual(delivered.deliveredAt);
    expect(await sys(() => app.prisma.earning.count({ where: { orderId } }))).toBe(1);
    expect(await logCount(orderId, 'DELIVERED')).toBe(1);
    expect(await sys(() => app.prisma.notification.count({ where: { userId: sender.userId, title: 'Parcel delivered' } }))).toBe(1);
    // The sender heard exactly three things, in order: a courier is coming, the
    // parcel is picked up, the parcel arrived.
    const heard = await sys(() => app.prisma.notification.findMany({ where: { userId: sender.userId }, orderBy: { createdAt: 'asc' }, select: { title: true, data: true } }));
    expect(heard.map((n) => n.title)).toEqual(['Rider On The Way!', 'On Its Way!', 'Parcel delivered']);
    expect(heard.every((n) => (n.data as { orderId?: string } | null)?.orderId === orderId)).toBe(true);

    // ── The link the recipient kept: DELIVERED, and the courier's position is
    //    no longer anyone's business ─────────────────────────────────────────
    const done = await track(trackingToken);
    expect(done.json().data.status).toBe('DELIVERED');
    expect(done.json().data.rider).toEqual({ currentLat: null, currentLng: null, lastLocationUpdate: null, user: { firstName: 'Kofi' } });
  });
});

// E16 (S1, ledger): the courier journey had NO pickup-photo custody proof —
// PUT picked-up took custody on a bare tap. #1283 made the courier pickup-proof
// step the only courier door into PICKED_UP. This asserts it: custody refused
// until a server-issued pickup photo exists (409 PICKUP_PROOF_REQUIRED), and
// nothing changes. The whole run to the pickup happens in beforeAll, so the
// assertion is the custody refusal itself.
describe('GOLD-3 · COUR-01 — [E16] pickup custody is photo-proven', () => {
  let orderId = '';
  let courierToken = '';

  beforeAll(async () => {
    const sender = await makeUser('Esi', ['CUSTOMER'], 'CUSTOMER');
    const courier = await makeMover('Eko', 'COURIER', 'MOTORCYCLE', { lat: 6.81477, lng: -58.13702 });
    courierToken = courier.token;
    const created = await call('POST', '/api/v1/courier/order', sender.token, ORDER_BODY);
    expect(created.statusCode, created.body).toBe(201);
    orderId = created.json().data.orderId as string;
    const accept = await call('POST', '/api/v1/rider/offers/accept', courier.token, { orderId });
    expect(accept.statusCode, accept.body).toBe(200);
    for (const slug of ['en-route-pickup', 'arrived-pickup']) {
      const step = await call('PUT', `/api/v1/rider/orders/${orderId}/${slug}`, courier.token, {});
      expect(step.statusCode, step.body).toBe(200);
    }
    const collect = await call('POST', `/api/v1/courier/order/${orderId}/collect`, courier.token, { outcome: 'paid', gps: PICKUP });
    expect(collect.statusCode, collect.body).toBe(200);
    const ready = await orderRow(orderId);
    expect({ status: ready.status, payment: ready.paymentStatus, pickedUpAt: ready.pickedUpAt })
      .toEqual({ status: 'RIDER_ARRIVED_PICKUP', payment: 'CAPTURED', pickedUpAt: null });
  });

  it('[E16] taking custody without a server-issued pickup photo is refused and changes nothing', async () => {
    const picked = await call('PUT', `/api/v1/rider/orders/${orderId}/picked-up`, courierToken, {});
    expect(picked.statusCode).toBe(409);
    expect(picked.json().error.code).toBe('PICKUP_PROOF_REQUIRED');
    const order = await orderRow(orderId);
    expect({ status: order.status, pickedUpAt: order.pickedUpAt }).toEqual({ status: 'RIDER_ARRIVED_PICKUP', pickedUpAt: null });
    expect(await logCount(orderId, 'PICKED_UP')).toBe(0);
  });
});

describe('GOLD-3 · COUR-02 — the wrong service or vehicle never gets the parcel; the eligible courier does', () => {
  it('offers the LARGE parcel past two nearer ineligible movers, refuses their board grabs, and the eligible courier takes it', async () => {
    const sender = await makeUser('Nia', ['CUSTOMER'], 'CUSTOMER');
    // In Linden — far outside the 15 km outer ring of every mover above, so
    // this pass sees exactly these three. Nearest: a DELIVERY-only mover on a
    // motorbike. Next: a courier on a bicycle. Farthest (still inside the
    // first ring): a courier on a motorbike.
    const lindenPickup = { lat: 6.00741, lng: -58.30589 };
    const lindenDrop = { lat: 6.01552, lng: -58.29761 };
    const deliveryOnly = await makeMover('Dele', 'DELIVERY', 'MOTORCYCLE', { lat: 6.00744, lng: -58.30586 });
    const bicycle = await makeMover('Bina', 'COURIER', 'BICYCLE', { lat: 6.00751, lng: -58.30578 });
    const eligible = await makeMover('Tariq', 'COURIER', 'MOTORCYCLE', { lat: 6.01633, lng: -58.30012 });

    const created = await call('POST', '/api/v1/courier/order', sender.token, {
      ...ORDER_BODY,
      pickup: lindenPickup,
      dropoff: lindenDrop,
      pickupAddress: '3 Republic Avenue, Linden',
      dropoffAddress: '12 Mackenzie Road, Linden',
      packageSize: 'LARGE',
    });
    expect(created.statusCode, created.body).toBe(201);
    const orderId = created.json().data.orderId as string;

    // The one dispatch pass skipped both nearer movers and offered the eligible one.
    expect((await app.redis.get(offerKey(orderId)))!.split(':')[0]).toBe(eligible.riderId);
    expect(await sys(() => app.prisma.alertDelivery.findMany({ where: { kind: 'MOVER_OFFER', subjectId: orderId }, select: { recipientId: true } })))
      .toEqual([{ recipientId: eligible.userId }]);
    for (const wrong of [deliveryOnly, bicycle]) {
      expect((await call('GET', '/api/v1/rider/offers/current', wrong.token)).json().data.offer).toBeNull();
      const steal = await call('POST', '/api/v1/rider/offers/accept', wrong.token, { orderId });
      expect(steal.statusCode).toBe(409);
      expect(steal.json().error.code).toBe('OFFER_EXPIRED');
    }

    // The board-grab entrance holds the same line.
    const wrongService = await call('POST', `/api/v1/rider/orders/${orderId}/accept`, deliveryOnly.token, {});
    expect(wrongService.statusCode).toBe(400);
    expect(wrongService.json().error.code).toBe('WRONG_SERVICE_TYPE');
    const wrongVehicle = await call('POST', `/api/v1/rider/orders/${orderId}/accept`, bicycle.token, {});
    expect(wrongVehicle.statusCode).toBe(400);
    expect(wrongVehicle.json().error.code).toBe('VEHICLE_TOO_SMALL');
    const open = await orderRow(orderId);
    expect({ status: open.status, rider: open.riderId }).toEqual({ status: 'READY_FOR_PICKUP', rider: null });
    expect((await app.redis.get(offerKey(orderId)))!.split(':')[0]).toBe(eligible.riderId);

    const accept = await call('POST', '/api/v1/rider/offers/accept', eligible.token, { orderId });
    expect(accept.statusCode, accept.body).toBe(200);
    expect(accept.json().data.status).toBe('RIDER_ASSIGNED');

    const [order, refused, assigned] = await Promise.all([
      orderRow(orderId),
      sys(() => app.prisma.rider.findMany({
        where: { id: { in: [deliveryOnly.riderId, bicycle.riderId] } },
        select: { id: true, currentOrderId: true, isOnline: true, isAvailable: true },
        orderBy: { id: 'asc' },
      })),
      logCount(orderId, 'RIDER_ASSIGNED'),
    ]);
    expect({ status: order.status, rider: order.riderId }).toEqual({ status: 'RIDER_ASSIGNED', rider: eligible.riderId });
    expect(refused).toEqual([deliveryOnly.riderId, bicycle.riderId].sort().map((id) => ({ id, currentOrderId: null, isOnline: true, isAvailable: true })));
    expect(assigned).toBe(1);
  });
});
