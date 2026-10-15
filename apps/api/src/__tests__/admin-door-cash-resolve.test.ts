import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [L02 · row 34 · review S2-1] Partial cash a rider could not hand back at the
// door is HELD for operations. Before this route nothing in the product could
// ever move HELD, so the rider holding it could never close their account.
// Operations now records it resolved: a stated reason and a second admin (C4,
// "claims settlement of value", like refund-settled), one audited write.
// RECORD ONLY: Swift moves, refunds and deducts nothing.
// ---------------------------------------------------------------------------
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { adminRoutes } from '../modules/admin/admin.routes';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { APPROVAL_HEADER } from '../modules/admin/admin-approval';
import { partnerObligations, verdictFor } from '../modules/user/partner-wind-down';

const RUN = nanoid(8);
const REASON = 'The rider brought the partial cash to the store and the customer collected it there.';
const ROUTE = 'POST /orders/:id/door-cash-return/resolve';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:door-cash-resolve');
let app: FastifyInstance;
let vendorId = '';
let riderId = '';
const orderIds: string[] = [];
const people: Record<string, { id: string; token: string }> = {};

async function person(role: 'ADMIN' | 'SUPER_ADMIN' | 'CUSTOMER' | 'MOVER', suffix: number) {
  const user = await sys(() => app.prisma.user.create({ data: {
    phone: `+59271${Date.now().toString().slice(-6)}${suffix}`, firstName: 'Fixture', lastName: RUN,
    roles: (role === 'MOVER' ? ['MOVER', 'CUSTOMER'] : [role]) as UserRole[], activeRole: role as UserRole,
    status: 'ACTIVE', isPhoneVerified: true,
    ...(['ADMIN', 'SUPER_ADMIN'].includes(role) ? { admin: { create: { permissions: ['*'] } } } : {}),
  } }));
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid() });
  await sys(() => app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    expiresAt: new Date(Date.now() + 86_400_000), deviceId: RUN, deviceType: 'test',
  } }));
  return { id: user.id, token };
}

/** A cash delivery that went back to the store, with the customer's partial
 *  cash still with the rider (HELD), as the door's "cannot pay in full" leaves it. */
async function heldOrder(status: 'HELD' | 'RETURNED' | null = 'HELD') {
  const created = await sys(() => app.prisma.order.create({ data: {
    orderNumber: `DCR-${RUN}-${nanoid(6)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
    customerId: people['CUSTOMER']!.id, vendorId, riderId, status: 'RETURNED',
    paymentMethod: 'CASH', paymentStatus: 'PENDING',
    subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000, deliveryFee: 500, totalAmount: 3500,
    deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15,
    ...(status ? { doorCashReturnAmount: 2000, doorCashReturnStatus: status, doorCashReturnRecordedAt: new Date() } : {}),
  } }));
  orderIds.push(created.id);
  return created;
}
const read = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const resolve = (id: string, role = 'ADMIN', approval?: string, reason: string | null = REASON) => app.inject({
  method: 'POST', url: `/api/v1/admin/orders/${id}/door-cash-return/resolve`,
  headers: { authorization: `Bearer ${people[role]!.token}`, ...(reason ? { 'x-swift-reason': reason } : {}), ...(approval ? { [APPROVAL_HEADER]: approval } : {}) },
  payload: {},
});
async function approve(id: string, role = 'ADMIN') {
  const ask = await resolve(id, role);
  expect(ask.statusCode, ask.body).toBe(202);
  const approval = ask.json().error.details.approvalId as string;
  const second = role === 'ADMIN' ? 'SUPER_ADMIN' : 'ADMIN';
  const res = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${approval}/decide`,
    headers: { authorization: `Bearer ${people[second]!.token}`, 'x-swift-reason': REASON }, payload: { approve: true } });
  expect(res.statusCode, res.body).toBe(200);
  return approval;
}
const riderCensus = () => sys(() => app.prisma.$transaction((tx) => partnerObligations(tx, people['MOVER']!.id)));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  let n = 0;
  for (const role of ['ADMIN', 'SUPER_ADMIN', 'CUSTOMER', 'MOVER'] as const) people[role] = await person(role, ++n);
  const rider = await sys(() => app.prisma.rider.create({ data: {
    userId: people['MOVER']!.id, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', documentsVerified: true,
  } }));
  riderId = rider.id;
  const vendor = await sys(() => app.prisma.vendor.findFirst({ where: { status: 'ACTIVE', owner: { user: { status: 'ACTIVE' } } }, select: { id: true } }));
  if (!vendor) throw new Error('seeded ACTIVE vendor with an owner required');
  vendorId = vendor.id;
});
afterAll(async () => {
  if (!app) return;
  try {
    await sys(async () => {
      const ids = Object.values(people).map((p) => p.id);
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: ids } } });
      await purgeAuditLogs(app.prisma, { userId: { in: ids } }, 'test-cleanup:door-cash-resolve');
      await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    });
  } finally { await app.close(); }
});

