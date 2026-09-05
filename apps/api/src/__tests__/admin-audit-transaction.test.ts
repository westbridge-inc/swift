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
import { auditWithin, wroteAuditInline, type AuditLogWriter, type AuditRequestLike } from '../modules/admin/audit-within';
import { adminAuditCounter } from '../plugins/observability';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';
import { refusalName, refuseAuditWhere, dropAuditRefusal } from './helpers/audit-refusal';

// ---------------------------------------------------------------------------
// [ADM-002] THE AUDIT ROW IS WRITTEN AFTER COMMIT AND MAY FAIL SILENTLY.
//
// The trail was written by an `onResponse` hook — after the action committed
// and after the response was sent. So the only thing a failed audit write
// could do was log:
//
//     } catch (err) {
//       app.log.error({ err }, '[admin-audit] failed to write audit log');
//     }
//
// A privileged action completed with no record of it, discoverable only by
// absence. The clause asks for exactly one proof: INJECT AN AUDIT-WRITE
// FAILURE AND ASSERT THE STATE CHANGE DID NOT COMMIT.
//
// The injection here is a real one — a BEFORE INSERT trigger on `audit_logs`
// that refuses the row, which is the clause's own trigger list ("a validation
// error on the audit row"). Not a mock: the failure arrives from the database,
// inside the transaction, exactly where contention would put it.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
let token = '';
const REASON = 'Rate corrected after the September reconciliation, ref GY-4471';
const KEY = `ADM002_${RUN}`;

