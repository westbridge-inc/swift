import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// [A-14] A CASH ORDER REFUND IS A PROMISE UNTIL SOMEBODY PROVES IT.
//
// `refund: true` on the admin cancel used to write REFUNDED — a terminal state
// whose name asserts the customer has their money back — with no amount, no
// actor, and no evidence that a single dollar moved. On the cash rail the STORE
// holds the customer's money, not Swift, so that terminal was a claim about
// somebody else's cash drawer.
//
// Deciding now records an OBLIGATION on the order; only reconciled evidence —
// a unique reference and the amount actually handed back — closes it.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
let vendorId: string;
const userIds: string[] = [];
let seq = 0;

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200781${String(seq).padStart(2, '0')}`,
      firstName: 'RefObl', lastName: `U${seq}`,
      roles: ['CUSTOMER'] as never, activeRole: 'CUSTOMER' as never, isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeCashOrder(opts?: { payment?: 'CASH' | 'MOBILE_MONEY'; total?: number }) {
  const customer = await makeCustomer();
  return app.prisma.order.create({
    data: {
      orderNumber: `AROB-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
      customerId: customer.id, vendorId, status: 'ACCEPTED',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 300, totalAmount: opts?.total ?? 1300,
      paymentMethod: opts?.payment ?? 'CASH',
    },
  });
}

// A reference the shape actually accepts: `nanoid` draws from an alphabet that
// includes `-` and `_`, and a reference may not END in one. Roughly three runs
// in a hundred produced a trailing `-` and a 400 that had nothing to do with
// what the test was grading. Alphanumeric, always.
const refFor = (prefix: string) => `${prefix}-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}`.toUpperCase();

const cancel = (id: string, body: Record<string, unknown>) =>
  app.inject({
    method: 'PUT', url: `/api/v1/admin/orders/${id}/cancel`,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    payload: body,
  });

const settle = (id: string, body: Record<string, unknown>) =>
  app.inject({
    method: 'PUT', url: `/api/v1/admin/orders/${id}/refund-settled`,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    payload: body,
  });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  seq += 1;
  const admin = await app.prisma.user.create({
    data: {
      phone: `+59200781${String(seq).padStart(2, '0')}`,
      firstName: 'RefObl', lastName: 'Admin',
      roles: ['ADMIN'] as never, activeRole: 'ADMIN' as never, isPhoneVerified: true,
    },
  });
  userIds.push(admin.id);
  adminToken = (await loginWithOtp(app, admin.phone)).json().data.tokens.accessToken;

  const vendors = await app.prisma.vendor.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 1 });
  if (!vendors[0]) throw new Error('seeded ACTIVE vendor required');
  vendorId = vendors[0].id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'AROB-' } } });
  await app.prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[A-14] deciding to refund a cash order records an obligation, not a payment', () => {
  it('does NOT claim REFUNDED — the order is cancelled and the refund is recorded as OWED', async () => {
    const order = await makeCashOrder({ total: 1300 });
    const res = await cancel(order.id, { reason: 'store could not fulfil', refund: true });
    expect(res.statusCode).toBe(200);

    // The terminal that used to be written here asserted somebody else's cash
    // drawer had been opened. It is gone.
    expect(res.json().data.status).toBe('CANCELLED');

    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('CANCELLED');
    expect(Number(fresh.refundOwedAmount)).toBe(1300);
    expect(fresh.refundOwedAt).not.toBeNull();
    expect(fresh.refundOwedById).not.toBeNull();
    // …and nothing yet claims the money moved.
    expect(fresh.refundRef).toBeNull();
    expect(fresh.refundPaidAmount).toBeNull();
    expect(fresh.refundSettledAt).toBeNull();
  });

  it('cancelling WITHOUT the refund flag records no obligation', async () => {
    const order = await makeCashOrder();
    expect((await cancel(order.id, { reason: 'duplicate', refund: false })).statusCode).toBe(200);
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('CANCELLED');
    expect(fresh.refundOwedAt).toBeNull();
  });

  it('an MMG order still fails closed — Swift never asserts a store’s external transfer', async () => {
    const order = await makeCashOrder({ payment: 'MOBILE_MONEY' });
    const res = await cancel(order.id, { reason: 'store could not fulfil', refund: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MMG_REFUND_UNAVAILABLE');
  });
});

