/**
 * [DB-05 EXPAND] ReturnRequest, ContentReport and CollectionContact leave
 * PENDING_EXPAND: they reached a tenant only through loose owner strings, with
 * no tenantId and no structural parent. Now each carries a NULLABLE tenantId
 * that is stamped by the wall, derived from its owners by a lineage trigger,
 * refused when the owners do not resolve or disagree, and — for rows that
 * already existed — backfilled by the trigger's own derivation, with rows whose
 * owners disagree or are gone left NULL (quarantined, visible to no tenant)
 * rather than defaulted into the production tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin, TENANT_MODEL_NAMES } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { TENANT_TABLES, TENANT_LINEAGE_TABLES, allRlsDdl, appRoleDdl, tenantLineageDdl, rlsDdlFor, lineageBackfillSql } from '../lib/tenant-rls';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const REVIEW = `db05-${RUN}`;
const PRODUCTION = 'swift-default';
const PROBE = 'swift_rls_probe';
const TABLES = ['return_requests', 'content_reports', 'collection_contacts'] as const;
const MODELS = ['returnRequest', 'contentReport', 'collectionContact'] as const;
const MIGRATION = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', '20261005150000_db05_pending_expand_tenant', 'migration.sql'), 'utf8');
let app: FastifyInstance;
const ids = {
  reviewUser: '', prodUser: '', reviewOrder: '', prodOrder: '',
  reviewVendor: '', reviewOwnerUser: '', reviewSub: '', splitSub: '', prodRider: '',
};
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'db05-expand-test');

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
  await installDdl(app.prisma, [...appRoleDdl(), ...allRlsDdl(), ...tenantLineageDdl()]);
  await installDdl(app.prisma, [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE}') THEN CREATE ROLE ${PROBE} NOLOGIN NOBYPASSRLS; END IF; END $$`,
    `GRANT USAGE ON SCHEMA public TO ${PROBE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROBE}`,
  ]);
  await system(async () => {
    await app.prisma.tenant.create({ data: { id: REVIEW, name: 'DB-05 fiction', slug: REVIEW, kind: 'REVIEW', purgeProtected: true } });
    const user = (tenantId: string, n: number) => app.prisma.user.create({ data: { phone: `+59275${NUM}${n}`, firstName: 'D', lastName: 'F', activeRole: 'CUSTOMER', tenantId, isSynthetic: tenantId !== PRODUCTION } });
    const order = (tenantId: string, customerId: string) => app.prisma.order.create({ data: {
      tenantId, orderNumber: `D5-${RUN}-${tenantId === PRODUCTION ? 'p' : 'r'}`, orderType: 'FOOD_DELIVERY', customerId, deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
    } });
    ids.reviewUser = (await user(REVIEW, 1)).id;
    ids.prodUser = (await user(PRODUCTION, 2)).id;
    ids.reviewOrder = (await order(REVIEW, ids.reviewUser)).id;
    ids.prodOrder = (await order(PRODUCTION, ids.prodUser)).id;
    ids.reviewOwnerUser = (await app.prisma.user.create({ data: { phone: `+59275${NUM}3`, firstName: 'O', lastName: 'W', activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], tenantId: REVIEW, isSynthetic: true } })).id;
    const vo = await app.prisma.vendorOwner.create({ data: { userId: ids.reviewOwnerUser } });
    ids.reviewVendor = (await app.prisma.vendor.create({ data: {
      tenantId: REVIEW, isSynthetic: true, ownerId: vo.id, name: `D5 ${RUN}`, slug: `d5-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+59275${NUM}4`,
      addressLine1: '5 Lineage Way', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    } })).id;
    const sub = (data: Record<string, unknown>) => app.prisma.subscription.create({ data: {
      type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000), ...data,
    } as never });
    ids.reviewSub = (await sub({ vendorId: ids.reviewVendor })).id;
    // Owners in two tenants (the database does not yet hold exactly-one owner — DB-07).
    const riderUser = await app.prisma.user.create({ data: { phone: `+59275${NUM}5`, firstName: 'R', lastName: 'P', activeRole: 'RIDER', tenantId: PRODUCTION } });
    ids.prodRider = (await app.prisma.rider.create({ data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } })).id;
    const vo2 = await app.prisma.vendorOwner.create({ data: { userId: (await app.prisma.user.create({ data: { phone: `+59275${NUM}6`, firstName: 'O', lastName: 'X', activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], tenantId: REVIEW, isSynthetic: true } })).id } });
    const v2 = await app.prisma.vendor.create({ data: {
      tenantId: REVIEW, isSynthetic: true, ownerId: vo2.id, name: `D5b ${RUN}`, slug: `d5b-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+59275${NUM}7`,
      addressLine1: '6 Lineage Way', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    } });
    ids.splitSub = (await sub({ vendorId: v2.id, riderId: ids.prodRider })).id;
  });
});

afterAll(async () => {
  await system(async () => {
    const phones = { startsWith: `+59275${NUM}` };
    const users = (await app.prisma.user.findMany({ where: { phone: phones }, select: { id: true } })).map((u) => u.id);
    await app.prisma.returnRequest.deleteMany({ where: { customerId: { in: users } } });
    await app.prisma.contentReport.deleteMany({ where: { reporterId: { in: users } } });
    await app.prisma.collectionContact.deleteMany({ where: { subscriptionId: { in: [ids.reviewSub, ids.splitSub] } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: [ids.reviewSub, ids.splitSub] } } });
    await app.prisma.order.deleteMany({ where: { id: { in: [ids.reviewOrder, ids.prodOrder] } } });
    await app.prisma.vendor.deleteMany({ where: { slug: { startsWith: `d5` }, name: { contains: RUN } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.prisma.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  await app.close();
});

const rr = (orderId: string, customerId: string, extra: Record<string, unknown> = {}) => ({ orderId, customerId, reason: `db05 ${RUN}`, ...extra });
const report = (reporterId: string, extra: Record<string, unknown> = {}) => ({ reporterId, targetType: 'USER' as const, targetId: `t-${nanoid(6)}`, reason: 'SPAM' as const, ...extra });
const contact = (subscriptionId: string, extra: Record<string, unknown> = {}) => ({ subscriptionId, outcome: 'REACHED', byAdminId: `admin-${RUN}`, ...extra });

describe('[DB-05] the three tables are walled on the row', () => {
  it('each is in BOTH walls, RLS enabled AND forced with the tenant policy, and held by a nullable lineage rule', async () => {
    for (const t of TABLES) {
      expect(TENANT_TABLES).toContain(t);
      expect(TENANT_LINEAGE_TABLES.find((r) => r.table === t)?.nullable).toBe(true);
    }
    for (const m of MODELS) expect(TENANT_MODEL_NAMES).toContain(m);
    const walled = await app.prisma.$queryRaw<{ relname: string }[]>(Prisma.sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
      WHERE n.nspname = 'public' AND c.relname = ANY(${[...TABLES]}) AND c.relrowsecurity AND c.relforcerowsecurity`);
    expect(walled.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
  });

  it('the migration carries the code’s own text: the backfill derivation, the wall and the lineage triggers', () => {
    const lineage = tenantLineageDdl();
    for (const t of TABLES) {
      expect(MIGRATION).toContain(lineageBackfillSql(t));
      for (const s of rlsDdlFor(t)) expect(MIGRATION).toContain(s);
      const i = TENANT_LINEAGE_TABLES.findIndex((r) => r.table === t);
      for (const s of lineage.slice(i * 3, i * 3 + 3)) expect(MIGRATION).toContain(s);
    }
    // never a silent default into the production tenant
    expect(MIGRATION).not.toMatch(/"tenantId" TEXT NOT NULL DEFAULT/);
  });
});

describe('[DB-05] a new row takes its tenant from its owners, or is refused', () => {
  it('ReturnRequest: bound callers are stamped, system rows derived; split, missing or contradicting owners are refused', async () => {
    const bound = await runWithTenant(REVIEW, () => app.prisma.returnRequest.create({ data: rr(ids.reviewOrder, ids.reviewUser) }));
    expect(bound.tenantId).toBe(REVIEW);
    const derived = await system(() => app.prisma.returnRequest.create({ data: rr(ids.reviewOrder, ids.reviewUser) }));
    expect(derived.tenantId).toBe(REVIEW);
    // an order in one tenant and a customer in another: no owner
    await expect(system(() => app.prisma.returnRequest.create({ data: rr(ids.reviewOrder, ids.prodUser) }))).rejects.toThrow(/STA-1 lineage/);
    await expect(system(() => app.prisma.returnRequest.create({ data: rr(`missing-${RUN}`, ids.reviewUser) }))).rejects.toThrow(/STA-1 lineage/);
    await expect(runWithTenant(PRODUCTION, () => app.prisma.returnRequest.create({ data: rr(ids.reviewOrder, ids.reviewUser) }))).resolves.toMatchObject({ tenantId: REVIEW }); // production default = unstamped → derived
    await expect(system(() => app.prisma.returnRequest.create({ data: rr(ids.reviewOrder, ids.reviewUser, { tenantId: `other-${RUN}` }) }))).rejects.toThrow(/STA-1 lineage|Foreign key/);
    // moving an existing return to another tenant's order is refused
    await expect(system(() => app.prisma.returnRequest.update({ where: { id: derived.id }, data: { orderId: ids.prodOrder, customerId: ids.prodUser } }))).rejects.toThrow(/STA-1 lineage/);
  });

  it('ContentReport: derived from the reporter; a missing reporter or a contradicting tenant is refused', async () => {
    const r = await system(() => app.prisma.contentReport.create({ data: report(ids.reviewUser) }));
    expect(r.tenantId).toBe(REVIEW);
    const p = await runWithTenant(PRODUCTION, () => app.prisma.contentReport.create({ data: report(ids.prodUser) }));
    expect(p.tenantId).toBe(PRODUCTION);
    await expect(system(() => app.prisma.contentReport.create({ data: report(`missing-${RUN}`) }))).rejects.toThrow(/STA-1 lineage/);
    await expect(runWithTenant(REVIEW, () => app.prisma.contentReport.create({ data: report(ids.prodUser) }))).rejects.toThrow(/STA-1 lineage/);
  });

  it('CollectionContact: derived from the subscription’s owner; owners in two tenants or a missing subscription are refused', async () => {
    const c = await system(() => app.prisma.collectionContact.create({ data: contact(ids.reviewSub) }));
    expect(c.tenantId).toBe(REVIEW);
    await expect(system(() => app.prisma.collectionContact.create({ data: contact(ids.splitSub) }))).rejects.toThrow(/STA-1 lineage/);
    await expect(system(() => app.prisma.collectionContact.create({ data: contact(`missing-${RUN}`) }))).rejects.toThrow(/STA-1 lineage/);
  });

  it('an old binary that never names tenantId (raw INSERT) still gets the derived tenant', async () => {
    const id = `d5raw-${RUN}`;
    await system(() => app.prisma.$executeRaw`INSERT INTO content_reports (id, "reporterId", "targetType", "targetId", reason, status, "createdAt", "updatedAt") VALUES (${id}, ${ids.reviewUser}, 'USER', ${`raw-${RUN}`}, 'SPAM', 'PENDING', now(), now())`);
    const row = await system(() => app.prisma.contentReport.findUniqueOrThrow({ where: { id } }));
    expect(row.tenantId).toBe(REVIEW);
  });
});

describe('[DB-05] the backfill: true where the owners agree, quarantined (NULL) where they do not', () => {
  class RolledBack extends Error {}
  it('existing rows take their owners’ tenant; split and orphan rows stay NULL — never the production default', async () => {
    let seen: Record<string, string | null> = {};
    try {
      await system(() => app.prisma.$transaction(async (tx) => {
        for (const t of TABLES) await tx.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
        const ins = (sql: Prisma.Sql) => tx.$executeRaw(sql);
        await ins(Prisma.sql`INSERT INTO return_requests (id, "orderId", "customerId", reason) VALUES ('bf-rr-good', ${ids.reviewOrder}, ${ids.reviewUser}, 'x'), ('bf-rr-split', ${ids.reviewOrder}, ${ids.prodUser}, 'x'), ('bf-rr-orphan', ${`gone-${RUN}`}, ${ids.reviewUser}, 'x')`);
        await ins(Prisma.sql`INSERT INTO content_reports (id, "reporterId", "targetType", "targetId", reason, status, "createdAt", "updatedAt") VALUES ('bf-cr-good', ${ids.reviewUser}, 'USER', 'a', 'SPAM', 'PENDING', now(), now()), ('bf-cr-orphan', ${`gone-${RUN}`}, 'USER', 'b', 'SPAM', 'PENDING', now(), now())`);
        await ins(Prisma.sql`INSERT INTO collection_contacts (id, "subscriptionId", outcome, "byAdminId") VALUES ('bf-cc-good', ${ids.reviewSub}, 'REACHED', 'a'), ('bf-cc-split', ${ids.splitSub}, 'REACHED', 'a'), ('bf-cc-orphan', ${`gone-${RUN}`}, 'REACHED', 'a')`);
        for (const t of TABLES) await tx.$executeRawUnsafe(lineageBackfillSql(t));
        const rows = await tx.$queryRaw<{ id: string; tenantId: string | null }[]>(Prisma.sql`
          SELECT id, "tenantId" FROM return_requests WHERE id LIKE 'bf-%' UNION ALL
          SELECT id, "tenantId" FROM content_reports WHERE id LIKE 'bf-%' UNION ALL
          SELECT id, "tenantId" FROM collection_contacts WHERE id LIKE 'bf-%'`);
        seen = Object.fromEntries(rows.map((r) => [r.id, r.tenantId]));
        throw new RolledBack();
      }, { timeout: 30_000 }));
    } catch (e) { if (!(e instanceof RolledBack)) throw e; }
    expect(seen).toEqual({
      'bf-rr-good': REVIEW, 'bf-rr-split': null, 'bf-rr-orphan': null,
      'bf-cr-good': REVIEW, 'bf-cr-orphan': null,
      'bf-cc-good': REVIEW, 'bf-cc-split': null, 'bf-cc-orphan': null,
    });
  });
});

describe('[DB-05] the application wall: a tenant-bound read sees its own rows, never another tenant’s', () => {
  it('ContentReport and ReturnRequest listed from each tenant (the admin queues’ scope is now this column)', async () => {
    const mine = await system(() => app.prisma.contentReport.create({ data: report(ids.reviewUser) }));
    const theirs = await system(() => app.prisma.contentReport.create({ data: report(ids.prodUser) }));
    const rMine = await system(() => app.prisma.returnRequest.create({ data: rr(ids.reviewOrder, ids.reviewUser) }));
    const rTheirs = await system(() => app.prisma.returnRequest.create({ data: rr(ids.prodOrder, ids.prodUser) }));
    const reports = (tenant: string) => runWithTenant(tenant, () => app.prisma.contentReport.findMany({ where: { id: { in: [mine.id, theirs.id] } }, select: { id: true } }));
    const returns = (tenant: string) => runWithTenant(tenant, () => app.prisma.returnRequest.findMany({ where: { id: { in: [rMine.id, rTheirs.id] } }, select: { id: true } }));
    expect((await reports(REVIEW)).map((r) => r.id)).toEqual([mine.id]);
    expect((await reports(PRODUCTION)).map((r) => r.id)).toEqual([theirs.id]);
    expect((await returns(REVIEW)).map((r) => r.id)).toEqual([rMine.id]);
    expect((await returns(PRODUCTION)).map((r) => r.id)).toEqual([rTheirs.id]);
  });
});

describe('[DB-05] the wall binds a NOBYPASSRLS role', () => {
  it('bound to production it counts ZERO of the fiction’s rows; the fiction sees its own; nobody sees a quarantined row', async () => {
    await system(() => app.prisma.contentReport.create({ data: report(ids.reviewUser) }));
    const count = (guc: string, sql: string) => app.prisma.$transaction(async (t) => {
      await t.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE}`);
      await t.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${guc}'`);
      return Number((await t.$queryRawUnsafe<{ n: bigint }[]>(sql))[0]!.n);
    });
    const q = `SELECT count(*)::bigint AS n FROM content_reports WHERE "reporterId" = '${ids.reviewUser}'`;
    expect(await count(REVIEW, q)).toBeGreaterThan(0);
    expect(await count(PRODUCTION, q)).toBe(0);
    // a quarantined (NULL) row, made with the triggers off as a legacy row would be
    class RolledBack extends Error {}
    let visible: number[] = [];
    try {
      await app.prisma.$transaction(async (t) => {
        await t.$executeRawUnsafe('ALTER TABLE content_reports DISABLE TRIGGER USER');
        await t.$executeRaw`INSERT INTO content_reports (id, "reporterId", "targetType", "targetId", reason, status, "createdAt", "updatedAt") VALUES ('q-null', ${`gone-${RUN}`}, 'USER', 'q', 'SPAM', 'PENDING', now(), now())`;
        await t.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE}`);
        visible = [];
        for (const guc of [REVIEW, PRODUCTION, '']) {
          await t.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${guc}'`);
          visible.push(Number((await t.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM content_reports WHERE id = 'q-null'`))[0]!.n));
        }
        throw new RolledBack();
      });
    } catch (e) { if (!(e instanceof RolledBack)) throw e; }
    expect(visible).toEqual([0, 0, 0]);
  });
});
