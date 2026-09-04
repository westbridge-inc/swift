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
// [ADM-002 · batch 2] THE SIX ROUTES THAT HAD NO AUDIT ROW OF THEIR OWN.
//
// These six never called the legacy `audit()` helper, so the onResponse hook
// was their ONLY writer — the exact shape the clause names: the row is written
// after commit and after the response, and a failure leaves a privileged
// action with no record and a log line.
//
// Two of them were worse. `POST /billing/fx-rates` and `PUT /billing/price-book`
// CREATE their subject, and a create declares no entity in
// ADMIN_ROUTE_AUTHORITY, so the hook's row recorded `entityId = '-'`. Setting
// the rate every payer is charged at left a trail that could not say WHICH
// rate had been set.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
let token = '';
const REASON = 'September FX reconciliation, board minute GY-2026-09';
const QUOTE = 'XTS'; // ISO 4217 code reserved for testing

const call = (m: string, u: string, p?: unknown) => injectWithApproval(app, {
  method: m as never, url: u,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });

const allowAudit = () => withSuiteCapability('ddl', () => runWithoutTenant(async () => {
  await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS swift_b2_refuse_${RUN} ON audit_logs;`);
  await app.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS swift_b2_refuse_${RUN}();`);
}, 'cleanup'));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const user = await app.prisma.user.create({ data: {
    phone: `+59277${String(Math.floor(Math.random() * 90000) + 10000)}`,
    firstName: 'Batch2', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } } } });
  userIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: 'batch2', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
});

afterAll(async () => {
  await allowAudit().catch(() => {});
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.fxRate.deleteMany({ where: { quote: QUOTE } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'b2').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'b2').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'b2');
  await app.close();
});

describe('[ADM-002] setting the FX rate is recorded, and names the rate it set', () => {
  it('the audit row carries the created rate id, not "-"', async () => {
    const res = await call('POST', '/api/v1/admin/billing/fx-rates', {
      quote: QUOTE, rate: 210.5, source: 'FOUNDER_MANUAL', reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
    const created = (JSON.parse(res.body) as { data: { id: string } }).data;

    const rows = await runWithoutTenant(() => app.prisma.auditLog.findMany({
      where: { userId: userIds[0]!, action: { contains: '/billing/fx-rates' } } }), 'read');
    expect(rows.length, 'the rate change is audited at all').toBeGreaterThan(0);
    expect(rows.some((r) => r.entityId === created.id),
      `the trail must name rate ${created.id}; before this it recorded "-"`).toBe(true);
  });

  it('a refused audit row rolls the RATE back — no rate, no record, together', async () => {
    const before = await runWithoutTenant(() => app.prisma.fxRate.count({ where: { quote: QUOTE } }), 'read');
    // refuse every audit row this route would write, whatever id it invents
    await withSuiteCapability('ddl', () => runWithoutTenant(async () => {
      await app.prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION swift_b2_refuse_${RUN}() RETURNS trigger AS $fn$
        BEGIN
          IF NEW."action" LIKE '%/billing/fx-rates%' THEN RAISE EXCEPTION 'injected'; END IF;
          RETURN NEW;
        END; $fn$ LANGUAGE plpgsql;`);
      await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS swift_b2_refuse_${RUN} ON audit_logs;`);
      await app.prisma.$executeRawUnsafe(`
        CREATE TRIGGER swift_b2_refuse_${RUN} BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION swift_b2_refuse_${RUN}();`);
    }, 'inject'));
    try {
      const res = await call('POST', '/api/v1/admin/billing/fx-rates', {
        quote: QUOTE, rate: 211.5, source: 'FOUNDER_MANUAL', reason: REASON });
      expect(res.statusCode, 'a rate whose audit was refused must not report success').not.toBe(200);
    } finally {
      await allowAudit();
    }
    const after = await runWithoutTenant(() => app.prisma.fxRate.count({ where: { quote: QUOTE } }), 'read');
    expect(after, 'the rate must not have been written').toBe(before);
  });
});
