import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import courierRoutes from '../modules/courier/courier.routes';
import { OrderService, reconcileMissingEarnings } from '../modules/order/order.service';
import { COURIER_CASH_OUTCOME_ENFORCED_AT } from '../modules/cash/cash-rules.service';

// ---------------------------------------------------------------------------
// [M-28 · S0] A proof photo never implies money.
//
// Before: the courier's payer selection (sender or recipient) was stored and
// read by nothing, and the delivery proof transitioned DELIVERED and minted
// the rider's fee whether anyone had paid. Now the payer and the collection
// moment govern an explicit cash outcome: the sender's fee is collected at
// pickup (or refused — the job ends, the sender takes a strike); the
// recipient's fee is recorded WITH the proof (paid captures and completes;
// refused or nobody there fails the job with the photo as the claim's
// evidence, a strike, and the rider's claim); the terminal authority, the
// earnings writer and the reconciler all refuse an unpaid cash courier job.
// ---------------------------------------------------------------------------

const CENTRAL = { lat: 6.81, lng: -58.155 };
const SOUTH = { lat: 6.755, lng: -58.155 };
const DAY = 86_400_000;
let app: FastifyInstance;
let orders: OrderService;
const createdUserIds: string[] = [];
let seq = 0;

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200178${String(seq).padStart(2, '0')}`, firstName: 'Courier', lastName: `Cash${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2', countryCode: 'GY',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'm28', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}
async function makeRider() {
  const u = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({ data: { userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
  return { ...u, riderId: rider.id };
}
const ORDER_BODY = { pickup: CENTRAL, dropoff: SOUTH, pickupAddress: '12 Sender Street', dropoffAddress: '34 Recipient Avenue', packageSize: 'MEDIUM' as const, speed: 'STANDARD' as const, recipientName: 'Aunty Pat', recipientPhone: '+5926001234' };
function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
}
let doorSeq = 0;
/** A courier job in the rider's custody with the proof photo issued. */
async function jobInCustody(payer: 'SENDER' | 'RECIPIENT', status: 'RIDER_ASSIGNED' | 'PICKED_UP' = 'PICKED_UP') {
  const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
  const created = (await inject('POST', '/api/v1/courier/order', { ...ORDER_BODY, payer }, sender.token)).json().data;
  const rider = await makeRider();
  doorSeq += 1;
  const issued = `storage://t/courier-proof/${created.orderId}/proof.jpg`;
  await app.prisma.order.update({
    where: { id: created.orderId },
    data: { riderId: rider.riderId, status, courierProofIssuedUrl: issued, courierProofIssuedRiderId: rider.riderId, deliveryLat: SOUTH.lat + doorSeq * 0.01, deliveryLng: SOUTH.lng - doorSeq * 0.01 },
  });
  await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: created.orderId, isAvailable: false } }).catch(() => {});
  const order = await app.prisma.order.findUniqueOrThrow({ where: { id: created.orderId } });
  return { orderId: created.orderId as string, sender, rider, issued, drop: { lat: order.deliveryLat, lng: order.deliveryLng } };
}
async function facts(orderId: string, customerId: string) {
  const o = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  return {
    status: o.status, payment: o.paymentStatus, proof: o.courierProofPhotoUrl,
    strikes: await app.prisma.strike.count({ where: { orderId, userId: customerId } }),
    claims: await app.prisma.reimbursementClaim.count({ where: { orderId } }),
    fees: await app.prisma.earning.count({ where: { orderId, type: 'COURIER_FEE' } }),
  };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
  orders = new OrderService(app.prisma, app.io);
});

afterAll(async () => {
  const riders = await app.prisma.rider.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } });
  const rows = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: createdUserIds } }, { riderId: { in: riders.map((r) => r.id) } }] }, select: { id: true } });
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

