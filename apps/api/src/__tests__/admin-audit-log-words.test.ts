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
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-5, S3-7] "Who did what, and why" names the who and says the why.
//
// The audit log showed a raw account id and no reason; the approvals card named
// the asker by account id. The reads now carry the admin's name (within this
// tenant) and, on an audit row, the reason the admin stated.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const TENANT_B = `auditwords-b-${RUN}`;
const userIds: string[] = [];
const auditIds: string[] = [];
const approvalIds: string[] = [];

async function makeAdmin(firstName: string, lastName: string, tenantId = 'swift-default') {
  const user = await runWithoutTenant(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName, lastName, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE',
    isPhoneVerified: true, tenantId, admin: { create: { permissions: ['*'] } },
  } }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await runWithoutTenant(() => app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'audit-words', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
  } }));
  return { id: user.id, token };
}
const call = (token: string, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

let viewer: { id: string; token: string };
let asker: { id: string; token: string };
let approver: { id: string; token: string };

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'Audit Words B', slug: TENANT_B, isActive: true } }));
  viewer = await makeAdmin('Vera', `Viewer${RUN}`);
  asker = await makeAdmin('Asha', `Asker${RUN}`);
  approver = await makeAdmin('Omar', `Approver${RUN}`);
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.auditLog.deleteMany({ where: { OR: [{ id: { in: auditIds } }, { userId: { in: userIds } }] } }).catch(() => {});
    await app.prisma.privilegedApproval.deleteMany({ where: { id: { in: approvalIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } }).catch(() => {});
  }, 'test-cleanup:audit-words');
  await app.close();
});

describe('[ADMIN-AUDIT S3-5] the audit log names the admin and says the stated reason', () => {
  it('a row carries the actor\'s name and the reason; a row without one says null, never invents it', async () => {
    const withReason = await runWithoutTenant(() => app.prisma.auditLog.create({ data: {
      userId: asker.id, action: 'ADMIN PUT /subscriptions/:id/waive-fee', entity: 'subscriptions', entityId: `sub_${RUN}`,
      changes: { reason: 'Partner was closed for the flood week, waived once.', params: { id: `sub_${RUN}` } },
    } }));
    const without = await runWithoutTenant(() => app.prisma.auditLog.create({ data: {
      userId: asker.id, action: 'ADMIN GET /billing/mmg-checkouts', entity: 'billing', entityId: `q_${RUN}`, changes: { params: {} },
    } }));
    auditIds.push(withReason.id, without.id);
    const res = await call(viewer.token, `/api/v1/admin/audit-logs?userId=${asker.id}&limit=10`);
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().data as { id: string; actorName: string | null; reason: string | null }[];
    const a = rows.find((r) => r.id === withReason.id)!;
    const b = rows.find((r) => r.id === without.id)!;
    expect(a.actorName).toBe(`Asha Asker${RUN}`);
    expect(a.reason).toBe('Partner was closed for the flood week, waived once.');
    expect(b.actorName).toBe(`Asha Asker${RUN}`);
    expect(b.reason).toBeNull();
  });

  it('pages: the meta says how many rows exist and a second page continues the first', async () => {
    for (let i = 0; i < 3; i++) {
      const row = await runWithoutTenant(() => app.prisma.auditLog.create({ data: {
        userId: approver.id, action: 'ADMIN POST /approvals/:id/decide', entity: 'approvals', entityId: `ap_${RUN}_${i}`, changes: { reason: `decided ${i}` },
      } }));
      auditIds.push(row.id);
    }
    const p1 = (await call(viewer.token, `/api/v1/admin/audit-logs?userId=${approver.id}&limit=2&page=1`)).json();
    const p2 = (await call(viewer.token, `/api/v1/admin/audit-logs?userId=${approver.id}&limit=2&page=2`)).json();
    expect(p1.meta.total).toBe(3);
    expect(p1.meta.hasNext).toBe(true);
    expect(p1.data).toHaveLength(2);
    expect(p2.data).toHaveLength(1);
    expect(new Set([...p1.data, ...p2.data].map((r: { id: string }) => r.id)).size).toBe(3);
  });
});

describe('[ADMIN-AUDIT S3-7] an approval names who asked and who decided', () => {
  it('the asker and the approver by name; an approver from another tenant is never named', async () => {
    const stranger = await makeAdmin('Zed', `Elsewhere${RUN}`, TENANT_B);
    const row = await runWithoutTenant(() => app.prisma.privilegedApproval.create({ data: {
      tenantId: 'swift-default', action: 'PUT /subscriptions/:id/waive-fee', cls: 'C4', capability: 'subscription.waive', entityId: `sub_${RUN}`,
      fingerprint: 'f'.repeat(64), status: 'PENDING', requestedBy: asker.id, reason: 'Partner was closed for the flood week.', expiresAt: new Date(Date.now() + 3_600_000),
    } }));
    const odd = await runWithoutTenant(() => app.prisma.privilegedApproval.create({ data: {
      tenantId: 'swift-default', action: 'PUT /subscriptions/:id/waive-fee', cls: 'C4', capability: 'subscription.waive', entityId: `sub2_${RUN}`,
      fingerprint: 'e'.repeat(64), status: 'APPROVED', requestedBy: asker.id, approvedBy: stranger.id, decidedAt: new Date(), reason: 'A row whose approver is not of this tenant.', expiresAt: new Date(Date.now() + 3_600_000),
    } }));
    approvalIds.push(row.id, odd.id);
    const pending = (await call(viewer.token, '/api/v1/admin/approvals?status=PENDING&limit=50')).json().data as { id: string; requestedByName: string | null }[];
    expect(pending.find((r) => r.id === row.id)!.requestedByName).toBe(`Asha Asker${RUN}`);
    const approved = (await call(viewer.token, '/api/v1/admin/approvals?status=APPROVED&limit=50')).json().data as { id: string; requestedByName: string | null; approvedByName: string | null }[];
    const o = approved.find((r) => r.id === odd.id)!;
    expect(o.requestedByName).toBe(`Asha Asker${RUN}`);
    expect(o.approvedByName).toBeNull();
  });
});
