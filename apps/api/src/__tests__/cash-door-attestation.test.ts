import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
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
const SUBTOTAL = 3000;
const FEE = 500;
const DUE = SUBTOTAL + FEE;

let app: FastifyInstance;
const createdUserIds: string[] = [];
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
      phone: `+5920041${String(seq).padStart(3, '0')}${String(Date.now()).slice(-2)}`,
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
      phone: `+5920042${String(seq).padStart(3, '0')}${String(Date.now()).slice(-2)}`,
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
      phone: `+5920043${String(Date.now()).slice(-5)}`, firstName: 'Ops', lastName: `Door${RUN}`,
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
    await app.prisma.earning.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { id: { in: sessionIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
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

    const res = await handover(holder.token, order.id, { outcome: 'short_payment', collectedAmount: 2000, handoverVersion: await shownVersion(order.id) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('RETURNING');

    const f = await facts(order.id);
    expect(f.order.status).toBe('RETURNING');
    // Nothing was handed over, so nothing was collected or captured.
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
    const body = { outcome: 'short_payment', collectedAmount: 1500, handoverVersion: await shownVersion(order.id) };
    const key = `cda-${nanoid(10)}`;
    const first = await handover(holder.token, order.id, body, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(200);
    const replay = await handover(holder.token, order.id, body, { 'idempotency-key': key });
    expect(replay.statusCode, replay.body).toBe(200);
    // A retry without the key (the answer was lost) answers the committed fact.
    const lost = await handover(holder.token, order.id, { outcome: 'short_payment', collectedAmount: 1500 });
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
});