describe('[A-14] only reconciled evidence closes the obligation', () => {
  async function owedOrder(total = 1300) {
    const order = await makeCashOrder({ total });
    await cancel(order.id, { reason: 'store could not fulfil', refund: true });
    return order;
  }

  it('a reference and the amount actually handed back close it to REFUNDED', async () => {
    const order = await owedOrder(1300);
    const ref = refFor('CASH');
    const res = await settle(order.id, { reference: ref, amount: 1300 });
    expect(res.statusCode).toBe(200);

    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('REFUNDED');
    expect(fresh.refundRef).toBe(ref);
    expect(Number(fresh.refundPaidAmount)).toBe(1300);
    expect(fresh.refundSettledById).not.toBeNull();
    expect(fresh.refundSettledAt).not.toBeNull();
  });

  it('a wrong amount is refused in either direction, to the cent', async () => {
    const low = await owedOrder(1300);
    expect((await settle(low.id, { reference: refFor('CASH'), amount: 1200 })).statusCode).toBe(409);
    const high = await owedOrder(1300);
    expect((await settle(high.id, { reference: refFor('CASH'), amount: 1300.01 })).statusCode).toBe(409);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: low.id } })).status).toBe('CANCELLED');
  });

  it('one handover settles ONE order — a reused reference is refused', async () => {
    const first = await owedOrder(1300);
    const second = await owedOrder(1300);
    const ref = refFor('CASH');
    expect((await settle(first.id, { reference: ref, amount: 1300 })).statusCode).toBe(200);
    const dup = await settle(second.id, { reference: ref, amount: 1300 });
    expect(dup.statusCode).toBe(409);
    // The CODE, not just the status: the error handler maps a raw P2002 to 409
    // by itself, so asserting the status alone would stay green with the
    // translation deleted — and the settler would be told "Unique constraint
    // failed" instead of what actually happened.
    expect(dup.json().error.code).toBe('REFUND_REF_ALREADY_USED');
    expect(dup.json().error.message).toMatch(/One handover settles one order/);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('CANCELLED');
  });

  it('the same reference typed in a different case is the same reference', async () => {
    const first = await owedOrder(1300);
    const second = await owedOrder(1300);
    const ref = refFor('CASH');
    expect((await settle(first.id, { reference: ref, amount: 1300 })).statusCode).toBe(200);
    expect((await settle(second.id, { reference: ref.toLowerCase(), amount: 1300 })).statusCode).toBe(409);
  });

  it('nothing entered and something wrong are different mistakes', async () => {
    const order = await owedOrder();
    expect((await settle(order.id, { reference: '   ', amount: 1300 })).json().error.code).toBe('REFUND_REF_REQUIRED');
    expect((await settle(order.id, { reference: '!!', amount: 1300 })).json().error.code).toBe('REFUND_REF_INVALID');
  });

  it('an order that owes nothing cannot be settled', async () => {
    const order = await makeCashOrder();
    await cancel(order.id, { reason: 'duplicate', refund: false });
    const res = await settle(order.id, { reference: refFor('CASH'), amount: 1300 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NO_REFUND_DUE');
  });

  it('settlers racing produce ONE settlement and one reference on file, however they interleave', async () => {
    // Graded as an INVARIANT, not a status code: the read-then-check and the
    // compare-and-set can each win depending on scheduling, and both refusals
    // are legitimate. What must never happen is two settlements, or a
    // settlement whose reference is not the one on the row.
    const order = await owedOrder(1300);
    const refs = Array.from({ length: 5 }, (_, i) => refFor(`CASH-R${i}`));
    const results = await Promise.all(refs.map((reference) => settle(order.id, { reference, amount: 1300 })));

    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    for (const refused of results.filter((r) => r.statusCode !== 200)) {
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect(['NO_REFUND_DUE', 'ALREADY_SETTLED', 'REFUND_REF_ALREADY_USED'])
        .toContain(refused.json().error.code);
    }

    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('REFUNDED');
    expect(refs).toContain(fresh.refundRef);
    expect(Number(fresh.refundPaidAmount)).toBe(1300);
    // Exactly one settlement row, not five.
    expect(await app.prisma.orderStatusLog.count({
      where: { orderId: order.id, status: 'REFUNDED' },
    })).toBe(1);
  });
});
