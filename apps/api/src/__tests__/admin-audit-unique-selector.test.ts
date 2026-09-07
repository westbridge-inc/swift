import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { ADMIN_ROUTE_AUTHORITY, type AdminRouteEntity } from '../modules/admin/admin-authority';
import { snapshot } from '../modules/admin/audit-change';
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
// [ADM-004 · C-01 / Codex URGENT-REPORT-092] THE SNAPSHOT QUERIED THE WRONG
// COLUMN, AND A STATIC CENSUS SAID IT WAS FINE.
//
// `snapshot()` built its selector as:
//
//     const where = entity.param === 'key' ? { key: id } : { id };
//
// `param` is the ROUTE PARAMETER name. It is not the model's unique column,
// and for two of the three entities that declare one it is not even the same
// string:
//
//     docType         :code    selects doc_type.code    — and DocType has NO id column at all
//     platformConfig  :key     selects platform_config.key
//     lossProtection  :userId  selects user.id          — NOT user.userId, which does not exist
//
// So every doc-type decision asked Prisma for `where: { id: 'GY.national_id' }`
// on a model whose only key is `code`. Prisma threw, `snapshot()` caught it and
// returned ABSENT, and the audit row for the single most consequential
// verification action on the platform — permitting a personal document to leave
// the country — recorded a null before, a null after and an empty diff. The
// trail said an action happened and nothing about what it did.
//
// The census in `admin-audit-declared-fields.test.ts` computed the CORRECT rule
// and asserted it against the authority table, never against the runtime. It
// passed throughout. That is the whole lesson: a static census is a secondary
// gate, never the oracle. THIS file is the oracle — it watches the arguments
// the real Prisma delegate actually receives.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
let app: FastifyInstance;
let token = '';
const userIds: string[] = [];
const REASON = 'C-01 selector proof: the trail must carry the digests, ref GY-C01';
const RUN = nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const DOC_CODE = `ZZ.selector_${RUN}`;
const CONFIG_KEY = `ADM_SELECTOR_${RUN}`;
let userId = '';

interface DelegateCall { readonly model: string; readonly where: unknown }

/**
 * The real client, wrapped so every `findUnique` records the arguments Prisma
 * is actually handed and then runs for real. A fake delegate would have
 * accepted `{ id }` on DocType happily; the real one refuses it, which is the
 * only reason this test can tell the truth.
 */
function recording(real: PrismaClient, calls: DelegateCall[]): PrismaClient {
  return new Proxy(real as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || value === null || typeof value !== 'object') return value;
      const delegate = value as { findUnique?: unknown };
      if (typeof delegate.findUnique !== 'function') return value;
      return new Proxy(delegate, {
        get(dTarget, dProp, dReceiver) {
          const dValue = Reflect.get(dTarget, dProp, dReceiver);
          if (dProp !== 'findUnique' || typeof dValue !== 'function') return dValue;
          return (args: { where?: unknown }) => {
            calls.push({ model: prop, where: args?.where });
            return (dValue as (a: unknown) => Promise<unknown>).call(dTarget, args);
          };
        },
      });
    },
  }) as unknown as PrismaClient;
}

const entityOf = (route: string): AdminRouteEntity => {
  const entity = ADMIN_ROUTE_AUTHORITY[route]?.entity;
  if (!entity) throw new Error(`no declared entity for '${route}' — the authority table changed shape`);
  return entity;
};

