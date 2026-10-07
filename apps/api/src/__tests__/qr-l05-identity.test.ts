import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { QrService } from '../modules/qr/qr.service';
import { AttributionService } from '../modules/qr/attribution.service';
import { grantSuiteCapability } from '../lib/test-target-lock';

// The shortCode generator is controllable so a retired code can be offered
// again (contract §5.6); every other call is the real CSPRNG.
const codes = vi.hoisted(() => ({ next: [] as string[] }));
vi.mock('../modules/qr/qr-codes', async (importOriginal) => {
  const real = await importOriginal<typeof import('../modules/qr/qr-codes')>();
  return { ...real, generateShortCode: (...a: Parameters<typeof real.generateShortCode>) => codes.next.shift() ?? real.generateShortCode(...a) };
});

// This suite grades the MIGRATIONS as applied (`migrate deploy`): it installs
// no lineage or identity DDL itself. A probe role for the system login is
// created by raw DDL — a stated, reviewable capability.
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [row 106 · #1217] A printed QR code can only ever open its own tenant's
// store, and a printed token's identity is permanent.
//
//  - A store's tenant never changes (vendors_tenant_immutable) — for the
//    request login, the system login and the owner alike — so an old-tenant
//    child write can never meet a moved parent (contract A1).
//  - A printed code's id, short code and target never change, its lifecycle
//    only moves forward, and deleting it retires its identity instead of
//    freeing it (swift_qr.token_identities, contract M4).
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const contender = new PrismaClient();
const run = `l05id-${nanoid(10)}`;
const SYSTEM_PROBE = 'l05_system_probe';
const M4 = readFileSync(path.resolve(__dirname, '../../prisma/migrations/20261005210300_qr_token_identity/migration.sql'), 'utf8');
let tenantA: string, tenantB: string, userId: string, ownerId: string;
let sequence = 0;

type Tx = Prisma.TransactionClient;
async function as<T>(role: 'swift_app' | typeof SYSTEM_PROBE, fn: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    await tx.$executeRawUnsafe("SELECT set_config('app.current_tenant', $1, true)", tenantA);
    const facts = await tx.$queryRaw<Array<{ role: string; superuser: boolean; bypass: boolean; member: boolean }>>`
      SELECT current_user::text AS role, rolsuper AS superuser, rolbypassrls AS bypass,
             pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER') AS member
        FROM pg_roles WHERE rolname = current_user`;
    expect(facts).toEqual([{ role, superuser: false, bypass: false, member: role === SYSTEM_PROBE }]);
    return fn(tx);
  }, { timeout: 15_000 });
}
const restricted = <T>(fn: (tx: Tx) => Promise<T>) => as('swift_app', fn);

async function fixture(tenantId = tenantA) {
  const slug = `${run}-${sequence++}`;
  const vendor = await prisma.vendor.create({ data: { tenantId, ownerId, name: 'Synthetic QR store', slug,
    vendorType: 'RESTAURANT', status: 'ACTIVE', isVerified: true, phone: `+592041${sequence.toString().padStart(4, '0')}`,
    addressLine1: 'Synthetic street', city: 'Synthetic city', region: 'Synthetic region', latitude: 6.8, longitude: -58.15 } });
  const qr = await new QrService(prisma).getOrCreateForVendor(vendor.id, userId);
  return { vendor, qr };
}
const registry = (id: string) => prisma.$queryRaw<Array<Record<string, unknown>>>`
  SELECT "qrCodeId", "shortCode", "entityType", "entityId", "originTenantId", "retiredAt" IS NOT NULL AS retired
    FROM swift_qr.token_identities WHERE "qrCodeId" = ${id}`;

