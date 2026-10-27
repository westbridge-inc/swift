import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { SUPPORT_OPERATOR_CAPABILITIES } from '../modules/admin/admin-authority';
import { WAITING_QUEUES, countWaiting, servesRead, type WaitingKey } from '../modules/admin/dashboard-waiting';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S2-1] TODAY LISTS EVERY QUEUE THAT WAITS FOR A PERSON.
//
// Today's "Needs you" counted unassigned orders, past-due fees and pending
// stores, and said "All clear — no active alerts" while an ops page waited for
// acknowledgement, documents waited, a second signature was owed and a SAFETY
// ticket was open. GET /admin/dashboard/waiting counts every queue with the
// queue page's own read, only for a grant that opens that read, and never
// turns a count it could not read into a zero.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const TENANT_B = `waiting-b-${RUN}`;
const userIds: string[] = [];
const ticketIds: string[] = [];
const reportIds: string[] = [];
const alertIds: string[] = [];
const docIds: string[] = [];
const claimIds: string[] = [];
const orderIds: string[] = [];
const riderIds: string[] = [];

async function makeUser(role: 'ADMIN' | 'SUPER_ADMIN' | 'CUSTOMER', permissions: string[] | null, tenantId = 'swift-default') {
  const user = await runWithoutTenant(() => app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Waiting', lastName: `Test${RUN}`, roles: role === 'CUSTOMER' ? ['CUSTOMER'] : [role, 'CUSTOMER'],
      activeRole: role, status: 'ACTIVE', isPhoneVerified: true, tenantId,
      ...(permissions ? { admin: { create: { permissions } } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  await runWithoutTenant(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'dashboard-waiting', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  }));
  return { id: user.id, token };
}

const call = (token: string, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

async function waiting(token: string) {
  const res = await call(token, '/api/v1/admin/dashboard/waiting');
  expect(res.statusCode, res.body).toBe(200);
  const data = res.json().data as { queues: { key: WaitingKey; count: number | null; door: boolean }[]; notCounted: WaitingKey[] };
  return { ...data, count: (key: WaitingKey) => data.queues.find((q) => q.key === key)?.count, door: (key: WaitingKey) => data.queues.find((q) => q.key === key)?.door };
}

async function ticket(userId: string, category: 'SAFETY' | 'ORDER_ISSUE', status: 'OPEN' | 'IN_PROGRESS' = 'OPEN') {
  const row = await runWithoutTenant(() => app.prisma.supportTicket.create({ data: { userId, category, subject: `Waiting ${RUN}`, message: 'Fixture ticket for the Today count.', status } }));
  ticketIds.push(row.id);
}
async function opsAlert(tenantId: string | null) {
  const row = await runWithoutTenant(() => app.prisma.opsAlert.create({ data: { tenantId, kind: 'DRILL', title: `Waiting ${RUN}`, body: 'Fixture page.', ackDeadlineAt: new Date(Date.now() + 600_000) } }));
  alertIds.push(row.id);
}
async function vatCertificate(userId: string) {
  const row = await runWithoutTenant(() => app.prisma.verificationDocument.create({ data: { userId, role: 'VENDOR_OWNER', docType: 'vat_registration_certificate', fileUrl: `local://waiting-${RUN}/${nanoid(6)}.pdf` } }));
  docIds.push(row.id);
}
async function report(reporterId: string) {
  const row = await runWithoutTenant(() => app.prisma.contentReport.create({ data: { reporterId, targetType: 'USER', targetId: `waiting-${nanoid(8)}`, reason: 'SPAM' } }));
  reportIds.push(row.id);
}

let superAdmin: { id: string; token: string };
let admin: { id: string; token: string };
let customer: { id: string; token: string };
let customerB: { id: string; token: string };

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
  await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'Waiting Tenant B', slug: TENANT_B, isActive: true } }));
  superAdmin = await makeUser('SUPER_ADMIN', ['*']);
  admin = await makeUser('ADMIN', null);
  customer = await makeUser('CUSTOMER', null);
  customerB = await makeUser('CUSTOMER', null, TENANT_B);
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.opsAlert.deleteMany({ where: { id: { in: alertIds } } }).catch(() => {});
    await app.prisma.verificationDocument.deleteMany({ where: { id: { in: docIds } } }).catch(() => {});
    await app.prisma.reimbursementClaim.deleteMany({ where: { id: { in: claimIds } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } }).catch(() => {});
    await app.prisma.contentReport.deleteMany({ where: { id: { in: reportIds } } }).catch(() => {});
    await app.prisma.supportTicket.deleteMany({ where: { id: { in: ticketIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } }).catch(() => {});
  }, 'test-cleanup:dashboard-waiting');
  await app.close();
});

