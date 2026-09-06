import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole, OrderStatus } from '@prisma/client';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { CashRulesService, orderingRestriction } from '../modules/cash/cash-rules.service';
import { OrderService } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { syntheticLocationOwner } from './helpers/online-mover';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { injectWithApproval } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// cash rules. The cash-rules table as tests: a simulated dishonest rider
// gets flagged, a prankster customer gets restricted, and an honest rider's
// clean claim pays. Claims are impossible outside the delivery state or
// without a GPS stamp.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
// Own geo sandbox, ~50km from step8/step9 fixtures — online riders here must
// never enter another file's dispatch radius when suites run in parallel.
const GPS = { lat: 7.2, lng: -58.6 };
// SWIFT-076: handover claims now assert proximity — a legit handover happens AT
// the door, so the delivery point sits beside GPS (~110 m). GPS_FAR is a claim
// reported implausibly far from the door (spoofed), well outside the guarantee
// radius; it stays inside this file's isolated geo sandbox.
const GPS_FAR = { lat: 7.3, lng: -58.7 };

let app: FastifyInstance;
let cash: CashRulesService;
let orders: OrderService;
let adminToken: string;
let vendorId: string;

const createdUserIds: string[] = [];

const RESERVE_NOTE = 'cash.test fixture reserve';
let itemId = '';

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({
    where: { phone: { startsWith: '+59200133' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const riders = await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const riderIds = riders.map((r) => r.id);
  // [P31-1] The reserve draws of this suite's payouts go first (a draw outlives its claim as an
  // orphan otherwise, and the suite's funding entry with it), then the funding, then the claims.
  await app.prisma.rlpReserveEntry.deleteMany({
    where: { OR: [{ claim: { OR: [{ customerId: { in: ids } }, { riderId: { in: riderIds } }] } }, { note: RESERVE_NOTE }] },
  });
  await app.prisma.reimbursementClaim.deleteMany({
    where: { OR: [{ customerId: { in: ids } }, { riderId: { in: riderIds } }] },
  });
  const ordersToDrop = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: ids } }, { riderId: { in: riderIds } }] },
    select: { id: true },
  });
  const orderIds = ordersToDrop.map((o) => o.id);
  await app.prisma.earning.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole, opts: { createdDaysAgo?: number; trustLevel?: 'L1' | 'L2' | 'L3' } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200133${String(seq).padStart(2, '0')}`,
      firstName: 'Cash',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      trustLevel: opts.trustLevel ?? 'L1',
      ...(opts.createdDaysAgo && { createdAt: new Date(Date.now() - opts.createdDaysAgo * DAY) }),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      ...(roles.some((role) => role === 'ADMIN' || role === 'SUPER_ADMIN') && { authMethod: 'OTP' as const }),
      deviceId: 'step10', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeRider() {
  const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await app.prisma.rider.create({
    data: {
      userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
      documentsVerified: true, isOnline: true, locationSessionId: syntheticLocationOwner('cash'), currentLat: GPS.lat, currentLng: GPS.lng,
    },
  });
  return { ...u, riderId: rider.id };
}

async function makeAtDoorOrder(
  customerId: string,
  riderId: string,
  amount: number,
  status: OrderStatus = 'ARRIVED',
  delivery: { lat: number; lng: number } = { lat: 7.2007, lng: -58.6007 },
) {
  const created = await app.prisma.order.create({
    data: {
      orderNumber: `S10-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      riderId,
      status,
      deliveryAddress: '9 Cash Street, Georgetown',
      deliveryLat: delivery.lat,
      deliveryLng: delivery.lng,
      pickupLat: GPS.lat,
      pickupLng: GPS.lng,
      pickupAddress: 'Vendor corner',
      subtotalBase: amount, subtotalMarkup: 0, subtotalCustomer: amount,
      deliveryFee: 500, totalAmount: amount,
      paymentMethod: 'CASH',
      // [P31-1] The cart the rider paid for at pickup — part of the claim's evidence bundle.
      items: { create: { itemId, name: 'Plate', quantity: 1, basePrice: amount, markedUpPrice: amount, markupAmount: 0, totalBase: amount, totalMarkup: 0, totalCustomer: amount, selectedOptions: {} } },
    },
  });
  // [P31-1] The rider took custody at pickup (having paid the vendor) — the PICKED_UP row is
  // the bundle's pickup proof. An order at the door, or failed after it, has both artefacts.
  await app.prisma.orderStatusLog.create({
    data: { orderId: created.id, status: 'PICKED_UP', changedBy: riderId, note: 'fixture pickup', createdAt: new Date(Date.now() - 40 * 60_000) },
  });
  if (status === 'ARRIVED' || status === 'FAILED') await arriveAtDoor(created.id, riderId, delivery);
  return created;
}

