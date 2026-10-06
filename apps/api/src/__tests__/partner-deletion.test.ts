import { grantStepUp } from './helpers/step-up';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import type { PrismaClient } from '@prisma/client';
import { retryAccountErasures } from '../modules/user/account-erasure-retry';
import { AccountService } from '../modules/user/account.service';
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
const vendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_817_000_000 + Math.floor(Math.random() * 100_000_000);

async function makePartner(roles: UserRole[], opts: { committedFloat?: number; stepUp?: boolean } = {}) {
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
  if (opts.stepUp !== false) await grantStepUp(app, token);
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
  await app.prisma.reimbursementClaim.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.subscription.deleteMany({ where: { riderId: { in: riderIds } } });
  await app.prisma.supportTicket.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
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

  it('blocks on unsettled cash but not direct-payment earnings records', () => {
    expect(verdictFor({ committedFloat: 500, unsettledCashCount: 0, earningsOwed: 0 }).blockers).toEqual(['CASH_HELD']);
    expect(verdictFor({ committedFloat: 0, unsettledCashCount: 1, earningsOwed: 0 }).blockers).toEqual(['UNSETTLED_CASH']);
    expect(verdictFor({ committedFloat: 0, unsettledCashCount: 0, earningsOwed: 250 }).blockers).toEqual([]);
    expect(verdictFor({ committedFloat: 0, unsettledCashCount: 0, earningsOwed: 0, openClaimCount: 1 }).blockers).toEqual(['OPEN_CLAIM']);
  });

  it('reports every blocker at once, not the first one', () => {
    // Told one at a time, a person clears a blocker, tries again, and is
    // refused for a different reason they were never shown. That is the
    // "contact Support" dead end with extra steps.
    const all = verdictFor({ committedFloat: 500, unsettledCashCount: 2, earningsOwed: 250, openClaimCount: 1 });
    expect(all.blockers).toHaveLength(PARTNER_BLOCKERS.length);
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
  it.each(['DELETE', 'POST'] as const)('requires session step-up before %s closure can change account authority', async (method) => {
    const p = await makePartner(method === 'POST' ? ['VENDOR_OWNER'] : ['MOVER'], { stepUp: false });
    const request = () => app.inject({ method, url: method === 'POST' ? '/api/v1/customer/account/closure-request' : '/api/v1/customer/account', headers: { authorization: `Bearer ${p.token}` } });
    const denied = await request();
    expect(denied.statusCode, denied.payload).toBe(403);
    expect(denied.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(await app.prisma.supportTicket.count({ where: { userId: p.userId } })).toBe(0);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).status).toBe('ACTIVE');
    expect(await app.prisma.session.count({ where: { userId: p.userId } })).toBe(1);
    await grantStepUp(app, p.token);
    const accepted = await request();
    expect(accepted.statusCode, accepted.payload).toBe(method === 'POST' ? 202 : 200);
    expect(accepted.json().data).toMatchObject(method === 'POST' ? { status: 'CLOSURE_REQUESTED' } : { deleted: true });
  });

  it('starts one durable closure request in-app without revoking access', async () => {
    const p = await makePartner(['VENDOR_OWNER']);
    const request = () => app.inject({ method: 'POST', url: '/api/v1/customer/account/closure-request', headers: { authorization: `Bearer ${p.token}` } });
    const [a, b] = await Promise.all([request(), request()]);
    expect(a.statusCode, a.payload).toBe(202);
    expect(b.statusCode, b.payload).toBe(202);
    expect(a.json().data).toMatchObject({ deleted: false, status: 'CLOSURE_REQUESTED' });
    expect(a.json().data.ticketId).toBe(b.json().data.ticketId);
    // Build 10+ (shows every receipt by its message) gets the same request back.
    const viaDelete = await app.inject({ method: 'DELETE', url: '/api/v1/customer/account?receipts=v2', headers: { authorization: `Bearer ${p.token}` } });
    expect(viaDelete.statusCode, viaDelete.payload).toBe(202);
    expect(viaDelete.json().data.ticketId).toBe(a.json().data.ticketId);
    // Build 9 is never told the account was deleted: same request, not a success.
    const build9 = await del(p.token);
    expect(build9.statusCode, build9.payload).toBe(409);
    expect(build9.json().error).toMatchObject({ code: 'ACCOUNT_CLOSURE_REQUESTED', details: { ticketId: a.json().data.ticketId } });
    expect(await app.prisma.supportTicket.count({ where: { userId: p.userId } })).toBe(1);
    expect(await app.prisma.session.count({ where: { userId: p.userId } })).toBe(1);
  });

  it.each(['RIDER', 'DRIVER'] as const)('blocks active work assigned to a %s even in customer mode', async (role) => {
    const p = await makePartner(['CUSTOMER', role]);
    const order = await makeCashOrder(p.riderId);
    if (role === 'DRIVER') {
      const driver = await app.prisma.driver.create({ data: { userId: p.userId, vehicleMake: 'Synthetic', vehicleModel: 'Car', vehicleYear: 2025, vehicleColor: 'Blue', licensePlate: nanoid(8), driverLicenseUrl: '', vehicleInsuranceUrl: '' } });
      await app.prisma.order.update({ where: { id: order.orderId }, data: { riderId: null, driverId: driver.id, status: 'PICKED_UP' } });
    } else await app.prisma.order.update({ where: { id: order.orderId }, data: { status: 'PICKED_UP' } });
    const res = await del(p.token);
    expect(res.statusCode, res.payload).toBe(409);
    expect(res.json().error.code).toBe('ACTIVE_ORDERS');
    expect(await app.prisma.session.count({ where: { userId: p.userId } })).toBe(1);
    await app.prisma.order.update({ where: { id: order.orderId }, data: { status: 'DELIVERED' } });
    expect((await del(p.token)).statusCode).toBe(200);
  });

  it('blocks live work at an owned store before winding it down', async () => {
    const p = await makePartner(['CUSTOMER', 'VENDOR_OWNER']);
    const owner = await app.prisma.vendorOwner.create({ data: { userId: p.userId } });
    const vendor = await app.prisma.vendor.create({ data: {
      ownerId: owner.id, name: 'Synthetic deletion store', slug: `del-${nanoid(12)}`, vendorType: 'RESTAURANT',
      phone: 'synthetic', addressLine1: 'Synthetic', city: 'Synthetic', region: 'Synthetic', latitude: 0, longitude: 0,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true,
    } });
    vendorIds.push(vendor.id);
    const order = await makeCashOrder(p.riderId);
    await app.prisma.order.update({ where: { id: order.orderId }, data: { vendorId: vendor.id, riderId: null, status: 'PREPARING' } });
    await expect(new AccountService(app).deleteAccount(p.userId)).rejects.toMatchObject({ code: 'ACTIVE_ORDERS' });
    expect(await app.prisma.vendor.findUnique({ where: { id: vendor.id } })).toMatchObject({ status: 'ACTIVE', acceptingOrders: true });
    await app.prisma.order.update({ where: { id: order.orderId }, data: { status: 'DELIVERED' } });
    const settlement = await app.prisma.deliveryCashSettlement.create({ data: { orderId: order.orderId, riderId: p.riderId, vendorId: vendor.id, amount: 1500, status: 'OWED' } });
    await expect(new AccountService(app).deleteAccount(p.userId)).rejects.toMatchObject({ code: 'PARTNER_OBLIGATIONS' });
    await app.prisma.deliveryCashSettlement.update({ where: { id: settlement.id }, data: { status: 'SETTLED' } });
    await expect(new AccountService(app).deleteAccount(p.userId)).resolves.toMatchObject({ deleted: true });
    expect(await app.prisma.vendor.findUnique({ where: { id: vendor.id } })).toMatchObject({ status: 'SUSPENDED', acceptingOrders: false });
  });

  it('does not bypass cash obligations when only the customer role remains', async () => {
    const p = await makePartner(['CUSTOMER'], { committedFloat: 4000 });
    expect((await del(p.token)).statusCode).toBe(409);
  });

  it('does not claim completion when partner wind-down fails after cutoff', async () => {
    const p = await makePartner(['MOVER']);
    await app.prisma.deviceToken.create({ data: { userId: p.userId, token: `synthetic-${nanoid(16)}`, platform: 'test' } });
    // The wind-down runs in its own transaction (main #1393), so the outage is
    // injected into that transaction's first owner lookup, as before.
    const realTransaction = app.prisma.$transaction.bind(app.prisma) as (...args: unknown[]) => Promise<unknown>;
    let failed = false;
    const outage = (tx: any) => new Proxy(tx, { get: (target, key) => key !== 'vendorOwner' ? target[key] : new Proxy(target.vendorOwner, {
      get: (delegate, method) => method === 'findUnique' && !failed
        ? () => { failed = true; return Promise.reject(new Error('synthetic cleanup outage')); }
        : delegate[method],
    }) });
    const failure = vi.spyOn(app.prisma, '$transaction').mockImplementation(((work: unknown, options?: unknown) => typeof work === 'function'
      ? realTransaction((tx: unknown) => (work as (tx: unknown) => unknown)(outage(tx)), options)
      : realTransaction(work, options)) as never);
    try {
      await expect(new AccountService(app).deleteAccount(p.userId)).rejects.toThrow('synthetic cleanup outage');
    } finally { failure.mockRestore(); }
    expect(await app.prisma.user.findUnique({ where: { id: p.userId } })).toMatchObject({ phone: `deleted:${p.userId}` });
    expect(await app.prisma.session.count({ where: { userId: p.userId } })).toBe(0);
    expect(await app.prisma.deviceToken.count({ where: { userId: p.userId } })).toBe(0);
    // Keep the production pagination predicate intact, restricting the scope by AND.
    const scopedDb = app.prisma.$extends({ query: { user: { findMany: ({ args, query }) => query({ ...args, where: { AND: [args.where ?? {}, { id: p.userId }] } }) } } }) as unknown as PrismaClient;
    await retryAccountErasures({ prisma: scopedDb, io: app.io, log: app.log });
    expect(await app.prisma.user.findUnique({ where: { id: p.userId } })).toMatchObject({ firstName: 'Deleted' });
  });

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

  it('direct-payment earnings survive deletion without an impossible payout requirement', async () => {
    const p = await makePartner(['CUSTOMER', 'MOVER']);
    const eo = await makeCashOrder(p.riderId);
    await app.prisma.earning.create({ data: { riderId: p.riderId, orderId: eo.orderId, type: 'DELIVERY_FEE', amount: 900, status: 'AVAILABLE' } });
    const res = await del(p.token);
    expect(res.statusCode, res.payload).toBe(200);
    const earning = await app.prisma.earning.findFirstOrThrow({ where: { orderId: eo.orderId } });
    expect(earning.status).toBe('AVAILABLE');
    expect(Number(earning.amount)).toBe(900);
    expect(await app.prisma.rider.findUnique({ where: { id: p.riderId } })).toMatchObject({ isOnline: false, isAvailable: false, licensePlate: null, currentLat: null, currentLng: null });
    expect(await app.prisma.user.findUnique({ where: { id: p.userId } })).toMatchObject({ firstName: 'Deleted', email: null });
  });

  it('an open loss-protection claim Swift has not paid blocks deletion until it is paid or decided', async () => {
    const p = await makePartner(['MOVER']);
    const order = await makeCashOrder(p.riderId);
    const claim = await app.prisma.reimbursementClaim.create({ data: {
      orderId: order.orderId, riderId: p.riderId, customerId: (await app.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).customerId,
      amount: 1500, reason: 'no_show', gpsLat: 6.8055, gpsLng: -58.1553, status: 'APPROVED',
    } });
    const refused = await del(p.token);
    expect(refused.statusCode, refused.payload).toBe(409);
    expect(refused.json().error.code).toBe('PARTNER_OBLIGATIONS');
    expect(refused.json().error.message).toContain('Get help');
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).status).toBe('ACTIVE');
    for (const status of ['PENDING_REVIEW', 'AUTO_APPROVED'] as const) {
      await app.prisma.reimbursementClaim.update({ where: { id: claim.id }, data: { status } });
      expect((await del(p.token)).statusCode, status).toBe(409);
    }
    await app.prisma.reimbursementClaim.update({ where: { id: claim.id }, data: { status: 'PAID', paidAt: new Date() } });
    const accepted = await del(p.token);
    expect(accepted.statusCode, accepted.payload).toBe(200);
    expect(await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ status: 'PAID', riderId: p.riderId });
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
        nextBillingDate: new Date(Date.now() + 86_400_000), nextRetryAt: new Date(Date.now() + 2 * 86_400_000),
      },
    });
    expect((await del(p.token)).statusCode).toBe(200);
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('CANCELLED');
    expect(after.autoRenew).toBe(false);
    expect(after.nextRetryAt).toBeNull();
  });
});
