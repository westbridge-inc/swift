import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { adminRoutes } from '../modules/admin/admin.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { DeliveryCashSettlementService } from '../modules/cash/delivery-cash-settlement.service';
import { reconcileHandoverClaims } from '../modules/cash/handover-claims';
import { NotificationService } from '../modules/notification/notification.service';
import { partnerObligations, verdictFor } from '../modules/user/partner-wind-down';
import { injectWithApproval } from './helpers/admin-approval';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { grantStepUp } from './helpers/step-up';

// The store owes a rider the delivery pay on an MMG order, and only the two of them could close the record. A store that
// never confirms, or has left Swift, held the rider's account deletion for ever, and the owner's in the other direction,
// while the refusal said to use Get help and Swift support had no button. Support now closes the record: a stated reason,
// a second admin, both sides told, no money moved. The row keeps every fact it held.

const DAY = 86_400_000;
const ROUTE = 'POST /finance/cash-settlements/:id/close';
const REASON = 'The store has left Swift and cannot confirm this handover; the rider asked to close it.';
const RUN = wordFreeTag(8);
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:settlement-no-dead-end');
let app: FastifyInstance;
let adminToken = '';
let customerId = '';
const people: string[] = [];
const orders: string[] = [];
const vendors: string[] = [];
const tokens = new Map<string, string>();

async function person(roles: UserRole[], extra: Record<string, unknown> = {}) {
  const user = await sys(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Settle', lastName: RUN, roles, activeRole: roles[0]!, status: 'ACTIVE', isPhoneVerified: true,
    avatar: `storage://test/settle-${nanoid(8)}.jpg`, customer: { create: {} }, ...extra,
  } }));
  people.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid() });
  await sys(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY), deviceId: `settle-${nanoid(6)}`, deviceType: 'test' } }));
  tokens.set(user.id, token);
  return user.id;
}