/** [AF-MOB-001] A REAL at-door order carries an arrival: the status-log row the
 *  transition writes, and a rider standing where they say they are. These
 *  fixtures used to create `status: 'ARRIVED'` with neither, which the no-show
 *  policy correctly refuses — a mover who never arrived cannot report a no-show.
 *  Arranging the precondition properly is not weakening the test; it is the
 *  difference between an order that arrived and one that merely says so. */
async function arriveAtDoor(orderId: string, riderId: string, door: { lat: number; lng: number }, minutesAgo = 10) {
  await app.prisma.orderStatusLog.create({
    data: { orderId, status: 'ARRIVED', changedBy: riderId, note: 'fixture arrival', createdAt: new Date(Date.now() - minutesAgo * 60_000) },
  });
  await app.prisma.rider.update({
    where: { id: riderId },
    data: { currentLat: door.lat, currentLng: door.lng, lastLocationUpdate: new Date() },
  });
}

/** A prior failed-handover claim, backdated, for synthetic patterns. */
async function plantClaim(riderId: string, customerId: string, daysAgo: number, status: 'AUTO_APPROVED' | 'PENDING_REVIEW' = 'AUTO_APPROVED') {
  const order = await makeAtDoorOrder(customerId, riderId, 2000, 'FAILED');
  return app.prisma.reimbursementClaim.create({
    data: {
      orderId: order.id,
      riderId,
      customerId,
      amount: 2000,
      reason: 'no_show',
      gpsLat: GPS.lat,
      gpsLng: GPS.lng,
      photoUrl: 'storage://t/door.jpg', // [P31-1] the photo at the door — no payout without it
      status,
      flags: status === 'PENDING_REVIEW' ? ['over_cap'] : [],
      createdAt: new Date(Date.now() - daysAgo * DAY),
    },
  });
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
  return injectWithApproval(app, {
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { ...(url.includes('/api/v1/admin') ? { 'x-swift-reason': TEST_ADMIN_REASON } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  orders = new OrderService(app.prisma, ioStub);
  cash = new CashRulesService(app.prisma, new NotificationService(app.prisma, ioStub), orders);

  await purgeFixtures();

  const admin = await makeUser(['ADMIN'], 'ADMIN');
  adminToken = admin.token;
  await app.prisma.admin.create({ data: { userId: admin.userId, permissions: ['*'] } });

  // One vendor for all the synthetic orders
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name: 'Cash Corner', slug: `cash-corner-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: '+5920013399',
      addressLine1: '1 Cash Corner', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: GPS.lat, longitude: GPS.lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  // [DOC-1 §31.4 · P31-1] A real cash order has a cart; a real claim's bundle cites it.
  const category = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
  itemId = (await app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Plate', basePrice: 1000 } as never })).id;
  // [DOC-1 §31.4 · P31-1] Payouts are drawn from the loss-protection reserve line: fund it for the suite.
  await app.prisma.rlpReserveEntry.create({ data: { countryCode: 'GY', kind: 'ADJUSTMENT', amount: 1_000_000, note: RESERVE_NOTE } });
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('Golden rule handover', () => {
  it('payment collected -> DELIVERED with GPS evidence and earnings', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, 3000);

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'paid',
      gps: GPS,
    }, rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('DELIVERED');
    expect(res.json().data.claim).toBeNull();

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(db.paymentStatus).toBe('CAPTURED');

    const log = await app.prisma.orderStatusLog.findFirst({
      where: { orderId: order.id, status: 'DELIVERED' },
    });
    expect(log?.note).toContain('gps:');

    const earnings = await app.prisma.earning.count({ where: { orderId: order.id } });
    expect(earnings).toBeGreaterThan(0);
  });

  it('handover is impossible away from the door', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, 3000, 'PICKED_UP');

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'no_show',
      gps: GPS,
    }, rider.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_AT_DOOR');
  });

  it('a claim is impossible without a GPS stamp', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, 3000);

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'no_show',
    }, rider.token);
    expect(res.statusCode).toBe(400); // zod refuses before any business logic
  });
});

describe('The guarantee — honest claim pays, guardrails catch patterns', () => {
  it('an honest rider with a clean record: claim auto-approved, customer struck', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, 3500);

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'refused',
      gps: GPS,
      photoUrl: 'storage://t/door.jpg',
    }, rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('FAILED');
    expect(res.json().data.claim.status).toBe('AUTO_APPROVED');
    expect(res.json().data.claim.flags).toEqual([]);

    const strike = await app.prisma.strike.findFirst({ where: { orderId: order.id } });
    expect(strike).not.toBeNull();
    expect(strike!.phone).toBeTruthy();
    expect(strike!.addressKey).toContain('geo:');
  });

  it('a claim reported implausibly far from the door goes to review, not auto-payout [SWIFT-076]', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    // A unique delivery point so no historical guardrail (shared-address, pair,
    // outlier) can co-fire — gps_far is proven in isolation. The reported
    // handover GPS is ~17 km from this door.
    const door = { lat: 7.25, lng: -58.55 };
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, 3500, 'ARRIVED', door);

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'refused',
      gps: GPS_FAR,
      photoUrl: 'storage://t/door.jpg',
    }, rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('FAILED'); // the order still fails through the machine
    expect(res.json().data.claim.status).toBe('PENDING_REVIEW'); // caused solely by proximity
    // [P31-1] A far GPS also fails the bundle's rider-at-door artefact, so the evidence flag rides along.
    expect(res.json().data.claim.flags).toEqual(['gps_far', 'evidence_incomplete']);

    // The customer is still struck — a far GPS doesn't erase the failed handover.
    const strike = await app.prisma.strike.findFirst({ where: { orderId: order.id } });
    expect(strike).not.toBeNull();
  });

  it('claim payout is single-winner: two concurrent markClaimPaid → one pays, one 400s (no double-payout)', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const claim = await plantClaim(rider.riderId, customer.userId, 0); // AUTO_APPROVED

    // Two admins (or a double-click / retry) mark the SAME claim paid at once.
    const results = await Promise.allSettled([
      cash.markClaimPaid(claim.id, 'admin-a', 'REF-A1', 2000),
      cash.markClaimPaid(claim.id, 'admin-b', 'REF-B1', 2000),
    ]);
    // Exactly one payout goes through; the loser is rejected, not a second payout.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const final = await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(final.status).toBe('PAID');

    // A later attempt on an already-PAID claim is a clean 400, never another payout.
    await expect(cash.markClaimPaid(claim.id, 'admin-c', 'REF-C1', 2000)).rejects.toThrow(/PAID/);
  });

  it('[WR-004] a claim payout without a payment reference is refused — PAID needs evidence', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const claim = await plantClaim(rider.riderId, customer.userId, 0); // AUTO_APPROVED

    await expect(cash.markClaimPaid(claim.id, 'admin-a', '', 2000)).rejects.toThrow(/reference/i);
    await expect(cash.markClaimPaid(claim.id, 'admin-a', '   ', 2000)).rejects.toThrow(/reference/i);

    // The refusal changed nothing: the claim is still payable with evidence.
    const still = await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(still.status).toBe('AUTO_APPROVED');
    const paid = await cash.markClaimPaid(claim.id, 'admin-a', 'BANK-REF-1', 2000);
    expect(paid.status).toBe('PAID');
    expect(paid.paymentRef).toBe('BANK-REF-1');
  });

  it('orders at/over the USD gate are not auto-covered (strike still recorded)', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER', { trustLevel: 'L2' });
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, 20000);

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'no_show',
      gps: GPS,
    }, rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.claim).toBeNull();

    const strike = await app.prisma.strike.findFirst({ where: { orderId: order.id } });
    expect(strike).not.toBeNull();
  });

  it('a rider over the monthly cap goes to review, not auto-payout', async () => {
    const rider = await makeRider();
    for (let i = 0; i < 3; i++) {
      const victim = await makeUser(['CUSTOMER'], 'CUSTOMER');
      // daysAgo=0: the cap counts the CURRENT calendar month (cash-rules `monthStart`
      // = setDate(1)). Dating claims 2 days ago straddles the month boundary on the
      // 1st–2nd (claims land in the prior month, excluded from the cap) — which flaked
      // this test in CI on Jul 1 UTC while it passed locally on Jun 30. Plant in-month.
      await plantClaim(rider.riderId, victim.userId, 0);
    }

    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, 3000);
    const result = await cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: GPS });

    expect(result.claim!.status).toBe('PENDING_REVIEW');
    expect(result.claim!.flags).toContain('over_cap');
  });

  it('a dishonest rider (steady false claims) gets the outlier flag', async () => {
    // Peers: two riders with one claim each in the window
    for (let i = 0; i < 2; i++) {
      const peer = await makeRider();
      const victim = await makeUser(['CUSTOMER'], 'CUSTOMER');
      await plantClaim(peer.riderId, victim.userId, 40 + i); // outside 30d window for cap, inside 90d
    }

    // Steady stream: enough claims that no realistic peer average excuses it
    // (the cap-test rider above is also a "peer" here, raising the bar)
    const dishonest = await makeRider();
    for (let i = 0; i < 9; i++) {
      const victim = await makeUser(['CUSTOMER'], 'CUSTOMER');
      await plantClaim(dishonest.riderId, victim.userId, 1 + i);
    }

    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeAtDoorOrder(customer.userId, dishonest.riderId, 2500);
    const result = await cash.handover(order.id, dishonest.userId, { outcome: 'no_show', gps: GPS });

    expect(result.claim!.status).toBe('PENDING_REVIEW');
    expect(result.claim!.flags).toContain('outlier');
  });

  it('the same customer across two riders flags collusion_customer', async () => {
    const target = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const riderA = await makeRider();
    await plantClaim(riderA.riderId, target.userId, 10);

    const riderB = await makeRider();
    const order = await makeAtDoorOrder(target.userId, riderB.riderId, 2200);
    const result = await cash.handover(order.id, riderB.userId, { outcome: 'refused', gps: GPS });

    expect(result.claim!.flags).toContain('collusion_customer');
  });

  it('one rider repeatedly against one customer flags collusion_pair', async () => {
    const target = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    await plantClaim(rider.riderId, target.userId, 15);

    const order = await makeAtDoorOrder(target.userId, rider.riderId, 1800);
    const result = await cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: GPS });

    expect(result.claim!.flags).toContain('collusion_pair');
  });
});

describe('Strike consequences — the prankster customer gets restricted', () => {
  async function strikeTimes(userId: string, n: number) {
    for (let i = 0; i < n; i++) {
      await app.prisma.strike.create({
        data: { userId, reason: 'failed_payment_no_show', phone: 'x', addressKey: `geo:t${i}` },
      });
    }
  }

  it('2 strikes: L1 restricted, L2 still flows; 4 strikes: banned outright', async () => {
    const prankster = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await strikeTimes(prankster.userId, 2);

    expect(await orderingRestriction(app.prisma, prankster.userId)).toBe('restricted');

    await app.prisma.user.update({ where: { id: prankster.userId }, data: { trustLevel: 'L2' } });
    expect(await orderingRestriction(app.prisma, prankster.userId)).toBeNull();

    await strikeTimes(prankster.userId, 2);
    expect(await orderingRestriction(app.prisma, prankster.userId)).toBe('banned');
  });

  it('a restricted customer is blocked from requesting rides over HTTP', async () => {
    const prankster = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await strikeTimes(prankster.userId, 2);

    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: { lat: 6.81, lng: -58.155 },
      dropoff: { lat: 6.755, lng: -58.155 },
      pickupAddress: 'Strike Street 1',
      dropoffAddress: 'Strike Street 2',
    }, prankster.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STRIKE_RESTRICTED');
  });

  it('a banned customer cannot check out at all', async () => {
    const banned = await makeUser(['CUSTOMER'], 'CUSTOMER', { trustLevel: 'L3' });
    await strikeTimes(banned.userId, 4);

    await app.prisma.cart.create({
      data: {
        customerId: banned.userId,
        vendorId,
        items: { create: { itemId: (await app.prisma.item.findFirstOrThrow({ where: { vendorId: { not: vendorId } } })).id, quantity: 1, selectedOptions: {} } },
      },
    });

    await expect(
      orders.checkout({ userId: banned.userId, paymentMethod: 'CASH' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
  });
});

describe('L3 — earned trust', () => {
  it('promotes an L2 veteran with paid history and zero strikes on a paid handover', async () => {
    const veteran = await makeUser(['CUSTOMER'], 'CUSTOMER', { trustLevel: 'L2', createdDaysAgo: 60 });
    const rider = await makeRider();

    // 20 prior paid orders
    for (let i = 0; i < 20; i++) {
      const prior = await makeAtDoorOrder(veteran.userId, rider.riderId, 1500, 'DELIVERED');
      await app.prisma.order.update({ where: { id: prior.id }, data: { paymentStatus: 'CAPTURED' } });
    }

    const order = await makeAtDoorOrder(veteran.userId, rider.riderId, 1500);
    await cash.handover(order.id, rider.userId, { outcome: 'paid', gps: GPS });

    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: veteran.userId } });
    expect(user.trustLevel).toBe('L3');
  });

  it('a single strike blocks the promotion', async () => {
    const tainted = await makeUser(['CUSTOMER'], 'CUSTOMER', { trustLevel: 'L2', createdDaysAgo: 60 });
    const rider = await makeRider();
    await app.prisma.strike.create({
      data: { userId: tainted.userId, reason: 'failed_payment_no_show', phone: 'x', addressKey: 'geo:z' },
    });
    for (let i = 0; i < 20; i++) {
      const prior = await makeAtDoorOrder(tainted.userId, rider.riderId, 1500, 'DELIVERED');
      await app.prisma.order.update({ where: { id: prior.id }, data: { paymentStatus: 'CAPTURED' } });
    }

    const order = await makeAtDoorOrder(tainted.userId, rider.riderId, 1500);
    await cash.handover(order.id, rider.userId, { outcome: 'paid', gps: GPS });

    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: tainted.userId } });
    expect(user.trustLevel).toBe('L2');
  });
});

describe('Admin review + founder metrics', () => {
  it('flagged claims queue through review -> approve -> paid', async () => {
    // [P31-1] A flagged claim WITH its evidence bundle: the queue holds other suites' claims too,
    // some filed without a bundle (a far GPS, no photo) — those are refused at payout by design.
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const flagged = await plantClaim(rider.riderId, customer.userId, 0, 'PENDING_REVIEW');
    const queue = await inject('GET', '/api/v1/admin/cash-rules/claims?limit=200', undefined, adminToken);
    expect(queue.statusCode).toBe(200);
    const pending = queue.json().data as Array<{ id: string; status: string; amount: string | number }>;
    expect(pending.length).toBeGreaterThan(0);
    const mine = pending.find((c) => c.id === flagged.id);
    expect(mine, 'the planted flagged claim is in the review queue').toBeTruthy();

    const claimId = flagged.id;
    const approve = await inject('PUT', `/api/v1/admin/cash-rules/claims/${claimId}/approve`, { reason: 'Verified with photos' }, adminToken);
    expect(approve.statusCode).toBe(200);
    expect(approve.json().data.status).toBe('APPROVED');

    // [A-11] the payer states the amount actually transferred; it must be the
    // claim's own figure, so the test reads it rather than inventing one
    const paid = await inject(
      'PUT',
      `/api/v1/admin/cash-rules/claims/${claimId}/paid`,
      { reference: `CASHPAYOUT-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}`, amount: mine!.amount },
      adminToken,
    );
    expect(paid.statusCode).toBe(200);
    expect(paid.json().data.status).toBe('PAID');

    // A paid claim cannot be re-reviewed
    const again = await inject('PUT', `/api/v1/admin/cash-rules/claims/${claimId}/approve`, {}, adminToken);
    expect(again.statusCode).toBe(400);
  });

  it('founder metrics tell the failed-payment story', async () => {
    const res = await inject('GET', '/api/v1/admin/cash-rules/metrics', undefined, adminToken);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.failedPaymentPct).toBeGreaterThanOrEqual(0);
    expect(data.guaranteePayoutsThisWeek.total).toBeGreaterThan(0);
    expect(Array.isArray(data.claimsByRider)).toBe(true);
    expect(data.claimsByRider.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// [A-11] S0 money. Closing a claim moves real money to a claimant on a MANUAL
// rail — a bank transfer or an MMG send — so the reference typed afterwards is
// the only proof the payout ever happened.
//
// What was already right and is NOT re-fixed here: WR-004 made that reference
// required, and the transition is compare-and-set so two admins cannot pay the
// same claim twice. Both are covered above.
//
// What was missing: the reference was not UNIQUE, so one string could close ten
// claims and a mistyped, reused or invented one read exactly like a real one;
// `min(1)` accepted a single character; and nothing bound the payment to the
// claim's amount, so a GY$2,000 claim could be closed by a GY$200 transfer and
// the record would look identical.
// ---------------------------------------------------------------------------

describe('[A-11] a claim payout carries evidence that holds up', () => {
  async function payable() {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    return plantClaim(rider.riderId, customer.userId, 0); // AUTO_APPROVED, amount 2000
  }

  it('one transfer settles ONE claim — a reused reference is refused', async () => {
    const first = await payable();
    const second = await payable();
    await cash.markClaimPaid(first.id, 'admin-a', 'BANK-REUSE-9', 2000);

    await expect(cash.markClaimPaid(second.id, 'admin-a', 'BANK-REUSE-9', 2000))
      .rejects.toThrow(/already recorded against another claim/i);

    // the refusal changed nothing: the second claim is still payable
    const still = await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: second.id } });
    expect(still.status).toBe('AUTO_APPROVED');
    expect(still.paymentRef).toBeNull();
  });

  it('the same reference typed in a different case is the SAME reference', async () => {
    const first = await payable();
    const second = await payable();
    await cash.markClaimPaid(first.id, 'admin-a', 'Bank-Case-7', 2000);
    // normalised on the way in, so case cannot defeat the unique index
    await expect(cash.markClaimPaid(second.id, 'admin-a', 'bank-case-7', 2000))
      .rejects.toThrow(/already recorded/i);
    const stored = await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.paymentRef).toBe('BANK-CASE-7');
  });

  it('a reference too short or malformed is refused, and says WHICH', async () => {
    const claim = await payable();
    // An empty field and a malformed one are different mistakes, and the payer
    // is told which they made — "enter it" vs "that is not one".
    const code = async (bad: unknown) => {
      try {
        await cash.markClaimPaid(claim.id, 'admin-a', bad as string, 2000);
        throw new Error('should have refused');
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    for (const empty of ['', '   ', undefined]) {
      expect(await code(empty), String(empty)).toBe('PAYMENT_REF_REQUIRED');
    }
    for (const malformed of ['x', 'ab', '!!!!', '-lead', 'trail-', 'A'.repeat(65)]) {
      expect(await code(malformed), malformed).toBe('PAYMENT_REF_INVALID');
    }
    expect((await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe('AUTO_APPROVED');
  });

  it('the payer must state the amount, and it must be the claim’s own figure', async () => {
    const claim = await payable(); // 2000
    await expect(cash.markClaimPaid(claim.id, 'admin-a', 'BANK-AMT-1', undefined))
      .rejects.toThrow(/amount/i);
    for (const wrong of [200, 2001, 1999.99, '200.00']) {
      await expect(cash.markClaimPaid(claim.id, 'admin-a', 'BANK-AMT-2', wrong), String(wrong))
        .rejects.toThrow(/not GY\$|amount/i);
    }
    expect((await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe('AUTO_APPROVED');
  });

  it('a non-numeric amount is refused rather than coerced', async () => {
    const claim = await payable();
    // Number('') and Number([]) are both 0; neither is an attestation.
    for (const bad of ['', '  ', 'two thousand', 'GY$2000', '2e3']) {
      await expect(cash.markClaimPaid(claim.id, 'admin-a', 'BANK-COERCE-1', bad), String(bad)).rejects.toThrow();
    }
    expect((await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe('AUTO_APPROVED');
  });

  it('records the exact figure and WHO paid it, alongside who approved it', async () => {
    const claim = await payable();
    const paid = await cash.markClaimPaid(claim.id, 'admin-payer', 'BANK-OK-1', '2000.00');
    expect(paid.status).toBe('PAID');
    const row = await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(Number(row.paidAmount)).toBe(2000);
    expect(row.paidById).toBe('admin-payer');
    expect(row.paymentRef).toBe('BANK-OK-1');
    // the approver and the payer are separately attributable — the point of paidById
    expect(row.reviewedBy).not.toBe(null);
  });
});
