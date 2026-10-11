import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [MMGCLOSE · owner 8 Oct ~22:45 "money doesn't go through me"] A store-claimed
// MMG order that cannot be fulfilled could never be closed: every cancel path
// refuses paid MMG money (MMG_CANCEL_UNAVAILABLE) and refund-settled refuses
// MMG (MMG_REFUND_RAIL_REQUIRED). Swift support can now close it as "refund
// handled by the store": RECORD ONLY. Two admins (the C4 approval gate), a
// stated reason, bound to the order and the claim revision the admin reviewed;
// the order becomes CANCELLED with the refund rail's CANCELLATION obligation
// (OWED — the store owes the customer); no money moves anywhere; the customer
// and the store are told in plain words.
// ---------------------------------------------------------------------------
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, PaymentStatus } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { adminRoutes } from '../modules/admin/admin.routes';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { APPROVAL_HEADER } from '../modules/admin/admin-approval';
import { TERMINAL_ORDER_STATUSES, MOVER_HOLDING_STATUSES } from '../modules/order/order-status';

const RUN = nanoid(8);
const REASON = 'The store cannot fulfil this order; support is following up with the store about its direct refund.';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:mmg-store-close');
let app: FastifyInstance;
let customerId: string, vendorId: string, ownerId: string;
const orderIds: string[] = [];
const people: Record<string, { id: string; token: string }> = {};

async function person(role: 'ADMIN' | 'SUPER_ADMIN' | 'CUSTOMER' | 'VENDOR_OWNER', suffix: number) {
  const user = await sys(() => app.prisma.user.create({ data: {
    phone: `+59270${Date.now().toString().slice(-6)}${suffix}`, firstName: 'Fixture', lastName: RUN,
    roles: [role], activeRole: role, status: 'ACTIVE', isPhoneVerified: true,
    ...(['ADMIN', 'SUPER_ADMIN'].includes(role) ? { admin: { create: { permissions: ['*'] } } } : {}),
  } }));
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid() });
  await sys(() => app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    expiresAt: new Date(Date.now() + 86_400_000), deviceId: RUN, deviceType: 'test',
  } }));
  return { id: user.id, token };
}

async function order(over: { status?: OrderStatus; paymentStatus?: PaymentStatus; paymentMethod?: 'CASH' | 'MOBILE_MONEY'; mmgClaimRevision?: number } = {}) {
  const created = await sys(() => app.prisma.order.create({ data: {
    orderNumber: `MMGCLOSE-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP',
    customerId, vendorId, status: 'ACCEPTED', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED',
    mmgClaimRevision: 3, mmgAttestedRef: `CLOSE${nanoid(12).replace(/[^a-zA-Z0-9]/g, '0')}`,
    mmgAttestedAt: new Date(), mmgAttestedAmount: 1300,
    deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15,
    subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300,
    ...over,
  } }));
  orderIds.push(created.id);
  return created;
}
const read = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const close = (id: string, role = 'ADMIN', revision = 3, approval?: string, reason: string | null = REASON) => app.inject({
  method: 'POST', url: `/api/v1/admin/orders/${id}/close-store-refund`,
  headers: { authorization: `Bearer ${people[role]!.token}`, ...(reason ? { 'x-swift-reason': reason } : {}), ...(approval ? { [APPROVAL_HEADER]: approval } : {}) },
  payload: { expectedClaimRevision: revision },
});
async function approve(id: string, role = 'ADMIN', revision = 3) {
  const ask = await close(id, role, revision);
  expect(ask.statusCode, ask.body).toBe(202);
  const approval = ask.json().error.details.approvalId as string;
  const second = role === 'ADMIN' ? 'SUPER_ADMIN' : 'ADMIN';
  const res = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${approval}/decide`,
    headers: { authorization: `Bearer ${people[second]!.token}`, 'x-swift-reason': REASON }, payload: { approve: true } });
  expect(res.statusCode, res.body).toBe(200);
  return approval;
}

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
  for (const role of ['ADMIN', 'SUPER_ADMIN', 'CUSTOMER', 'VENDOR_OWNER'] as const) people[role] = await person(role, ++n);
  customerId = people['CUSTOMER']!.id;
  ownerId = people['VENDOR_OWNER']!.id;
  const owner = await sys(() => app.prisma.vendorOwner.create({ data: { userId: ownerId } }));
  const vendor = await sys(() => app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Fixture ${RUN}`, slug: `close-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT',
    status: 'ACTIVE', phone: '+5920000000', addressLine1: 'Fixture', city: 'Fixture', region: 'Fixture', latitude: 6.8, longitude: -58.1,
  } }));
  vendorId = vendor.id;
});
afterAll(async () => {
  if (!app) return;
  try {
    await sys(async () => {
      const ids = Object.values(people).map((p) => p.id);
      await app.prisma.mmgRefundObligation.deleteMany({ where: { orderId: { in: orderIds } } });
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: ids } } });
      await purgeAuditLogs(app.prisma, { userId: { in: ids } }, 'test-cleanup:mmg-store-close');
      await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: ids } } } });
      await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    });
  } finally { await app.close(); }
});

