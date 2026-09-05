/**
 * [STA-1 §4 lineage — the exemplar EXPAND] Items and categories are walled on
 * the row itself.
 *
 * Both tables carry tenantId, sit in BOTH walls, are FORCED, and a database
 * trigger holds each row's tenant equal to its vendor's: a row created in
 * system mode without a tenant (the default) for a vendor of another tenant is
 * refused, never stored wrong; a cross-tenant vendor is refused; the wall
 * stamps a bound caller's rows correctly. The migration's backfill left no
 * row disagreeing with its vendor.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin, TENANT_MODEL_NAMES } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { TENANT_TABLES, TENANT_LINEAGE_TABLES, allRlsDdl, appRoleDdl, tenantLineageDdl } from '../lib/tenant-rls';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const REVIEW = `lineage-${RUN}`;
const PRODUCTION = 'swift-default';
const PROBE = 'swift_rls_probe';
let app: FastifyInstance;
const ids = { reviewOwner: '', prodOwner: '', reviewVendor: '', prodVendor: '', reviewCategory: '', prodCategory: '' };
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'sta1-lineage-test');

async function vendorIn(tenantId: string, phone: string) {
  const owner = await app.prisma.user.create({ data: { phone, firstName: 'O', lastName: 'W', activeRole: 'VENDOR_OWNER', tenantId, isSynthetic: tenantId !== PRODUCTION } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    tenantId, isSynthetic: tenantId !== PRODUCTION, ownerId: vo.id, name: `L ${RUN} ${tenantId}`, slug: `l-${RUN}-${tenantId === REVIEW ? 'r' : 'p'}`,
    vendorType: 'RESTAURANT', phone, addressLine1: '1', city: 'Georgetown', region: 'D', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
  } });
  const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, tenantId, name: 'Menu' } });
  return { ownerId: owner.id, vendorId: vendor.id, categoryId: cat.id };
}

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
    await app.prisma.tenant.create({ data: { id: REVIEW, name: 'Lineage fiction', slug: REVIEW, kind: 'REVIEW', purgeProtected: true } });
    const r = await vendorIn(REVIEW, `+59276${NUM}1`);
    const p = await vendorIn(PRODUCTION, `+59276${NUM}2`);
    ids.reviewOwner = r.ownerId; ids.reviewVendor = r.vendorId; ids.reviewCategory = r.categoryId;
    ids.prodOwner = p.ownerId; ids.prodVendor = p.vendorId; ids.prodCategory = p.categoryId;
  });
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.item.deleteMany({ where: { vendorId: { in: [ids.reviewVendor, ids.prodVendor] } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: [ids.reviewVendor, ids.prodVendor] } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: [ids.reviewVendor, ids.prodVendor] } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: [ids.reviewOwner, ids.prodOwner] } } });
    await app.prisma.user.deleteMany({ where: { id: { in: [ids.reviewOwner, ids.prodOwner] } } });
    await app.prisma.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  await app.close();
});

const item = (data: Prisma.ItemUncheckedCreateInput) => app.prisma.item.create({ data });
const plate = (vendorId: string, categoryId: string, extra: Partial<Prisma.ItemUncheckedCreateInput> = {}): Prisma.ItemUncheckedCreateInput =>
  ({ vendorId, categoryId, name: `Plate ${nanoid(4)}`, basePrice: 1000, isAvailable: true, ...extra });

describe('[STA-1 §4 lineage] items and categories carry their tenant on the row', () => {
  it('both tables are in BOTH walls and are FORCED', async () => {
    for (const t of ['items', 'categories']) expect(TENANT_TABLES).toContain(t);
    for (const m of ['item', 'category']) expect(TENANT_MODEL_NAMES).toContain(m);
    expect(TENANT_LINEAGE_TABLES.map((t) => t.table)).toEqual(['items', 'categories']);
    const rows = await app.prisma.$queryRaw<{ relname: string }[]>(Prisma.sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('items', 'categories') AND c.relrowsecurity AND c.relforcerowsecurity`);
    expect(rows.map((r) => r.relname).sort()).toEqual(['categories', 'items']);
  });

  it('no item or category disagrees with its vendor about the tenant — the backfill is true, not merely present', async () => {
    const [i] = await app.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*)::bigint AS n FROM items i JOIN vendors v ON v.id = i."vendorId" WHERE i."tenantId" <> v."tenantId"`);
    const [c] = await app.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*)::bigint AS n FROM categories c JOIN vendors v ON v.id = c."vendorId" WHERE c."tenantId" <> v."tenantId"`);
    expect([Number(i!.n), Number(c!.n)]).toEqual([0, 0]);
  });

  it('a bound caller’s new item is stamped with its tenant, which is its vendor’s', async () => {
    const row = await runWithTenant(REVIEW, () => item(plate(ids.reviewVendor, ids.reviewCategory)));
    expect(row.tenantId).toBe(REVIEW);
  });

  it('system mode WITHOUT a tenant (the default = unstamped) is DERIVED from the vendor — never stored as production', async () => {
    const stray = await system(() => item(plate(ids.reviewVendor, ids.reviewCategory)));
    expect(stray.tenantId).toBe(REVIEW);
    const cat = await system(() => app.prisma.category.create({ data: { vendorId: ids.reviewVendor, name: 'Stray' } }));
    expect(cat.tenantId).toBe(REVIEW);
  });

  it('an EXPLICIT tenant that disagrees with the vendor is refused, and a vendor that does not exist is refused', async () => {
    await expect(system(() => item(plate(ids.reviewVendor, ids.reviewCategory, { tenantId: PRODUCTION === 'swift-default' ? `other-${RUN}` : PRODUCTION })))).rejects.toThrow(/STA-1 lineage|Foreign key/);
    await expect(system(() => item(plate(`no-such-vendor-${RUN}`, ids.reviewCategory)))).rejects.toThrow(/STA-1 lineage|Foreign key/);
  });

  it('a cross-tenant parent is refused: bound to the fiction, an item for a real vendor cannot exist', async () => {
    await expect(runWithTenant(REVIEW, () => item(plate(ids.prodVendor, ids.prodCategory)))).rejects.toThrow(/STA-1 lineage/);
  });

  it('moving an item to a vendor of another tenant is refused too', async () => {
    const mine = await runWithTenant(REVIEW, () => item(plate(ids.reviewVendor, ids.reviewCategory)));
    await expect(system(() => app.prisma.item.update({ where: { id: mine.id }, data: { vendorId: ids.prodVendor } }))).rejects.toThrow(/STA-1 lineage/);
  });

  it('RLS-N1 for items: bound to production, a NOBYPASSRLS role counts ZERO of the fiction’s items; the fiction sees its own', async () => {
    const count = (guc: string) => app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE}`);
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${guc}'`);
      const rows = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*)::bigint AS n FROM items WHERE "vendorId" = ${ids.reviewVendor}`);
      return Number(rows[0]!.n);
    });
    expect(await count(REVIEW)).toBeGreaterThan(0);
    expect(await count(PRODUCTION)).toBe(0);
  });
});
