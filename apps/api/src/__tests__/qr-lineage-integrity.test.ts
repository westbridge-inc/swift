import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { TENANT_LINEAGE_TABLES, tenantLineageDdl, vendorTenantMoveDdl } from '../lib/tenant-rls';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { QrService } from '../modules/qr/qr.service';
import { QrAnalyticsService } from '../modules/qr/qr-analytics.service';

grantSuiteCapability('ddl');
const prisma = new PrismaClient();
const run = `qr-integrity-${nanoid(8)}`;
const tables = ['qr_codes', 'slug_redirects', 'pending_attributions', 'attribution_claims', 'scan_events', 'scan_daily_rollups', 'orders'];
let tenantA: string, tenantB: string, userId: string, ownerId: string;
const vendorIds: string[] = [];
const codeIds: string[] = [];
async function raceHeldChild(
  childWrite: (tx: Prisma.TransactionClient) => Promise<unknown>,
  parentWrite: (tx: Prisma.TransactionClient) => Promise<unknown>,
) {
  const contender = new PrismaClient();
  let release!: () => void, inserted!: () => void, pid = 0, settled = false;
  const hold = new Promise<void>(r => { release = r; });
  const ready = new Promise<void>(r => { inserted = r; });
  const child = prisma.$transaction(async tx => { await childWrite(tx); inserted(); await hold; }, { timeout: 15_000 });
  await ready;
  const move = contender.$transaction(async tx => {
    pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
    await parentWrite(tx);
  }, { timeout: 15_000 }).then(() => { settled = true; return 'accepted'; }, (error: unknown) => {
    settled = true;
    // A refusal must be the lineage guard, never a fixture failure, deadlock,
    // pool timeout, or an unrelated SQL error masquerading as a safe race.
    expect(String(error)).toMatch(/lineage|non-QR|cannot change tenant while/i);
    return 'refused';
  });
  try {
    // Release only after the parent actually completes OR PostgreSQL proves
    // its connection is blocked. A scheduling delay cannot give false green.
    const deadline = Date.now() + 5_000;
    while (!settled) {
      if (pid) {
        const rows = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`;
        if (rows[0]?.blocked) break;
      }
      if (Date.now() > deadline) throw new Error('parent query neither completed nor reached a database lock');
      await new Promise(r => setTimeout(r, 5));
    }
  } finally { release(); }
  await child;
  try { return await move; } finally { await contender.$disconnect(); }
}
async function fixture(tenantId = tenantA) {
  const slug = `${run}-${vendorIds.length}`;
  const vendor = await prisma.vendor.create({ data: { tenantId, ownerId, name: slug, slug, vendorType: 'RESTAURANT', status: 'ACTIVE', isVerified: true, phone: `+592${Date.now()}${vendorIds.length}`, addressLine1: 'Test', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15 } });
  vendorIds.push(vendor.id);
  const qr = await new QrService(prisma).getOrCreateForVendor(vendor.id, userId);
  codeIds.push(qr.id);
  return { vendor, qr };
}
beforeAll(async () => {
  const rules = TENANT_LINEAGE_TABLES.filter(r => tables.includes(r.table));
  await installDdl(prisma, tenantLineageDdl().filter(sql => rules.some(r => sql.includes(r.trigger))));
  await installDdl(prisma, vendorTenantMoveDdl());
  if (process.env['QR_MUTATION_TAG']) {
    const definitions = await prisma.$queryRaw<Array<{ name: string; sql: string }>>`SELECT proname AS name, pg_get_functiondef(oid) AS sql FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('qr_codes_tenant_matches_vendor', 'vendors_tenant_move_guard') ORDER BY proname`;
    // eslint-disable-next-line no-console -- capture the installed mutation, not just its source bytes
    console.log('[mutation installed]', process.env['QR_MUTATION_TAG'], JSON.stringify(definitions));
  }
  for (const suffix of ['a', 'b']) await prisma.tenant.create({ data: { id: `${run}-${suffix}`, name: run, slug: `${run}-${suffix}`, kind: 'PRODUCTION' } });
  tenantA = `${run}-a`; tenantB = `${run}-b`;
  const u = await prisma.user.create({ data: { tenantId: tenantA, phone: `+592${Date.now()}88`, firstName: 'Test', lastName: 'Owner', roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', customer: { create: {} } } });
  userId = u.id;
  ownerId = (await prisma.vendorOwner.create({ data: { userId } })).id;
});
afterAll(async () => {
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: run } } });
  await prisma.scanDailyRollup.deleteMany({ where: { qrCodeId: { in: codeIds } } });
  await prisma.pendingAttribution.deleteMany({ where: { id: { startsWith: run } } });
  await prisma.attributionClaim.deleteMany({ where: { installId: { startsWith: run } } });
  await prisma.scanEvent.deleteMany({ where: { qrCodeId: { in: codeIds } } });
  await prisma.slugRedirect.deleteMany({ where: { oldSlug: { startsWith: run } } });
  await prisma.qrCode.deleteMany({ where: { id: { in: codeIds } } });
  await prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.bookingException.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  if (ownerId) await prisma.vendorOwner.delete({ where: { id: ownerId } });
  if (userId) {
    await prisma.customer.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } });
  await prisma.$disconnect();
});
describe('strict QR lineage on INSERT and UPDATE', () => {
  it('a QR UPDATE cannot replace its vendor with a missing parent', async () => {
    const { qr } = await fixture();
    await expect(prisma.qrCode.update({ where: { id: qr.id }, data: { entityId: `${run}-ghost` } })).rejects.toThrow(/STA-1 lineage/);
  });
  it('a redirect UPDATE cannot replace its vendor with a missing parent', async () => {
    const { vendor } = await fixture();
    const r = await prisma.slugRedirect.create({ data: { tenantId: tenantA, entityType: 'VENDOR', entityId: vendor.id, oldSlug: `${run}-redirect` } });
    await expect(prisma.slugRedirect.update({ where: { id: r.id }, data: { entityId: `${run}-ghost` } })).rejects.toThrow(/STA-1 lineage/);
  });
  it('pending and claimed attribution UPDATEs require a real code', async () => {
    const { qr } = await fixture();
    const p = await prisma.pendingAttribution.create({ data: { id: `${run}-pending`, tenantId: tenantA, qrCodeId: qr.id, destinationPath: '/store/test', platform: 'ios', fpHash: run, expiresAt: new Date(Date.now() + 60_000) } });
    const c = await prisma.attributionClaim.create({ data: { tenantId: tenantA, installId: `${run}-claim`, qrCodeId: qr.id, destinationPath: '/store/test', platform: 'android', outcome: 'matched' } });
    await expect(prisma.pendingAttribution.update({ where: { id: p.id }, data: { qrCodeId: `${run}-ghost` } })).rejects.toThrow(/STA-1 lineage/);
    await expect(prisma.attributionClaim.update({ where: { id: c.id }, data: { qrCodeId: `${run}-ghost` } })).rejects.toThrow(/STA-1 lineage/);
  });
  it('RLS-hidden parent on UPDATE is refused, even though the FK can see it', async () => {
    const a = await fixture(), b = await fixture(tenantB);
    const s = await prisma.scanEvent.create({ data: { tenantId: tenantA, qrCodeId: a.qr.id, decision: 'WEB_RENDER' } });
    await expect(prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE swift_app');
      await tx.$executeRawUnsafe("SELECT set_config('app.current_tenant', $1, true)", tenantA);
      await tx.scanEvent.update({ where: { id: s.id }, data: { qrCodeId: b.qr.id } });
    })).rejects.toThrow(/STA-1 lineage/);
  });
  it('rollups require the code’s tenant on insert and update, including missing code updates', async () => {
    const { qr } = await fixture();
    const data = { qrCodeId: qr.id, tenantId: tenantA, date: new Date(), decision: 'WEB_RENDER' as const, count: 5 };
    await expect(prisma.scanDailyRollup.create({ data: { ...data, tenantId: tenantB } })).rejects.toThrow(/STA-1 lineage/);
    const good = await prisma.scanDailyRollup.create({ data });
    await expect(prisma.scanDailyRollup.update({ where: { id: good.id }, data: { tenantId: tenantB } })).rejects.toThrow(/STA-1 lineage/);
    await expect(prisma.scanDailyRollup.update({ where: { id: good.id }, data: { qrCodeId: `${run}-ghost` } })).rejects.toThrow(/STA-1 lineage/);
  });
  it('order credit belongs to that order’s store and tenant; null remains valid', async () => {
    const a = await fixture(), b = await fixture(), foreign = await fixture(tenantB);
    const data = { tenantId: tenantA, orderNumber: `${run}-order`, customerId: userId, vendorId: a.vendor.id, orderType: 'FOOD_DELIVERY' as const, fulfillment: 'PICKUP' as const, status: 'DELIVERED' as const, paymentMethod: 'CASH' as const, subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 0, totalAmount: 1000, deliveryAddress: 'Test', deliveryLat: 6.8, deliveryLng: -58.15, channel: 'WEB' };
    await expect(prisma.order.create({ data: { ...data, attributionQrCodeId: b.qr.id } })).rejects.toThrow(/STA-1 lineage/);
    await expect(prisma.order.create({ data: { ...data, attributionQrCodeId: foreign.qr.id } })).rejects.toThrow(/STA-1 lineage/);
    const good = await prisma.order.create({ data: { ...data, attributionQrCodeId: a.qr.id } });
    await expect(prisma.order.update({ where: { id: good.id }, data: { vendorId: b.vendor.id } })).rejects.toThrow(/STA-1 lineage/);
    await expect(prisma.order.update({ where: { id: good.id }, data: { tenantId: tenantB } })).rejects.toThrow(/STA-1 lineage/);
    await prisma.order.update({ where: { id: good.id }, data: { attributionQrCodeId: null } });
  });
});
describe('parent moves preserve lineage rather than trusting a writable GUC', () => {
  it('a forged app.vendor_tenant_move setting cannot bypass the guard', async () => {
    const { vendor } = await fixture();
    await expect(prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SELECT set_config('app.vendor_tenant_move', $1, true)", vendor.id);
      await tx.vendor.update({ where: { id: vendor.id }, data: { tenantId: tenantB } });
    })).rejects.toThrow(/cannot change tenant while/i);
  });
  it('the supported move refuses non-QR store/financial dependencies without altering them', async () => {
    const { vendor } = await fixture();
    const c = await prisma.category.create({ data: { tenantId: tenantA, vendorId: vendor.id, name: 'Test', sortOrder: 0 } });
    await expect(prisma.$executeRawUnsafe('SELECT move_vendor_tenant($1, $2)', vendor.id, tenantB)).rejects.toThrow(/non-QR|cannot change tenant while/i);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: c.id } })).tenantId).toBe(tenantA);
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).tenantId).toBe(tenantA);
  });
  it('a supported QR-only move carries all four credit tables and keeps the ACTIVE sticker', async () => {
    const { vendor, qr } = await fixture();
    await prisma.scanDailyRollup.create({ data: { tenantId: tenantA, qrCodeId: qr.id, date: new Date(), decision: 'WEB_RENDER', count: 7 } });
    await prisma.scanEvent.create({ data: { tenantId: tenantA, qrCodeId: qr.id, decision: 'WEB_RENDER' } });
    await prisma.pendingAttribution.create({ data: { id: `${run}-move-pending`, tenantId: tenantA, qrCodeId: qr.id, destinationPath: '/store/test', platform: 'ios', fpHash: run, expiresAt: new Date(Date.now() + 60_000) } });
    await prisma.attributionClaim.create({ data: { tenantId: tenantA, installId: `${run}-move-claim`, qrCodeId: qr.id, platform: 'android', outcome: 'matched' } });
    await prisma.$executeRawUnsafe('SELECT move_vendor_tenant($1, $2)', vendor.id, tenantB);
    for (const table of ['scan_daily_rollups', 'scan_events', 'pending_attributions', 'attribution_claims']) {
      const rows = await prisma.$queryRawUnsafe<Array<{ tenantId: string }>>(`SELECT "tenantId" FROM "${table}" WHERE "qrCodeId" = $1`, qr.id);
      expect(rows, table).toEqual([{ tenantId: tenantB }]);
    }
    const found = await new QrService(prisma).findByShortCode(qr.shortCode);
    expect(found).toMatchObject({ status: 'ACTIVE', tenantId: tenantB, entity: { slug: vendor.slug, live: true } });
  });
  it('a QR parent cannot leave its credited rows in another tenant', async () => {
    const a = await fixture(), b = await fixture(tenantB);
    await prisma.scanDailyRollup.create({ data: { tenantId: tenantA, qrCodeId: a.qr.id, date: new Date(), decision: 'WEB_RENDER', count: 1 } });
    await expect(prisma.qrCode.update({ where: { id: a.qr.id }, data: { entityId: b.vendor.id, tenantId: tenantB, status: 'DEACTIVATED' } })).rejects.toThrow(/lineage|credit/i);
  });
  it('a QR parent cannot silently retarget order credit to another store in the same tenant', async () => {
    const a = await fixture(), b = await fixture();
    await prisma.order.create({ data: { tenantId: tenantA, orderNumber: `${run}-parent-order`, customerId: userId, vendorId: a.vendor.id, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', paymentMethod: 'CASH', subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 0, totalAmount: 1000, deliveryAddress: 'Test', deliveryLat: 6.8, deliveryLng: -58.15, attributionQrCodeId: a.qr.id } });
    await expect(prisma.qrCode.update({ where: { id: a.qr.id }, data: { entityId: b.vendor.id, status: 'DEACTIVATED' } })).rejects.toThrow(/lineage|credit/i);
  });
  it('an already-printed code cannot be retargeted even before its first credited scan', async () => {
    const a = await fixture(), b = await fixture();
    await expect(prisma.qrCode.update({ where: { id: a.qr.id }, data: { entityId: b.vendor.id, status: 'DEACTIVATED' } })).rejects.toThrow(/immutable|printed|lineage/i);
    expect((await prisma.qrCode.findUniqueOrThrow({ where: { id: a.qr.id } })).entityId).toBe(a.vendor.id);
  });
  it('concurrent child INSERT and vendor move cannot commit a mismatched pair', async () => {
    const { vendor, qr } = await fixture();
    await prisma.qrCode.delete({ where: { id: qr.id } });
    expect(await raceHeldChild(
      tx => tx.qrCode.create({ data: { ...qr, id: qr.id, createdAt: new Date() } }),
      tx => tx.vendor.update({ where: { id: vendor.id }, data: { tenantId: tenantB } }),
    )).toBe('refused');
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).tenantId).toBe(tenantA);
    expect((await prisma.qrCode.findUniqueOrThrow({ where: { id: qr.id } })).tenantId).toBe(tenantA);
  });
  it('a concurrent non-QR child cannot slip past the QR-only move dependency census', async () => {
    const { vendor, qr } = await fixture();
    await prisma.qrCode.delete({ where: { id: qr.id } });
    expect(await raceHeldChild(
      tx => tx.category.create({ data: { tenantId: tenantA, vendorId: vendor.id, name: 'Concurrent menu', sortOrder: 0 } }),
      tx => tx.$executeRawUnsafe('SELECT move_vendor_tenant($1, $2)', vendor.id, tenantB),
    )).toBe('refused');
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).tenantId).toBe(tenantA);
    expect((await prisma.category.findFirstOrThrow({ where: { vendorId: vendor.id } })).tenantId).toBe(tenantA);
  });
  it('a non-FK child INSERT cannot race either the supported move or a bare vendor UPDATE', async () => {
    for (const supported of [true, false]) {
      const { vendor, qr } = await fixture();
      await prisma.qrCode.delete({ where: { id: qr.id } });
      expect(await raceHeldChild(
        tx => tx.bookingException.create({ data: { tenantId: tenantA, vendorId: vendor.id, date: new Date() } }),
        tx => supported
          ? tx.$executeRawUnsafe('SELECT move_vendor_tenant($1, $2)', vendor.id, tenantB)
          : tx.vendor.update({ where: { id: vendor.id }, data: { tenantId: tenantB } }),
      )).toBe('refused');
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).tenantId).toBe(tenantA);
    }
  });
  it('tenant/target moves refuse snapshot isolation that could hide a concurrent child', async () => {
    const a = await fixture(), b = await fixture(tenantB);
    await prisma.qrCode.delete({ where: { id: b.qr.id } });
    await expect(prisma.$transaction(tx => tx.vendor.update({ where: { id: b.vendor.id }, data: { tenantId: tenantA } }), { isolationLevel: 'RepeatableRead' })).rejects.toThrow(/READ COMMITTED/i);
    await expect(prisma.$transaction(async tx => {
      await tx.vendor.update({ where: { id: a.vendor.id }, data: { tenantId: tenantB } });
      await tx.qrCode.update({ where: { id: a.qr.id }, data: { tenantId: tenantB } });
    }, { isolationLevel: 'RepeatableRead' })).rejects.toThrow(/READ COMMITTED/i);
  });
});

it('analytics excludes pre-migration cross-tenant credit rows on a valid code', async () => {
  const { vendor, qr } = await fixture();
  // The write wall is temporarily disabled in ONE transaction to reproduce
  // legacy corruption. The independent read-side boundary must still hold.
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('ALTER TABLE scan_events DISABLE TRIGGER scan_events_tenant_matches_code');
    await tx.$executeRawUnsafe('ALTER TABLE scan_daily_rollups DISABLE TRIGGER USER');
    await tx.scanEvent.create({ data: { tenantId: tenantB, qrCodeId: qr.id, decision: 'WEB_RENDER' } });
    await tx.scanDailyRollup.create({ data: { tenantId: tenantB, qrCodeId: qr.id, date: new Date(), decision: 'WEB_RENDER', count: 9 } });
    await tx.$executeRawUnsafe('ALTER TABLE scan_events ENABLE TRIGGER scan_events_tenant_matches_code');
    await tx.$executeRawUnsafe('ALTER TABLE scan_daily_rollups ENABLE TRIGGER USER');
  });
  const analytics = await new QrAnalyticsService(prisma).forVendor(vendor.id, 'all');
  expect(analytics.totals.scans).toBe(0);
  expect(analytics.totals.approxUniqueScanners).toBe(0);
  expect(analytics.byDay).toEqual([]);
});