describe('operations records held partial cash as resolved (record only)', () => {
  it('is a money-class action: a stated reason and a second admin', () => {
    expect(ADMIN_ROUTE_AUTHORITY[ROUTE]).toMatchObject({ cls: 'C4', capability: 'order.refund.settle' });
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])('%s resolves only after another admin agrees; the rider can then close their account', async (role) => {
    const before = await heldOrder();
    expect(verdictFor(await riderCensus()).blockers).toContain('PARTIAL_CASH_RETURN');
    const approval = await approve(before.id, role);
    expect((await read(before.id)).doorCashReturnStatus).toBe('HELD');
    const res = await resolve(before.id, role, approval);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ orderId: before.id, doorCashReturn: { amount: 2000, status: 'RESOLVED' } });
    const after = await read(before.id);
    expect(after.doorCashReturnStatus).toBe('RESOLVED');
    expect(after.doorCashReturnResolvedById).toBe(people[role]!.id);
    expect(after.doorCashReturnResolvedAt).toBeInstanceOf(Date);
    for (const key of ['status', 'paymentStatus', 'totalAmount', 'doorCashReturnAmount', 'doorCashReturnRecordedAt', 'refundOwedAmount', 'refundPaidAmount'] as const) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(await sys(() => app.prisma.earning.count({ where: { orderId: before.id } }))).toBe(0);
    expect(await sys(() => app.prisma.transaction.count({ where: { userId: { in: [people['CUSTOMER']!.id, people['MOVER']!.id] } } }))).toBe(0);
    const audit = await sys(() => app.prisma.auditLog.findFirstOrThrow({ where: { entityId: before.id, action: `ADMIN POST /api/v1/admin/orders/:id/door-cash-return/resolve` } }));
    expect(audit.changes).toMatchObject({ disposition: 'DOOR_CASH_RESOLVED', amount: 2000, previousStatus: 'HELD', approvalId: approval, reason: REASON });
    expect(verdictFor(await riderCensus()).blockers).not.toContain('PARTIAL_CASH_RETURN');
  });

  it('refuses without a reason, and refuses a customer or a rider', async () => {
    const held = await heldOrder();
    expect((await resolve(held.id, 'ADMIN', undefined, null)).statusCode).toBe(400);
    for (const role of ['CUSTOMER', 'MOVER']) expect((await resolve(held.id, role)).statusCode).toBe(403);
    expect((await read(held.id)).doorCashReturnStatus).toBe('HELD');
  });

  it.each([['RETURNED'], [null]] as const)('refuses an order whose partial cash is %s (nothing held)', async (status) => {
    const order = await heldOrder(status);
    const approval = await approve(order.id);
    const res = await resolve(order.id, 'ADMIN', approval);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('NO_HELD_CASH');
    expect((await read(order.id)).doorCashReturnStatus).toBe(status);
  });
});