beforeAll(async () => {
  // The database under test is the lane's own fresh `migrate deploy`.
  const db = (await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`)[0]?.db;
  expect(db).toBe(new URL(process.env['DATABASE_URL']!).pathname.slice(1));
  for (const sql of [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_PROBE}') THEN CREATE ROLE ${SYSTEM_PROBE} NOLOGIN NOBYPASSRLS; END IF; END $$`,
    `GRANT swift_app TO ${SYSTEM_PROBE}`,
    `GRANT swift_bypass_rls TO ${SYSTEM_PROBE}`,
  ]) await prisma.$executeRawUnsafe(sql);
  tenantA = `${run}-a`; tenantB = `${run}-b`;
  for (const id of [tenantA, tenantB]) await prisma.tenant.create({ data: { id, name: 'Synthetic QR tenant', slug: id, kind: 'PRODUCTION' } });
  const user = await prisma.user.create({ data: { tenantId: tenantA, phone: `+592041${Date.now()}`, firstName: 'Synthetic', lastName: 'Test', roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', customer: { create: {} } } });
  userId = user.id;
  ownerId = (await prisma.vendorOwner.create({ data: { userId } })).id;
});
afterAll(async () => {
  // The synthetic operators' rows are removed (later suites count every user
  // and store on the default tenant), child rows first. Printed-token identity
  // is permanent by design: the registry keeps each code as RETIRED after its
  // row goes. The two synthetic operators themselves stay, switched OFF: an
  // extra ACTIVE tenant changes the public storefront's single-tenant
  // resolution for every later suite.
  const tenants = [tenantA, tenantB].filter(Boolean);
  const inTenants = { tenantId: { in: tenants } };
  await prisma.attributionClaim.deleteMany({ where: inTenants });
  await prisma.pendingAttribution.deleteMany({ where: inTenants });
  await prisma.scanEvent.deleteMany({ where: inTenants });
  await prisma.scanDailyRollup.deleteMany({ where: inTenants });
  await prisma.order.deleteMany({ where: inTenants });
  await prisma.slugRedirect.deleteMany({ where: inTenants });
  await prisma.qrCode.deleteMany({ where: inTenants });
  await prisma.vendor.deleteMany({ where: inTenants });
  if (ownerId) await prisma.vendorOwner.deleteMany({ where: { id: ownerId } });
  if (userId) {
    await prisma.customer.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  await prisma.tenant.updateMany({ where: { id: { in: tenants } }, data: { isActive: false } });
  await Promise.all([prisma.$disconnect(), contender.$disconnect()]);
});

describe('[A1] a store never changes tenant — for any role', () => {
  it('the request login (swift_app), the system login and the owner are all refused', async () => {
    const { vendor } = await fixture();
    await expect(restricted(tx => tx.vendor.update({ where: { id: vendor.id }, data: { tenantId: tenantB } }))).rejects.toThrow(/VENDOR_TENANT_IMMUTABLE/);
    await expect(as(SYSTEM_PROBE, tx => tx.vendor.update({ where: { id: vendor.id }, data: { tenantId: tenantB } }))).rejects.toThrow(/VENDOR_TENANT_IMMUTABLE/);
    await expect(prisma.vendor.update({ where: { id: vendor.id }, data: { tenantId: tenantB } })).rejects.toThrow(/VENDOR_TENANT_IMMUTABLE/);
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).tenantId).toBe(tenantA);
  });
  it('the system login can still update a store’s other fields, and a same-tenant write is not a change', async () => {
    const { vendor } = await fixture();
    await as(SYSTEM_PROBE, tx => tx.vendor.update({ where: { id: vendor.id }, data: { name: 'Renamed', tenantId: tenantA } }));
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).name).toBe('Renamed');
  });
  it('(restated red case 1) an old-tenant child write held open while a tenant change is attempted: the change is refused, the child commits under its own tenant', async () => {
    const { vendor } = await fixture();
    let resume!: () => void, reached!: () => void;
    const hold = new Promise<void>(r => { resume = r; });
    const ready = new Promise<void>(r => { reached = r; });
    const child = restricted(async tx => {
      expect(await tx.vendor.findUnique({ where: { id: vendor.id } })).not.toBeNull();
      reached(); await hold;
      return tx.bookingException.create({ data: { tenantId: tenantA, vendorId: vendor.id, date: new Date('2026-10-05') } });
    });
    await ready;
    try {
      await expect(contender.vendor.update({ where: { id: vendor.id }, data: { tenantId: tenantB } })).rejects.toThrow(/VENDOR_TENANT_IMMUTABLE/);
    } finally { resume(); }
    expect((await child).tenantId).toBe(tenantA);
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).tenantId).toBe(tenantA);
  });
  it('(restated red case 2) a child can never be reattached to a store that “moved”, because no store moves', async () => {
    const a = await fixture(), b = await fixture();
    const child = await restricted(tx => tx.bookingException.create({ data: { tenantId: tenantA, vendorId: a.vendor.id, date: new Date('2026-10-06') } }));
    await expect(prisma.vendor.update({ where: { id: b.vendor.id }, data: { tenantId: tenantB } })).rejects.toThrow(/VENDOR_TENANT_IMMUTABLE/);
    const moved = await restricted(tx => tx.bookingException.update({ where: { id: child.id }, data: { vendorId: b.vendor.id } }));
    expect(moved.tenantId).toBe(tenantA);
  });
});