describe('[M-28] the sender pays — at pickup', () => {
  it('the register’s red test: an unpaid sender-pays job does not terminalize on proof; collecting the fee captures it, then the proof closes the job and earns once', async () => {
    const job = await jobInCustody('SENDER');
    const refused = await inject('POST', `/api/v1/courier/order/${job.orderId}/proof`, { proofPhotoUrl: job.issued }, job.rider.token);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('PAYMENT_NOT_CAPTURED');
    expect(await facts(job.orderId, job.sender.userId)).toMatchObject({ status: 'PICKED_UP', payment: 'PENDING', fees: 0 });
    const collected = await inject('POST', `/api/v1/courier/order/${job.orderId}/collect`, { outcome: 'paid', gps: CENTRAL }, job.rider.token);
    expect(collected.statusCode).toBe(200);
    expect(collected.json().data).toMatchObject({ status: 'PICKED_UP', paymentStatus: 'CAPTURED', collected: true });
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: job.orderId, note: { startsWith: 'cash collected from sender' } } })).toBe(1);
    expect((await inject('POST', `/api/v1/courier/order/${job.orderId}/collect`, { outcome: 'paid', gps: CENTRAL }, job.rider.token)).json().data.collected).toBe(true); // a repeated tap answers the fact
    const proof = await inject('POST', `/api/v1/courier/order/${job.orderId}/proof`, { proofPhotoUrl: job.issued }, job.rider.token);
    expect(proof.statusCode).toBe(200);
    expect(await facts(job.orderId, job.sender.userId)).toMatchObject({ status: 'DELIVERED', payment: 'CAPTURED', proof: job.issued, fees: 1, strikes: 0, claims: 0 });
  });

  it('the sender refuses at pickup: the job ends before custody, the sender takes a strike, no claim is minted, nothing is earned', async () => {
    const job = await jobInCustody('SENDER', 'RIDER_ASSIGNED');
    const res = await inject('POST', `/api/v1/courier/order/${job.orderId}/collect`, { outcome: 'refused', gps: CENTRAL }, job.rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'CANCELLED', paymentStatus: 'FAILED', collected: false });
    expect(await facts(job.orderId, job.sender.userId)).toMatchObject({ status: 'CANCELLED', payment: 'FAILED', strikes: 1, claims: 0, fees: 0 });
    expect((await app.prisma.strike.findFirstOrThrow({ where: { orderId: job.orderId } })).reason).toBe('failed_payment_refused');
    expect(await app.prisma.notification.count({ where: { userId: job.sender.userId, title: 'Courier job ended — fee not paid' } })).toBe(1);
  });
});

