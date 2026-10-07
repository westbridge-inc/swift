import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type PrismaClient, type UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { reserveRiderLeg } from '../modules/dispatch/concurrency-policy';
import { FloatService } from '../modules/dispatch/float.service';
import { invalidateAlgoConfig } from '../modules/algo/algo-config';
import { handoverAuthorityFor } from '../modules/order/handover-authority';
import { CashRulesService } from '../modules/cash/cash-rules.service';
import { OrderService } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { doorCashHoldAudience, stageDoorCashHoldPage } from '../modules/cash/door-cash-hold';
import { AccountService } from '../modules/user/account.service';
import { partnerObligations, verdictFor } from '../modules/user/partner-wind-down';

// ---------------------------------------------------------------------------
// [L02 · row 34] CASH AT THE DOOR IS RECORDED AS THE REAL AMOUNT.
//
// The rider's "paid" used to mean "the full amount was collected": the server
// never asked how much cash changed hands, so a short payment was recorded as
// a full one. The owner's ruling (5 Oct 2026):
//   - NO HANDOVER without full cash. A customer who cannot pay in full does
//     not get the goods; the order goes back to the store (the return flow),
//     where the rider gets the cash they fronted back.
//   - A rider who hands over for less anyway bears the difference: the real
//     amount is recorded, the mismatch is held for a person, and operations
//     is paged. Nothing is deducted from anyone automatically.
//   - Over-collection is refused.
//   - The rider echoes the version of the order they were shown; a stale one
//     is refused before anything is recorded.
// An older app that sends no amount completes exactly as before.
// ---------------------------------------------------------------------------

const GEO = { lat: 6.7413, lng: -58.2553 };
const DOOR = { lat: GEO.lat + 0.004, lng: GEO.lng + 0.004 };
const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
const PHONE_RUN = String(Date.now()).slice(-8);
const SUBTOTAL = 3000;
const FEE = 500;
const DUE = SUBTOTAL + FEE;

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];
const sessionIds: string[] = [];
let vendorId = '';
let adminUserId = '';
let seq = 0;