describe('[AX2 · red cases 3–5] a printed token and its surviving receipts never acquire a new identity', () => {
  it('refuses freeing a short code and assigning it to another same-tenant store', async () => {
    const a = await fixture(), b = await fixture();
    await expect(restricted(async tx => {
      await tx.$executeRawUnsafe('UPDATE qr_codes SET "shortCode"=$1 WHERE id=$2', `UNUSED${sequence}`, a.qr.id);
      await tx.$executeRawUnsafe('UPDATE qr_codes SET "shortCode"=$1 WHERE id=$2', a.qr.shortCode, b.qr.id);
    })).rejects.toThrow(/QR_TOKEN_IMMUTABLE/);
  });
  it('refuses changing a QR primary id while a claim receipt survives', async () => {
    const { qr } = await fixture();
    await prisma.attributionClaim.create({ data: { tenantId: tenantA, qrCodeId: qr.id, installId: `${run}-id-change`, platform: 'android', outcome: 'deterministic', destinationPath: '/store/synthetic' } });
    await expect(restricted(tx => tx.$executeRawUnsafe('UPDATE qr_codes SET id=$1 WHERE id=$2', `${run}-replacement-id`, qr.id))).rejects.toThrow(/QR_TOKEN_IMMUTABLE/);
  });
  it('refuses delete-then-recreate of the code id and token for another store; the old receipt keeps answering for its own store', async () => {
    const a = await fixture(), b = await fixture();
    await prisma.qrCode.update({ where: { id: b.qr.id }, data: { status: 'DEACTIVATED' } });
    const svc = new AttributionService(prisma), installId = `${run}-delete-recreate`;
    expect((await svc.claim(installId, 'android', `swift_qr=${a.qr.shortCode}`, { ip: '198.51.100.51', ua: undefined })).destination).toBe(`/store/${a.vendor.slug}`);
    await expect(restricted(async tx => {
      await tx.$executeRawUnsafe('DELETE FROM qr_codes WHERE id=$1', a.qr.id);
      await tx.qrCode.create({ data: { ...a.qr, entityId: b.vendor.id, slug: b.vendor.slug } });
    })).rejects.toThrow(/QR_TOKEN_TOMBSTONED/);
    // once deleted for real, the identity is retired, never freed
    await prisma.qrCode.delete({ where: { id: a.qr.id } });
    expect(await registry(a.qr.id)).toEqual([{ qrCodeId: a.qr.id, shortCode: a.qr.shortCode, entityType: 'VENDOR', entityId: a.vendor.id, originTenantId: tenantA, retired: true }]);
    await expect(prisma.qrCode.create({ data: { ...a.qr, entityId: b.vendor.id, slug: b.vendor.slug } })).rejects.toThrow(/QR_TOKEN_TOMBSTONED/);
    await expect(prisma.qrCode.create({ data: { ...a.qr, id: `${run}-new-id`, entityId: b.vendor.id, slug: b.vendor.slug } })).rejects.toThrow();
    expect(await prisma.qrCode.count({ where: { shortCode: a.qr.shortCode } })).toBe(0);
  });
});

describe('[M4] the lifecycle only moves forward', () => {
  it('ACTIVE → SUPERSEDED → DEACTIVATED is allowed through the service; no step goes back, and recorded times never change', async () => {
    const { vendor, qr } = await fixture();
    const svc = new QrService(prisma);
    const { superseded } = await svc.regenerateForVendor(vendor.id, userId);
    expect(superseded?.id).toBe(qr.id);
    await expect(prisma.qrCode.update({ where: { id: qr.id }, data: { status: 'ACTIVE' } })).rejects.toThrow(/QR_TOKEN_LIFECYCLE/);
    await expect(prisma.qrCode.update({ where: { id: qr.id }, data: { supersededAt: new Date(Date.now() + 86_400_000) } })).rejects.toThrow(/QR_TOKEN_LIFECYCLE/);
    await prisma.qrCode.update({ where: { id: qr.id }, data: { status: 'DEACTIVATED', deactivatedAt: new Date() } });
    await expect(prisma.qrCode.update({ where: { id: qr.id }, data: { status: 'SUPERSEDED' } })).rejects.toThrow(/QR_TOKEN_LIFECYCLE/);
    await expect(prisma.qrCode.update({ where: { id: qr.id }, data: { deactivatedAt: new Date(0) } })).rejects.toThrow(/QR_TOKEN_LIFECYCLE/);
    expect((await svc.deactivateForVendor(vendor.id)).deactivated).toBe(1);
  });
});

