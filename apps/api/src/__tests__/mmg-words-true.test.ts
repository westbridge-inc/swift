// [BUG-HUNT-2 G14 + G22] The MMG words are true for the person reading them, and a dispute at the door can close. Through the
// real routes on a real database.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { walkOrderStatus } from './helpers/order-status-walk';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

const DAY = 86_400_000;
const MIN = 60_000;
const REASON = 'Support checked both sides and decided this payment.';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:mmg-words-true');
type Actor = { id: string; token: string };

let app: FastifyInstance;
let customer: Actor; let owner: Actor; let riderUser: Actor; let admin: Actor;
let vendorId = ''; let riderId = '';
const people: string[] = [];
const orderIds: string[] = [];

async function actor(roles: UserRole[], active: UserRole, adminRow = false): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Mo', lastName: 'Words', roles, activeRole: active, status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}), ...(adminRow ? { admin: { create: { permissions: ['*'] } } } : {}),
  } }));
  people.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: active, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'words', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { id: user.id, token };
}

async function order(status: 'PENDING' | 'ACCEPTED' | 'PICKED_UP', over: Record<string, unknown> = {}) {
  const row = await sys(async () => {
    const created = await app.prisma.order.create({ data: {
      orderNumber: `WRD-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: customer.id, vendorId, status: 'PENDING', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING',
      deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500,
      ...over,
    } as never });
    await walkOrderStatus(app.prisma, created.id, status, { acceptedAt: new Date(Date.now() - 40 * MIN), ...(status === 'PICKED_UP' ? { riderId, pickedUpAt: new Date(), courierPickupProofUrl: undefined } : {}) });
    return app.prisma.order.findUniqueOrThrow({ where: { id: created.id } });
  });
  orderIds.push(row.id);
  return row;
}

const paidByStore = () => ({ paymentStatus: 'CLAIMED', mmgAttestedRef: `PAY${nanoid(12).replace(/[^a-zA-Z0-9]/g, '0')}`, mmgAttestedAt: new Date(), mmgAttestedAmount: 1500, mmgClaimRevision: 1 });
function call(method: 'GET' | 'POST', url: string, as: Actor, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${as.token}`, ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}
const view = async (id: string) => (await call('GET', `/api/v1/customer/orders/${id}`, customer)).json().data;
const claim = (id: string, paid: boolean) => call('POST', `/api/v1/customer/orders/${id}/payment-claim`, customer, { paid });
const row = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const cases = (id: string) => sys(() => app.prisma.custodyRecoveryCase.findMany({ where: { orderId: id } }));
const resolve = (id: string, resolution: string, revision: number) => call('POST', `/api/v1/admin/orders/${id}/payment-claim/resolve`, admin, { resolution, note: 'Checked the store statement', expectedClaimRevision: revision }, { 'x-swift-reason': REASON });
const waitNotices = async (userId: string, orderId: string, count: number) => {
  for (let i = 0; i < 40; i += 1) {
    const rows = await sys(() => app.prisma.notification.findMany({ where: { userId, data: { path: ['orderId'], equals: orderId } } }));
    if (rows.length >= count) return rows;
    await new Promise((resolved) => setTimeout(resolved, 25));
  }
  return sys(() => app.prisma.notification.findMany({ where: { userId, data: { path: ['orderId'], equals: orderId } } }));
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  vi.stubEnv('LIFECYCLE_V2', '1');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  customer = await actor(['CUSTOMER'], 'CUSTOMER');
  owner = await actor(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  riderUser = await actor(['MOVER', 'CUSTOMER'], 'MOVER');
  admin = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
  await sys(async () => {
    const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    vendorId = (await app.prisma.vendor.create({ data: {
      ownerId: vendorOwner.id, name: `Words Shop ${wordFreeTag(4)}`, slug: `words-${nanoid(10).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
      addressLine1: '1 Word Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1, status: 'ACTIVE', isVerified: true,
    } })).id;
    riderId = (await app.prisma.rider.create({ data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } as never })).id;
  });
});

afterAll(async () => {
  await sys(async () => {
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.rider.deleteMany({ where: { id: riderId } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: people } } });
    await purgeAuditLogs(app.prisma, { userId: { in: people } }, 'test-cleanup:mmg-words-true');
    await app.prisma.session.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.user.deleteMany({ where: { id: { in: people } } });
  });
  await app.close();
  vi.unstubAllEnvs();
});

describe('[G14a] a customer who said they did not pay', () => {
  it('is never told the order is already paid: the screen and the refused cancel both say it is paused for a person', async () => {
    const o = await order('ACCEPTED', paidByStore());
    expect((await claim(o.id, false)).statusCode).toBe(200);
    const seen = await view(o.id);
    expect(seen.mmgClaim.disputed).toBe(true);
    expect(seen.cancelUnavailable.message).toContain('You and the store disagree');
    expect(seen.cancelUnavailable.message).not.toContain('already paid');
    const res = await call('POST', `/api/v1/customer/orders/${o.id}/cancel`, customer, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('You and the store disagree');
    expect(res.json().error.message).not.toContain('already paid');
  });

  it('with no dispute the paid words stand', async () => {
    const o = await order('ACCEPTED', paidByStore());
    expect((await view(o.id)).cancelUnavailable.message).toContain('already paid by MMG');
  });
});

describe('[G14d] "I paid the store" before anyone could pay', () => {
  it('is not offered until the store accepts, because the number is not shown until then', async () => {
    const waiting = await order('PENDING');
    expect((await view(waiting.id)).mmgClaim.canClaim).toBe(false);
    const accepted = await order('ACCEPTED');
    expect((await view(accepted.id)).mmgClaim.canClaim).toBe(true);
  });

  it('with the store\'s pay link on, money can move before the store accepts, so it is offered', async () => {
    vi.stubEnv('STORE_MMG_PAY_LINK', '1');
    const waiting = await order('PENDING');
    expect((await view(waiting.id)).mmgClaim.canClaim).toBe(true);
    vi.stubEnv('STORE_MMG_PAY_LINK', '');
  });
});

describe('[G22] "I didn\'t pay" with the goods at the door', () => {
  it('the rider is told at once, and one case opens for support', async () => {
    const o = await order('PICKED_UP', paidByStore());
    expect((await claim(o.id, false)).statusCode).toBe(200);
    const told = await waitNotices(riderUser.id, o.id, 1);
    expect(told.map((notice) => notice.title)).toEqual(['Payment dispute: keep the order']);
    expect(told[0]!.body).toContain('Do not hand it over');
    expect(told[0]!.data).toMatchObject({ orderId: o.id, kind: 'mmg_dispute_hold', audience: 'earner' });
    const open = await cases(o.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ state: 'SUPPORT_HOLD', reason: 'OTHER', holderRiderId: riderId, resolvedAt: null });
    expect(open[0]!.reasonNote).toContain('did not pay');
  });

  it('a dispute before pickup opens no case and tells no rider', async () => {
    const o = await order('ACCEPTED', paidByStore());
    expect((await claim(o.id, false)).statusCode).toBe(200);
    expect(await cases(o.id)).toHaveLength(0);
  });
});

describe('[G22] after the goods came back', () => {
  const returned = async () => {
    const o = await order('PICKED_UP', paidByStore());
    expect((await claim(o.id, false)).statusCode).toBe(200);
    await sys(async () => {
      await app.prisma.custodyRecoveryCase.updateMany({ where: { orderId: o.id }, data: { state: 'RETURN_REQUIRED' } }).catch(() => undefined);
      await walkOrderStatus(app.prisma, o.id, 'RETURNED');
    });
    return row(o.id);
  };

  it('support can still decide the customer did not pay: the dispute closes and the card stops saying paused', async () => {
    const o = await returned();
    expect(o.mmgClaimMismatchAt).toBeInstanceOf(Date);
    const res = await resolve(o.id, 'CUSTOMER_DID_NOT_PAY', o.mmgClaimRevision);
    expect(res.statusCode, res.body).toBe(200);
    const after = await row(o.id);
    expect(after).toMatchObject({ status: 'RETURNED', mmgClaimMismatchAt: null, mmgClaimResolution: 'CUSTOMER_DID_NOT_PAY', paymentStatus: 'PENDING' });
    expect((await view(o.id)).mmgClaim.disputed).toBe(false);
  });

  it('or that the store\'s report stands', async () => {
    const o = await returned();
    const res = await resolve(o.id, 'CUSTOMER_PAID', o.mmgClaimRevision);
    expect(res.statusCode, res.body).toBe(200);
    expect(await row(o.id)).toMatchObject({ status: 'RETURNED', mmgClaimMismatchAt: null, mmgClaimResolution: 'CUSTOMER_PAID', paymentStatus: 'CLAIMED' });
  });

  it('a closed order that is not a return stays closed to a decision', async () => {
    const closedOrder = await order('PICKED_UP', paidByStore());
    expect((await claim(closedOrder.id, false)).statusCode).toBe(200);
    await sys(() => walkOrderStatus(app.prisma, closedOrder.id, 'FAILED'));
    const failed = await row(closedOrder.id);
    const res = await resolve(failed.id, 'CUSTOMER_DID_NOT_PAY', failed.mmgClaimRevision);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORDER_CLOSED');
  });
});
