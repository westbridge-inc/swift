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
import { adminAuditCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [ADM-002] A BROADCAST IS ANNOUNCED BEFORE IT IS RECORDED.
//
// The route created the notification rows, EMITTED them over socket.io, and
// then wrote its audit row — with the audit free to fail on its own after
// every recipient already held the message. An emit cannot be recalled.
//
// It is also the one route whose subject is not a row. Its exemption reason
// says so: "addresses every user; the subject is the audience, not a row". So
// the legacy `audit()` row carried `{ title, role, recipientCount }`, and
// `changeRecord()` cannot derive any of that — consolidating without carrying
// them across would record that a broadcast happened while losing HOW MANY
// PEOPLE IT REACHED.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const recipientIds: string[] = [];
let token = '';
const REASON = 'Service notice to movers, ops ticket GY-4482';
const TITLE = `Broadcast probe ${RUN}`;

const call = (m: string, u: string, p?: unknown) => injectWithApproval(app, {
  method: m as never, url: u,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });

/** `swift_admin_audit_total{writer="refused",cls="C5"}` — the only place an
 *  inline refusal is counted, since the hook leaves on any 5xx. */
const refusedC5 = async () => (await adminAuditCounter.get()).values
  .find((v) => v.labels['writer'] === 'refused' && v.labels['cls'] === 'C5')?.value ?? 0;

const broadcastRows = async () => {
  for (let i = 0; i < 20; i += 1) {
    const rows = await runWithoutTenant(() => app.prisma.auditLog.findMany({
      where: { userId: userIds[0]!, entityId: 'broadcast' } }), 'read');
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
};

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await app.prisma.user.create({ data: {
    phone: `+59279${String(Math.floor(Math.random() * 90000) + 10000)}`,
    firstName: 'Bcast', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } } } });
  userIds.push(admin.id);
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: 'bcast', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  // two RIDERs so the count under test is not 0 or 1 by accident
  for (const n of [1, 2]) {
    const r = await app.prisma.user.create({ data: {
      phone: `+5926${String(700000 + Math.floor(Math.random() * 99999)).slice(0, 6)}${n}`,
      firstName: `Rider${n}`, lastName: `B${RUN}`, roles: ['RIDER'], activeRole: 'RIDER',
      status: 'ACTIVE', isPhoneVerified: true } });
    recipientIds.push(r.id);
  }
});

afterAll(async () => {
  await withSuiteCapability('ddl', () => runWithoutTenant(async () => {
    await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS swift_bc_refuse_${RUN} ON audit_logs;`);
    await app.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS swift_bc_refuse_${RUN}();`);
  }, 'cleanup')).catch(() => {});
  await cleanupSecondApprovers(app);
  const all = [...userIds, ...recipientIds];
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: all } } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'bc').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'bc').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: all } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: all } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: all } } }).catch(() => {});
  }, 'bc');
  await app.close();
});

describe('[ADM-002] a broadcast records how far it reached', () => {
  it('the audit row keeps recipientCount — the subject of this route IS the audience', async () => {
    const res = await call('POST', '/api/v1/admin/notifications/broadcast', {
      title: TITLE, body: 'Service notice.', role: 'RIDER', category: 'service', reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
    const sent = (JSON.parse(res.body) as { data: { sent: number } }).data.sent;
    expect(sent, 'the two seeded riders received it').toBeGreaterThanOrEqual(2);

    const rows = await broadcastRows();
    expect(rows.length, 'the broadcast is audited').toBeGreaterThan(0);
    const changes = rows[0]!.changes as Record<string, unknown>;
    expect(changes['recipientCount'],
      'a trail that cannot say how many people a broadcast reached has not recorded it').toBe(sent);
    expect(changes['role']).toBe('RIDER');
    expect(changes['title']).toBe(TITLE);
  });

  it('a refused audit row rolls the NOTIFICATIONS back — nothing is announced that is not recorded', async () => {
    const before = await runWithoutTenant(() => app.prisma.notification.count({
      where: { userId: { in: recipientIds } } }), 'read');
    const refusedBefore = await refusedC5();

    await withSuiteCapability('ddl', () => runWithoutTenant(async () => {
      await app.prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION swift_bc_refuse_${RUN}() RETURNS trigger AS $fn$
        BEGIN
          IF NEW."entityId" = 'broadcast' THEN RAISE EXCEPTION 'injected'; END IF;
          RETURN NEW;
        END; $fn$ LANGUAGE plpgsql;`);
      await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS swift_bc_refuse_${RUN} ON audit_logs;`);
      await app.prisma.$executeRawUnsafe(`
        CREATE TRIGGER swift_bc_refuse_${RUN} BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION swift_bc_refuse_${RUN}();`);
    }, 'inject'));
    try {
      const res = await call('POST', '/api/v1/admin/notifications/broadcast', {
        title: `${TITLE} refused`, body: 'Should not land.', role: 'RIDER',
        category: 'service', reason: REASON });
      expect(res.statusCode, 'a broadcast whose audit was refused must not report success').not.toBe(200);
    } finally {
      await withSuiteCapability('ddl', () => runWithoutTenant(async () => {
        await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS swift_bc_refuse_${RUN} ON audit_logs;`);
      }, 'cleanup'));
    }

    const after = await runWithoutTenant(() => app.prisma.notification.count({
      where: { userId: { in: recipientIds } } }), 'read');
    expect(after, 'no notification row may survive a refused audit').toBe(before);
    expect(await refusedC5(), 'an inline refusal is a number, not an anonymous 500').toBe(refusedBefore + 1);
  });
});