describe('[M4 · §5.6] issuing never reuses an identity', () => {
  it('a retired short code offered again by the generator is skipped by the existing retry', async () => {
    const a = await fixture();
    await prisma.qrCode.delete({ where: { id: a.qr.id } });
    const b = await prisma.vendor.create({ data: { tenantId: tenantA, ownerId, name: 'Synthetic QR store', slug: `${run}-retry`,
      vendorType: 'RESTAURANT', status: 'ACTIVE', isVerified: true, phone: '+5920419999', addressLine1: 'x', city: 'x', region: 'x', latitude: 6.8, longitude: -58.15 } });
    codes.next.push(a.qr.shortCode);
    const fresh = await new QrService(prisma).getOrCreateForVendor(b.id, userId);
    expect(codes.next).toEqual([]);
    expect(fresh.shortCode).not.toBe(a.qr.shortCode);
  });
  it('a store id that had printed codes is never given to a new store, and a store id never changes', async () => {
    const { vendor } = await fixture();
    await expect(prisma.$executeRawUnsafe('UPDATE vendors SET id=$1 WHERE id=$2', `${run}-renamed`, vendor.id)).rejects.toThrow(/QR_TARGET_IMMUTABLE/);
    // Deleting the STORE (its printed code row still exists) retires every
    // reservation that names it, in the same transaction.
    await prisma.vendor.delete({ where: { id: vendor.id } });
    const reserved = await prisma.$queryRaw<Array<{ open: bigint }>>`SELECT count(*) FILTER (WHERE "retiredAt" IS NULL) AS open FROM swift_qr.token_identities WHERE "entityType"='VENDOR' AND "entityId"=${vendor.id}`;
    expect(Number(reserved[0]!.open)).toBe(0);
    await expect(prisma.vendor.create({ data: { id: vendor.id, tenantId: tenantA, ownerId, name: 'Impostor', slug: `${run}-impostor`,
      vendorType: 'RESTAURANT', status: 'ACTIVE', isVerified: true, phone: '+5920419998', addressLine1: 'x', city: 'x', region: 'x', latitude: 6.8, longitude: -58.15 } })).rejects.toThrow(/QR_TARGET_RESERVED/);
  });
});

