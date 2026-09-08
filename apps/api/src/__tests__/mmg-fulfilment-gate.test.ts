import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { handoverAuthorityFor, handoverVersionFor } from '../modules/order/handover-authority';
import { handoverBlockCounter } from '../plugins/observability';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, PaymentStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { OrderService, reconcileMissingEarnings } from '../modules/order/order.service';
import { registerErrorHandler } from '../middleware/error-handler';
import { loginWithOtp } from './helpers/otp';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// [W-25] A store's attestation now carries the provider reference from its own
// wallet message — a bare tap is refused (REFERENCE_REQUIRED), and one reference
// cannot mark two orders paid. The refusal cases are graded in
// mmg-vendor-attestation.test.ts; these suites keep grading the lifecycle.
const mmgRef = () => `MMGT${Math.random().toString(36).slice(2, 12).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;


// ---------------------------------------------------------------------------
// [SPS-F-0016 / LB-015] The MMG payment-first law. An MMG marketplace order is
// paid customer→store OUTSIDE Swift, and only the store can attest the money
// landed (POST /orders/:id/confirm-payment → paymentStatus CAPTURED). Until
// then the order must not move through fulfilment — not accepted, prepared,
// readied, claimed, delivered, self-delivered, or pickup-completed. The store's
// payment confirmation itself must stay possible while PENDING (it is the
// capture), and the negative paths (cancel/refund) stay open. One domain error:
// MMG_PAYMENT_PENDING.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let orders: OrderService;
let adminToken: string;
const userIds: string[] = [];

let seq = 0;
// Randomized per run (like post-delivery-tip.test.ts): a crashed cleanup must
// never brick the next run on the unique phone constraint.
const phoneBase = 592_760_000_000 + Math.floor(Math.random() * 100_000_000);
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Gate', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'gate-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeVendor(ownerUserId: string, name = 'Gate Diner') {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name, slug: `${name.toLowerCase().replace(/ /g, '-')}-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: '+5920076100', addressLine1: '7 Gate Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  return vendor.id;
}

async function makeRider(userId: string) {
  const rider = await app.prisma.rider.create({
    data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' },
  });
  return rider.id;
}

let vendorOwner: { userId: string; token: string };
let vendorId: string;
let rider: { userId: string; token: string };
let riderId: string;
let customer: { userId: string; token: string };

