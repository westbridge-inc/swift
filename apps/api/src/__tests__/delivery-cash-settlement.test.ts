import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { OrderService } from '../modules/order/order.service';
import { DeliveryCashSettlementService } from '../modules/cash/delivery-cash-settlement.service';
import { NotificationService } from '../modules/notification/notification.service';
import { settle } from '../modules/fulfillment/money-matrix';
import { registerErrorHandler } from '../middleware/error-handler';

// MMG Phase 3: for an MMG-paid delivery the customer paid the STORE, so the
// store owes the rider the delivery fee in cash. Swift records the debt and a
// dual-confirm (rider "received" + store "paid") settles it. No money moves.

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let orders: OrderService;
const userIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200741${String(seq).padStart(2, '0')}`,
      firstName: 'Ledger', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'ledger-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeVendor(ownerUserId: string, name = 'Ledger Diner') {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name, slug: `${name.toLowerCase().replace(/ /g, '-')}-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: '+5920074100', addressLine1: '5 Deal Street', city: 'Georgetown', region: 'Demerara-Mahaica',
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

function inject(method: 'GET' | 'POST', url: string, token: string, payload?: unknown, vendorId?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
      ...(vendorId ? { 'x-vendor-id': vendorId } : {}),
    },
  });
}

let vendorOwner: { userId: string; token: string };
let vendorId: string;
let rider: { userId: string; token: string };
let riderId: string;
let outsiderRider: { userId: string; token: string };
let customer: { userId: string; token: string };