const call = (method: string, url: string, payload?: unknown) =>
  injectWithApproval(app, {
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const configValue = async (key: string) => runWithoutTenant(
  () => app.prisma.platformConfig.findUnique({ where: { key } }),
  'test-read',
);

/** Refuse the audit row for ONE subject, at the database, inside the tx. */
const REFUSAL = refusalName('tx');
const refuseAuditFor = (entityId: string) => refuseAuditWhere(app, REFUSAL, { entityId });
const allowAuditAgain = () => dropAuditRefusal(app, REFUSAL);

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
  const phone = `+59272${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Txn', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN',
      status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'admin-audit-txn', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});

afterAll(async () => {
  await allowAuditAgain().catch(() => {});
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.platformConfig.deleteMany({ where: { key: { startsWith: `ADM002_${RUN}` } } }).catch(() => {});
    await app.prisma.promoCode.deleteMany({ where: { code: { startsWith: `AD2${RUN.toUpperCase()}` } } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:admin-audit-txn').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-audit-txn').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-audit-txn');
  await app.close();
});

// ── the clause's red test ───────────────────────────────────────────────────

describe('[ADM-002] a refused audit row takes the action down with it', () => {
  it('CONTROL: with the audit table healthy, the config write commits', async () => {
    await runWithoutTenant(() => app.prisma.platformConfig.create({ data: { key: KEY, value: { rate: 1 } } }), 'test-seed');
    const res = await call('PUT', `/api/v1/admin/config/${KEY}`, { value: { rate: 2 }, reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
    expect((await configValue(KEY))?.value).toEqual({ rate: 2 });
  });

  it('THE DEFECT: an audit row the database refuses ROLLS THE CONFIG CHANGE BACK', async () => {
    // the row as the control left it
    expect((await configValue(KEY))?.value).toEqual({ rate: 2 });

    await refuseAuditFor(KEY);
    try {
      const res = await call('PUT', `/api/v1/admin/config/${KEY}`, { value: { rate: 999 }, reason: REASON });
      // the action must NOT report success
      expect(res.statusCode, 'a write whose audit was refused must not return 200').not.toBe(200);
    } finally {
      await allowAuditAgain();
    }

    // THE ASSERTION THE CLAUSE ASKS FOR. Before the fix this read { rate: 999 }
    // with a 200 response and a single log line to say the trail had been lost.
    expect((await configValue(KEY))?.value,
      'the config must be unchanged — the audit row and the change commit together').toEqual({ rate: 2 });
  });

  it('and no orphan audit row survives for the refused attempt', async () => {
    const rows = await runWithoutTenant(() => app.prisma.auditLog.findMany({
      where: { userId: userIds[0]!, entityId: KEY },
    }), 'test-read');
    // one row for the control write, none for the refused one
    const changed999 = rows.filter((r) => JSON.stringify(r.changes ?? {}).includes('999'));
    expect(changed999, 'the refused action left no audit row either').toHaveLength(0);
  });

  it('the row is already committed when the response arrives — not written afterwards', async () => {
    const key = `ADM002_${RUN}_single`;
    await runWithoutTenant(() => app.prisma.platformConfig.create({ data: { key, value: { n: 1 } } }), 'test-seed');
    const res = await call('PUT', `/api/v1/admin/config/${key}`, { value: { n: 2 }, reason: REASON });
    expect(res.statusCode, res.body).toBe(200);

    // NO polling. That is the assertion. The hook wrote after the response, so
    // a read this early saw nothing and the suite had to wait for a row that
    // might never come; an inline row is committed with the change itself, so
    // it is there the moment the caller is told the action happened.
    const immediate = await runWithoutTenant(() => app.prisma.auditLog.findMany({
      where: { userId: userIds[0]!, entityId: key },
    }), 'test-read');
    expect(immediate, 'the audit row must already exist when the 200 lands').toHaveLength(1);
    expect(immediate[0]!.action).toContain('/config/:key');

    // and the backstop must not add a second row for the same action
    await new Promise((r) => setTimeout(r, 400));
    const settled = await runWithoutTenant(() => app.prisma.auditLog.findMany({
      where: { userId: userIds[0]!, entityId: key },
    }), 'test-read');
    expect(settled, 'the backstop must not double-write a row the action already wrote').toHaveLength(1);
  });
});

// ── the mechanism, without a database ───────────────────────────────────────

describe('[ADM-002] auditWithin binds the row to the caller transaction', () => {
  const request = (): AuditRequestLike => ({
    method: 'PUT',
    url: '/api/v1/admin/config/RATE',
    routeOptions: { url: '/api/v1/admin/config/:key' },
    params: { key: 'RATE' },
    body: { reason: REASON },
    ip: '10.0.0.1',
    headers: { 'user-agent': 'vitest' },
    user: { userId: 'admin-1' },
  });

  it('a writer that throws propagates — so the caller transaction rolls back', async () => {
    const boom: AuditLogWriter = { auditLog: { create: async () => { throw new Error('audit refused'); } } };
    const req = request();
    await expect(auditWithin(boom, req, '/api/v1/admin')).rejects.toThrow('audit refused');
  });

  it('a FAILED audit does not mark the request — the backstop still covers it', async () => {
    const boom: AuditLogWriter = { auditLog: { create: async () => { throw new Error('audit refused'); } } };
    const req = request();
    await auditWithin(boom, req, '/api/v1/admin').catch(() => {});
    expect(wroteAuditInline(req), 'an unwritten row must not silence the backstop').toBe(false);
  });

  it('a successful write marks the request so the hook does not double-write', async () => {
    const rows: Record<string, unknown>[] = [];
    const ok: AuditLogWriter = { auditLog: { create: async ({ data }) => { rows.push(data); return data; } } };
    const req = request();
    await auditWithin(ok, req, '/api/v1/admin');
    expect(wroteAuditInline(req)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['action']).toBe('ADMIN PUT /api/v1/admin/config/:key');
    expect(rows[0]!['entityId']).toBe('RATE');
    expect(rows[0]!['userId']).toBe('admin-1');
  });

  it('an action with no actor writes nothing rather than an unattributable row', async () => {
    let called = 0;
    const ok: AuditLogWriter = { auditLog: { create: async () => { called += 1; return {}; } } };
    const req = { ...request(), user: undefined };
    await auditWithin(ok, req, '/api/v1/admin');
    expect(called).toBe(0);
    expect(wroteAuditInline(req)).toBe(false);
  });
});

// ── the observability the clause asks for, proven to MOVE ───────────────────

describe('[ADM-002] swift_admin_audit_total says which writer produced the row', () => {
  /** Total per `writer` label, across every action class. */
  const byWriter = async (): Promise<Record<string, number>> => {
    const metric = await adminAuditCounter.get();
    const out: Record<string, number> = {};
    for (const s of metric.values) {
      const w = String(s.labels['writer']);
      out[w] = (out[w] ?? 0) + s.value;
    }
    return out;
  };

  // A counter that is declared, imported and never incremented reads exactly
  // like one that works. These two tests are the difference — the same shape
  // that left 19 of 21 config fields dead and looking wired.
  it('a MIGRATED route increments writer=inline', async () => {
    const key = `ADM002_${RUN}_inline`;
    await runWithoutTenant(() => app.prisma.platformConfig.create({ data: { key, value: { n: 1 } } }), 'test-seed');
    const before = await byWriter();
    const res = await call('PUT', `/api/v1/admin/config/${key}`, { value: { n: 2 }, reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const after = await byWriter();
    expect((after['inline'] ?? 0) - (before['inline'] ?? 0),
      'a route that audits inside its transaction must count as inline').toBeGreaterThan(0);
  });

  it('an UNMIGRATED route increments writer=backstop — the number that must go to zero', async () => {
    const before = await byWriter();
    const res = await call('POST', '/api/v1/admin/promos', {
      code: `AD2${RUN.toUpperCase()}`,
      description: 'Audit writer probe',
      discountType: 'PERCENTAGE',
      discountValue: 5,
      validFrom: new Date().toISOString(),
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      reason: REASON,
    });
    // The action MUST have succeeded. A 4xx never reaches the audit hook at
    // all, so without this line a schema change that starts rejecting the
    // payload would leave the counter assertion passing on some other
    // request's increment — green, and measuring nothing.
    expect(res.statusCode, `the promo write must succeed for this to mean anything: ${res.body}`).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
    const after = await byWriter();
    expect((after['backstop'] ?? 0) - (before['backstop'] ?? 0),
      'a route still on the hook must count as backstop').toBeGreaterThan(0);
  });
});

// ── a create names what it created ──────────────────────────────────────────

describe('[ADM-002] a CREATE route records the id of the row it made', () => {
  const zoneIds: string[] = [];
  afterAll(async () => {
    await runWithoutTenant(
      () => app.prisma.zone.deleteMany({ where: { id: { in: zoneIds } } }).then(() => undefined),
      'test-cleanup',
    ).catch(() => {});
  });

  // `POST /zones` declares no entity in ADMIN_ROUTE_AUTHORITY — the subject
  // does not exist when the request is routed — so the hook's row falls back
  // to entityId `-`. The legacy `CREATE_ZONE` row was the only thing carrying
  // the new id, and consolidating onto one row would have silently dropped it.
  it('the audit row names the created zone, not "-"', async () => {
    const name = `ADM002 ${RUN} zone`;
    const res = await call('POST', '/api/v1/admin/zones', {
      name,
      boundary: { type: 'Polygon', coordinates: [[[-58.2, 6.8], [-58.1, 6.8], [-58.1, 6.9], [-58.2, 6.9], [-58.2, 6.8]]] },
      priority: 77,
      reason: REASON,
    });
    expect(res.statusCode, res.body).toBe(200);
    const created = (JSON.parse(res.body) as { data: { id: string } }).data;
    zoneIds.push(created.id);

    const rows = await runWithoutTenant(() => app.prisma.auditLog.findMany({
      where: { userId: userIds[0]!, action: { contains: '/zones' } },
    }), 'test-read');
    const mine = rows.filter((r) => r.entityId === created.id);
    expect(mine, `the trail must name zone ${created.id}, not "-"`).toHaveLength(1);
  });
});