async function makeMmgOrder(status: OrderStatus, opts: { paymentStatus?: PaymentStatus; fee?: number; tip?: number; withRider?: boolean } = {}) {
  const fee = opts.fee ?? 300;
  const tip = opts.tip ?? 200;
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `GATE-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId: customer.userId, vendorId, status,
      ...(opts.withRider === false ? {} : { riderId }),
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: fee, tipAmount: tip, totalAmount: 1000 + fee + tip,
      paymentMethod: 'MOBILE_MONEY', paymentStatus: opts.paymentStatus ?? 'PENDING',
    },
  });
  return order;
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown, vendor?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
      ...(vendor ? { 'x-vendor-id': vendor } : {}),
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  orders = new OrderService(app.prisma, app.io);
  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken;

  vendorOwner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  vendorId = await makeVendor(vendorOwner.userId);
  rider = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  riderId = await makeRider(rider.userId);
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  await app.prisma.deliveryCashSettlement.deleteMany({ where: { rider: { userId: { in: userIds } } } });
  await app.prisma.earning.deleteMany({ where: { rider: { userId: { in: userIds } } } });
  await app.prisma.strike.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  // order_status_logs is append-only (prisma guard) — order deletion cascades it.
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('the gate — no fulfilment while MMG payment is PENDING', () => {
  it('vendor cannot ACCEPT an unpaid MMG order (409 MMG_PAYMENT_PENDING)', async () => {
    const order = await makeMmgOrder('PENDING', { withRider: false });
    const res = await inject('PUT', `/api/v1/vendor/orders/${order.id}/accept`, vendorOwner.token, {}, vendorId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('MMG_PAYMENT_PENDING');
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('PENDING');
  });

  it('the store CAN confirm payment while PENDING, and acceptance then works', async () => {
    const order = await makeMmgOrder('PENDING', { withRider: false });
    const confirm = await inject('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);
    expect(confirm.statusCode).toBe(200);
    const paid = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paid.paymentStatus).toBe('CLAIMED'); // [DOC-1 §31.5 · DOC-INV-48] the store's word is a claim, never a capture

    const accept = await inject('PUT', `/api/v1/vendor/orders/${order.id}/accept`, vendorOwner.token, {}, vendorId);
    expect(accept.statusCode).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ACCEPTED');
  });

  it('every canonical fulfilment transition refuses while unpaid', async () => {
    const cases: Array<{ from: OrderStatus; to: OrderStatus }> = [
      { from: 'PENDING', to: 'ACCEPTED' },
      { from: 'ACCEPTED', to: 'PREPARING' },
      { from: 'PREPARING', to: 'READY_FOR_PICKUP' },
      { from: 'ACCEPTED', to: 'RIDER_ASSIGNED' },
      { from: 'RIDER_ASSIGNED', to: 'RIDER_EN_ROUTE_PICKUP' },
      { from: 'RIDER_EN_ROUTE_PICKUP', to: 'RIDER_ARRIVED_PICKUP' },
      { from: 'READY_FOR_PICKUP', to: 'PICKED_UP' },
      { from: 'PICKED_UP', to: 'EN_ROUTE_DELIVERY' },
      { from: 'EN_ROUTE_DELIVERY', to: 'ARRIVED' },
      { from: 'PICKED_UP', to: 'DELIVERED' },
      { from: 'READY_FOR_PICKUP', to: 'COMPLETED' }, // customer pickup close-out
    ];
    for (const { from, to } of cases) {
      const order = await makeMmgOrder(from);
      await expect(orders.updateStatus(order.id, to, 'test-system')).rejects.toMatchObject({ code: 'MMG_PAYMENT_PENDING' });
      const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(fresh.status).toBe(from);
    }
  });

  it('rider /delivered refuses an unpaid MMG order; after capture it completes and the settlement owes fee + tip', async () => {
    const order = await makeMmgOrder('ARRIVED', { fee: 300, tip: 200 });
    const blocked = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error?.code ?? blocked.json().code).toBe('MMG_PAYMENT_PENDING');

    await app.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'CAPTURED' } });
    const done = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, {});
    expect(done.statusCode).toBe(200);

    // D2 — the vendor-to-rider debt is the rider's COMPLETE earned amount.
    const settlement = await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId: order.id } });
    expect(settlement).not.toBeNull();
    expect(Number(settlement!.amount)).toBe(500); // 300 fee + 200 tip
  });

  it('a legacy in-flight row cannot be claimed by a rider while unpaid (defense in depth)', async () => {
    // Simulates a pre-gate row: already ACCEPTED, payment still PENDING.
    const order = await makeMmgOrder('ACCEPTED', { withRider: false });
    await expect(
      app.prisma.$transaction((tx) => orders.stageDirectRiderAssignment(tx, {
        orderId: order.id, riderId, changedBy: rider.userId, moverUserId: rider.userId,
      })),
    ).rejects.toMatchObject({ code: 'MMG_PAYMENT_PENDING' });
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.riderId).toBeNull();
  });

  it('the negative path stays open — an UNATTESTED MMG order can still be cancelled', async () => {
    // "PENDING" is absence of the store's attestation, NOT proof the customer
    // never paid — cancellation stays possible (the only exit from an unpaid
    // order), and the honesty for the may-have-paid case is proven below.
    const order = await makeMmgOrder('PENDING', { withRider: false });
    const updated = await orders.updateStatus(order.id, 'CANCELLED', 'test-system', 'customer changed their mind');
    expect(updated.status).toBe('CANCELLED');
  });

  it('a HELD unattested-MMG cancellation still warns the store — the pay link was already live [REPORT-008 F-02]', async () => {
    // LIFECYCLE_V2 checkout births the order HELD (hidden from the vendor
    // board) yet hands the customer the live pay URL immediately — money can
    // be in flight during the exact window the old !heldNow guard used to
    // suppress the liability notice.
    const order = await makeMmgOrder('PENDING', { withRider: false });
    await app.prisma.order.update({
      where: { id: order.id },
      data: { holdExpiresAt: new Date(Date.now() + 2 * 60_000) }, // held NOW
    });
    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, { reason: 'changed my mind' });
    expect(res.statusCode).toBe(200);
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('CANCELLED');
    expect(fresh.paymentStatus).toBe('PENDING');
    const log = await app.prisma.orderStatusLog.findFirstOrThrow({
      where: { orderId: order.id, status: 'CANCELLED' }, orderBy: { createdAt: 'desc' },
    });
    expect(log.note).toContain('UNATTESTED');
    const notices = await app.prisma.notification.count({
      where: { userId: vendorOwner.userId, title: 'Cancelled order may hold an MMG payment', body: { contains: order.orderNumber } },
    });
    expect(notices).toBe(1); // exactly one — held no longer suppresses it
  });

  it('cancelling unattested MMG says the truth and tells the STORE a refund may be owed [REPORT-007-v4 F-02]', async () => {
    const order = await makeMmgOrder('ACCEPTED', { withRider: false }); // payment PENDING
    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, { reason: 'changed my mind' });
    expect(res.statusCode).toBe(200);
    // Customer copy never asserts "no charge" on MMG — the platform cannot know.
    expect(res.json().data.message).toContain('the store refunds you directly');
    expect(res.json().data.message).not.toContain('no charge');
    // Immutable evidence records the ambiguity in the SAME commit…
    const log = await app.prisma.orderStatusLog.findFirstOrThrow({
      where: { orderId: order.id, status: 'CANCELLED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log.note).toContain('UNATTESTED');
    // …and the party holding the money is told a refund may be owed.
    const notice = await app.prisma.notification.findFirst({
      where: { userId: vendorOwner.userId, title: 'Cancelled order may hold an MMG payment' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notice).not.toBeNull();
    expect(notice!.body).toContain(order.orderNumber);
  });
});

describe('capture evidence and idempotency', () => {
  it('confirm-payment records its audit row atomically and double-taps stay single-logged', async () => {
    const order = await makeMmgOrder('PENDING', { withRider: false });
    const first = await inject('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);
    expect(first.statusCode).toBe(200);
    const second = await inject('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);
    expect(second.statusCode).toBe(200);

    // [W-25] the note now names the attestation and its reference, so match the
    // durable half rather than the prose: exactly ONE capture log either way
    const logs = await app.prisma.orderStatusLog.findMany({ where: { orderId: order.id, note: { contains: 'MMG payment' } } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.note).toMatch(/ref [A-Z0-9._-]+/);
  });

  it('zero-fee, positive-tip MMG delivery still creates the settlement for the tip', async () => {
    const order = await makeMmgOrder('DELIVERED', { paymentStatus: 'CAPTURED', fee: 0, tip: 400 });
    await orders.createEarnings(order.id);
    const settlement = await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId: order.id } });
    expect(settlement).not.toBeNull();
    expect(Number(settlement!.amount)).toBe(400);
  });

  it('a legacy delivered-but-unconfirmed MMG order is never receipted as paid', async () => {
    const { renderReceiptHtml } = await import('../modules/order/receipt');
    const base = {
      orderNumber: 'GATE-RCPT', placedAt: new Date(), status: 'DELIVERED', orderType: 'FOOD_DELIVERY',
      fulfillment: 'DELIVERY', paymentMethod: 'MOBILE_MONEY',
      subtotalCustomer: 1000, deliveryFee: 300, tipAmount: 200, discount: 0, totalAmount: 1500,
      deliveryAddress: 'x', vendor: { name: 'Gate Diner', addressLine1: '7 Gate Street', city: 'Georgetown', phone: '+5920076100' },
      customer: { firstName: 'Gate', lastName: 'Customer' },
      items: [{ name: 'Sweet & Sour Chicken', quantity: 1, totalCustomer: 1000 }],
    };
    const pending = renderReceiptHtml({ ...base, paymentStatus: 'PENDING' });
    expect(pending).toContain('confirmation pending');
    expect(pending).not.toContain('Paid by MMG');
    const captured = renderReceiptHtml({ ...base, paymentStatus: 'CAPTURED' });
    expect(captured).toContain('Paid by MMG — directly to the store');
    // [REPORT-004 F-004-07] No affirmative money-moved claims anywhere on the
    // receipt: even a CAPTURED MMG total proves only store receipt — the
    // store-to-rider settlement may still be OWED.
    for (const html of [pending, captured]) {
      expect(html.toLowerCase()).not.toContain('paid to your rider');
      expect(html.toLowerCase()).not.toContain('every dollar above went');
      expect(html).toContain('Delivery pay for your rider');
    }
  });
});

describe('the cash-handover door is CASH-only [REPORT-004 F-004-02]', () => {
  const gps = { lat: 6.8, lng: -58.15 };

  it('a rider cannot self-attest an unpaid MMG order at the door', async () => {
    const order = await makeMmgOrder('ARRIVED');
    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'paid', gps });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('MMG_PAYMENT_PENDING');
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.paymentStatus).toBe('PENDING');
    expect(fresh.status).toBe('ARRIVED');
  });

  it('even a captured MMG order cannot use the cash door — wrong endpoint', async () => {
    const order = await makeMmgOrder('ARRIVED', { paymentStatus: 'CAPTURED' });
    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'paid', gps });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('CASH_HANDOVER_ONLY');
  });

  it('a failed-handover outcome on MMG strikes nobody and claims nothing', async () => {
    const order = await makeMmgOrder('ARRIVED');
    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'no_show', gps });
    expect(res.statusCode).toBe(409);
    expect(await app.prisma.strike.findMany({ where: { orderId: order.id } })).toHaveLength(0);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ARRIVED');
  });
});

describe('earnings are downstream of confirmed money [REPORT-004 F-004-03]', () => {
  it('createEarnings refuses a delivered-but-unpaid MMG order — no debt, no earnings', async () => {
    const order = await makeMmgOrder('DELIVERED');
    await expect(orders.createEarnings(order.id)).rejects.toMatchObject({ code: 'MMG_PAYMENT_PENDING' });
    expect(await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId: order.id } })).toBeNull();
    expect(await app.prisma.earning.findMany({ where: { orderId: order.id } })).toHaveLength(0);
  });

  it('the scheduled reconciler never sweeps unconfirmed MMG money', async () => {
    const order = await makeMmgOrder('DELIVERED');
    await app.prisma.order.update({ where: { id: order.id }, data: { deliveredAt: new Date(Date.now() - 60 * 60_000) } });
    const result = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 1, cap: 500 });
    expect(result.healed).not.toContain(order.id);
    expect(await app.prisma.earning.findMany({ where: { orderId: order.id } })).toHaveLength(0);
    expect(await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId: order.id } })).toBeNull();
  });
});

describe('exemptions and negative paths stay exactly as wide as designed', () => {
  it('TAXI settles at the kerb — the MMG gate never touches rides', async () => {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `GATE-TAXI-${nanoid(8)}`, orderType: 'TAXI', customerId: customer.userId,
        status: 'RIDE_IN_PROGRESS', deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 0,
        taxiFareTotal: 2400, totalAmount: 2400, paymentMethod: 'MOBILE_MONEY',
      },
    });
    const updated = await orders.updateStatus(order.id, 'DELIVERED', 'test-system');
    expect(updated.status).toBe('DELIVERED');
  });

  it('REFUNDED stays open for a legacy unpaid MMG row (accounting path)', async () => {
    const order = await makeMmgOrder('DELIVERED');
    const updated = await orders.updateStatus(order.id, 'REFUNDED', 'test-system', 'legacy cleanup');
    expect(updated.status).toBe('REFUNDED');
  });
});

describe('paid money is never silently rewritten [REPORT-004 F-004-04]', () => {
  it('convert-to-pickup fails closed on a captured MMG order', async () => {
    process.env['DISPATCH_EXHAUSTION'] = '1';
    const order = await makeMmgOrder('ACCEPTED', { paymentStatus: 'CAPTURED', withRider: false });
    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/convert-to-pickup`, customer.token, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('MMG_REFUND_UNAVAILABLE');
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(fresh.totalAmount)).toBe(1500); // untouched: 1000 + 300 fee + 200 tip
    expect(fresh.fulfillment).toBe('DELIVERY');
  });

  it('NO MMG order converts — PENDING is not proof external funds haven’t moved [F-005-03]', async () => {
    process.env['DISPATCH_EXHAUSTION'] = '1';
    const order = await makeMmgOrder('ACCEPTED', { withRider: false });
    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/convert-to-pickup`, customer.token, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('MMG_REFUND_UNAVAILABLE');
  });
});

describe('captured money cannot be repriced [REPORT-005 F-005-01]', () => {
  // The board-grab route requires a live GO session before it reads the order.
  async function riderOnline() {
    // Capacity is now a COUNT of live orders, not a pointer (stacking,
    // 2026-08-29). Earlier tests here "freed" the rider old-style by nulling
    // the pointer while leaving their orders live — phantoms that now make the
    // rider look at-capacity. Terminalize them so "online and free" is true.
    await app.prisma.order.updateMany({
      where: { riderId, status: { notIn: ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'] } },
      data: { status: 'CANCELLED', riderId: null },
    });
    const session = await app.prisma.session.findFirst({ where: { userId: rider.userId } });
    await app.prisma.rider.update({
      where: { id: riderId },
      data: {
        isOnline: true, isAvailable: true, currentOrderId: null,
        locationSessionId: session!.id, currentLat: 6.8, currentLng: -58.15, lastLocationUpdate: new Date(),
      },
    });
  }

  it('a board grab with a lower fare refuses on captured MMG — assignment and price untouched', async () => {
    await riderOnline();
    const order = await makeMmgOrder('READY_FOR_PICKUP', { paymentStatus: 'CAPTURED', withRider: false });
    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/accept`, rider.token, { fare: 100 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('MMG_PRICE_LOCKED');
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.riderId).toBeNull();
    expect(Number(fresh.deliveryFee)).toBe(300);
    expect(Number(fresh.totalAmount)).toBe(1500);
  });

  it('the persistence seam itself refuses a repricing attempt on MMG (defense in depth)', async () => {
    const order = await makeMmgOrder('ACCEPTED', { paymentStatus: 'CAPTURED', withRider: false });
    await expect(
      app.prisma.$transaction((tx) => orders.stageDirectRiderAssignment(tx, {
        orderId: order.id, riderId, changedBy: rider.userId, moverUserId: rider.userId, requestedFee: 100,
      })),
    ).rejects.toMatchObject({ code: 'MMG_PRICE_LOCKED' });
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.riderId).toBeNull();
    expect(Number(fresh.deliveryFee)).toBe(300);
  });

  it('a market-fee board grab (no undercut) still assigns a captured MMG order', async () => {
    await riderOnline();
    const order = await makeMmgOrder('READY_FOR_PICKUP', { paymentStatus: 'CAPTURED', withRider: false });
    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/accept`, rider.token, {});
    expect(res.statusCode).toBe(200);
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('RIDER_ASSIGNED');
    expect(Number(fresh.totalAmount)).toBe(1500);
    // Free the rider for later tests (one-live-job pointer).
    await app.prisma.rider.update({ where: { id: riderId }, data: { isAvailable: true, currentOrderId: null } });
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', riderId: null } });
  });
});

describe('capture responses never leak verifier secrets [REPORT-005 F-005-04]', () => {
  it('winner and double-tap loser responses omit pickup code and ride PIN', async () => {
    const order = await makeMmgOrder('PENDING', { withRider: false });
    await app.prisma.order.update({ where: { id: order.id }, data: { pickupCode: '123456', ridePin: '9876' } });
    const winner = await inject('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);
    expect(winner.statusCode).toBe(200);
    const wBody = JSON.stringify(winner.json());
    expect(wBody).not.toContain('123456');
    expect(wBody).not.toContain('9876');
    expect(winner.json().data.paymentStatus).toBe('CLAIMED');

    const loser = await inject('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);
    expect(loser.statusCode).toBe(200);
    const lBody = JSON.stringify(loser.json());
    expect(lBody).not.toContain('123456');
    expect(lBody).not.toContain('9876');
  });

  it('a capture cannot attach to a cancelled order [F-005-03 tail]', async () => {
    const order = await makeMmgOrder('PENDING', { withRider: false });
    await orders.updateStatus(order.id, 'CANCELLED', 'test-system', 'changed mind');
    const res = await inject('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('ORDER_CLOSED');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe('PENDING');
  });
});

describe('capture and cancellation are serialized — CANCELLED+CAPTURED is unmintable [REPORT-006 F-006-01]', () => {
  it('capture-first: a customer cannot cancel a captured MMG order (409 MMG_CANCEL_UNAVAILABLE)', async () => {
    const order = await makeMmgOrder('ACCEPTED', { paymentStatus: 'CAPTURED', withRider: false });
    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, { reason: 'changed my mind' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('MMG_CANCEL_UNAVAILABLE');
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('ACCEPTED');
    expect(fresh.paymentStatus).toBe('CAPTURED');
  });

  it('capture-first: the vendor cannot reject a captured MMG order either (canonical seam gate)', async () => {
    const order = await makeMmgOrder('ACCEPTED', { paymentStatus: 'CAPTURED', withRider: false });
    const res = await inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, vendorOwner.token, { reason: 'out of stock' }, vendorId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('MMG_CANCEL_UNAVAILABLE');
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('ACCEPTED');
    expect(fresh.paymentStatus).toBe('CAPTURED');
  });

  it('a legacy CAPTURED row on a closed order answers the refusal, never the idempotent success', async () => {
    // Pre-gate history could hold CAPTURED+CANCELLED; the fast path must not
    // return 200 for it (the old order of checks did) [F-006-01 contradiction].
    const order = await makeMmgOrder('PENDING', { paymentStatus: 'CAPTURED', withRider: false });
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    const res = await inject('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('ORDER_CLOSED');
  });

  it('the vendor-no-response auto-cancel treats a captured MMG order as answered — clean no-op', async () => {
    const order = await makeMmgOrder('PENDING', { paymentStatus: 'CAPTURED', withRider: false });
    await app.prisma.order.update({ where: { id: order.id }, data: { holdExpiresAt: new Date(Date.now() - 60_000) } });
    const { autoCancelUnresponsiveOrder } = await import('../jobs/queue');
    const cancelled = await autoCancelUnresponsiveOrder(
      { prisma: app.prisma, io: app.io, redis: app.redis, log: app.log } as never,
      order.id,
    );
    expect(cancelled).toBe(false);
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('PENDING'); // untouched, not CANCELLED
    expect(fresh.paymentStatus).toBe('CAPTURED');
  });

  it('the admin refund override fails closed on MMG — no REFUNDED terminal without store evidence [REPORT-008 F-03]', async () => {
    const order = await makeMmgOrder('ACCEPTED', { withRider: false }); // payment PENDING
    const refused = await app.inject({
      method: 'PUT', url: `/api/v1/admin/orders/${order.id}/cancel`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { reason: 'ops', refund: true },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error?.code ?? refused.json().code).toBe('MMG_REFUND_UNAVAILABLE');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ACCEPTED');

    // Plain cancellation stays open — and the canonical seam stamps the
    // ambiguity marker centrally, so admin cancels carry the same immutable
    // evidence the customer path writes.
    const cancelled = await app.inject({
      method: 'PUT', url: `/api/v1/admin/orders/${order.id}/cancel`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { reason: 'ops cancel' },
    });
    expect(cancelled.statusCode).toBe(200);
    const log = await app.prisma.orderStatusLog.findFirstOrThrow({
      where: { orderId: order.id, status: 'CANCELLED' }, orderBy: { createdAt: 'desc' },
    });
    expect(log.note).toContain('UNATTESTED');
  });

  it('concurrent CLAIM vs cancel (stress): whatever interleaving wins, CANCELLED + (CLAIMED|CAPTURED) never exists', async () => {
    // [F-106-05] SUPPLEMENTAL STRESS, not the correctness proof. Uncontrolled
    // Promise.all rounds cannot prove both lock orders occurred; the two
    // FORCED-ORDER tests below are the proof, and this samples the real race
    // on top of them.
    for (let round = 0; round < 3; round += 1) {
      const order = await makeMmgOrder('ACCEPTED', { withRider: false }); // payment PENDING
      const [confirm, cancel] = await Promise.all([
        inject('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId),
        inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, { reason: 'raced' }),
      ]);
      const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      // [DOC-1 §31.5 · F-103-01b] MONEY LANDED IS TWO STATES, NOT ONE.
      //
      // `confirm-payment` records the store's word as CLAIMED, not CAPTURED
      // (vendor.routes.ts:1801). This test still asked only about CAPTURED, so:
      //
      //   * the invariant could not see the state that actually occurs — a
      //     CANCELLED + CLAIMED order would have passed it silently; and
      //   * whenever the capture WON the race the assertions took the
      //     cancel-won branch and the test failed. Measured at ~40% of runs on
      //     origin/main; it is not a flake, it is a stale predicate that only
      //     looks like one because the race decides which branch it takes.
      const moneyLanded = fresh.paymentStatus === 'CAPTURED' || fresh.paymentStatus === 'CLAIMED';
      const shot = JSON.stringify({ round, confirm: confirm.statusCode, cancel: cancel.statusCode, status: fresh.status, paymentStatus: fresh.paymentStatus });
      expect(fresh.status === 'CANCELLED' && moneyLanded, shot).toBe(false);
      if (moneyLanded) {
        // the store's claim won → the cancel must have refused
        expect(confirm.statusCode, shot).toBe(200);
        expect(cancel.statusCode, shot).toBe(409);
        expect(fresh.status, shot).toBe('ACCEPTED');
        expect(fresh.paymentStatus, shot).toBe('CLAIMED');
      } else {
        // cancel won → the claim must have refused
        expect(cancel.statusCode, shot).toBe(200);
        expect(confirm.statusCode, shot).toBe(409);
        expect(fresh.status, shot).toBe('CANCELLED');
        expect(fresh.paymentStatus, shot).toBe('PENDING');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// [MOB-023] The door's authority. The screen used to say "collect NOTHING"
// from the payment METHOD; the server now says what the door may do from the
// payment STATE, carries it on every rider job with a version, and validates
// it again at the moment of hand-over.
// ---------------------------------------------------------------------------
describe('[MOB-023] the handover authority at the door', () => {
  const blocked = async (reason: string): Promise<number> => {
    const m = await handoverBlockCounter.get();
    return m.values.find((v) => v.labels['reason'] === reason)?.value ?? 0;
  };

  it('an MMG order whose payment is UNKNOWN, FAILED or REFUNDED is never handed over as paid — 409, the reason counted', async () => {
    for (const paymentStatus of ['UNKNOWN', 'FAILED', 'REFUNDED'] as const) {
      const order = await makeMmgOrder('ARRIVED', { fee: 300, tip: 0, paymentStatus });
      const before = await blocked(`MOBILE_MONEY_${paymentStatus}`);
      const res = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, {});
      expect(res.statusCode, paymentStatus).toBe(409);
      expect(res.json().error?.code ?? res.json().code, paymentStatus).toBe('PAYMENT_NOT_CAPTURED');
      expect(await blocked(`MOBILE_MONEY_${paymentStatus}`), paymentStatus).toBe(before + 1);
      const still = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
      expect(still.status, paymentStatus).toBe('ARRIVED');
    }
  });

  it('the rider job carries the authority: BLOCKED with its reason while pending, DELIVER_NO_CASH once captured, and a version that changes with the state', async () => {
    const order = await makeMmgOrder('ARRIVED', { fee: 300, tip: 0 });
    await app.prisma.rider.update({ where: { id: riderId }, data: { currentOrderId: order.id } });
    const pending = await inject('GET', '/api/v1/rider/orders/active', rider.token);
    expect(pending.statusCode).toBe(200);
    expect(pending.json().data?.handover).toMatchObject({ rail: 'MOBILE_MONEY', paymentState: 'PENDING', custodyState: 'ARRIVED', permitted: 'BLOCKED', blockReason: 'MOBILE_MONEY_PENDING', currency: 'GYD' });
    const v1 = pending.json().data.handover.version as string;
    await app.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'CAPTURED' } });
    const captured = await inject('GET', '/api/v1/rider/orders/active', rider.token);
    expect(captured.json().data?.handover).toMatchObject({ permitted: 'DELIVER_NO_CASH', blockReason: null, paymentState: 'CAPTURED' });
    expect(captured.json().data.handover.version).not.toBe(v1);
    // the pure derivation agrees with the served one
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(handoverAuthorityFor(row).version).toBe(captured.json().data.handover.version);
    expect(handoverVersionFor(row)).toBe(captured.json().data.handover.version);
  });

  it('a screen that echoes a stale version is refused (409 HANDOVER_STALE, counted); the current version hands over', async () => {
    const order = await makeMmgOrder('ARRIVED', { fee: 300, tip: 0 });
    await app.prisma.rider.update({ where: { id: riderId }, data: { currentOrderId: order.id } });
    const stale = (await inject('GET', '/api/v1/rider/orders/active', rider.token)).json().data.handover.version as string;
    await app.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'CAPTURED' } });
    const before = await blocked('STALE_VERSION');
    const refused = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, { handoverVersion: stale });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error?.code ?? refused.json().code).toBe('HANDOVER_STALE');
    expect(await blocked('STALE_VERSION')).toBe(before + 1);
    const fresh = (await inject('GET', '/api/v1/rider/orders/active', rider.token)).json().data.handover.version as string;
    const done = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, { handoverVersion: fresh });
    expect(done.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// [DOC-INV-48 · F-103-01] THE DOOR OPENED ON A DISPUTED PAYMENT.
//
// Codex ran the real `handoverAuthorityFor` against a MOBILE_MONEY + CLAIMED +
// disputed order at the merged SHA and captured what the server answered:
//
//   HANDOVER {"mismatchPresent":true,"authority":{ … "permitted":"DELIVER_NO_CASH","blockReason":null }}
//
// The server told the person at the customer's door to hand the goods over on
// a payment the customer says never happened. The canonical status write
// refuses afterwards; that is worth nothing, because nothing can un-hand food
// already given to someone.
//
// These are the route-level proofs Codex required: both active payloads, the
// final route, the stale-version behaviour, and zero money side effects.
// ---------------------------------------------------------------------------
describe('[F-103-01] a disputed MMG claim closes the door at every rider surface', () => {
  const dispute = (orderId: string) =>
    app.prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'CLAIMED', mmgClaimMismatchAt: new Date() } });

  it('GET /orders/active says BLOCKED / MMG_CLAIM_MISMATCH — not DELIVER_NO_CASH', async () => {
    const order = await makeMmgOrder('ARRIVED', { fee: 300, tip: 0 });
    await app.prisma.rider.update({ where: { id: riderId }, data: { currentOrderId: order.id } });
    await dispute(order.id);

    const res = await inject('GET', '/api/v1/rider/orders/active', rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data?.handover).toMatchObject({
      rail: 'MOBILE_MONEY', paymentState: 'CLAIMED', permitted: 'BLOCKED', blockReason: 'MMG_CLAIM_MISMATCH',
    });
  });

  it('GET /orders/active-legs says the same on every leg', async () => {
    const order = await makeMmgOrder('ARRIVED', { fee: 300, tip: 0 });
    await app.prisma.rider.update({ where: { id: riderId }, data: { currentOrderId: order.id } });
    await dispute(order.id);

    const res = await inject('GET', '/api/v1/rider/orders/active-legs', rider.token);
    expect(res.statusCode).toBe(200);
    const legs = (res.json().data?.legs ?? []) as Array<{ id: string; handover?: { permitted?: string; blockReason?: string } }>;
    const leg = legs.find((l) => l.id === order.id);
    expect(leg, 'the disputed leg is on the board').toBeTruthy();
    expect(leg!.handover).toMatchObject({ permitted: 'BLOCKED', blockReason: 'MMG_CLAIM_MISMATCH' });
  });

  it('PUT /delivered refuses with MMG_CLAIM_MISMATCH, leaves custody untouched, and creates NO earnings or settlement', async () => {
    const order = await makeMmgOrder('ARRIVED', { fee: 300, tip: 200 });
    await dispute(order.id);

    const res = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('MMG_CLAIM_MISMATCH');

    const still = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, deliveredAt: true } });
    expect(still.status, 'custody did not move').toBe('ARRIVED');
    expect(still.deliveredAt).toBeNull();
    expect(await app.prisma.earning.findMany({ where: { orderId: order.id } }), 'no earnings').toHaveLength(0);
    expect(await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId: order.id } }), 'no settlement debt').toBeNull();
  });

  it('a version echoed BEFORE the dispute is refused as stale — the generation is in the digest, not implied by a clock', async () => {
    const order = await makeMmgOrder('ARRIVED', { fee: 300, tip: 0, paymentStatus: 'CLAIMED' });
    await app.prisma.rider.update({ where: { id: riderId }, data: { currentOrderId: order.id } });

    const open = await inject('GET', '/api/v1/rider/orders/active', rider.token);
    expect(open.json().data.handover.permitted, 'undisputed CLAIMED still opens').toBe('DELIVER_NO_CASH');
    const echoed = open.json().data.handover.version as string;

    // The dispute commits, and `updatedAt` is forced back to what the screen
    // saw — so this can only pass if the DISPUTE itself is in the version.
    const before = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { updatedAt: true } });
    await app.prisma.order.update({ where: { id: order.id }, data: { mmgClaimMismatchAt: new Date() } });
    await app.prisma.$executeRaw`UPDATE "orders" SET "updatedAt" = ${before.updatedAt} WHERE "id" = ${order.id}`;

    const refused = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, { handoverVersion: echoed });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error?.code ?? refused.json().code).toBe('HANDOVER_STALE');
  });
});

// ---------------------------------------------------------------------------
// [F-106-05] BOTH ORDERS, FORCED — not sampled.
//
// The race test above repeats `Promise.all` and asserts the invariant for
// whichever side won. Codex's objection is exact: five green runs may all have
// taken one scheduler order, so that is sampled stress and not proof that both
// serializations are safe.
//
// WHAT THESE TWO ACTUALLY PROVE, stated precisely because the previous wording
// overstated it. They force each COMMIT order — the first request is awaited to
// completion before the second is issued — and assert the whole outcome: HTTP
// result, final state, audit row, and the absence of the forbidden combination.
// They do NOT prove anything about LOCK ordering, because sequential requests
// never contend: removing the `SELECT ... FOR UPDATE` from confirm-payment's
// transaction leaves both of them green, carried by the CAS predicates. The
// interleaving property is still covered only by the sampled stress above.
// Closing that needs real contention — a barrier or an injected delay inside
// one transaction — and is not done here.
//
// The forbidden combination is CANCELLED + money-landed, where money-landed is
// CLAIMED *or* CAPTURED: `confirm-payment` writes CLAIMED (vendor.routes.ts),
// and asking only about CAPTURED is what let this test read as a flake for so
// long (F-103-01b).
// ---------------------------------------------------------------------------
describe('[F-106-05] claim vs cancel, each COMMIT order forced (sequential, not contended)', () => {
  const forbidden = (o: { status: string; paymentStatus: string }) =>
    o.status === 'CANCELLED' && (o.paymentStatus === 'CLAIMED' || o.paymentStatus === 'CAPTURED');

  it('CLAIM commits first: the cancel is refused and the money state stands', async () => {
    const order = await makeMmgOrder('ACCEPTED', { withRider: false });
    const claim = await inject('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);
    expect(claim.statusCode, claim.body).toBe(200);
    const cancel = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, { reason: 'forced-claim-first' });

    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(cancel.statusCode, 'a claimed order cannot then be cancelled by the customer').toBe(409);
    expect(fresh.status).toBe('ACCEPTED');
    expect(fresh.paymentStatus).toBe('CLAIMED');
    expect(forbidden(fresh)).toBe(false);
    expect(await app.prisma.auditLog.count({ where: { entityId: order.id, action: 'VENDOR_CLAIMED_PAYMENT_RECEIVED' } }), 'the claim is on the record exactly once').toBe(1);
  });

  it('CANCEL commits first: the claim is refused and no money state is minted', async () => {
    const order = await makeMmgOrder('ACCEPTED', { withRider: false });
    const cancel = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, { reason: 'forced-cancel-first' });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const claim = await inject('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);

    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(claim.statusCode, 'a cancelled order cannot then be claimed as paid').toBe(409);
    expect(fresh.status).toBe('CANCELLED');
    expect(fresh.paymentStatus, 'PENDING — nothing was minted onto a dead order').toBe('PENDING');
    expect(forbidden(fresh)).toBe(false);
    expect(await app.prisma.auditLog.count({ where: { entityId: order.id, action: 'VENDOR_CLAIMED_PAYMENT_RECEIVED' } }), 'and the refused claim left no claim record').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// [F-106-01 · Codex re-review item 3] The route-level CAPTURED + mismatch case.
// The existing route proofs use CLAIMED; the server now blocks a dispute ahead
// of CAPTURED too, and that has to be shown where it matters — on the payload
// the rider's screen reads, and at the route that completes the delivery.
// ---------------------------------------------------------------------------
describe('[F-106-01] a dispute outranks CAPTURED at the route, not only in the unit', () => {
  it('CAPTURED + disputed: the active payload is BLOCKED and /delivered creates no money', async () => {
    const order = await makeMmgOrder('ARRIVED', { fee: 300, tip: 200, paymentStatus: 'CAPTURED' });
    await app.prisma.rider.update({ where: { id: riderId }, data: { currentOrderId: order.id } });
    await app.prisma.order.update({ where: { id: order.id }, data: { mmgClaimMismatchAt: new Date() } });

    const payload = await inject('GET', '/api/v1/rider/orders/active', rider.token);
    expect(payload.statusCode).toBe(200);
    expect(payload.json().data?.handover).toMatchObject({ paymentState: 'CAPTURED', permitted: 'BLOCKED', blockReason: 'MMG_CLAIM_MISMATCH' });

    const res = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('MMG_CLAIM_MISMATCH');

    const still = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, deliveredAt: true } });
    expect(still.status).toBe('ARRIVED');
    expect(still.deliveredAt).toBeNull();
    expect(await app.prisma.earning.findMany({ where: { orderId: order.id } })).toHaveLength(0);
    expect(await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId: order.id } })).toBeNull();
  });
});
