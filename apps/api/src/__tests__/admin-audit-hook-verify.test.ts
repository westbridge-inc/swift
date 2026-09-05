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
import { adminAuditCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [ADM-002] THE HOOK VERIFIES THE ROW IT IS ASKED TO TRUST.
//
// `auditWithin` marks the request "audited" INSIDE the transaction, before
// COMMIT. A route that swallowed a commit-time failure and still answered 2xx
// would reach the onResponse hook marked, with no row behind the mark — and a
// hook that trusted the marker would write nothing. The one privileged action
// with no record would be the one that failed to record itself.
//
// No migrated route swallows its transaction today, so the failure cannot be
// produced through a route. It is produced the only honest way: a root-level
// onRequest hook FORGES the marker (set, pointing at a row that does not
// exist) on an unmigrated C2 route. The admin hook must notice, write the
// backstop row anyway, and count it under `rolled-back`.
//
// The route is `POST /ads/placements/seed`: C2 (no reason, no approval),
// idempotent, needs no fixture beyond the admin.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const ROUTE = '/api/v1/admin/ads/placements/seed';
const ACTION = `ADMIN POST ${ROUTE}`;
const FORGE = 'x-test-forge-inline-marker';
const userIds: string[] = [];
let token = '';

const counter = async (writer: string) => (await adminAuditCounter.get()).values
  .find((v) => v.labels['writer'] === writer && v.labels['cls'] === 'C2')?.value ?? 0;

const rows = () => runWithoutTenant(() => app.prisma.auditLog.findMany({
  where: { userId: userIds[0]!, action: ACTION }, orderBy: { createdAt: 'asc' } }), 'read');

const rowsAtLeast = async (n: number) => {
  for (let i = 0; i < 30; i += 1) {
    const r = await rows();
    if (r.length >= n) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  return rows();
};

const call = (forge: boolean) => app.inject({
  method: 'POST', url: ROUTE,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(forge ? { [FORGE]: '1' } : {}) },
  payload: {},
});

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  // THE FORGERY — on the root, BEFORE the admin plugin, so it runs first and
  // the request reaches the admin onResponse hook already marked.
  app.addHook('onRequest', async (request) => {
    if (request.url === ROUTE && request.headers[FORGE] === '1') {
      const r = request as unknown as { auditWrittenInline?: boolean; auditInlineRowId?: string };
      r.auditWrittenInline = true;
      r.auditInlineRowId = `forged_${RUN}_never_committed`;
    }
  });
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await app.prisma.user.create({ data: {
    phone: `+59278${String(Math.floor(Math.random() * 90000) + 10000)}`,
    firstName: 'Verify', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } } } });
  userIds.push(admin.id);
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: 'verify', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'hv').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'hv').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'hv');
  await app.close();
});

describe('[ADM-002] the backstop hook verifies the inline marker', () => {
  it('CONTROL: an unmigrated C2 route is written by the backstop, and its entity names the resource', async () => {
    const backstopBefore = await counter('backstop');
    const res = await call(false);
    expect(res.statusCode, res.body).toBe(200);
    const r = await rowsAtLeast(1);
    expect(r.length, 'the backstop wrote the row').toBeGreaterThanOrEqual(1);
    // The entity column used to say `api` for every admin row.
    expect(r[0]!.entity, 'entity is the route resource, not the mount prefix').toBe('ads');
    expect(await counter('backstop')).toBe(backstopBefore + 1);
  });

  it('THE DEFECT: a marker with no row behind it is not trusted — the backstop still writes, and counts it', async () => {
    const before = (await rows()).length;
    const rolledBackBefore = await counter('rolled-back');
    const inlineBefore = await counter('inline');

    const res = await call(true);
    expect(res.statusCode, res.body).toBe(200);

    const r = await rowsAtLeast(before + 1);
    expect(r.length, 'a forged "audited" marker must not suppress the row').toBe(before + 1);
    expect(await counter('rolled-back'), 'the miss is counted under its own label').toBe(rolledBackBefore + 1);
    expect(await counter('inline'), 'and is never mistaken for an inline write').toBe(inlineBefore);
  });
});