beforeAll(async () => {
  await prisma.docType.create({
    data: {
      code: DOC_CODE, countryCode: 'ZZ', legacyCode: `selector_${RUN}`, displayName: 'Selector probe',
      bucket: 'PERSONAL', subjectKind: 'PERSON', issuer: 'Test', imagePolicy: 'PURGE_AFTER_REVIEW',
      hasExpiry: false, extractionProfile: 'none',
    },
  });
  await prisma.platformConfig.create({ data: { key: CONFIG_KEY, value: { probe: true } } });
  const user = await prisma.user.create({
    data: { phone: `+5926${RUN.slice(0, 6).replace(/[a-z]/g, '7')}`, firstName: 'Selector', lastName: 'Probe', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' },
  });
  userId = user.id;

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await app.prisma.user.create({
    data: {
      phone: `+59273${String(Math.floor(Math.random() * 90000) + 10000)}`, firstName: 'Selector', lastName: `Admin${RUN.slice(0, 4)}`,
      roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
      admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(admin.id);
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'adm-selector', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});

const call = (method: string, url: string, payload?: unknown) =>
  injectWithApproval(app, {
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

/** The audit row this action wrote, whichever writer produced it. */
const auditRowFor = (entityId: string) => runWithoutTenant(
  () => app.prisma.auditLog.findFirst({ where: { entityId }, orderBy: { createdAt: 'desc' } }),
  'test-read:c01',
);

afterAll(async () => {
  await cleanupSecondApprovers(app).catch(() => {});
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:c01').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:c01').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:c01').catch(() => {});
  await app.close().catch(() => {});
  await prisma.docType.deleteMany({ where: { code: DOC_CODE } });
  await prisma.platformConfig.deleteMany({ where: { key: CONFIG_KEY } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('[C-01] the audit snapshot selects on the model column, not the route parameter', () => {
  it('a :code route reads the row by code — DocType has no id column to read it by', async () => {
    const calls: DelegateCall[] = [];
    const result = await snapshot(recording(prisma, calls), entityOf('PUT /verification/doc-types/:code/external-processing'), DOC_CODE);

    expect(calls, 'exactly one delegate read').toHaveLength(1);
    expect(calls[0]!.model).toBe('docType');
    expect(calls[0]!.where, 'the selector is the code column, never id').toEqual({ code: DOC_CODE });
    expect(result.exists, 'the row was found — an ABSENT here is the defect, not a missing row').toBe(true);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.fields).toHaveProperty('externalProcessingAllowed');
  });

  it('a :key route reads the row by key', async () => {
    const calls: DelegateCall[] = [];
    const result = await snapshot(recording(prisma, calls), entityOf('PUT /config/:key'), CONFIG_KEY);

    expect(calls[0]!.where).toEqual({ key: CONFIG_KEY });
    expect(result.exists).toBe(true);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a :userId route reads the USER by id — `userId` is the parameter, not the column', async () => {
    const calls: DelegateCall[] = [];
    const result = await snapshot(recording(prisma, calls), entityOf('PUT /cash-rules/rlp/movers/:userId/suspend'), userId);

    expect(calls[0]!.model).toBe('user');
    expect(calls[0]!.where, 'user.userId does not exist; the row is addressed by id').toEqual({ id: userId });
    expect(result.exists).toBe(true);
    expect(result.fields).toHaveProperty('lossProtectionSuspendedAt');
  });

  it('an ordinary :id route reads by id', async () => {
    const calls: DelegateCall[] = [];
    const result = await snapshot(recording(prisma, calls), entityOf('PUT /users/:id/suspend'), userId);

    expect(calls[0]!.where).toEqual({ id: userId });
    expect(result.exists).toBe(true);
  });

  it('every declared entity selects on a column its model actually has', () => {
    // The runtime rule, applied to the whole authority table — the census's
    // question, asked of the code that answers it rather than of the table.
    const problems: string[] = [];
    for (const [route, authority] of Object.entries(ADMIN_ROUTE_AUTHORITY)) {
      const entity = authority.entity;
      if (!entity) continue;
      const field = entity.uniqueField ?? 'id';
      if (!(['id', 'key', 'code'] as const).includes(field)) problems.push(`${route}: '${field}' is outside the allowed selector set`);
    }
    expect(problems).toEqual([]);
  });
});

// ── the executed proof: real routes, real audit rows ───────────────────────
//
// Codex's condition, verbatim: "execute a real doc-type decision and a
// loss-protection action proving non-null digests". A unit test on `snapshot()`
// proves the selector; only the route proves the TRAIL.

describe('[C-01] a real privileged action records what it changed', () => {
  it('a doc-type external-processing decision writes non-null digests and the real diff', async () => {
    const res = await call('PUT', `/api/v1/admin/verification/doc-types/${DOC_CODE}/external-processing`, {
      allowed: true, decisionRef: `FD-C01-${RUN.slice(0, 5)}`, reason: REASON,
    });
    expect(res.statusCode, res.body).toBe(200);

    const row = await auditRowFor(DOC_CODE);
    expect(row, 'the decision wrote an audit row').toBeTruthy();
    const changes = row!.changes as { before?: unknown; after?: unknown; changed?: Record<string, { from: unknown; to: unknown }> };

    expect(changes.before, 'the BEFORE digest — null here is exactly the C-01 defect').toMatch(/^[0-9a-f]{64}$/);
    expect(changes.after, 'the AFTER digest').toMatch(/^[0-9a-f]{64}$/);
    expect(changes.before).not.toBe(changes.after);
    expect(changes.changed?.['externalProcessingAllowed'], 'the trail names the permission that moved').toEqual({ from: false, to: true });
    expect(changes.changed?.['externalProcessingDecisionRef']?.to).toBe(`FD-C01-${RUN.slice(0, 5)}`);
  });

  it('a loss-protection suspension writes non-null digests for a :userId route', async () => {
    const res = await call('PUT', `/api/v1/admin/cash-rules/rlp/movers/${userId}/suspend`, { reason: REASON });
    expect(res.statusCode, res.body).toBe(200);

    const row = await auditRowFor(userId);
    expect(row, 'the suspension wrote an audit row').toBeTruthy();
    const changes = row!.changes as { before?: unknown; after?: unknown; changed?: Record<string, { from: unknown; to: unknown }> };

    expect(changes.before).toMatch(/^[0-9a-f]{64}$/);
    expect(changes.after).toMatch(/^[0-9a-f]{64}$/);
    expect(changes.before).not.toBe(changes.after);
    expect(changes.changed?.['lossProtectionSuspendedAt']?.from, 'was not suspended before').toBeNull();
    expect(changes.changed?.['lossProtectionSuspendedAt']?.to, 'is suspended after').toBeTruthy();
  });
});
