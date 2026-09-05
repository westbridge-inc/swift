import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { withSuiteCapability } from '../lib/test-target-lock';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [ADM-002] THE LAST THREE SELF-OWNED MONEY ROUTES.
//
// `PUT /orders/:id/refund-settled`, `PUT /returns/:id/refund-settled` and
// `PUT /subscriptions/:id/waive-fee` wrote their change, then a legacy
// `audit()` row, then the hook's row — three writes bound to nothing. The
// legacy rows carried the one fact that matters for a refund, the REFERENCE
// ("the only proof it happened", in the route's own words). Retiring them
// without carrying that fact across would have been the promos trap again.
//
// The fact now travels through the declared `E.order` / `E.returnRequest`
// fields as a before/after DIFF — which also exposed that those declared
// lists named columns that do not exist (`total`, `refundStatus`,
// `resolvedAt`), so every order diff had been empty. Fixed in the same PR and
// held by `admin-audit-declared-fields.test.ts`.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];
const orderIds: string[] = [];
let token = '';
let vendorId = '';
const REASON = 'Refund handed back at the counter, receipt on file, ticket GY-5511';
const refFor = (p: string) => `${p}${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}`.toUpperCase();

const call = (m: string, u: string, p?: unknown) => injectWithApproval(app, {
  method: m as never, url: u,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
  ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });

const rowsFor = async (entityId: string) => {
  for (let i = 0; i < 30; i += 1) {
    const rows = await runWithoutTenant(() => app.prisma.auditLog.findMany({
      where: { userId: userIds[0]!, entityId } }), 'read');
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
};
const changedOf = (row: { changes: unknown }) =>
  ((row.changes as Record<string, unknown>)['changed'] ?? {}) as Record<string, { from: unknown; to: unknown }>;

const refuseAuditFor = (entityId: string) => withSuiteCapability('ddl', () => runWithoutTenant(async () => {
  await app.prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION swift_b4_refuse_${RUN}() RETURNS trigger AS $fn$
    BEGIN
      IF NEW."entityId" = '${entityId}' THEN RAISE EXCEPTION 'injected'; END IF;
      RETURN NEW;
    END; $fn$ LANGUAGE plpgsql;`);
  await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS swift_b4_refuse_${RUN} ON audit_logs;`);
  await app.prisma.$executeRawUnsafe(`
    CREATE TRIGGER swift_b4_refuse_${RUN} BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION swift_b4_refuse_${RUN}();`);
}, 'inject'));
const allowAuditAgain = () => withSuiteCapability('ddl', () => runWithoutTenant(async () => {
  await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS swift_b4_refuse_${RUN} ON audit_logs;`);
}, 'cleanup'));

let seq = 0;
async function customer() {
  seq += 1;
  const u = await app.prisma.user.create({ data: {
    phone: `+5926${String(510000 + Math.floor(Math.random() * 89999))}${seq % 10}`,
    firstName: 'B4', lastName: `C${RUN}${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE', isPhoneVerified: true } });
  userIds.push(u.id);
  return u;
}
async function owedOrder(total = 1300) {
  const c = await customer();
  const order = await app.prisma.order.create({ data: {
    orderNumber: `B4-${RUN}-${nanoid(6)}`, orderType: 'FOOD_DELIVERY', customerId: c.id, vendorId,
    status: 'CANCELLED', deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
    subtotalBase: total - 300, subtotalMarkup: 0, subtotalCustomer: total - 300, deliveryFee: 300, totalAmount: total,
    paymentMethod: 'CASH', cancelledAt: new Date(), refundOwedAmount: total, refundOwedAt: new Date(), refundOwedById: userIds[0]! } });
  orderIds.push(order.id);
  return order;
}
async function dueReturn(refundAmount = 4500) {
  const order = await owedOrder(refundAmount);
  return app.prisma.returnRequest.create({ data: {
    orderId: order.id, customerId: order.customerId, reason: 'damaged', status: 'REFUND_DUE', refundAmount } });
}
/** `Subscription.vendorId` is unique (one subscription per vendor), so every
 *  subscription under test gets a vendor of its own. */
async function freshVendor() {
  const ownerUser = await app.prisma.user.create({ data: {
    phone: `+59276${String(Math.floor(Math.random() * 90000) + 10000)}`,
    firstName: 'B4', lastName: `Owner${RUN}${nanoid(3)}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', status: 'ACTIVE', isPhoneVerified: true } });
  userIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  ownerIds.push(owner.id);
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `B4 Kitchen ${RUN} ${nanoid(3)}`, slug: `b4-${RUN}-${nanoid(5).toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: `+59275${String(Math.floor(Math.random() * 90000) + 10000)}`, addressLine1: '1 Audit Row', city: 'Georgetown',
    region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true } });
  vendorIds.push(vendor.id);
  return vendor.id;
}
async function subscription() {
  const ownVendorId = await freshVendor();
  return app.prisma.subscription.create({ data: {
    vendorId: ownVendorId, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000) } });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await app.prisma.user.create({ data: {
    phone: `+59277${String(Math.floor(Math.random() * 90000) + 10000)}`,
    firstName: 'B4', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } } } });
  userIds.push(admin.id);
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: 'b4', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  // a vendor of our own, so the suite does not depend on seeded data
  vendorId = await freshVendor();
});