describe('[ADMIN-AUDIT S2-1] Today counts every queue that waits for a person', () => {
  it('lists every queue, safety first, and each count is the number the queue\'s own page reads', async () => {
    await ticket(customer.id, 'SAFETY');
    await ticket(customer.id, 'ORDER_ISSUE', 'IN_PROGRESS');
    await opsAlert('swift-default');
    await report(customer.id);
    const w = await waiting(superAdmin.token);
    expect(w.queues.map((q) => q.key)).toEqual(WAITING_QUEUES.map((q) => q.key));
    expect(w.queues.slice(0, 3).map((q) => q.key)).toEqual(['opsAlerts', 'supportSafety', 'supportSafetyInProgress']);
    for (const q of w.queues) expect(q.door, q.key).toBe(true);
    expect(w.notCounted).toEqual([]);
    for (const q of w.queues) expect(q.count, q.key).not.toBeNull();

    const json = async (url: string) => { const r = await call(superAdmin.token, url); expect(r.statusCode, url).toBe(200); return r.json(); };
    expect(w.count('opsAlerts')).toBe((await json('/api/v1/safety/ops-alerts')).data.length);
    // Each support row is the tab that lists its tickets: Open, In progress.
    expect(w.count('supportSafety')! + w.count('support')!).toBe((await json('/api/v1/admin/support?status=OPEN')).data.total);
    expect(w.count('supportSafetyInProgress')! + w.count('supportInProgress')!).toBe((await json('/api/v1/admin/support?status=IN_PROGRESS')).data.total);
    // Documents: what waits in the Review Center, less the VAT certificates Store VAT decides (counted there).
    const vatWaiting = await runWithoutTenant(() => app.prisma.verificationDocument.count({ where: { status: 'PENDING', docType: 'vat_registration_certificate', user: { tenantId: 'swift-default' } } }));
    expect(w.count('documents')).toBe(((await json('/api/v1/admin/verification/queue/counts')).data.byStatus.PENDING ?? 0) - vatWaiting);
    expect(w.count('approvals')).toBe((await json('/api/v1/admin/approvals?status=PENDING')).pagination.total);
    expect(w.count('paymentConfirmations')).toBe((await json('/api/v1/admin/billing/confirmations')).data.length);
    const catalogue = (await json('/api/v1/admin/catalogue-review')).data;
    expect(w.count('catalogue')).toBe(catalogue.total + catalogue.storesTotal);
    expect(w.count('storeVat')).toBe((await json('/api/v1/admin/store-vat/pending')).data.length);
    expect(w.count('custody')).toBe((await json('/api/v1/admin/custody-cases?open=true')).data.length);
    expect(w.count('claimsToDecide')).toBe((await json('/api/v1/admin/cash-rules/claims?status=PENDING_REVIEW')).meta.total);
    expect(w.count('claimsToPay')).toBe((await json('/api/v1/admin/cash-rules/claims?status=APPROVED')).meta.total);
    expect(w.count('claimsAutoToPay')).toBe((await json('/api/v1/admin/cash-rules/claims?status=AUTO_APPROVED')).meta.total);
    expect(w.count('returnsToDecide')).toBe((await json('/api/v1/admin/returns?status=REQUESTED')).meta.total);
    expect(w.count('refundsOwed')).toBe((await json('/api/v1/admin/returns?status=REFUND_DUE')).meta.total);
    const ratings = (await json('/api/v1/admin/ratings/moderation')).data;
    expect(w.count('moderation')).toBe((await json('/api/v1/admin/moderation/reports')).pendingTotal + ratings.held.length + ratings.reports.length);
  });

  it('a SAFETY ticket is counted on its own line, by the tab that lists it (Open, In progress); any other on the support lines', async () => {
    const keys = ['supportSafety', 'supportSafetyInProgress', 'support', 'supportInProgress'] as const;
    const cases: [ 'SAFETY' | 'ORDER_ISSUE', 'OPEN' | 'IN_PROGRESS', (typeof keys)[number]][] = [
      ['SAFETY', 'OPEN', 'supportSafety'], ['SAFETY', 'IN_PROGRESS', 'supportSafetyInProgress'],
      ['ORDER_ISSUE', 'OPEN', 'support'], ['ORDER_ISSUE', 'IN_PROGRESS', 'supportInProgress'],
    ];
    for (const [category, status, key] of cases) {
      const before = await waiting(superAdmin.token);
      await ticket(customer.id, category, status);
      const after = await waiting(superAdmin.token);
      for (const k of keys) expect(after.count(k), `${category} ${status} -> ${k}`).toBe(before.count(k)! + (k === key ? 1 : 0));
    }
  });

  it('an approved claim and an automatically approved one are each counted on the line whose tab lists it', async () => {
    const orders = await runWithoutTenant(() => Promise.all([0, 1].map(() => app.prisma.order.create({ data: {
      orderNumber: `WT-${nanoid(10).toUpperCase()}`, customerId: customer.id, orderType: 'COURIER', status: 'DELIVERED',
      deliveryAddress: '1 Test St', deliveryLat: 6.8055, deliveryLng: -58.1553,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
    }, select: { id: true, customerId: true } }))));
    orderIds.push(...orders.map((o) => o.id));
    const mover = await makeUser('CUSTOMER', null);
    const rider = await runWithoutTenant(() => app.prisma.rider.create({ data: { userId: mover.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } }));
    riderIds.push(rider.id);
    const before = await waiting(superAdmin.token);
    for (const [order, status] of [[orders[0]!, 'APPROVED'], [orders[1]!, 'AUTO_APPROVED']] as const) {
      const row = await runWithoutTenant(() => app.prisma.reimbursementClaim.create({ data: {
        orderId: order.id, customerId: order.customerId, riderId: rider.id, amount: 1500, reason: 'no_show', gpsLat: 6.8055, gpsLng: -58.1553, status,
      } }));
      claimIds.push(row.id);
    }
    const after = await waiting(superAdmin.token);
    expect(after.count('claimsToPay')).toBe(before.count('claimsToPay')! + 1);
    expect(after.count('claimsAutoToPay')).toBe(before.count('claimsAutoToPay')! + 1);
  });

  it('a waiting VAT certificate is counted once, under Store VAT\'s own count — never as a Review Center document', async () => {
    const before = await waiting(superAdmin.token);
    await vatCertificate(customer.id);
    const after = await waiting(superAdmin.token);
    expect(after.count('documents')).toBe(before.count('documents'));
  });

  it('ops pages: a tenant ADMIN counts their tenant\'s, the platform responder every tenant\'s and the platform\'s — as GET /safety/ops-alerts lists them', async () => {
    const [s0, a0] = [await waiting(superAdmin.token), await waiting(admin.token)];
    await opsAlert(null);
    await opsAlert(TENANT_B);
    await opsAlert('swift-default');
    const [s1, a1] = [await waiting(superAdmin.token), await waiting(admin.token)];
    expect(s1.count('opsAlerts')).toBe(s0.count('opsAlerts')! + 3);
    expect(a1.count('opsAlerts')).toBe(a0.count('opsAlerts')! + 1);
    expect(a1.count('opsAlerts')).toBe((await call(admin.token, '/api/v1/safety/ops-alerts')).json().data.length);
  });

  it('another tenant\'s tickets and reports are never counted', async () => {
    const [s0, a0] = [await waiting(superAdmin.token), await waiting(admin.token)];
    await ticket(customerB.id, 'SAFETY');
    await ticket(customerB.id, 'ORDER_ISSUE');
    await report(customerB.id);
    const [s1, a1] = [await waiting(superAdmin.token), await waiting(admin.token)];
    for (const key of ['supportSafety', 'support', 'moderation'] as const) {
      expect(s1.count(key), key).toBe(s0.count(key));
      expect(a1.count(key), key).toBe(a0.count(key));
    }
  });

  it('a narrowed operator is counted only the queues their grant opens; the rest are named, never zero — and agree with the routes', async () => {
    const op = await makeUser('ADMIN', [...SUPPORT_OPERATOR_CAPABILITIES]);
    const w = await waiting(op.token);
    expect(w.queues.map((q) => q.key)).toEqual(['opsAlerts', 'supportSafety', 'supportSafetyInProgress', 'documents', 'support', 'supportInProgress', 'catalogue', 'moderation']);
    expect(w.notCounted).toEqual(['approvals', 'paymentConfirmations', 'storeVat', 'custody', 'claimsToDecide', 'claimsToPay', 'claimsAutoToPay', 'returnsToDecide', 'refundsOwed']);
    // It may count documents (DOC-1 §8.4) but not open the Review Center's queue: that row is not a door.
    expect(w.door('documents')).toBe(false);
    expect((await call(op.token, '/api/v1/admin/verification/queue')).statusCode).toBe(403);
    for (const key of ['opsAlerts', 'supportSafety', 'support', 'catalogue', 'moderation'] as const) expect(w.door(key), key).toBe(true);
    // The rule is the capability hook's own: every named read answers 403 to this token, every counted one does not.
    for (const q of WAITING_QUEUES) {
      for (const route of q.reads) {
        const url = `/api/v1/admin${route.slice(4)}`;
        const status = (await call(op.token, url)).statusCode;
        if (w.notCounted.includes(q.key)) expect(status, url).toBe(403);
        else expect(status, url).not.toBe(403);
      }
    }
  });

  it('a customer is refused', async () => {
    expect((await call(customer.token, '/api/v1/admin/dashboard/waiting')).statusCode).toBe(403);
  });
});