describe('record-only closure of store-claimed MMG orders', () => {
  it.each(['ADMIN', 'SUPER_ADMIN'])('%s closes only after another admin agrees, without moving money', async (role) => {
    const before = await order();
    const approval = await approve(before.id, role);
    expect((await read(before.id)).status).toBe('ACCEPTED');
    const res = await close(before.id, role, 3, approval);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ orderId: before.id, status: 'CANCELLED', disposition: 'REFUND_HANDLED_BY_STORE' });
    const after = await read(before.id);
    expect(TERMINAL_ORDER_STATUSES).toContain(after.status);
    for (const key of ['paymentStatus', 'mmgClaimRevision', 'totalAmount', 'refundOwedAt', 'refundSettledAt', 'refundRef', 'lateCancelFeeDue'] as const) expect(after[key]).toEqual(before[key]);
    const obligation = await sys(() => app.prisma.mmgRefundObligation.findFirstOrThrow({ where: { orderId: before.id } }));
    expect(obligation).toMatchObject({ kind: 'CANCELLATION', status: 'OWED', sendId: null });
    expect(String(obligation.amount)).toBe('1300');
    expect(await sys(() => app.prisma.mmgRefundSend.count({ where: { orderId: before.id } }))).toBe(0);
    expect(await sys(() => app.prisma.earning.count({ where: { orderId: before.id } }))).toBe(0);
    expect(await sys(() => app.prisma.transaction.count({ where: { userId: { in: [customerId, ownerId] } } }))).toBe(0);
    const audit = await sys(() => app.prisma.auditLog.findFirstOrThrow({ where: { entityId: before.id, action: 'ADMIN POST /api/v1/admin/orders/:id/close-store-refund' } }));
    expect(audit.changes).toMatchObject({ disposition: 'REFUND_HANDLED_BY_STORE', claimRevision: 3, approvalId: approval, reason: REASON });
    const notices = await sys(() => app.prisma.notification.findMany({ where: { userId: { in: [customerId, ownerId] }, data: { path: ['orderId'], equals: before.id } } }));
    expect(notices).toHaveLength(2);
    expect(new Set(notices.map((n) => n.userId))).toEqual(new Set([customerId, ownerId]));
    for (const notice of notices) {
      expect(notice.body).toMatch(/store.*refund/i);
      expect(notice.body).toMatch(/Swift.*(never|does not).*money/i);
      expect(notice.body).not.toMatch(/refund (is confirmed|has arrived)|Swift refunded/);
    }
  });

  it('requires a reason and refuses customer and store actors', async () => {
    const o = await order();
    expect((await close(o.id, 'ADMIN', 3, undefined, null)).statusCode).toBe(400);
    for (const role of ['CUSTOMER', 'VENDOR_OWNER']) expect((await close(o.id, role)).statusCode).toBe(403);
    expect((await read(o.id)).status).toBe('ACCEPTED');
  });

  it('refuses self-approval and an unapproved application', async () => {
    const o = await order();
    const ask = await close(o.id);
    expect(ask.statusCode, ask.body).toBe(202);
    const id = ask.json().error.details.approvalId;
    const decision = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${id}/decide`,
      headers: { authorization: `Bearer ${people['ADMIN']!.token}`, 'x-swift-reason': REASON }, payload: { approve: true } });
    expect(decision.statusCode).toBe(403);
    expect((await close(o.id, 'ADMIN', 3, id)).statusCode).toBe(403);
    expect((await read(o.id)).status).toBe('ACCEPTED');
  });

  it('binds approval to the order and claim revision and rechecks the locked revision', async () => {
    const a = await order(), b = await order();
    const approved = await approve(a.id);
    expect((await close(b.id, 'ADMIN', 3, approved)).statusCode).toBe(403);
    expect((await close(a.id, 'ADMIN', 4, approved)).statusCode).toBe(403);
    await sys(() => app.prisma.order.update({ where: { id: a.id }, data: { mmgClaimRevision: 4 } }));
    const stale = await close(a.id, 'ADMIN', 3, approved);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('MMG_CLAIM_STALE');
    expect((await read(a.id)).status).toBe('ACCEPTED');
  });

  it.each([...TERMINAL_ORDER_STATUSES, ...MOVER_HOLDING_STATUSES])('refuses status %s', async (status) => {
    const o = await order({ status });
    const approved = await approve(o.id);
    const res = await close(o.id, 'ADMIN', 3, approved);
    expect(res.statusCode, res.body).toBe(409);
    expect((await read(o.id)).status).toBe(status);
    expect(await sys(() => app.prisma.mmgRefundObligation.count({ where: { orderId: o.id } }))).toBe(0);
  });

  it.each(['PENDING', 'CAPTURED', 'FAILED'] as const)('refuses payment state %s', async (paymentStatus) => {
    const o = await order({ paymentStatus });
    const approved = await approve(o.id);
    expect((await close(o.id, 'ADMIN', 3, approved)).statusCode).toBe(409);
    expect((await read(o.id)).status).toBe('ACCEPTED');
  });

  it('refuses cash and double close, including two independently approved simultaneous requests', async () => {
    const cash = await order({ paymentMethod: 'CASH' });
    expect((await close(cash.id, 'ADMIN', 3, await approve(cash.id))).statusCode).toBe(409);
    const o = await order();
    const a = await approve(o.id), b = await approve(o.id, 'SUPER_ADMIN');
    const results = await Promise.all([close(o.id, 'ADMIN', 3, a), close(o.id, 'SUPER_ADMIN', 3, b)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await close(o.id, 'ADMIN', 3, await approve(o.id))).statusCode).toBe(409);
    expect(await sys(() => app.prisma.mmgRefundObligation.count({ where: { orderId: o.id } }))).toBe(1);
  });

  it('refuses while the two payment claims are in dispute — that is the payment-claim decision first', async () => {
    const o = await order({ mmgClaimMismatchAt: new Date() } as never);
    const res = await close(o.id, 'ADMIN', 3, await approve(o.id));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('MMG_CLAIM_DISPUTED');
    expect((await read(o.id)).status).toBe('ACCEPTED');
    expect(await sys(() => app.prisma.mmgRefundObligation.count({ where: { orderId: o.id } }))).toBe(0);
  });

  it('the order screen is told when the close is available, by the same rule the write applies', async () => {
    const eligible = await order();
    const cash = await order({ paymentMethod: 'CASH', paymentStatus: 'PENDING' });
    const view = async (id: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/admin/orders/${id}`, headers: { authorization: `Bearer ${people['ADMIN']!.token}` } });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().data as { canCloseStoreRefund?: boolean };
    };
    expect((await view(eligible.id)).canCloseStoreRefund).toBe(true);
    expect((await view(cash.id)).canCloseStoreRefund).toBe(false);
    await close(eligible.id, 'ADMIN', 3, await approve(eligible.id));
    expect((await view(eligible.id)).canCloseStoreRefund).toBe(false);
  });
});