describe('[M4 · §5.4] the registry is private and permanent', () => {
  it('swift_app can neither read nor write it, yet its QR inserts are reserved (the triggers fire without schema USAGE)', async () => {
    for (const sql of [
      'SELECT 1 FROM swift_qr.token_identities LIMIT 1',
      `INSERT INTO swift_qr.token_identities ("qrCodeId") VALUES ('${run}-direct')`,
      'UPDATE swift_qr.token_identities SET "retiredAt" = now() WHERE false',
      'DELETE FROM swift_qr.token_identities WHERE false',
      'TRUNCATE swift_qr.token_identities',
    ]) {
      await expect(restricted(tx => tx.$executeRawUnsafe(sql)), sql).rejects.toMatchObject({ meta: { code: '42501' } });
    }
    const { vendor } = await fixture();
    const issued = await restricted(tx => tx.qrCode.create({ data: { tenantId: tenantA, entityType: 'VENDOR', entityId: vendor.id, shortCode: `${run.slice(-6).toUpperCase()}ZZZZ`.slice(0, 10), slug: vendor.slug, version: 9, createdById: userId, status: 'DEACTIVATED' } }));
    expect(await registry(issued.id)).toEqual([{ qrCodeId: issued.id, shortCode: issued.shortCode, entityType: 'VENDOR', entityId: vendor.id, originTenantId: tenantA, retired: false }]);
  });
  it('even the owner can only retire a row once: any other UPDATE, a DELETE or a TRUNCATE is refused', async () => {
    const { qr } = await fixture();
    await expect(prisma.$executeRaw`UPDATE swift_qr.token_identities SET "entityId" = 'elsewhere' WHERE "qrCodeId" = ${qr.id}`).rejects.toThrow(/QR_TOKEN_REGISTRY_IMMUTABLE/);
    await expect(prisma.$executeRaw`DELETE FROM swift_qr.token_identities WHERE "qrCodeId" = ${qr.id}`).rejects.toThrow(/QR_TOKEN_REGISTRY_IMMUTABLE/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE swift_qr.token_identities')).rejects.toThrow(/QR_TOKEN_REGISTRY_IMMUTABLE/);
    await prisma.$executeRaw`UPDATE swift_qr.token_identities SET "retiredAt" = now() WHERE "qrCodeId" = ${qr.id}`;
    await expect(prisma.$executeRaw`UPDATE swift_qr.token_identities SET "retiredAt" = now() + interval '1 day' WHERE "qrCodeId" = ${qr.id}`).rejects.toThrow(/QR_TOKEN_REGISTRY_IMMUTABLE/);
  });
});

describe('[M4 · §5.5] the backfill reserves exactly what exists', () => {
  it('existing codes keep their exact provenance; ids known only from receipts are reserved already retired', async () => {
    const { vendor, qr } = await fixture();
    const orphan = `${run}-orphan`;
    const block = M4.slice(M4.indexOf('-- BEGIN QR TOKEN BACKFILL'), M4.indexOf('-- END QR TOKEN BACKFILL'));
    expect(block).toContain('INSERT INTO swift_qr.token_identities');
    class RolledBack extends Error {}
    let seen: Array<Record<string, unknown>> = [];
    try {
      await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe('ALTER TABLE swift_qr.token_identities DISABLE TRIGGER USER');
        await tx.$executeRaw`DELETE FROM swift_qr.token_identities WHERE "qrCodeId" = ${qr.id}`;
        await tx.$executeRawUnsafe('ALTER TABLE swift_qr.token_identities ENABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE attribution_claims DISABLE TRIGGER USER');
        await tx.attributionClaim.create({ data: { tenantId: tenantA, qrCodeId: orphan, installId: `${run}-orphan`, platform: 'android', outcome: 'none' } });
        for (const statement of block.split(';').map(s => s.trim()).filter(s => s && !/^--[^\n]*$/.test(s))) await tx.$executeRawUnsafe(statement);
        seen = await tx.$queryRawUnsafe(`SELECT "qrCodeId", "shortCode", "entityType", "entityId", "originTenantId", "retiredAt" IS NOT NULL AS retired
          FROM swift_qr.token_identities WHERE "qrCodeId" IN ($1, $2) ORDER BY "qrCodeId"`, qr.id, orphan);
        throw new RolledBack();
      }, { timeout: 30_000 });
    } catch (e) { if (!(e instanceof RolledBack)) throw e; }
    expect(seen).toEqual([
      { qrCodeId: qr.id, shortCode: qr.shortCode, entityType: 'VENDOR', entityId: vendor.id, originTenantId: tenantA, retired: false },
      { qrCodeId: orphan, shortCode: null, entityType: null, entityId: null, originTenantId: null, retired: true },
    ].sort((x, y) => String(x.qrCodeId).localeCompare(String(y.qrCodeId))));
  });
});