async function session(userId: string, role: string, label: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  const s = await app.prisma.session.create({
    data: { userId, token, refreshToken: nanoid(32), authMethod: 'OTP', deviceId: `cda-${label}-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3600_000) },
  });
  sessionIds.push(s.id);
  return { token, sessionId: s.id };
}

async function makeRider() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+592${PHONE_RUN}${String(seq).padStart(3, '0')}`,
      firstName: `Door${seq}`, lastName: 'Rider',
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER' as UserRole,
      countryCode: 'GY', isPhoneVerified: true, status: 'ACTIVE',
    },
  });
  createdUserIds.push(user.id);
  const { token, sessionId } = await session(user.id, 'MOVER', `r${seq}`);
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id, riderType: 'BOTH', vehicleType: 'MOTORCYCLE',
      documentsVerified: true, isOnline: true, isAvailable: true,
      locationSessionId: sessionId, currentLat: DOOR.lat, currentLng: DOOR.lng, lastLocationUpdate: new Date(),
      floatLimit: 40_000,
    },
  });
  return { user, rider, token };
}

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+592${PHONE_RUN}${String(seq).padStart(3, '0')}`,
      firstName: 'Cust', lastName: `Door${seq}`,
      roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER' as UserRole,
      countryCode: 'GY', isPhoneVerified: true, status: 'ACTIVE',
    },
  });
  createdUserIds.push(user.id);
  return { user };
}

/** A CASH food order at the customer's door, the float committed the way a
 *  real claim commits it. No door PIN (a legacy row completes presence-gated),
 *  so every assertion here is about money, not the PIN. */
async function orderAtDoor(riderId: string, customerId: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `CDA-${RUN}-${nanoid(6)}`,
      orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId, vendorId,
      status: 'RIDER_ASSIGNED',
      paymentMethod: 'CASH', paymentStatus: 'PENDING',
      subtotalBase: SUBTOTAL, subtotalMarkup: 0, subtotalCustomer: SUBTOTAL,
      deliveryFee: FEE, serviceFee: 0, taxAmount: 0, tipAmount: 0, discount: 0, totalAmount: DUE,
      deliveryAddress: '4 Door Street', deliveryLat: DOOR.lat, deliveryLng: DOOR.lng,
      pickupLat: GEO.lat, pickupLng: GEO.lng, pickupAddress: 'Store corner',
      riderId, acceptedAt: new Date(), readyAt: new Date(), pickedUpAt: new Date(Date.now() - 30 * 60_000),
    },
  });
  expect(await reserveRiderLeg(app.prisma, riderId, order.id, 2)).toBe(true);
  expect(await new FloatService(app.prisma).commit(app.prisma, riderId, SUBTOTAL)).toBe(true);
  await app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'PICKED_UP', changedBy: riderId, note: 'fixture pickup', createdAt: new Date(Date.now() - 30 * 60_000) } });
  await app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'ARRIVED', changedBy: riderId, note: 'fixture arrival', createdAt: new Date(Date.now() - 2 * 60_000) } });
  return app.prisma.order.update({ where: { id: order.id }, data: { status: 'ARRIVED' } });
}

/** What the rider's screen was shown: the server's own door authority. */
async function shownVersion(orderId: string): Promise<string> {
  const row = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  return handoverAuthorityFor(row).version;
}

const as = (token: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const handover = (token: string, orderId: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  as(token, 'POST', `/api/v1/rider/orders/${orderId}/handover`, { gps: DOOR, ...body }, headers);

const report = (token: string, orderId: string, reason = 'RECIPIENT_ABSENT') =>
  as(token, 'POST', `/api/v1/rider/orders/${orderId}/recovery`, { reason, note: 'nobody answered at first', gps: DOOR });

/** The order's money and custody facts, read straight from the rows. */
async function facts(orderId: string) {
  return runWithoutTenant(async () => {
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const statuses = (await app.prisma.orderStatusLog.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })).map((l) => l.status);
    const claims = await app.prisma.reimbursementClaim.count({ where: { orderId } });
    const strikes = await app.prisma.strike.count({ where: { orderId } });
    const earnings = await app.prisma.earning.findMany({ where: { orderId } });
    const cases = await app.prisma.custodyRecoveryCase.findMany({ where: { orderId } });
    const rider = order.riderId ? await app.prisma.rider.findUnique({ where: { id: order.riderId }, select: { committedFloat: true } }) : null;
    return { order: order as typeof order & Record<string, unknown>, statuses, claims, strikes, earnings, cases, committedFloat: Number(rider?.committedFloat ?? 0) };
  }, 'test:cash-door-attestation');
}

async function adminPages(orderId: string, kind: string) {
  const rows = await runWithoutTenant(() => app.prisma.notification.findMany({ where: { userId: adminUserId } }), 'test:cash-door-attestation');
  return rows.filter((n) => {
    const data = (n.data ?? {}) as Record<string, unknown>;
    return data['kind'] === kind && data['orderId'] === orderId;
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  invalidateAlgoConfig();

  const vendor = await runWithoutTenant(() => app.prisma.vendor.findFirst({
    where: { status: 'ACTIVE', owner: { user: { status: 'ACTIVE' } } },
    select: { id: true },
  }), 'test:cash-door-attestation');
  if (!vendor) throw new Error('seeded ACTIVE vendor with an owner required');
  vendorId = vendor.id;

  const admin = await app.prisma.user.create({
    data: {
      phone: `+592${PHONE_RUN}999`, firstName: 'Ops', lastName: `Door${RUN}`,
      roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
      admin: { create: { permissions: ['*'] } },
    },
  });
  createdUserIds.push(admin.id);
  adminUserId = admin.id;
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    const orders = await app.prisma.order.findMany({ where: { orderNumber: { startsWith: `CDA-${RUN}-` } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await app.prisma.opsAlert.deleteMany({ where: { OR: [
      { body: { contains: `Order CDA-${RUN}-` } }, { tenantId: { in: createdTenantIds } },
    ] } }).catch(() => {});
    await app.prisma.earning.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { id: { in: sessionIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    // Every suite shares the test database. Leaving an active fixture tenant
    // behind makes the public catalogue correctly refuse an ambiguous tenant.
    await app.prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
    expect(await app.prisma.tenant.count({ where: { id: { in: createdTenantIds } } })).toBe(0);
  }, 'test-cleanup:cash-door-attestation');
  await app.close();
});

describe('[row 34] exact cash: the amount the rider took is the amount recorded', () => {
  it('collected = due completes the delivery and records the attested amount, with no mismatch', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);

    const res = await handover(holder.token, order.id, { outcome: 'paid', collectedAmount: DUE, handoverVersion: await shownVersion(order.id) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('DELIVERED');

    const f = await facts(order.id);
    expect(f.order.status).toBe('DELIVERED');
    expect(f.order.paymentStatus).toBe('CAPTURED');
    expect(Number(f.order['doorCashCollectedAmount'])).toBe(DUE);
    expect(f.order['doorCashShortfallAmount']).toBeNull();
    expect(f.order['doorCashMismatchAt']).toBeNull();
    expect(f.claims).toBe(0);
    expect(f.committedFloat).toBe(0);
    expect(await adminPages(order.id, 'ops_cash_door_short')).toHaveLength(0);
  });

  it('an older app that sends no amount completes exactly as before, and nothing is attested for it', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);

    const res = await handover(holder.token, order.id, { outcome: 'paid' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ orderId: order.id, status: 'DELIVERED', claim: null });
    const f = await facts(order.id);
    expect(f.order.status).toBe('DELIVERED');
    expect(f.order.paymentStatus).toBe('CAPTURED');
    expect(f.order['doorCashCollectedAmount']).toBeNull();
    expect(f.order['doorCashMismatchAt']).toBeNull();
  });
});

describe('[row 34] over-collection is refused and nothing is written', () => {
  it('collected > due answers 409 CASH_OVER_DUE; the order is still at the door, unpaid', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);

    const res = await handover(holder.token, order.id, { outcome: 'paid', collectedAmount: DUE + 1, handoverVersion: await shownVersion(order.id) });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CASH_OVER_DUE');

    const f = await facts(order.id);
    expect(f.order.status).toBe('ARRIVED');
    expect(f.order.paymentStatus).toBe('PENDING');
    expect(f.order['doorCashCollectedAmount']).toBeNull();
    expect(f.statuses).not.toContain('DELIVERED');
    expect(f.earnings).toHaveLength(0);
    expect(f.committedFloat).toBe(SUBTOTAL);
  });
});

describe('[row 34] short cash: NO HANDOVER is the default (owner ruling, 5 Oct)', () => {
  it('collected < due without the handed-over acknowledgement is refused: do not hand over', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);

    const res = await handover(holder.token, order.id, { outcome: 'paid', collectedAmount: DUE - 1000, handoverVersion: await shownVersion(order.id) });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CASH_SHORT_NO_HANDOVER');

    const f = await facts(order.id);
    expect(f.order.status).toBe('ARRIVED');
    expect(f.order.paymentStatus).toBe('PENDING');
    expect(f.order['doorCashCollectedAmount']).toBeNull();
    expect(f.statuses).not.toContain('DELIVERED');
    expect(f.earnings).toHaveLength(0);
  });

  it('customer cannot pay in full → the order goes back to the store: RETURNING, one RETURN_REQUIRED case, ops paged, nobody struck or claimed against', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);

    const res = await handover(holder.token, order.id, { outcome: 'short_payment', collectedAmount: 2000, cashReturned: true, handoverVersion: await shownVersion(order.id) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('RETURNING');

    const f = await facts(order.id);
    expect(f.order.status).toBe('RETURNING');
    // No goods were handed over; the partial cash was handed back, not captured.
    expect(f.order.paymentStatus).toBe('PENDING');
    expect(f.order['doorCashCollectedAmount']).toBeNull();
    expect(f.order['doorCashMismatchAt']).toBeNull();
    expect(f.claims).toBe(0);
    expect(f.strikes).toBe(0);
    expect(f.earnings).toHaveLength(0);
    // The rider still holds the goods and the float until the store confirms.
    expect(f.committedFloat).toBe(SUBTOTAL);
    expect(f.cases).toHaveLength(1);
    expect(f.cases[0]!.state).toBe('RETURN_REQUIRED');
    expect(f.cases[0]!.reasonNote ?? '').toMatch(/could not pay in full/i);
    expect(f.statuses.filter((s) => s === 'RETURNING')).toHaveLength(1);
    expect(await adminPages(order.id, 'ops_custody_case')).toHaveLength(1);
  });

  it('a short payment while a recovery case is already open moves THAT case: one case, one outcome', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const opened = await report(holder.token, order.id);
    expect(opened.statusCode, opened.body).toBe(201);
    const caseId = opened.json().data.caseId as string;

    const res = await handover(holder.token, order.id, { outcome: 'short_payment', collectedAmount: 0, handoverVersion: await shownVersion(order.id) });
    expect(res.statusCode, res.body).toBe(200);

    const f = await facts(order.id);
    expect(f.order.status).toBe('RETURNING');
    expect(f.cases).toHaveLength(1);
    expect(f.cases[0]!.id).toBe(caseId);
    expect(f.cases[0]!.state).toBe('RETURN_REQUIRED');
    expect(f.statuses.filter((s) => s === 'RETURNING')).toHaveLength(1);
    expect(f.claims).toBe(0);
  });

  it('a retried short payment (same Idempotency-Key, or a lost answer) does not start a second return', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const body = { outcome: 'short_payment', collectedAmount: 1500, cashReturned: true, handoverVersion: await shownVersion(order.id) };
    const key = `cda-${nanoid(10)}`;
    const first = await handover(holder.token, order.id, body, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(200);
    const replay = await handover(holder.token, order.id, body, { 'idempotency-key': key });
    expect(replay.statusCode, replay.body).toBe(200);
    // A retry without the key (the answer was lost) answers the committed fact.
    const lost = await handover(holder.token, order.id, { outcome: 'short_payment', collectedAmount: 1500, cashReturned: true });
    expect(lost.statusCode, lost.body).toBe(200);
    expect(lost.json().data.status).toBe('RETURNING');

    const f = await facts(order.id);
    expect(f.cases).toHaveLength(1);
    expect(f.statuses.filter((s) => s === 'RETURNING')).toHaveLength(1);
    expect(await adminPages(order.id, 'ops_custody_case')).toHaveLength(1);
  });

  it('short payment never refunds a captured order and is refused once the goods were handed over', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const paid = await handover(holder.token, order.id, { outcome: 'paid', collectedAmount: DUE });
    expect(paid.statusCode, paid.body).toBe(200);
    const late = await handover(holder.token, order.id, { outcome: 'short_payment', collectedAmount: 100 });
    expect(late.statusCode, late.body).toBe(409);
    const f = await facts(order.id);
    expect(f.order.status).toBe('DELIVERED');
    expect(f.cases).toHaveLength(0);
  });

  it('refuses an unpaid return if cash is already recorded while the goods are still at the door', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    await app.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'CAPTURED' } });
    const res = await handover(holder.token, order.id, {
      outcome: 'short_payment', collectedAmount: 100, cashReturned: true, handoverVersion: await shownVersion(order.id),
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CASH_ALREADY_RECORDED');
    const f = await facts(order.id);
    expect(f.order.status).toBe('ARRIVED');
    expect(f.order.paymentStatus).toBe('CAPTURED');
    expect(f.cases).toHaveLength(0);
    expect(f.statuses).not.toContain('RETURNING');
  });

  it('handed over for less anyway: the real amount is recorded, the rider bears the difference, the mismatch is held and operations is paged — no claim, no strike, no deduction', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);

    const res = await handover(holder.token, order.id, {
      outcome: 'paid', collectedAmount: 2800, handedOverShort: true, handoverVersion: await shownVersion(order.id),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('DELIVERED');

    const f = await facts(order.id);
    expect(f.order.status).toBe('DELIVERED');
    expect(Number(f.order['doorCashCollectedAmount'])).toBe(2800);
    expect(Number(f.order['doorCashShortfallAmount'])).toBe(DUE - 2800);
    expect(f.order['doorCashMismatchAt']).toBeInstanceOf(Date);
    // Nothing is assumed and nothing is charged to anyone else: no guarantee
    // claim, no customer strike, and the rider's delivery earning is the
    // delivery fee as always (the rider simply holds less cash).
    expect(f.claims).toBe(0);
    expect(f.strikes).toBe(0);
    expect(f.earnings.reduce((s, e) => s + Number(e.amount), 0)).toBe(FEE);
    expect(f.committedFloat).toBe(0);
    const pages = await adminPages(order.id, 'ops_cash_door_short');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.body).toMatch(/2,800/);
    expect(pages[0]!.body).toMatch(/3,500/);
  });
});

describe('[row 34] the version echo: a stale screen records nothing', () => {
  it('refuses a stale screen before consuming any delivery-PIN attempt', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    await app.prisma.order.update({ where: { id: order.id }, data: { ridePin: '314159' } });
    const stale = await shownVersion(order.id);
    await app.prisma.order.update({ where: { id: order.id }, data: { deliveryInstructions: 'Fixture door changed' } });
    const response = await handover(holder.token, order.id, {
      outcome: 'paid', collectedAmount: DUE, handoverVersion: stale, ridePin: '000000',
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe('HANDOVER_STALE');
    const row = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id }, select: { status: true, ridePinAttempts: true, doorCashCollectedAmount: true },
    });
    expect(row).toEqual({ status: 'ARRIVED', ridePinAttempts: 0, doorCashCollectedAmount: null });
  });

  it('a stale handoverVersion answers 409 HANDOVER_STALE and the order is untouched; the current one completes', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const stale = await shownVersion(order.id);
    // The order changes after the screen loaded (any committed write moves the version).
    await app.prisma.order.update({ where: { id: order.id }, data: { deliveryInstructions: 'gate code changed' } });

    for (const body of [
      { outcome: 'paid', collectedAmount: DUE, handoverVersion: stale },
      { outcome: 'short_payment', collectedAmount: 0, handoverVersion: stale },
    ]) {
      const res = await handover(holder.token, order.id, body);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('HANDOVER_STALE');
    }
    const after = await facts(order.id);
    expect(after.order.status).toBe('ARRIVED');
    expect(after.order['doorCashCollectedAmount']).toBeNull();
    expect(after.cases).toHaveLength(0);

    const res = await handover(holder.token, order.id, { outcome: 'paid', collectedAmount: DUE, handoverVersion: await shownVersion(order.id) });
    expect(res.statusCode, res.body).toBe(200);
    expect((await facts(order.id)).order.status).toBe('DELIVERED');
  });

  it('rechecks the version after locking when the total changed after the preview', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const version = await shownVersion(order.id);
    const orders = new OrderService(app.prisma, app.io);
    const cash = new CashRulesService(app.prisma, new NotificationService(app.prisma, app.io), orders);
    const transition = orders.updateStatus.bind(orders);
    const seam = vi.spyOn(orders, 'updateStatus').mockImplementationOnce(async (...args) => {
      await app.prisma.order.update({ where: { id: order.id }, data: { totalAmount: DUE + 100 } });
      return transition(...args);
    });
    try {
      await expect(cash.handover(order.id, holder.user.id, {
        outcome: 'paid', collectedAmount: DUE, handedOverShort: true, handoverVersion: version, gps: DOOR,
      })).rejects.toMatchObject({ code: 'HANDOVER_STALE' });
      expect(seam).toHaveBeenCalledOnce();
      const f = await facts(order.id);
      expect(f.order.status).toBe('ARRIVED');
      expect(f.order['doorCashCollectedAmount']).toBeNull();
      expect(f.order.paymentStatus).toBe('PENDING');
      expect(f.earnings).toHaveLength(0);
    } finally { seam.mockRestore(); }
  });

  it('uses the locked total for cash even if a caller omits the optional version echo', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const orders = new OrderService(app.prisma, app.io);
    const cash = new CashRulesService(app.prisma, new NotificationService(app.prisma, app.io), orders);
    const transition = orders.updateStatus.bind(orders);
    const seam = vi.spyOn(orders, 'updateStatus').mockImplementationOnce(async (...args) => {
      await app.prisma.order.update({ where: { id: order.id }, data: { totalAmount: DUE + 100 } });
      return transition(...args);
    });
    try {
      await expect(cash.handover(order.id, holder.user.id, {
        outcome: 'paid', collectedAmount: DUE, gps: DOOR,
      })).rejects.toMatchObject({ code: 'CASH_SHORT_NO_HANDOVER' });
      expect(seam).toHaveBeenCalledOnce();
      const f = await facts(order.id);
      expect(f.order.status).toBe('ARRIVED');
      expect(f.order.paymentStatus).toBe('PENDING');
      expect(f.order['doorCashCollectedAmount']).toBeNull();
      expect(f.earnings).toHaveLength(0);
    } finally { seam.mockRestore(); }
  });
});

describe('[row 34] cash attestation commits with all terminal facts', () => {
  it('a failed commit rolls back the amount and hold; retry records them and the earning once', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const orders = new OrderService(app.prisma, app.io);
    let fail = true;
    const cash = new CashRulesService(app.prisma, new NotificationService(app.prisma, app.io), orders, {
      afterTerminalFacts: async () => {
        if (fail) { fail = false; throw new Error('cash-attestation commit failpoint'); }
      },
    });
    const input = {
      outcome: 'paid' as const, collectedAmount: 2800, handedOverShort: true,
      handoverVersion: await shownVersion(order.id), gps: DOOR,
    };
    await expect(cash.handover(order.id, holder.user.id, input)).rejects.toThrow('cash-attestation commit failpoint');
    const rolledBack = await facts(order.id);
    expect(rolledBack.order.status).toBe('ARRIVED');
    expect(rolledBack.order.paymentStatus).toBe('PENDING');
    expect(rolledBack.order['doorCashCollectedAmount']).toBeNull();
    expect(rolledBack.order['doorCashMismatchAt']).toBeNull();
    expect(rolledBack.earnings).toHaveLength(0);
    expect(rolledBack.committedFloat).toBe(SUBTOTAL);
    expect(await adminPages(order.id, 'ops_cash_door_short')).toHaveLength(0);

    await cash.handover(order.id, holder.user.id, input);
    await cash.handover(order.id, holder.user.id, input);
    const committed = await facts(order.id);
    expect(Number(committed.order['doorCashCollectedAmount'])).toBe(2800);
    expect(Number(committed.order['doorCashShortfallAmount'])).toBe(700);
    expect(committed.order['doorCashMismatchAt']).toBeInstanceOf(Date);
    expect(committed.statuses.filter((s) => s === 'DELIVERED')).toHaveLength(1);
    expect(committed.earnings).toHaveLength(1);
    expect(Number(committed.earnings[0]!.amount)).toBe(FEE);
    expect(committed.committedFloat).toBe(0);
    expect(await adminPages(order.id, 'ops_cash_door_short')).toHaveLength(1);
  });
});


describe('[row 34] partial cash is returned at the door or held for operations (owner, 7 Oct)', () => {
  it('requires cash-return confirmation before a positive partial-cash report can move the goods', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const res = await handover(holder.token, order.id, { outcome: 'short_payment', collectedAmount: 2000 });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CASH_RETURN_CONFIRMATION_REQUIRED');
    const f = await facts(order.id);
    expect(f.order.status).toBe('ARRIVED');
    expect(f.order.paymentStatus).toBe('PENDING');
    expect(f.cases).toHaveLength(0);
    expect(f.earnings).toHaveLength(0);
  });

  it('cash returned records the actual amount handed back with the goods return, without capturing or refunding', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const res = await handover(holder.token, order.id, { outcome: 'short_payment', collectedAmount: 2000, cashReturned: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.cashReturn).toEqual({ amount: 2000, status: 'RETURNED', heldForReview: false });
    const f = await facts(order.id);
    expect(f.order.status).toBe('RETURNING');
    expect(f.order.paymentStatus).toBe('PENDING');
    expect(f.order['doorCashCollectedAmount']).toBeNull();
    expect(Number(f.order['doorCashReturnAmount'])).toBe(2000);
    expect(f.order['doorCashReturnStatus']).toBe('RETURNED');
    expect(f.order['doorCashReturnRecordedAt']).toBeInstanceOf(Date);
    expect(f.order.refundOwedAmount).toBeNull();
    expect(f.order.refundPaidAmount).toBeNull();
    expect(f.claims).toBe(0);
    expect(f.strikes).toBe(0);
    expect(f.earnings).toHaveLength(0);
    expect(f.committedFloat).toBe(SUBTOTAL);
    expect(f.cases).toHaveLength(1);
    expect(f.cases[0]!.reasonNote).toMatch(/cash returned.*2,000/i);
    expect(await adminPages(order.id, 'ops_cash_return_held')).toHaveLength(0);
  });

  it('partial cash that could not be returned stays recorded and held, pages operations once, and cannot be overwritten by a retry', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const body = { outcome: 'short_payment', collectedAmount: 2000, cashReturned: false };
    const first = await handover(holder.token, order.id, body);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.cashReturn).toEqual({ amount: 2000, status: 'HELD', heldForReview: true });
    const replay = await handover(holder.token, order.id, body);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data.cashReturn).toEqual(first.json().data.cashReturn);
    const contradictory = await handover(holder.token, order.id, { ...body, cashReturned: true });
    expect(contradictory.statusCode, contradictory.body).toBe(409);
    expect(contradictory.json().error.code).toBe('CASH_RETURN_ALREADY_RECORDED');
    const changedAmount = await handover(holder.token, order.id, { ...body, collectedAmount: 1000 });
    expect(changedAmount.statusCode, changedAmount.body).toBe(409);
    expect(changedAmount.json().error.code).toBe('CASH_RETURN_ALREADY_RECORDED');
    const f = await facts(order.id);
    expect(f.order.status).toBe('RETURNING');
    expect(f.order.paymentStatus).toBe('PENDING');
    expect(Number(f.order['doorCashReturnAmount'])).toBe(2000);
    expect(f.order['doorCashReturnStatus']).toBe('HELD');
    expect(f.order['doorCashReturnRecordedAt']).toBeInstanceOf(Date);
    expect(f.order['doorCashCollectedAmount']).toBeNull();
    expect(f.order['doorCashShortfallAmount']).toBeNull();
    expect(f.order.refundOwedAmount).toBeNull();
    expect(f.order.refundPaidAmount).toBeNull();
    expect(f.claims).toBe(0);
    expect(f.strikes).toBe(0);
    expect(f.earnings).toHaveLength(0);
    expect(f.committedFloat).toBe(SUBTOTAL);
    expect(f.cases).toHaveLength(1);
    expect(f.cases[0]!.reasonNote).toMatch(/cash.*2,000.*held/i);
    expect(f.statuses.filter((s) => s === 'RETURNING')).toHaveLength(1);
    const pages = await adminPages(order.id, 'ops_cash_return_held');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.body).toMatch(/2,000/);
  });

  it('keeps an unstated old request unchanged without inventing a cash-return record', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const res = await handover(holder.token, order.id, { outcome: 'short_payment' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).not.toHaveProperty('cashReturn');
    const f = await facts(order.id);
    expect(f.order.status).toBe('RETURNING');
    expect(f.order.paymentStatus).toBe('PENDING');
    expect(f.order['doorCashReturnAmount']).toBeNull();
    expect(f.order['doorCashReturnStatus']).toBeNull();
  });

  it.each([
    { outcome: 'short_payment', cashReturned: false },
    { outcome: 'short_payment', collectedAmount: 0, cashReturned: false },
    { outcome: 'short_payment', collectedAmount: 2000, cashReturned: true, handedOverShort: true },
    { outcome: 'paid', collectedAmount: DUE, cashReturned: true },
  ])('rejects contradictory or unknown partial cash: %j', async (body) => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const res = await handover(holder.token, order.id, body);
    expect(res.statusCode, res.body).toBe(400);
    const f = await facts(order.id);
    expect(f.order.status).toBe('ARRIVED');
    expect(f.cases).toHaveLength(0);
    expect(f.earnings).toHaveLength(0);
  });
});


describe('[row 34] partial cash and its operations page are one durable generation', () => {
  it('rechecks the cash-return version under the order lock', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const handoverVersion = await shownVersion(order.id);
    const orders = new OrderService(app.prisma, app.io);
    const cash = new CashRulesService(app.prisma, new NotificationService(app.prisma, app.io), orders);
    const transition = orders.transitionOrderAtomically.bind(orders);
    const seam = vi.spyOn(orders, 'transitionOrderAtomically').mockImplementationOnce(async (...args) => {
      await app.prisma.order.update({ where: { id: order.id }, data: { totalAmount: DUE + 100 } });
      return transition(...args);
    });
    try {
      await expect(cash.handover(order.id, holder.user.id, {
        outcome: 'short_payment', collectedAmount: 2000, cashReturned: true, handoverVersion, gps: DOOR,
      })).rejects.toMatchObject({ code: 'HANDOVER_STALE' });
      expect(seam).toHaveBeenCalledOnce();
      const f = await facts(order.id);
      expect(f.order.status).toBe('ARRIVED');
      expect(f.order['doorCashReturnAmount']).toBeNull();
      expect(f.cases).toHaveLength(0);
    } finally { seam.mockRestore(); }
  });

  it('rolls back held cash, custody and the operations page together, then retries once', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const observer = { afterCashReturnFacts: vi.fn().mockRejectedValueOnce(new Error('cash-return-cut')) };
    const cash = new CashRulesService(app.prisma, new NotificationService(app.prisma, app.io), new OrderService(app.prisma, app.io), observer);
    const input = { outcome: 'short_payment' as const, collectedAmount: 2000, cashReturned: false, gps: DOOR };
    await expect(cash.handover(order.id, holder.user.id, input)).rejects.toThrow('cash-return-cut');
    const failed = await facts(order.id);
    expect(failed.order.status).toBe('ARRIVED');
    expect(failed.order['doorCashReturnStatus']).toBeNull();
    expect(failed.order['doorCashReturnAmount']).toBeNull();
    expect(failed.cases).toHaveLength(0);
    expect(await adminPages(order.id, 'ops_cash_return_held')).toHaveLength(0);
    expect(await app.prisma.opsAlert.count({ where: { body: { contains: order.orderNumber } } })).toBe(0);
    const retried = await cash.handover(order.id, holder.user.id, input);
    expect(retried.cashReturn).toEqual({ amount: 2000, status: 'HELD', heldForReview: true });
    expect(await adminPages(order.id, 'ops_cash_return_held')).toHaveLength(1);
    expect(await app.prisma.opsAlert.count({ where: { body: { contains: order.orderNumber } } })).toBe(1);
  });

  it('retains the held amount and durable operations inbox if post-commit fanout fails', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const notifications = new NotificationService(app.prisma, app.io);
    const fanout = vi.spyOn(notifications, 'publishPersisted').mockRejectedValue(new Error('fanout-offline'));
    const cash = new CashRulesService(app.prisma, notifications, new OrderService(app.prisma, app.io));
    const result = await cash.handover(order.id, holder.user.id, { outcome: 'short_payment', collectedAmount: 2000, cashReturned: false, gps: DOOR });
    expect(result.cashReturn?.status).toBe('HELD');
    expect(fanout).toHaveBeenCalled();
    const pages = await adminPages(order.id, 'ops_cash_return_held');
    expect(pages).toHaveLength(1);
    const data = pages[0]!.data as { opsAlertId: string };
    const alert = await app.prisma.opsAlert.findUniqueOrThrow({ where: { id: data.opsAlertId }, include: { recipients: true } });
    expect(alert.acknowledgedAt).toBeNull();
    expect(alert.closedAt).toBeNull();
    expect(alert.recipients.some((r) => r.userId === adminUserId && r.notificationId === pages[0]!.id)).toBe(true);
    expect((await facts(order.id)).order['doorCashReturnStatus']).toBe('HELD');
  });

  it('checks partial cash against the locked total and leaves no hold if the total changed', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const orders = new OrderService(app.prisma, app.io);
    const cash = new CashRulesService(app.prisma, new NotificationService(app.prisma, app.io), orders);
    const transition = orders.transitionOrderAtomically.bind(orders);
    const seam = vi.spyOn(orders, 'transitionOrderAtomically').mockImplementationOnce(async (...args) => {
      await app.prisma.order.update({ where: { id: order.id }, data: { totalAmount: 1000 } });
      return transition(...args);
    });
    try {
      await expect(cash.handover(order.id, holder.user.id, { outcome: 'short_payment', collectedAmount: 2000, cashReturned: false, gps: DOOR }))
        .rejects.toMatchObject({ code: 'CASH_NOT_SHORT' });
      expect(seam).toHaveBeenCalledOnce();
      const f = await facts(order.id);
      expect(f.order.status).toBe('ARRIVED');
      expect(f.order['doorCashReturnStatus']).toBeNull();
      expect(f.cases).toHaveLength(0);
      expect(await adminPages(order.id, 'ops_cash_return_held')).toHaveLength(0);
    } finally { seam.mockRestore(); }
  });
});


describe('[row 34] cash-return retries and operations scope', () => {
  it.each(['rider', 'customer'])('keeps the %s account open while partial cash remains held after goods return', async (role) => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    await app.prisma.order.update({ where: { id: order.id }, data: {
      status: 'RETURNED', doorCashReturnAmount: 2000, doorCashReturnStatus: 'HELD', doorCashReturnRecordedAt: new Date(),
    } });
    // The goods and the store's fronted cash have come back. The customer's
    // separate partial cash is still with the rider, held for operations.
    await app.prisma.rider.update({ where: { id: holder.rider.id }, data: { committedFloat: 0 } });
    const userId = role === 'rider' ? holder.user.id : customer.user.id;
    const obligations = await app.prisma.$transaction((tx) => partnerObligations(tx, userId));
    expect(verdictFor(obligations).clear).toBe(false);
    expect(verdictFor(obligations).blockers).toContain('PARTIAL_CASH_RETURN');
    await expect(new AccountService(app).deleteAccount(userId)).rejects.toMatchObject({
      code: 'PARTNER_OBLIGATIONS',
      message: expect.stringMatching(/partial cash.*returned to the customer.*Get help.*confirm/i),
    });
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: userId } })).status).toBe('ACTIVE');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).doorCashReturnStatus).toBe('HELD');
  });

  it.each(['rider', 'customer'])('keeps the %s account open when goods return between deletion reads', async (role) => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    await app.prisma.rider.update({ where: { id: holder.rider.id }, data: { committedFloat: 0 } });
    const userId = role === 'rider' ? holder.user.id : customer.user.id;
    const realTransaction = app.prisma.$transaction.bind(app.prisma) as (...args: unknown[]) => Promise<unknown>;
    let crossed = false;
    const spy = vi.spyOn(app.prisma, '$transaction').mockImplementation((async (work: unknown, options?: unknown) => {
      if (typeof work !== 'function') return realTransaction(work, options);
      return realTransaction(async (tx: Prisma.TransactionClient) => {
        const orders = new Proxy(tx.order, { get(target, property) {
          if (property !== 'count') return Reflect.get(target, property);
          return async (args: Prisma.OrderCountArgs) => {
            if (!crossed && args.where?.status) {
              crossed = true;
              // Deterministic interleaving: goods return commits before the
              // active-work read, after any earlier cash census. The cash
              // still belongs to the customer and is still with this rider.
              await tx.order.update({ where: { id: order.id }, data: {
                status: 'RETURNED', doorCashReturnAmount: 2000, doorCashReturnStatus: 'HELD', doorCashReturnRecordedAt: new Date(),
              } });
            }
            return target.count(args);
          };
        } });
        return work(new Proxy(tx, { get(target, property) {
          return property === 'order' ? orders : Reflect.get(target, property);
        } }));
      }, options);
    }) as never);
    try {
      await expect(new AccountService(app).deleteAccount(userId)).rejects.toMatchObject({ code: 'PARTNER_OBLIGATIONS' });
      expect(crossed).toBe(true);
    } finally { spy.mockRestore(); }
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: userId } })).status).toBe('ACTIVE');
  });

  it('counts held partial cash only for its customer and holder, until cash is returned', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const unrelated = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    await app.prisma.order.update({ where: { id: order.id }, data: {
      status: 'RETURNED', doorCashReturnAmount: 2000, doorCashReturnStatus: 'HELD', doorCashReturnRecordedAt: new Date(),
    } });
    await app.prisma.rider.update({ where: { id: holder.rider.id }, data: { committedFloat: 0 } });
    const census = (userId: string) => app.prisma.$transaction((tx) => partnerObligations(tx, userId));
    expect(verdictFor(await census(unrelated.user.id)).clear).toBe(true);
    // No operations acknowledgement can settle this: the cash fact itself
    // must show RETURNED. Goods status is already RETURNED throughout.
    for (const userId of [holder.user.id, customer.user.id]) {
      expect(verdictFor(await census(userId)).blockers).toContain('PARTIAL_CASH_RETURN');
    }
    await app.prisma.order.update({ where: { id: order.id }, data: { doorCashReturnStatus: 'RETURNED' } });
    for (const userId of [holder.user.id, customer.user.id]) {
      expect(verdictFor(await census(userId)).clear).toBe(true);
    }
  });

  it.each(['failed', 'missing'])('refuses to resolve a cash page when tenant classification is %s', async (state) => {
    const unavailable = new Error('tenant lookup unavailable');
    const findUnique = state === 'failed' ? vi.fn().mockRejectedValue(unavailable) : vi.fn().mockResolvedValue(null);
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { tenant: { findUnique }, user: { findMany } } as unknown as PrismaClient;
    await expect(doorCashHoldAudience(client, 'unresolved-cash-tenant')).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('refuses an operations audience resolved for a different tenant before any cash page is written', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const foreign = await app.prisma.tenant.create({ data: { name: 'Cash audience fixture', slug: `cash-audience-${nanoid(10)}` } });
    createdTenantIds.push(foreign.id);
    seq += 1;
    const user = await app.prisma.user.create({ data: {
      phone: `+592${PHONE_RUN}${String(seq).padStart(3, '0')}`, firstName: 'Ops', lastName: 'CashAudience',
      tenantId: foreign.id, roles: ['ADMIN'], activeRole: 'ADMIN', status: 'ACTIVE',
    } });
    createdUserIds.push(user.id);
    const audience = await doorCashHoldAudience(app.prisma, foreign.id);
    await expect(app.prisma.$transaction((tx) => stageDoorCashHoldPage(tx, order, 2000, audience)))
      .rejects.toMatchObject({ code: 'HANDOVER_STALE' });
    expect(await app.prisma.opsAlert.count({ where: { body: { contains: order.orderNumber } } })).toBe(0);
  });

  it('never acknowledges an unrecorded positive cash amount on a previously unstated return', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    expect((await handover(holder.token, order.id, { outcome: 'short_payment' })).statusCode).toBe(200);
    const changed = await handover(holder.token, order.id, { outcome: 'short_payment', collectedAmount: 2000, cashReturned: false });
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().error.code).toBe('CASH_RETURN_ALREADY_RECORDED');
    const f = await facts(order.id);
    expect(f.order['doorCashReturnAmount']).toBeNull();
    expect(f.cases).toHaveLength(1);
  });

  it('two concurrent partial-cash reports produce one held fact, one case and one operations obligation', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const body = { outcome: 'short_payment', collectedAmount: 2000, cashReturned: false };
    const responses = await Promise.all([handover(holder.token, order.id, body), handover(holder.token, order.id, body)]);
    expect(responses.map((r) => r.statusCode)).toContain(200);
    expect(responses.every((r) => r.statusCode === 200 || r.statusCode === 409)).toBe(true);
    const f = await facts(order.id);
    expect(f.cases).toHaveLength(1);
    expect(f.statuses.filter((s) => s === 'RETURNING')).toHaveLength(1);
    expect(Number(f.order['doorCashReturnAmount'])).toBe(2000);
    expect(f.order['doorCashReturnStatus']).toBe('HELD');
    expect(await adminPages(order.id, 'ops_cash_return_held')).toHaveLength(1);
    expect(await app.prisma.opsAlert.count({ where: { body: { contains: order.orderNumber } } })).toBe(1);
  });

  it('pages the order tenant and platform admins without disclosing held cash to another tenant admin', async () => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const foreign = await app.prisma.tenant.create({ data: { name: 'Cash test tenant', slug: `cash-foreign-${nanoid(10)}` } });
    createdTenantIds.push(foreign.id);
    const ids: string[] = [];
    for (const tenantId of [order.tenantId, foreign.id]) {
      seq += 1;
      const user = await app.prisma.user.create({ data: {
        phone: `+592${PHONE_RUN}${String(seq).padStart(3, '0')}`, firstName: 'Ops', lastName: 'CashScope',
        tenantId, roles: ['ADMIN'], activeRole: 'ADMIN', status: 'ACTIVE',
      } });
      createdUserIds.push(user.id); ids.push(user.id);
    }
    const res = await handover(holder.token, order.id, { outcome: 'short_payment', collectedAmount: 2000, cashReturned: false });
    expect(res.statusCode, res.body).toBe(200);
    const notices = await runWithoutTenant(() => app.prisma.notification.findMany({
      where: { userId: { in: ids }, dedupeKey: `cash-return-held:${order.id}` }, select: { userId: true },
    }), 'test:cash-return-tenant');
    expect(notices).toEqual([{ userId: ids[0] }]);
    expect(await adminPages(order.id, 'ops_cash_return_held')).toHaveLength(1);
  });

  it('never pages real operators about review-tenant partial cash', async () => {
    const tenant = await app.prisma.tenant.create({ data: { name: 'Cash review fixture', slug: `cash-review-${nanoid(10)}`, kind: 'REVIEW' } });
    createdTenantIds.push(tenant.id);
    const audience = await doorCashHoldAudience(app.prisma, tenant.id);
    expect(audience).toEqual({ tenantId: tenant.id, suppressed: true, userIds: [] });
    const order = { id: `review-${nanoid(10)}`, orderNumber: `REVIEW-CASH-${nanoid(10)}`, tenantId: tenant.id };
    const ids = await app.prisma.$transaction((tx) => stageDoorCashHoldPage(tx, order, 2000, audience));
    expect(ids).toEqual([]);
    expect(await app.prisma.opsAlert.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});


describe('[row 34] the database refuses contradictory cash-return evidence', () => {
  it.each(['collected', 'shortfall', 'return'])('refuses numeric NaN in persisted %s cash', async (column) => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    const statement = column === 'collected'
      ? Prisma.sql`UPDATE orders SET "doorCashCollectedAmount" = 'NaN'::numeric WHERE id = ${order.id}`
      : column === 'shortfall'
        ? Prisma.sql`UPDATE orders SET "doorCashCollectedAmount" = 0, "doorCashShortfallAmount" = 'NaN'::numeric, "doorCashMismatchAt" = NOW() WHERE id = ${order.id}`
        : Prisma.sql`UPDATE orders SET "doorCashReturnAmount" = 'NaN'::numeric, "doorCashReturnStatus" = 'HELD', "doorCashReturnRecordedAt" = NOW() WHERE id = ${order.id}`;
    await expect(app.prisma.$executeRaw(statement)).rejects.toThrow(/check constraint/i);
    const f = await facts(order.id);
    expect(f.order['doorCashCollectedAmount']).toBeNull();
    expect(f.order['doorCashShortfallAmount']).toBeNull();
    expect(f.order['doorCashReturnAmount']).toBeNull();
  });

  it.each([
    { doorCashReturnAmount: -1, doorCashReturnStatus: 'HELD', doorCashReturnRecordedAt: new Date() },
    { doorCashReturnAmount: 0, doorCashReturnStatus: 'HELD', doorCashReturnRecordedAt: new Date() },
    { doorCashReturnAmount: 0.5, doorCashReturnStatus: 'RETURNED', doorCashReturnRecordedAt: new Date() },
    { doorCashReturnAmount: 2000, doorCashReturnStatus: null, doorCashReturnRecordedAt: new Date() },
    { doorCashReturnAmount: 2000, doorCashReturnStatus: 'HELD', doorCashReturnRecordedAt: null },
    { doorCashReturnAmount: 2000, doorCashReturnStatus: 'UNKNOWN', doorCashReturnRecordedAt: new Date() },
    { doorCashReturnAmount: 2000, doorCashReturnStatus: 'HELD', doorCashReturnRecordedAt: new Date(), doorCashCollectedAmount: 2000 },
  ])('rejects invalid persisted evidence: %j', async (data) => {
    const holder = await makeRider();
    const customer = await makeCustomer();
    const order = await orderAtDoor(holder.rider.id, customer.user.id);
    await expect(app.prisma.order.update({ where: { id: order.id }, data })).rejects.toThrow(/check constraint/i);
    const f = await facts(order.id);
    expect(f.order['doorCashReturnAmount']).toBeNull();
    expect(f.order['doorCashReturnStatus']).toBeNull();
    expect(f.order['doorCashReturnRecordedAt']).toBeNull();
  });
});