async function makeDeliveredOrder(opts: { payment: 'CASH' | 'MOBILE_MONEY'; fee?: number; withRider?: boolean }) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `LGR-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId: customer.userId, vendorId, status: 'DELIVERED',
      ...(opts.withRider === false ? {} : { riderId }),
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: opts.fee ?? 300, totalAmount: 1000 + (opts.fee ?? 300),
      paymentMethod: opts.payment,
    },
  });
  await orders.createEarnings(order.id);
  return order.id;
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
  await app.ready();
  orders = new OrderService(app.prisma, app.io);

  vendorOwner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  vendorId = await makeVendor(vendorOwner.userId);
  rider = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  riderId = await makeRider(rider.userId);
  outsiderRider = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  await makeRider(outsiderRider.userId);
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  await app.prisma.deliveryCashSettlement.deleteMany({ where: { rider: { userId: { in: userIds } } } });
  await app.prisma.earning.deleteMany({ where: { rider: { userId: { in: userIds } } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('debt recording (createEarnings)', () => {
  it('an MMG delivery births an OWED settlement for the delivery fee', async () => {
    const orderId = await makeDeliveredOrder({ payment: 'MOBILE_MONEY', fee: 450 });
    const row = await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('OWED');
    expect(Number(row!.amount)).toBe(450);
    expect(row!.riderId).toBe(riderId);
    expect(row!.vendorId).toBe(vendorId);
  });

  it('is idempotent — createEarnings twice keeps ONE settlement', async () => {
    const orderId = await makeDeliveredOrder({ payment: 'MOBILE_MONEY' });
    await orders.createEarnings(orderId);
    const rows = await app.prisma.deliveryCashSettlement.findMany({ where: { orderId } });
    expect(rows.length).toBe(1);
  });

  it('a CASH delivery records no debt (rider already holds the cash)', async () => {
    const orderId = await makeDeliveredOrder({ payment: 'CASH' });
    const row = await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } });
    expect(row).toBeNull();
  });

  it('no rider (pickup order) → no debt', async () => {
    const orderId = await makeDeliveredOrder({ payment: 'MOBILE_MONEY', withRider: false });
    const row = await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } });
    expect(row).toBeNull();
  });

  it('zero delivery fee → no debt', async () => {
    const orderId = await makeDeliveredOrder({ payment: 'MOBILE_MONEY', fee: 0 });
    const row = await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } });
    expect(row).toBeNull();
  });
});

describe('dual-confirm ledger', () => {
  it('rider first, then store → RIDER_CONFIRMED → SETTLED', async () => {
    const orderId = await makeDeliveredOrder({ payment: 'MOBILE_MONEY', fee: 500 });
    const row = (await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } }))!;

    const r1 = await inject('POST', `/api/v1/rider/cash-settlements/${row.id}/confirm`, rider.token, {});
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.status).toBe('RIDER_CONFIRMED');
    expect(r1.json().data.riderConfirmedAt).toBeTruthy();

    const r2 = await inject('POST', `/api/v1/vendor/cash-settlements/${row.id}/confirm`, vendorOwner.token, {}, vendorId);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().data.status).toBe('SETTLED');
    expect(r2.json().data.storeConfirmedAt).toBeTruthy();
  });

  it('store first, then rider → STORE_CONFIRMED → SETTLED', async () => {
    const orderId = await makeDeliveredOrder({ payment: 'MOBILE_MONEY' });
    const row = (await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } }))!;

    const s1 = await inject('POST', `/api/v1/vendor/cash-settlements/${row.id}/confirm`, vendorOwner.token, {}, vendorId);
    expect(s1.json().data.status).toBe('STORE_CONFIRMED');

    const s2 = await inject('POST', `/api/v1/rider/cash-settlements/${row.id}/confirm`, rider.token, {});
    expect(s2.json().data.status).toBe('SETTLED');
  });

  it('double-confirm by the same side is a no-op (idempotent)', async () => {
    const orderId = await makeDeliveredOrder({ payment: 'MOBILE_MONEY' });
    const row = (await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } }))!;

    await inject('POST', `/api/v1/rider/cash-settlements/${row.id}/confirm`, rider.token, {});
    const again = await inject('POST', `/api/v1/rider/cash-settlements/${row.id}/confirm`, rider.token, {});
    expect(again.statusCode).toBe(200);
    expect(again.json().data.status).toBe('RIDER_CONFIRMED'); // still waiting on the store

    const first = await app.prisma.deliveryCashSettlement.findUnique({ where: { id: row.id } });
    expect(first!.storeConfirmedAt).toBeNull();
  });

  it("another rider can't confirm my settlement (404 — existence hidden)", async () => {
    const orderId = await makeDeliveredOrder({ payment: 'MOBILE_MONEY' });
    const row = (await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } }))!;
    const res = await inject('POST', `/api/v1/rider/cash-settlements/${row.id}/confirm`, outsiderRider.token, {});
    expect(res.statusCode).toBe(404);
  });

  it("an unrelated vendor owner can't confirm this store's settlement", async () => {
    const orderId = await makeDeliveredOrder({ payment: 'MOBILE_MONEY' });
    const row = (await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } }))!;
    const stranger = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    await makeVendor(stranger.userId, 'Stranger Shop');
    const res = await inject('POST', `/api/v1/vendor/cash-settlements/${row.id}/confirm`, stranger.token, {});
    expect(res.statusCode).toBe(404);
  });

  it('confirming notifies the other side', async () => {
    const orderId = await makeDeliveredOrder({ payment: 'MOBILE_MONEY' });
    const row = (await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } }))!;
    await inject('POST', `/api/v1/vendor/cash-settlements/${row.id}/confirm`, vendorOwner.token, {}, vendorId);
    const note = await app.prisma.notification.findFirst({
      where: { userId: rider.userId, data: { path: ['settlementId'], equals: row.id } },
    });
    expect(note).not.toBeNull();
    expect(note!.body).toContain('Confirm you received it');
  });
});

describe('ledger lists', () => {
  it('rider sees owed rows + total; settled rows move to history', async () => {
    const res = await inject('GET', '/api/v1/rider/cash-settlements', rider.token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    // Everything OWED or STORE_CONFIRMED counts as still-owed for the rider.
    expect(data.summary.owed).toBeGreaterThan(0);
    expect(data.summary.count).toBeGreaterThan(0);
    expect(Array.isArray(data.unsettled)).toBe(true);
    expect(Array.isArray(data.settled)).toBe(true);
    expect(data.settled.length).toBeGreaterThan(0); // from the dual-confirm tests
    for (const s of data.unsettled) {
      expect(s.status).not.toBe('SETTLED');
      expect(s.vendor?.name).toBeTruthy();
      expect(s.vendor?.phone).toBeTruthy(); // reachable to make the cash handover
      expect(typeof s.amount).toBe('number');
    }
  });

  it("store sees what it owes; rows it confirmed don't count in the total", async () => {
    const res = await inject('GET', '/api/v1/vendor/cash-settlements', vendorOwner.token, undefined, vendorId);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    const owedStatuses = ['OWED', 'RIDER_CONFIRMED'];
    const expected = data.unsettled
      .filter((s: any) => owedStatuses.includes(s.status))
      .reduce((sum: number, s: any) => sum + s.amount, 0);
    expect(data.summary.owed).toBe(expected);
    for (const s of data.unsettled) {
      expect(s.rider?.name).toBeTruthy();
      expect(s.rider?.phone).toBeTruthy(); // reachable to make the cash handover
    }
  });

  it('an outsider rider has an empty ledger', async () => {
    const res = await inject('GET', '/api/v1/rider/cash-settlements', outsiderRider.token);
    expect(res.json().data.summary.owed).toBe(0);
    expect(res.json().data.unsettled.length).toBe(0);
  });

  it('rejects a bearer-less request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/rider/cash-settlements' });
    expect(res.statusCode).toBe(401);
  });

  it('the owed total sums EVERY open row, not just the displayed 100 [SWIFT-120]', async () => {
    // A rider with 105 open MMG debts — more than the display cap.
    const bigUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const bigRiderId = await makeRider(bigUser.userId);
    const N = 105;
    const FEE = 300;
    await app.prisma.order.createMany({
      data: Array.from({ length: N }, (_, i) => ({
        orderNumber: `S120-${nanoid(8)}-${i}`, orderType: 'FOOD_DELIVERY' as const,
        customerId: customer.userId, vendorId, riderId: bigRiderId, status: 'DELIVERED' as const,
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: FEE, totalAmount: 1000 + FEE, paymentMethod: 'MOBILE_MONEY' as const,
      })),
    });
    const orderRows = await app.prisma.order.findMany({ where: { orderNumber: { startsWith: 'S120-' } }, select: { id: true } });
    await app.prisma.deliveryCashSettlement.createMany({
      data: orderRows.map((o) => ({ orderId: o.id, riderId: bigRiderId, vendorId, amount: FEE, status: 'OWED' as const })),
    });

    const ledger = await new DeliveryCashSettlementService(app.prisma, new NotificationService(app.prisma, app.io)).listForRider(bigRiderId);
    // Summary covers ALL 105 (the bug summed only the 100 displayed rows).
    expect(ledger.summary.count).toBe(N);
    expect(ledger.summary.owed).toBe(N * FEE);
    // The display list is still capped for payload size.
    expect(ledger.unsettled.length).toBe(100);

    await app.prisma.deliveryCashSettlement.deleteMany({ where: { riderId: bigRiderId } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderRows.map((o) => o.id) } } });
    await app.prisma.rider.deleteMany({ where: { id: bigRiderId } });
    await app.prisma.user.deleteMany({ where: { id: bigUser.userId } });
  });
});

// FUL-002: the money-matrix oracle (FUL-001) only earns its keep if the REAL
// settlement matches it. Drive real DELIVERED orders through createEarnings and
// assert the recorded money equals settle() for matrix rows 1 (cash) and 2 (MMG)
// — the Part-6.4 reconciliation, proving the oracle reflects Swift's actual code.
describe('FUL-002: real settlement reconciles to the money-matrix oracle', () => {
  const FOOD = 1000; // makeDeliveredOrder fixes subtotalCustomer = 1000

  it('CASH delivery (row 1): the rider EARNS exactly the oracle riderNets, and nothing is owed', async () => {
    const fee = 700;
    const orderId = await makeDeliveredOrder({ payment: 'CASH', fee });
    const oracle = settle({ foodTotal: FOOD, deliveryFee: fee, mode: 'PLATFORM_RIDER', payment: 'CASH' });
    const earning = await app.prisma.earning.findFirst({ where: { orderId, type: 'DELIVERY_FEE' } });
    expect(earning).not.toBeNull();
    expect(Number(earning!.amount)).toBe(oracle.riderNets); // rider nets the fee
    // cash settles at the door — the oracle carries no obligation, and neither does the DB
    expect(oracle.obligations).toHaveLength(0);
    expect(await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } })).toBeNull();
  });

  it('MMG delivery (row 2): the real vendor-owes-rider debt equals the oracle VENDOR_OWES_RIDER obligation', async () => {
    const fee = 550;
    const orderId = await makeDeliveredOrder({ payment: 'MOBILE_MONEY', fee });
    const oracle = settle({ foodTotal: FOOD, deliveryFee: fee, mode: 'PLATFORM_RIDER', payment: 'VENDOR_MMG' });
    expect(oracle.obligations[0]).toMatchObject({ type: 'VENDOR_OWES_RIDER', amount: fee });
    const debt = await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId } });
    expect(debt).not.toBeNull();
    expect(Number(debt!.amount)).toBe(oracle.obligations[0]!.amount); // real debt == oracle obligation
    // the rider's income is still the fee — fulfilled via the debt, not at the door
    const earning = await app.prisma.earning.findFirst({ where: { orderId, type: 'DELIVERY_FEE' } });
    expect(Number(earning!.amount)).toBe(oracle.riderNets);
  });
});

// FUL-004c: a VENDOR_DELIVERY order is fulfilled by the vendor's own courier —
// there is no platform rider, so the settlement records NO rider earning and NO
// vendor-owes-rider debt, and the vendor keeps everything (matrix rows 3/4).
describe('FUL-004c: VENDOR_DELIVERY settles as matrix rows 3/4 (vendor keeps all, no rider)', () => {
  it('a vendor-delivered CASH order records no rider earning and no debt — matching the oracle', async () => {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `VD-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
        fulfillmentMode: 'VENDOR_DELIVERY', customerId: customer.userId, vendorId, status: 'DELIVERED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 400, totalAmount: 1400, paymentMethod: 'CASH',
      },
    });
    await orders.createEarnings(order.id);
    // no platform rider → no rider earning, no vendor-owes-rider debt
    expect(await app.prisma.earning.findFirst({ where: { orderId: order.id } })).toBeNull();
    expect(await app.prisma.deliveryCashSettlement.findUnique({ where: { orderId: order.id } })).toBeNull();
    // reconciles to oracle row 3: vendor keeps everything, no rider, no obligation
    const oracle = settle({ foodTotal: 1000, deliveryFee: 400, mode: 'VENDOR_DELIVERY', payment: 'CASH' });
    expect(oracle.net.VENDOR).toBe(1400);
    expect(oracle.riderNets).toBe(0);
    expect(oracle.obligations).toHaveLength(0);
    await app.prisma.order.delete({ where: { id: order.id } });
  });
});