describe('[ADMIN-AUDIT S2-1] the count rule', () => {
  const zero = Object.fromEntries(WAITING_QUEUES.map((q) => [q.key, async () => 0])) as Record<WaitingKey, () => Promise<number>>;

  it('a count that cannot be read is null (unknown), never zero, and never hides the others', async () => {
    const errors: string[] = [];
    const w = await countWaiting({ role: 'SUPER_ADMIN' }, { ...zero, documents: async () => { throw new Error('db down'); }, approvals: async () => 4 },
      (key) => errors.push(key), 'enforce');
    expect(w.queues.find((q) => q.key === 'documents')!.count).toBeNull();
    expect(w.queues.find((q) => q.key === 'approvals')!.count).toBe(4);
    expect(w.queues.filter((q) => q.count === null)).toHaveLength(1);
    expect(errors).toEqual(['documents']);
  });

  it('a value that is not a count is unknown too', async () => {
    const w = await countWaiting({ role: 'SUPER_ADMIN' }, { ...zero, custody: async () => Number.NaN }, () => {}, 'enforce');
    expect(w.queues.find((q) => q.key === 'custody')!.count).toBeNull();
  });

  it('shadow mode serves a plain capability miss (as the hook does), never a missing explicit grant', () => {
    const narrow = { role: 'ADMIN', permissions: ['dashboard.read'] };
    expect(servesRead(narrow, 'GET /approvals', 'enforce')).toBe(false);
    expect(servesRead(narrow, 'GET /approvals', 'shadow')).toBe(true);
    expect(servesRead(narrow, 'GET /verification/:id/document-url', 'shadow')).toBe(false);
    expect(servesRead(narrow, 'GET /no-such-route', 'shadow')).toBe(false);
  });
});