describe('[M-28] the recipient pays — with the proof', () => {
  it('the register’s red test: an unpaid recipient-pays job does not terminalize on a bare proof; the outcome travels with the proof and one commit captures, closes and earns', async () => {
    const job = await jobInCustody('RECIPIENT');
    const bare = await inject('POST', `/api/v1/courier/order/${job.orderId}/proof`, { proofPhotoUrl: job.issued }, job.rider.token);
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe('OUTCOME_REQUIRED');
    expect(await facts(job.orderId, job.sender.userId)).toMatchObject({ status: 'PICKED_UP', payment: 'PENDING', fees: 0 });
    const paid = await inject('POST', `/api/v1/courier/order/${job.orderId}/proof`, { proofPhotoUrl: job.issued, outcome: 'paid', gps: job.drop }, job.rider.token);
    expect(paid.statusCode).toBe(200);
    expect(paid.json().data).toMatchObject({ status: 'DELIVERED', claim: null });
    expect(await facts(job.orderId, job.sender.userId)).toMatchObject({ status: 'DELIVERED', payment: 'CAPTURED', proof: job.issued, fees: 1, strikes: 0, claims: 0 });
    expect(await app.prisma.notification.count({ where: { userId: job.sender.userId, title: 'Parcel delivered' } })).toBe(1);
    // A second proof on a closed job is refused, and nothing is paid twice.
    expect((await inject('POST', `/api/v1/courier/order/${job.orderId}/proof`, { proofPhotoUrl: job.issued, outcome: 'paid', gps: job.drop }, job.rider.token)).statusCode).toBe(400);
    expect((await facts(job.orderId, job.sender.userId)).fees).toBe(1);
  });

  it('refused at the drop-off: one coherent claim path — FAILED, payment FAILED, a strike, the rider’s claim with the proof photo as evidence, nothing earned', async () => {
    const job = await jobInCustody('RECIPIENT');
    const refused = await inject('POST', `/api/v1/courier/order/${job.orderId}/proof`, { proofPhotoUrl: job.issued, outcome: 'refused', gps: job.drop }, job.rider.token);
    expect(refused.statusCode).toBe(200);
    expect(refused.json().data.status).toBe('FAILED');
    expect(refused.json().data.claim).toMatchObject({ status: 'AUTO_APPROVED' });
    expect(await facts(job.orderId, job.sender.userId)).toMatchObject({ status: 'FAILED', payment: 'FAILED', strikes: 1, claims: 1, fees: 0 });
    const claim = await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { orderId: job.orderId } });
    expect({ riderId: claim.riderId, reason: claim.reason, photo: claim.photoUrl }).toEqual({ riderId: job.rider.riderId, reason: 'refused', photo: job.issued });
    expect(await app.prisma.notification.count({ where: { userId: job.sender.userId, title: 'Unpaid courier fee recorded' } })).toBe(1);
  });

  it('nobody there (no_show) has the same shape with its own reason', async () => {
    const job = await jobInCustody('RECIPIENT');
    const gone = await inject('POST', `/api/v1/courier/order/${job.orderId}/proof`, { proofPhotoUrl: job.issued, outcome: 'no_show', gps: job.drop }, job.rider.token);
    expect(gone.statusCode).toBe(200);
    expect(await facts(job.orderId, job.sender.userId)).toMatchObject({ status: 'FAILED', strikes: 1, claims: 1, fees: 0 });
    expect((await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { orderId: job.orderId } })).reason).toBe('no_show');
  });
});

describe('[M-28] the authority and the reconciler', () => {
  it('DELIVERED without a collected fee is refused by the terminal authority itself, from any caller', async () => {
    const job = await jobInCustody('SENDER');
    await expect(orders.transitionOrderAtomically({ orderId: job.orderId, target: 'DELIVERED', allowedFrom: ['PICKED_UP'], changedBy: job.rider.userId, note: 'a caller that skipped the cash step' })).rejects.toMatchObject({ code: 'PAYMENT_NOT_CAPTURED' });
    expect(await facts(job.orderId, job.sender.userId)).toMatchObject({ status: 'PICKED_UP', payment: 'PENDING', fees: 0 });
  });

  it('the reconciler never mints a fee for a cash courier job delivered without one, and reports the review set', async () => {
    const legacy = await jobInCustody('SENDER');
    await app.prisma.order.update({ where: { id: legacy.orderId }, data: { status: 'DELIVERED', deliveredAt: new Date(Date.now() - 3_600_000) } });
    const bypass = await jobInCustody('RECIPIENT');
    await app.prisma.order.update({ where: { id: bypass.orderId }, data: { status: 'DELIVERED', deliveredAt: new Date(COURIER_CASH_OUTCOME_ENFORCED_AT.getTime() + 3_600_000) } });
    const result = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
    expect(result.healed).not.toContain(legacy.orderId);
    expect(await app.prisma.earning.count({ where: { orderId: { in: [legacy.orderId, bypass.orderId] } } })).toBe(0);
    expect(result.courierUnpaidDelivered.total).toBeGreaterThanOrEqual(2);
    expect(result.courierUnpaidDelivered.sinceEnforced).toBeGreaterThanOrEqual(1);
    expect(await orders.createEarnings(legacy.orderId, app.prisma, false)).toEqual([]);
  });
});