/** A rider, a store with its owner, and the row checkout writes when an MMG order is delivered. */
async function world(over: { createdAt?: Date } = {}) {
  const riderUser = await person(['MOVER', 'CUSTOMER']);
  const rider = await sys(() => app.prisma.rider.create({ data: { userId: riderUser, riderType: 'BOTH', vehicleType: 'MOTORCYCLE' } }));
  const ownerUser = await person(['VENDOR_OWNER', 'CUSTOMER']);
  const vendor = await sys(() => app.prisma.vendor.create({ data: {
    owner: { create: { userId: ownerUser } }, name: `Settle ${RUN}`, slug: `settle-${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, '0')}`, vendorType: 'STORE',
    phone: '+5926001234', addressLine1: 'Fixture', city: 'Georgetown', region: '', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
  } }));
  vendors.push(vendor.id);
  const order = await sys(() => app.prisma.order.create({ data: {
    orderNumber: `STL-${RUN}-${nanoid(6)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId, vendorId: vendor.id, riderId: rider.id, status: 'DELIVERED',
    paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000, deliveryFee: 500, totalAmount: 3500,
    deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15,
  } }));
  orders.push(order.id);
  const row = await sys(() => app.prisma.deliveryCashSettlement.create({ data: { orderId: order.id, riderId: rider.id, vendorId: vendor.id, amount: 500, ...over } }));
  return { riderUser, riderId: rider.id, ownerUser, vendorId: vendor.id, orderId: order.id, id: row.id };
}

const read = (id: string) => sys(() => app.prisma.deliveryCashSettlement.findUniqueOrThrow({ where: { id } }));
const close = (id: string, reason: string | null = REASON, token = adminToken) => injectWithApproval(app, {
  method: 'POST', url: `/api/v1/admin/finance/cash-settlements/${id}/close`, payload: {},
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(reason ? { 'x-swift-reason': reason } : {}) },
});
const blockers = async (userId: string, now?: Date) => verdictFor(await sys(() => app.prisma.$transaction((tx) => partnerObligations(tx, userId, now)))).blockers;
const noticesFor = (userId: string) => sys(() => app.prisma.notification.findMany({ where: { userId } }));
const service = () => new DeliveryCashSettlementService(app.prisma, new NotificationService(app.prisma, app.io));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  const admin = await person(['ADMIN'], { admin: { create: { permissions: ['*'] } } });
  adminToken = tokens.get(admin)!;
  customerId = await person(['CUSTOMER']);
});

afterAll(async () => {
  await sys(async () => {
    await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendors } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: people } } });
    await purgeAuditLogs(app.prisma, { userId: { in: people } }, 'test-cleanup:settlement-no-dead-end');
    await app.prisma.notification.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.user.deleteMany({ where: { id: { in: people } } });
  });
  await app.close();
});

describe('Swift support closes a stuck delivery-pay record', () => {
  it('is a money-class action, as the other record-only closes are', () => {
    expect(ADMIN_ROUTE_AUTHORITY[ROUTE]).toMatchObject({ cls: 'C4' });
  });

  it('keeps every fact on the row, frees both people, and tells both, with no money moved', async () => {
    const w = await world();
    await service().confirm(w.id, 'STORE', { vendorIds: [w.vendorId] }, { actorId: w.ownerUser, amount: 500 });
    const before = await read(w.id);
    expect(await blockers(w.riderUser)).toContain('UNSETTLED_CASH');
    expect(await blockers(w.ownerUser)).toContain('UNSETTLED_CASH');

    const res = await close(w.id);
    expect(res.statusCode, res.body).toBe(200);

    const after = await read(w.id);
    expect(after.closedAt).toBeInstanceOf(Date);
    expect(after.closedById).toBeTruthy();
    expect({ ...after, closedAt: null, closedById: null }).toEqual({ ...before, closedAt: null, closedById: null });
    expect(after.status).toBe('STORE_CONFIRMED');
    expect(await blockers(w.riderUser)).not.toContain('UNSETTLED_CASH');
    expect(await blockers(w.ownerUser)).not.toContain('UNSETTLED_CASH');

    const audit = await sys(() => app.prisma.auditLog.findFirst({ where: { entityId: w.id }, orderBy: { createdAt: 'desc' } }));
    expect(JSON.stringify(audit)).toContain(REASON);
    expect(JSON.stringify(audit)).toContain('CLOSED_BY_SWIFT');
    for (const who of [w.riderUser, w.ownerUser]) {
      const notice = (await noticesFor(who)).find((n) => n.title === 'Delivery pay record closed by Swift');
      expect(notice?.body).toMatch(/moved no money/);
      expect(notice?.body).not.toContain(REASON);
    }
  });

  it('needs a stated reason and a second admin, and nobody else', async () => {
    const w = await world();
    const none = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/cash-settlements/${w.id}/close`, payload: {}, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' } });
    expect(none.statusCode).toBe(400);
    const alone = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/cash-settlements/${w.id}/close`, payload: {}, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': REASON } });
    expect(alone.statusCode, alone.body).toBe(202);
    expect((await read(w.id)).closedAt).toBeNull();
    const rider = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/cash-settlements/${w.id}/close`, payload: {}, headers: { authorization: `Bearer ${tokens.get(w.riderUser)}`, 'content-type': 'application/json', 'x-swift-reason': REASON } });
    expect(rider.statusCode).toBe(403);
  });

  it('a settled or already closed record is refused, and a stranger gets a 404', async () => {
    const w = await world();
    await sys(() => app.prisma.deliveryCashSettlement.update({ where: { id: w.id }, data: { status: 'SETTLED' } }));
    expect((await close(w.id)).statusCode).toBe(409);
    expect((await read(w.id)).closedAt).toBeNull();
    const open = await world();
    expect((await close(open.id)).statusCode).toBe(200);
    const again = await close(open.id, `${REASON} Asked again.`);
    expect(again.statusCode).toBe(409);
    expect((await close('no-such-record', `${REASON} Nothing.`)).statusCode).toBe(404);
  });

  it('a closed record cannot be confirmed afterwards, by either side, and the two ledgers drop it', async () => {
    const w = await world();
    expect((await close(w.id)).statusCode).toBe(200);
    await expect(service().confirm(w.id, 'RIDER', { riderId: w.riderId }, { actorId: w.riderUser, amount: 500 })).rejects.toMatchObject({ code: 'SETTLEMENT_CLOSED' });
    await expect(service().confirm(w.id, 'STORE', { vendorIds: [w.vendorId] }, { actorId: w.ownerUser, amount: 500 })).rejects.toMatchObject({ code: 'SETTLEMENT_CLOSED' });
    expect((await read(w.id)).status).toBe('OWED');
    const ledgers = [await sys(() => service().listForRider(w.riderId)), await sys(() => service().listForVendors([w.vendorId]))];
    for (const ledger of ledgers) {
      expect(JSON.stringify(ledger)).not.toContain(w.id);
      expect(ledger.summary.owed).toBe(0);
    }
  });

  it('a close that lands between a confirm\'s read and its write wins: the record is not moved', async () => {
    // A service whose read saw the record before the close landed.
    const racing = () => {
      const settlements = new Proxy(app.prisma.deliveryCashSettlement, { get(target, key, receiver) {
        if (key !== 'findFirst') return Reflect.get(target, key, receiver);
        return async (args: never) => { const row = await target.findFirst(args); return row ? { ...row, closedAt: null } : row; };
      } });
      const prisma = new Proxy(app.prisma, { get: (target, key, receiver) => (key === 'deliveryCashSettlement' ? settlements : Reflect.get(target, key, receiver)) });
      return new DeliveryCashSettlementService(prisma, new NotificationService(app.prisma, app.io));
    };

    const owed = await world();
    expect((await close(owed.id)).statusCode).toBe(200);
    await sys(() => racing().confirm(owed.id, 'RIDER', { riderId: owed.riderId }, { actorId: owed.riderUser, amount: 500 }));
    expect((await read(owed.id)).status).toBe('OWED');

    const half = await world();
    await service().confirm(half.id, 'STORE', { vendorIds: [half.vendorId] }, { actorId: half.ownerUser, amount: 500 });
    expect((await close(half.id)).statusCode).toBe(200);
    await sys(() => racing().confirm(half.id, 'RIDER', { riderId: half.riderId }, { actorId: half.riderUser, amount: 500 }));
    expect((await read(half.id)).status).toBe('STORE_CONFIRMED');
  });

  it('each person\'s notice is published, not only stored', async () => {
    const w = await world();
    const published = vi.spyOn(NotificationService.prototype, 'publishPersisted');
    expect((await close(w.id)).statusCode).toBe(200);
    expect(published).toHaveBeenCalledTimes(2);
    published.mockRestore();
  });

  it('the nightly reconciliation stops asking about a closed record', async () => {
    const w = await world({ createdAt: new Date(Date.now() - 10 * DAY) });
    expect((await sys(() => reconcileHandoverClaims(app.prisma))).unmatched.map((u) => u.settlementId)).toContain(w.id);
    expect((await close(w.id)).statusCode).toBe(200);
    expect((await sys(() => reconcileHandoverClaims(app.prisma))).unmatched.map((u) => u.settlementId)).not.toContain(w.id);
  });

  it('a store that has left Swift is not written to; the rider still is', async () => {
    const w = await world();
    await sys(() => app.prisma.user.update({ where: { id: w.ownerUser }, data: { status: 'DEACTIVATED' } }));
    expect((await close(w.id)).statusCode).toBe(200);
    expect((await noticesFor(w.riderUser)).some((n) => n.title === 'Delivery pay record closed by Swift')).toBe(true);
    expect((await noticesFor(w.ownerUser)).some((n) => n.title === 'Delivery pay record closed by Swift')).toBe(false);
  });

  it('the finance list says it is closed and its outstanding total drops it', async () => {
    const w = await world();
    const list = async () => (await app.inject({ method: 'GET', url: `/api/v1/admin/finance/cash-settlements?riderId=${w.riderId}`, headers: { authorization: `Bearer ${adminToken}` } })).json();
    const before = await list();
    expect(before.data[0]).toMatchObject({ id: w.id, closedAt: null });
    const owed = before.summary.OWED?.total ?? 0;
    expect((await close(w.id)).statusCode).toBe(200);
    const after = await list();
    expect(after.data[0].closedAt).toBeTruthy();
    expect(after.summary.OWED?.total ?? 0).toBe(owed - 500);
  });
});

describe('account deletion works through that close and is not weakened', () => {
  const del = async (userId: string) => {
    const token = tokens.get(userId)!;
    await grantStepUp(app, token);
    return app.inject({ method: 'DELETE', url: '/api/v1/customer/account', headers: { authorization: `Bearer ${token}` } });
  };

  it('an open record still refuses the rider, however old; closed by support, the deletion goes through and the record stays', async () => {
    const w = await world({ createdAt: new Date(Date.now() - 365 * DAY) });
    const refused = await del(w.riderUser);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('PARTNER_OBLIGATIONS');
    expect((await close(w.id)).statusCode).toBe(200);
    const gone = await del(w.riderUser);
    expect(gone.statusCode, gone.body).toBeLessThan(300);
    const kept = await read(w.id);
    expect(kept.status).toBe('OWED');
    expect(Number(kept.amount)).toBe(500);
  });

  it('the store that owes it is refused too, until the record is closed', async () => {
    const w = await world();
    expect(await blockers(w.ownerUser)).toContain('UNSETTLED_CASH');
    expect((await close(w.id)).statusCode).toBe(200);
    expect(await blockers(w.ownerUser)).not.toContain('UNSETTLED_CASH');
  });
});