describe('[§5.3] two checkouts at one store do not deadlock', () => {
  it('two concurrent attributed order inserts + store counter updates both commit', async () => {
    const { vendor, qr } = await fixture();
    const order = (n: number) => contender.$transaction(async tx => {
      await tx.order.create({ data: { tenantId: tenantA, orderNumber: `${run}-dl-${n}`, customerId: userId, vendorId: vendor.id, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', paymentMethod: 'CASH', subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 0, totalAmount: 1000, deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15, attributionQrCodeId: qr.id } });
      await new Promise(r => setTimeout(r, 50));
      await tx.vendor.updateMany({ where: { id: vendor.id }, data: { totalOrders: { increment: 1 } } });
    });
    const results = await Promise.allSettled([order(1), order(2), prisma.$transaction(async tx => {
      await tx.order.create({ data: { tenantId: tenantA, orderNumber: `${run}-dl-3`, customerId: userId, vendorId: vendor.id, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', paymentMethod: 'CASH', subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 0, totalAmount: 1000, deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15, attributionQrCodeId: qr.id } });
      await tx.vendor.updateMany({ where: { id: vendor.id }, data: { totalOrders: { increment: 1 } } });
    })]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).totalOrders).toBe(3);
  });
});

describe('[§5.8] catalog: definer functions are pinned, nothing is granted, the walls are untouched', () => {
  it('every SECURITY DEFINER function is owned by the table owner with the exact configuration', async () => {
    const rows = await prisma.$queryRaw<Array<{ fn: string; definer: boolean; config: string[] | null; same_owner: boolean }>>`
      SELECT n.nspname || '.' || p.proname AS fn, p.prosecdef AS definer, p.proconfig AS config,
             p.proowner = (SELECT relowner FROM pg_class WHERE oid = 'public.qr_codes'::regclass) AS same_owner
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'swift_qr' OR (n.nspname = 'public' AND p.proname IN ('qr_codes_identity_immutable', 'vendors_tenant_immutable'))
       ORDER BY 1`;
    const definers = ['swift_qr.qr_codes_token_reserve', 'swift_qr.qr_codes_token_retire', 'swift_qr.vendors_qr_target_identity', 'swift_qr.vendors_qr_target_retire'];
    expect(rows.map(r => r.fn)).toEqual(['public.qr_codes_identity_immutable', 'public.vendors_tenant_immutable', ...definers, 'swift_qr.token_identities_immutable', 'swift_qr.token_identities_no_truncate'].sort());
    for (const r of rows) {
      expect(r.same_owner, r.fn).toBe(true);
      expect(r.definer, r.fn).toBe(definers.includes(r.fn));
      expect(r.config, r.fn).toEqual(definers.includes(r.fn) ? ['search_path=pg_catalog, pg_temp', 'row_security=off'] : ['search_path=pg_catalog, pg_temp']);
    }
  });
  it('neither PUBLIC nor swift_app may execute a swift_qr function or use the schema; swift_bypass_rls gets nothing either', async () => {
    const fns = await prisma.$queryRaw<Array<{ fn: string; app: boolean; pub: boolean }>>`
      SELECT p.proname AS fn, has_function_privilege('swift_app', p.oid, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS pub
        FROM pg_proc p WHERE p.pronamespace = 'swift_qr'::regnamespace`;
    expect(fns.length).toBe(6);
    expect(fns.filter(f => f.app || f.pub)).toEqual([]);
    const schema = await prisma.$queryRaw<Array<{ who: string; usage: boolean; create: boolean }>>`
      SELECT r AS who, has_schema_privilege(r, 'swift_qr', 'USAGE') AS usage, has_schema_privilege(r, 'swift_qr', 'CREATE') AS create
        FROM unnest(ARRAY['swift_app', 'swift_bypass_rls']) AS r`;
    expect(schema).toEqual([{ who: 'swift_app', usage: false, create: false }, { who: 'swift_bypass_rls', usage: false, create: false }]);
    const publicSchema = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_namespace ns, aclexplode(COALESCE(ns.nspacl, acldefault('n', ns.nspowner))) a WHERE ns.nspname = 'swift_qr' AND a.grantee = 0`;
    expect(Number(publicSchema[0]!.n)).toBe(0);
  });
  it('the QR tables still carry exactly one canonical tenant_isolation policy each, and all seven identity triggers exist', async () => {
    const policies = await prisma.$queryRaw<Array<{ rel: string; n: bigint }>>`
      SELECT c.relname AS rel, count(p.*) AS n FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
       WHERE c.relname IN ('qr_codes', 'slug_redirects', 'attribution_claims', 'pending_attributions', 'scan_events', 'scan_daily_rollups', 'orders', 'vendors')
       GROUP BY 1 ORDER BY 1`;
    expect(policies.every(p => Number(p.n) === 1)).toBe(true);
    const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('qr_codes_token_reserve', 'qr_codes_token_retire', 'qr_codes_identity_immutable',
        'vendors_qr_target_identity', 'vendors_qr_target_retire', 'token_identities_immutable', 'token_identities_no_truncate', 'vendors_tenant_immutable') ORDER BY 1`;
    expect(triggers).toHaveLength(8);
  });
});
