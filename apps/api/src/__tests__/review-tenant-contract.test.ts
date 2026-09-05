/**
 * [STA-1 Parts 3–4] The review tenant exists and is walled.
 *
 * Contract suite for the store-reviewer fiction: the schema carries
 * Tenant.kind / purgeProtected and Actor.isSynthetic, the three review tables
 * are registered in BOTH walls (Prisma scoping and Postgres RLS), every
 * registered table is FORCED (4.2), the negative tests RLS-N1/N2/N4/N5 hold
 * against a NOBYPASSRLS role and through the real order route, a
 * purge-protected tenant cannot be deleted (DL-8), and the anchor is bound
 * exactly once (3.1) by exactly one writer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { prismaPlugin, TENANT_MODEL_NAMES } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { TENANT_TABLES, allRlsDdl, appRoleDdl, tenantPurgeGuardDdl } from '../lib/tenant-rls';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import {
  bindReviewAnchor, materialise, assertOffsetWithinCity, MAX_OFFSET_DEG, ReviewSessionClosedError,
} from '../modules/review/anchor';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const phone = (n: number) => `+59277${NUM}${n}`;
const REVIEW = `review-${RUN}`;
const GUARD = `guard-${RUN}`;
const PRODUCTION = 'swift-default';
const PROBE = 'swift_rls_probe';
const REVIEW_TABLES = ['review_sessions', 'review_credentials', 'review_fixtures'] as const;
const REVIEW_MODELS = ['reviewSession', 'reviewCredential', 'reviewFixture'] as const;

let app: FastifyInstance;
let reviewCustomerId = '';
let productionCustomerId = '';
let reviewOrderId = '';
let productionToken = '';
let reviewToken = '';

const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'sta1-review-contract');

async function probeCount(sql: Prisma.Sql, guc: Record<string, string>): Promise<number> {
  return app.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE}`);
    for (const [k, v] of Object.entries(guc)) await tx.$executeRawUnsafe(`SET LOCAL ${k} = '${v}'`);
    const rows = await tx.$queryRaw<{ n: bigint }[]>(sql);
    return Number(rows[0]!.n);
  });
}

async function sessionFor(userId: string): Promise<string> {
  const token = app.jwt.sign({ userId, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId, token, refreshToken: nanoid(64), authMethod: 'LEGACY',
    deviceId: `sta1-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000),
  } });
  return token;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  // db-push environments (CI) carry no migration-installed guards: heal the
  // wall, the FORCE, the purge guard, and give the probe role a body.
  await installDdl(app.prisma, [...appRoleDdl(), ...allRlsDdl(), ...tenantPurgeGuardDdl()]);
  await installDdl(app.prisma, [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE}') THEN
       CREATE ROLE ${PROBE} NOLOGIN NOBYPASSRLS; END IF; END $$`,
    `GRANT USAGE ON SCHEMA public TO ${PROBE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROBE}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${PROBE}`,
  ]);

  await system(async () => {
    await app.prisma.tenant.create({ data: { id: REVIEW, name: 'Review fiction', slug: REVIEW, kind: 'REVIEW', purgeProtected: true } });
    await app.prisma.tenant.create({ data: { id: GUARD, name: 'Guard probe', slug: GUARD, kind: 'REVIEW', purgeProtected: true } });
    const reviewCustomer = await app.prisma.user.create({ data: {
      phone: phone(1), firstName: 'Fiction', lastName: 'Customer', activeRole: 'CUSTOMER', tenantId: REVIEW, isSynthetic: true,
    } });
    const productionCustomer = await app.prisma.user.create({ data: {
      phone: phone(2), firstName: 'Real', lastName: 'Customer', activeRole: 'CUSTOMER', tenantId: PRODUCTION,
    } });
    reviewCustomerId = reviewCustomer.id;
    productionCustomerId = productionCustomer.id;
    const order = await app.prisma.order.create({ data: {
      tenantId: REVIEW, orderNumber: `RV-${RUN}`, orderType: 'FOOD_DELIVERY', customerId: reviewCustomer.id,
      deliveryAddress: 'Fiction Street 1', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
    } });
    reviewOrderId = order.id;
  });
  productionToken = await sessionFor(productionCustomerId);
  reviewToken = await sessionFor(reviewCustomerId);
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.reviewFixture.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.order.deleteMany({ where: { id: reviewOrderId } });
    await app.prisma.session.deleteMany({ where: { userId: { in: [reviewCustomerId, productionCustomerId] } } });
    await app.prisma.user.deleteMany({ where: { id: { in: [reviewCustomerId, productionCustomerId] } } });
    // DL-8: the fiction leaves in two deliberate statements, never one.
    await app.prisma.tenant.updateMany({ where: { id: { in: [REVIEW, GUARD] } }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: { in: [REVIEW, GUARD] } } });
  });
  await app.close();
});

describe('[STA-1 Part 3] the schema', () => {
  it('the default tenant is PRODUCTION and unprotected — the new defaults describe the rows that exist', async () => {
    const t = await system(() => app.prisma.tenant.findUniqueOrThrow({ where: { id: PRODUCTION }, select: { kind: true, purgeProtected: true } }));
    expect(t).toEqual({ kind: 'PRODUCTION', purgeProtected: false });
  });

  it('a person in the fiction is synthetic; a real person is not, by default', async () => {
    const [fiction, real] = await system(() => Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: reviewCustomerId }, select: { isSynthetic: true, tenant: { select: { kind: true } } } }),
      app.prisma.user.findUniqueOrThrow({ where: { id: productionCustomerId }, select: { isSynthetic: true, tenant: { select: { kind: true } } } }),
    ]));
    expect(fiction).toEqual({ isSynthetic: true, tenant: { kind: 'REVIEW' } });
    expect(real).toEqual({ isSynthetic: false, tenant: { kind: 'PRODUCTION' } });
  });
});

describe('[STA-1 Part 4] the wall', () => {
  it('the review tables are registered in BOTH walls — Prisma scoping and Postgres RLS', () => {
    for (const t of REVIEW_TABLES) expect(TENANT_TABLES).toContain(t);
    for (const m of REVIEW_MODELS) expect(TENANT_MODEL_NAMES).toContain(m);
  });

  it('[4.2] every registered table is FORCED — the table owner cannot walk through the policy', async () => {
    const unforced = await app.prisma.$queryRaw<{ relname: string }[]>(Prisma.sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY(${[...TENANT_TABLES]})
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`);
    expect(unforced).toEqual([]);
  });

  it('RLS-N1: bound to the production tenant, a raw count over orders returns ZERO review rows (and the row exists)', async () => {
    const sql = Prisma.sql`SELECT count(*)::bigint AS n FROM orders WHERE "tenantId" = ${REVIEW}`;
    expect(await probeCount(sql, { 'app.current_tenant': REVIEW })).toBe(1);
    expect(await probeCount(sql, { 'app.current_tenant': PRODUCTION })).toBe(0);
  });

  it('RLS-N2: with no tenant bound, the review tables and orders return ZERO rows — fail closed', async () => {
    expect(await probeCount(Prisma.sql`SELECT count(*)::bigint AS n FROM orders WHERE "tenantId" = ${REVIEW}`, {})).toBe(0);
    const sess = await system(() => app.prisma.reviewSession.create({ data: { tenantId: REVIEW, expiresAt: new Date(Date.now() + 86_400_000) } }));
    expect(await probeCount(Prisma.sql`SELECT count(*)::bigint AS n FROM review_sessions WHERE id = ${sess.id}`, {})).toBe(0);
    expect(await probeCount(Prisma.sql`SELECT count(*)::bigint AS n FROM review_sessions WHERE id = ${sess.id}`, { 'app.current_tenant': REVIEW })).toBe(1);
  });

  it('RLS-N4: a production session cannot fetch a review order by guessing its id — 404, never 403; the fiction’s own session can', async () => {
    const denied = await app.inject({ method: 'GET', url: `/api/v1/customer/orders/${reviewOrderId}`, headers: { authorization: `Bearer ${productionToken}` } });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).not.toMatch(/forbidden/i);
    const own = await app.inject({ method: 'GET', url: `/api/v1/customer/orders/${reviewOrderId}`, headers: { authorization: `Bearer ${reviewToken}` } });
    expect(own.statusCode).toBe(200);
    expect(own.body).toContain(reviewOrderId);
  });

  it('RLS-N5 (database): a review-bound INSERT wearing the production tenantId is refused by WITH CHECK; the honest row lands', async () => {
    const insert = (tenantId: string) => app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE}`);
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${REVIEW}'`);
      return tx.$executeRaw(Prisma.sql`
        INSERT INTO review_fixtures (id, "tenantId", kind, "refId", "offsetLat", "offsetLng")
        VALUES (${`fx-${RUN}-${tenantId === REVIEW ? 'r' : 'p'}`}, ${tenantId}, 'POI', ${`ref-${RUN}`}, 0.01, 0.02)`);
    });
    await expect(insert(PRODUCTION)).rejects.toThrow(/row-level security/i);
    expect(await insert(REVIEW)).toBe(1);
  });

  it('RLS-N5 (ORM): inside the review tenant, request-controlled data cannot move a fixture to production — the stamp wins', async () => {
    const row = await runWithTenant(REVIEW, () => app.prisma.reviewFixture.create({
      data: { tenantId: PRODUCTION, kind: 'CUSTOMER_ADDRESS', refId: reviewCustomerId, offsetLat: 0.0, offsetLng: 0.0 },
    }));
    expect(row.tenantId).toBe(REVIEW);
  });
});

describe('[STA-1 DL-8] purge protection', () => {
  it('a purge-protected tenant cannot be DELETEd; clearing the flag is its own statement, then it can', async () => {
    await expect(system(() => app.prisma.tenant.delete({ where: { id: GUARD } }))).rejects.toThrow(/purge-protected/);
    expect(await system(() => app.prisma.tenant.findUnique({ where: { id: GUARD }, select: { id: true } }))).toEqual({ id: GUARD });
    await system(() => app.prisma.tenant.update({ where: { id: GUARD }, data: { purgeProtected: false } }));
    await system(() => app.prisma.tenant.delete({ where: { id: GUARD } }));
    expect(await system(() => app.prisma.tenant.findUnique({ where: { id: GUARD } }))).toBeNull();
  });
});

describe('[STA-1 3.1] the anchor is bound exactly once', () => {
  const open = () => system(() => app.prisma.reviewSession.create({ data: { tenantId: REVIEW, expiresAt: new Date(Date.now() + 86_400_000) } }));
  const bind = (id: string, c: Parameters<typeof bindReviewAnchor>[2]) => runWithTenant(REVIEW, () => bindReviewAnchor(app.prisma, id, c));

  it('binds on the first call, returns the SAME anchor on every later call whatever the candidate, and the row says ANCHORED', async () => {
    const s = await open();
    const first = await bind(s.id, { lat: 6.8, lng: -58.15, source: 'DEVICE_GPS' });
    expect(first).toEqual({ lat: 6.8, lng: -58.15, source: 'DEVICE_GPS', wasAlreadyBound: false });
    const second = await bind(s.id, { lat: 10.5, lng: -61.2, source: 'IP_GEO' });
    expect(second).toEqual({ lat: 6.8, lng: -58.15, source: 'DEVICE_GPS', wasAlreadyBound: true });
    const row = await system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id: s.id } }));
    expect(row.status).toBe('ANCHORED');
    expect(row.anchorSource).toBe('DEVICE_GPS');
    expect(row.anchoredAt).toBeInstanceOf(Date);
  });

  it('two first requests racing bind ONE anchor: exactly one writer, both callers see the same city', async () => {
    const s = await open();
    const [a, b] = await Promise.all([
      bind(s.id, { lat: 6.8, lng: -58.15, source: 'DEVICE_GPS' }),
      bind(s.id, { lat: 5.0, lng: -57.0, source: 'IP_GEO' }),
    ]);
    expect([a.wasAlreadyBound, b.wasAlreadyBound].filter((x) => x === false)).toHaveLength(1);
    expect({ lat: a.lat, lng: a.lng }).toEqual({ lat: b.lat, lng: b.lng });
    const row = await system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id: s.id } }));
    expect(row.anchorLat).toBe(a.lat);
  });

  it('an EXPIRED or REVOKED session refuses to anchor (410) and stays unanchored; an unknown session is 404', async () => {
    for (const status of ['EXPIRED', 'REVOKED'] as const) {
      const s = await system(() => app.prisma.reviewSession.create({ data: { tenantId: REVIEW, status, expiresAt: new Date(Date.now() - 1000) } }));
      const err = await bind(s.id, { lat: 6.8, lng: -58.15, source: 'DEVICE_GPS' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReviewSessionClosedError);
      expect((err as ReviewSessionClosedError).statusCode).toBe(410);
      const row = await system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id: s.id } }));
      expect(row.anchorLat).toBeNull();
      expect(row.status).toBe(status);
    }
    await expect(bind('no-such-session', { lat: 6.8, lng: -58.15, source: 'DEVICE_GPS' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a candidate that is not a coordinate is refused before any write', async () => {
    const s = await open();
    await expect(bind(s.id, { lat: 95, lng: -58.15, source: 'DEVICE_GPS' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(bind(s.id, { lat: Number.NaN, lng: 0, source: 'IP_GEO' })).rejects.toMatchObject({ statusCode: 400 });
    const row = await system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id: s.id } }));
    expect(row.anchorLat).toBeNull();
    expect(row.status).toBe('PROVISIONED');
  });

  it('the anchor has ONE writer: no other source file touches anchorLat / anchorLng', () => {
    const root = join(__dirname, '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        if (/anchorL(at|ng)/.test(readFileSync(p, 'utf8'))) hits.push(relative(root, p));
      }
    };
    walk(root);
    expect(hits).toEqual(['modules/review/anchor.ts']);
  });
});

describe('[STA-1 3.2] the city translates rigidly', () => {
  it('materialise preserves relative offsets around any anchor', () => {
    const anchor = { lat: 6.8, lng: -58.15 };
    const a = materialise({ offsetLat: 0.01, offsetLng: 0.02 }, anchor);
    const b = materialise({ offsetLat: -0.03, offsetLng: 0.05 }, anchor);
    expect(b.lat - a.lat).toBeCloseTo(-0.04, 10);
    expect(b.lng - a.lng).toBeCloseTo(0.03, 10);
    const elsewhere = materialise({ offsetLat: 0.01, offsetLng: 0.02 }, { lat: 51.5, lng: -0.12 });
    expect(elsewhere.lat).toBeCloseTo(51.51, 10);
    expect(elsewhere.lng).toBeCloseTo(-0.1, 10);
  });

  it(`an authored offset past ${MAX_OFFSET_DEG}° in either axis is refused; the boundary itself is not`, () => {
    expect(() => assertOffsetWithinCity({ offsetLat: MAX_OFFSET_DEG, offsetLng: -MAX_OFFSET_DEG })).not.toThrow();
    expect(() => assertOffsetWithinCity({ offsetLat: 0.1, offsetLng: 0 })).toThrow(/0\.09/);
    expect(() => assertOffsetWithinCity({ offsetLat: 0, offsetLng: -0.0901 })).toThrow(/0\.09/);
    expect(() => materialise({ offsetLat: 0.2, offsetLng: 0 }, { lat: 6.8, lng: -58.15 })).toThrow(/0\.09/);
  });
});
