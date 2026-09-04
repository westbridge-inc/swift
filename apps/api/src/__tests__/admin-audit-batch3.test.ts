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
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [ADM-002 · batch 3] RETIRING THE LEGACY `audit()` ROW WITHOUT LOSING WHAT IT
// CARRIED.
//
// These routes wrote TWO audit rows: the onResponse hook's, and a second from
// the legacy `audit()` helper. Consolidating onto one row inside the action's
// transaction is the point of ADM-002 — but on a CREATE route the legacy row
// is the ONLY one carrying the new id, because a create declares no entity and
// the hook falls back to `entityId = '-'`.
//
// That is exactly how `POST /zones` silently lost its id earlier in this
// migration. So the assertions below were written and run BEFORE the routes
// were touched: they pass on the legacy row, and must still pass on the
// consolidated one. If the id override is forgotten, they fail.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
let token = '';
const REASON = 'Promo lifecycle audit check, ref GY-2026-09-04';

const call = (m: string, u: string, p?: unknown) => injectWithApproval(app, {
  method: m as never, url: u,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });

// Query by SUBJECT, not by action name. The legacy rows are called
// `CREATE_PROMO` / `DELETE_PROMO` — not paths — so an `action contains "/promos"`
// filter sees only the hook's rows and misses exactly the row under test.
// The hook also writes AFTER the response, so give it a moment to land.
const rowsNaming = async (entityId: string) => {
  for (let i = 0; i < 20; i += 1) {
    const rows = await runWithoutTenant(() => app.prisma.auditLog.findMany({
      where: { userId: userIds[0]!, entityId } }), 'read');
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
};

const promoBody = (code: string) => ({
  code, description: 'batch 3 audit check', discountType: 'PERCENTAGE', discountValue: 7,
  validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString(),
  reason: REASON });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const user = await app.prisma.user.create({ data: {
    phone: `+59278${String(Math.floor(Math.random() * 90000) + 10000)}`,
    firstName: 'Batch3', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } } } });
  userIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: 'batch3', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
});

afterAll(async () => {
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.promoCode.deleteMany({ where: { code: { startsWith: `B3${RUN.toUpperCase()}` } } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'b3').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'b3').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'b3');
  await app.close();
});

describe('[ADM-002] the promo lifecycle keeps naming its subject', () => {
  it('CREATE: the trail names the promo that was created', async () => {
    const res = await call('POST', '/api/v1/admin/promos', promoBody(`B3${RUN.toUpperCase()}A`));
    expect(res.statusCode, res.body).toBe(200);
    const promo = (JSON.parse(res.body) as { data: { id: string; code: string } }).data;

    const rows = await rowsNaming(promo.id);
    expect(rows.length,
      `the trail must name promo ${promo.id} — a create declares no entity, so the hook alone records "-"`).toBeGreaterThan(0);
  });

  it('DELETE: the trail names the promo that was deactivated', async () => {
    const made = await call('POST', '/api/v1/admin/promos', promoBody(`B3${RUN.toUpperCase()}B`));
    expect(made.statusCode, made.body).toBe(200);
    const promo = (JSON.parse(made.body) as { data: { id: string } }).data;

    const res = await call('DELETE', `/api/v1/admin/promos/${promo.id}`, { reason: REASON });
    expect(res.statusCode, res.body).toBe(200);

    const rows = await rowsNaming(promo.id);
    expect(rows.length, 'a declared entity takes its id from the params').toBeGreaterThan(0);
    const still = await runWithoutTenant(() => app.prisma.promoCode.findUnique({ where: { id: promo.id } }), 'read');
    expect(still?.isActive, 'the promo is deactivated, not deleted').toBe(false);
  });
});