afterAll(async () => {
  await allowAuditAgain().catch(() => {});
  await withSuiteCapability('ddl', () => runWithoutTenant(async () => {
    await app.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS swift_b4_refuse_${RUN}();`);
  }, 'cleanup')).catch(() => {});
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.subscription.deleteMany({ where: { vendorId: { in: vendorIds } } }).catch(() => {});
    await app.prisma.returnRequest.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await app.prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }).catch(() => {});
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'b4').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'b4').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'b4');
  await app.close();
});

describe('[ADM-002] PUT /orders/:id/refund-settled', () => {
  it('the trail carries the reference and the amount as a DIFF, and the legacy row is gone', async () => {
    const order = await owedOrder(1300);
    const ref = refFor('CASH');
    const res = await call('PUT', `/api/v1/admin/orders/${order.id}/refund-settled`, { reference: ref, amount: 1300, reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor(order.id);
    expect(rows.length, 'one inline row for the settlement').toBe(1);
    const changed = changedOf(rows[0]!);
    expect(changed['refundRef']?.to, 'the reference IS the proof — it must be in the trail').toBe(ref);
    expect(changed['status']?.to).toBe('REFUNDED');
    expect(String(changed['refundPaidAmount']?.to)).toMatch(/^1300(\.0+)?$/);
    expect(rows.some((r) => r.action === 'SETTLE_ORDER_REFUND'), 'the legacy row is retired').toBe(false);
  });

  it('a refused audit row rolls the settlement AND its status-log line back', async () => {
    const order = await owedOrder(1300);
    const logsBefore = await app.prisma.orderStatusLog.count({ where: { orderId: order.id } });
    await refuseAuditFor(order.id);
    try {
      const res = await call('PUT', `/api/v1/admin/orders/${order.id}/refund-settled`, { reference: refFor('CASH'), amount: 1300, reason: REASON });
      expect(res.statusCode, 'a settlement whose audit was refused must not report success').not.toBe(200);
    } finally { await allowAuditAgain(); }
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.refundSettledAt, 'the settlement did not commit').toBeNull();
    expect(fresh.status).toBe('CANCELLED');
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } }), 'nor did the status line').toBe(logsBefore);
  });
});

describe('[ADM-002] PUT /returns/:id/refund-settled', () => {
  it('the transfer reference travels in the diff', async () => {
    const r = await dueReturn(4500);
    const ref = refFor('BANK');
    const res = await call('PUT', `/api/v1/admin/returns/${r.id}/refund-settled`, { reference: ref, amount: 4500, reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor(r.id);
    expect(rows.length).toBe(1);
    const changed = changedOf(rows[0]!);
    expect(changed['refundRef']?.to).toBe(ref);
    expect(changed['status']?.to).toBe('REFUNDED');
    expect(rows.some((x) => x.action === 'SETTLE_RETURN_REFUND')).toBe(false);
  });

  it('a refused audit row leaves the return REFUND_DUE', async () => {
    const r = await dueReturn(4500);
    await refuseAuditFor(r.id);
    try {
      const res = await call('PUT', `/api/v1/admin/returns/${r.id}/refund-settled`, { reference: refFor('BANK'), amount: 4500, reason: REASON });
      expect(res.statusCode).not.toBe(200);
    } finally { await allowAuditAgain(); }
    const fresh = await app.prisma.returnRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(fresh.status).toBe('REFUND_DUE');
    expect(fresh.refundRef).toBeNull();
  });
});

describe('[ADM-002] PUT /subscriptions/:id/waive-fee', () => {
  it('the waiver and its reason are one committed record', async () => {
    const sub = await subscription();
    const res = await call('PUT', `/api/v1/admin/subscriptions/${sub.id}/waive-fee`, { reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor(sub.id);
    expect(rows.length).toBe(1);
    expect(changedOf(rows[0]!)['feeWaived']?.to).toBe(true);
    expect((rows[0]!.changes as Record<string, unknown>)['reason']).toBe(REASON);
    expect(rows.some((x) => x.action === 'WAIVE_SUBSCRIPTION_FEE')).toBe(false);
  });

  it('a refused audit row leaves the fee unwaived', async () => {
    const sub = await subscription();
    await refuseAuditFor(sub.id);
    try {
      const res = await call('PUT', `/api/v1/admin/subscriptions/${sub.id}/waive-fee`, { reason: REASON });
      expect(res.statusCode).not.toBe(200);
    } finally { await allowAuditAgain(); }
    const fresh = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(fresh.feeWaived).toBe(false);
  });
});
