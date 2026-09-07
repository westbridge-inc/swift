import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { ADMIN_ROUTE_AUTHORITY, type AdminRouteEntity } from '../modules/admin/admin-authority';
import { snapshot, ABSENT } from '../modules/admin/audit-change';
import { adminAuditRow, auditSubjectId } from '../modules/admin/audit-within';
import { adminAuditSnapshotCounter, adminAuditCounter } from '../plugins/observability';
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
// [review] The old fixture was `+5926${RUN.slice(0,6).replace(/[a-z]/g,'7')}` —
// a nanoid collapsed into six digits, which over 20,000 draws produced only
// 1,938 distinct numbers and landed on `+5926777777` 40.4% of the time.
// `User.phone` is unique, so one leftover row from a crashed run took the whole
// FILE down, behind an afterAll TypeError that hid the real cause.
const probePhone = `+5926${String(Math.floor(Math.random() * 900000) + 100000)}${String(Date.now()).slice(-4)}`;

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
  await prisma.user.deleteMany({ where: { phone: probePhone } }).catch(() => {});
  await prisma.docType.create({
    data: {
      code: DOC_CODE, countryCode: 'ZZ', legacyCode: `selector_${RUN}`, displayName: 'Selector probe',
      bucket: 'PERSONAL', subjectKind: 'PERSON', issuer: 'Test', imagePolicy: 'PURGE_AFTER_REVIEW',
      hasExpiry: false, extractionProfile: 'none',
    },
  });
  await prisma.platformConfig.create({ data: { key: CONFIG_KEY, value: { probe: true } } });
  const user = await prisma.user.create({
    data: { phone: probePhone, firstName: 'Selector', lastName: 'Probe', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' },
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

  // NOTE ON A TEST I DELETED. This block used to iterate the authority table
  // asserting that every `uniqueField` was inside the allowed set. `uniqueField`
  // is TYPED to that set, so the assertion could never fail — a test that only
  // restates the compiler. What actually needed proving is the runtime guard
  // that exists for a hand-edited or JSON-shaped table, and the four outcomes
  // the counter reports. Those are below, and they bite.

  it('a selector outside the allowed set is refused, counted, and never reaches Prisma', async () => {
    const calls: DelegateCall[] = [];
    const smuggled = { model: 'user', uniqueField: 'phone', fields: ['status'] } as unknown as AdminRouteEntity;

    const result = await snapshot(recording(prisma, calls), smuggled, userId);

    expect(calls, 'the database is never asked with a selector we do not vouch for').toHaveLength(0);
    expect(result).toEqual({ digest: '', fields: {}, exists: false });
  });

  it('reports the four outcomes it can have, so a swallowed read is a number rather than a silence', async () => {
    const readOutcome = async (outcome: string, model: string) => {
      const metric = await adminAuditSnapshotCounter.get();
      return metric.values.find((v) => v.labels['outcome'] === outcome && v.labels['model'] === model)?.value ?? 0;
    };
    const docType = entityOf('PUT /verification/doc-types/:code/external-processing');

    const foundBefore = await readOutcome('found', 'docType');
    await snapshot(prisma, docType, DOC_CODE);
    expect(await readOutcome('found', 'docType'), 'a row that exists').toBe(foundBefore + 1);

    const missingBefore = await readOutcome('missing', 'docType');
    await snapshot(prisma, docType, `ZZ.absent_${RUN}`);
    expect(await readOutcome('missing', 'docType'), 'a row that genuinely is not there').toBe(missingBefore + 1);

    // A read that THREW used to be indistinguishable from a row that was not
    // there — which is precisely how C-01 survived. Two numbers now.
    const failedBefore = await readOutcome('failed', 'docType');
    const exploding = { ...prisma, docType: { findUnique: async () => { throw new Error('connection reset'); } } } as unknown as typeof prisma;
    expect(await snapshot(exploding, docType, DOC_CODE)).toEqual({ digest: '', fields: {}, exists: false });
    expect(await readOutcome('failed', 'docType'), 'a refused read is its own number').toBe(failedBefore + 1);

    const selectorBefore = await readOutcome('selector', 'user');
    await snapshot(prisma, { model: 'user', uniqueField: 'phone', fields: [] } as unknown as AdminRouteEntity, userId);
    expect(await readOutcome('selector', 'user')).toBe(selectorBefore + 1);
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

// ---------------------------------------------------------------------------
// [independent review] THE THINGS THE FIRST VERSION CHANGED AND DID NOT TEST.
//
// The review's sharpest point was not a defect in the fix — it was that three
// of its behaviours had no test at all. Replacing the reason override with
// 'MUTANT-REASON-NOBODY-CHECKS' left 57 of 57 suites passing. A change nothing
// can detect is a change nobody can rely on.
// ---------------------------------------------------------------------------

describe('[review] the audit row records the reason the platform VALIDATED', () => {
  it('the header wins over a body that says something else', async () => {
    // ADM-006 grades the HEADER (`admin-authority.ts`: "The header wins: a route
    // whose body happens to contain the word is not thereby explained"). An
    // earlier version of this branch passed `body.reason` as an override, so the
    // reason validated and the reason recorded could differ — on ONE of two
    // adjacent routes, which is worse than either rule applied consistently.
    const headerReason = 'HEADER-REASON collusion finding confirmed, case 42';
    const res = await injectWithApproval(app, {
      method: 'PUT' as never,
      url: `/api/v1/admin/cash-rules/rlp/movers/${userId}/reinstate`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': headerReason },
      payload: { note: 'BODY-NOTE something entirely different' } as Record<string, unknown>,
    });
    expect(res.statusCode, res.body).toBe(200);

    const row = await auditRowFor(userId);
    expect((row!.changes as { reason?: string }).reason, 'the recorded reason is the validated one').toBe(headerReason);
  });
});

describe('[review] a colliding audit fact loses the fact, never the action', () => {
  it('drops the canonical key, counts it, and still writes the row', async () => {
    const readCollision = async (key: string) => {
      const m = await adminAuditCounter.get();
      return m.values.find((v) => v.labels['writer'] === `extra_collision:${key}`)?.value ?? 0;
    };
    const before = await readCollision('reason');

    // The shape the type cannot stop: a variable with a string index signature.
    const smuggled: Record<string, string> = { reason: 'SMUGGLED', harmless: 'kept' };
    const row = adminAuditRow(
      { method: 'PUT', url: '/x', params: { id: 'o1' }, headers: {} } as never,
      userId,
      { routeUrl: '/x', reason: null, before: ABSENT, after: ABSENT, entityDeclared: false, extra: smuggled },
    );

    const changes = row['changes'] as Record<string, unknown>;
    expect(changes['reason'], 'the canonical field is not overwritten').toBeUndefined();
    expect(changes['harmless'], 'the honest fact survives').toBe('kept');
    expect(await readCollision('reason'), 'and the drop is a number, not a silence').toBe(before + 1);
    // The row EXISTS. Throwing here used to 500 the whole privileged action —
    // which is the defect (C-01b) this branch was written to remove.
    expect(row['action']).toContain('ADMIN PUT');
  });
});

describe('[review] every snapshot exit is counted, not only the interesting ones', () => {
  const outcome = async (name: string, model: string) => {
    const m = await adminAuditSnapshotCounter.get();
    return m.values.find((v) => v.labels['outcome'] === name && v.labels['model'] === model)?.value ?? 0;
  };

  it('a route with no subject in its params reports no_id', async () => {
    const before = await outcome('no_id', 'user');
    expect(await snapshot(prisma, entityOf('PUT /users/:id/suspend'), undefined)).toEqual(ABSENT);
    expect(await outcome('no_id', 'user')).toBe(before + 1);
  });

  it('a declared model that does not exist on the client reports no_delegate', async () => {
    // What a renamed or mistyped `model` produces — the same shape as C-01, and
    // previously an ABSENT that moved no counter at all.
    const typo = { model: 'docTypes', uniqueField: 'code', fields: [] } as unknown as AdminRouteEntity;
    const before = await outcome('no_delegate', 'docTypes');
    expect(await snapshot(prisma, typo, DOC_CODE)).toEqual(ABSENT);
    expect(await outcome('no_delegate', 'docTypes')).toBe(before + 1);
  });
});

describe('[review] the subject id comes from the entity’s own route parameter', () => {
  it('a :code route records its subject without the route passing it by hand', () => {
    const params = { code: 'GY.national_id' };
    expect(auditSubjectId(params, entityOf('PUT /verification/doc-types/:code/external-processing'))).toBe('GY.national_id');
    // …and a :userId route still resolves through its own declared parameter.
    expect(auditSubjectId({ userId: 'u1' }, entityOf('PUT /cash-rules/rlp/movers/:userId/suspend'))).toBe('u1');
    // A route with no declared entity keeps the old fallback list.
    expect(auditSubjectId({ id: 'x1' }, undefined)).toBe('x1');
    expect(auditSubjectId({}, undefined)).toBe('-');
  });
});
