import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { verdictFor, refusalMessage, BLOCKER_MESSAGE, PARTNER_BLOCKERS } from '../modules/user/partner-wind-down';

// ---------------------------------------------------------------------------
// [Apple 5.1.1(v)] A mover or vendor closes their own account.
//
// `deleteAccount` refused every non-CUSTOMER role and pointed at Support. The
// app has a Delete account button, so a driver pressing it was told to write an
// email — which App Review names specifically as not satisfying the guideline:
// an app that lets you CREATE an account must let you delete it IN the app.
// The file's own header said so, in a comment, while nothing acted on it.
//
// The refusal was right about the risk and wrong about the remedy. Money in
// flight still blocks. Everything else winds down.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_817_000_000 + Math.floor(Math.random() * 100_000_000);

async function makePartner(roles: UserRole[], opts: { committedFloat?: number } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Part', lastName: `Ner${seq}`,
      email: `partner${seq}-${nanoid(6)}@example.com`,
      roles, activeRole: roles[0]!, isPhoneVerified: true,
      customer: { create: {} },
      rider: { create: { riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', committedFloat: opts.committedFloat ?? 0 } },
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'p', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  const rider = await app.prisma.rider.findUniqueOrThrow({ where: { userId: user.id }, select: { id: true } });
  return { userId: user.id, token, riderId: rider.id };
}


/** A settlement hangs off a real order and vendor; borrow whatever the seeded
 *  database already has rather than inventing a storefront for a fixture. */
async function makeCashOrder(riderId: string) {
  const vendor = await app.prisma.vendor.findFirstOrThrow({ select: { id: true } });
  const customer = await app.prisma.user.findFirstOrThrow({ where: { customer: { isNot: null } }, select: { id: true } });
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `PD-${nanoid(10).toUpperCase()}`,
      customerId: customer.id, vendorId: vendor.id, riderId,
      orderType: 'FOOD_DELIVERY', status: 'DELIVERED', deliveryAddress: '1 Test St',
      deliveryLat: 6.8055, deliveryLng: -58.1553,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500,
      deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
    },
  });
  orderIds.push(order.id);
  return { orderId: order.id, vendorId: vendor.id };
}

const del = (token: string) =>
  app.inject({ method: 'DELETE', url: '/api/v1/customer/account', headers: { authorization: `Bearer ${token}` } });

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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  const riders = await app.prisma.rider.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const riderIds = riders.map((r) => r.id);
  await app.prisma.earning.deleteMany({ where: { riderId: { in: riderIds } } });
  await app.prisma.deliveryCashSettlement.deleteMany({ where: { riderId: { in: riderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.subscription.deleteMany({ where: { riderId: { in: riderIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[5.1.1v] the verdict, without a database', () => {
  it('is clear when nothing is outstanding', () => {
    expect(verdictFor({ committedFloat: 0, unsettledCashCount: 0, earningsOwed: 0 }).clear).toBe(true);
  });

  it('blocks on each kind of money, separately', () => {
    expect(verdictFor({ committedFloat: 500, unsettledCashCount: 0, earningsOwed: 0 }).blockers).toEqual(['CASH_HELD']);
    expect(verdictFor({ committedFloat: 0, unsettledCashCount: 1, earningsOwed: 0 }).blockers).toEqual(['UNSETTLED_CASH']);
    expect(verdictFor({ committedFloat: 0, unsettledCashCount: 0, earningsOwed: 250 }).blockers).toEqual(['EARNINGS_OWED']);
  });

  it('reports every blocker at once, not the first one', () => {
    // Told one at a time, a person clears a blocker, tries again, and is
    // refused for a different reason they were never shown. That is the
    // "contact Support" dead end with extra steps.
    const all = verdictFor({ committedFloat: 500, unsettledCashCount: 2, earningsOwed: 250 });
    expect(all.blockers).toHaveLength(3);
    for (const b of PARTNER_BLOCKERS) expect(refusalMessage(all.blockers)).toContain(BLOCKER_MESSAGE[b]);
  });

  it('every refusal names something the person can do themselves', () => {
    // The whole point of the guideline. A refusal a person cannot act on is
    // the same dead end wearing a different error code — so no message here
    // may send them to Support.
    for (const b of PARTNER_BLOCKERS) {
      expect(BLOCKER_MESSAGE[b].length, b).toBeGreaterThan(60);
      expect(/support/i.test(BLOCKER_MESSAGE[b]), `${b} sends the person to Support`).toBe(false);
    }
  });
});

describe('[5.1.1v] a partner deletes their own account', () => {
  it('a mover holding nothing is erased, in the app', async () => {
    const p = await makePartner(['CUSTOMER', 'MOVER']);
    const res = await del(p.token);
    expect(res.statusCode, res.payload).toBe(200);
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } });
    expect(after.status).toBe('DEACTIVATED');
    expect(after.firstName).toBe('Deleted');
    expect(after.phone.startsWith('deleted:')).toBe(true);
  });

  it('a mover HOLDING vendor cash is refused — and told to hand it in', async () => {
    // Not "contact Support". The float is theirs to clear, and the account
    // closes the moment it is back to zero.
    const p = await makePartner(['CUSTOMER', 'MOVER'], { committedFloat: 4000 });
    const res = await del(p.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PARTNER_OBLIGATIONS');
    expect(res.json().error.message).toMatch(/hand it in/i);
    expect(res.json().error.message).not.toMatch(/support/i);
    // ...and nothing was erased on the way to being refused.
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } });
    expect(after.status).toBe('ACTIVE');
    expect(after.firstName).not.toBe('Deleted');
  });

  it('an unconfirmed cash settlement blocks until both sides close it', async () => {
    const p = await makePartner(['CUSTOMER', 'MOVER']);
    const order = await makeCashOrder(p.riderId);
    await app.prisma.deliveryCashSettlement.create({
      data: { orderId: order.orderId, riderId: p.riderId, vendorId: order.vendorId, amount: 1500, status: 'RIDER_CONFIRMED' },
    });
    const res = await del(p.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/settlement/i);
  });

  it('unpaid earnings block, so nobody deletes away their own money', async () => {
    const p = await makePartner(['CUSTOMER', 'MOVER']);
    const eo = await makeCashOrder(p.riderId);
    await app.prisma.earning.create({ data: { riderId: p.riderId, orderId: eo.orderId, type: 'DELIVERY_FEE', amount: 900, status: 'AVAILABLE' } });
    const res = await del(p.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/forfeit/i);
  });

  it('money already PAID OUT does not block — it has already reached them', async () => {
    const p = await makePartner(['CUSTOMER', 'MOVER']);
    const eo = await makeCashOrder(p.riderId);
    await app.prisma.earning.create({ data: { riderId: p.riderId, orderId: eo.orderId, type: 'DELIVERY_FEE', amount: 900, status: 'PAID_OUT' } });
    const order = await makeCashOrder(p.riderId);
    await app.prisma.deliveryCashSettlement.create({
      data: { orderId: order.orderId, riderId: p.riderId, vendorId: order.vendorId, amount: 1500, status: 'SETTLED' },
    });
    const res = await del(p.token);
    expect(res.statusCode, res.payload).toBe(200);
  });

  it('the subscription stops, so a person who left is not still billed', async () => {
    const p = await makePartner(['CUSTOMER', 'MOVER']);
    const sub = await app.prisma.subscription.create({
      data: {
        riderId: p.riderId, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: 2000,
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000),
        nextBillingDate: new Date(Date.now() + 86_400_000),
      },
    });
    expect((await del(p.token)).statusCode).toBe(200);
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('CANCELLED');
  });
});
