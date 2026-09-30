import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { QrService } from '../modules/qr/qr.service';
import { AttributionService } from '../modules/qr/attribution.service';

// Execute only on the assigned synthetic namespace with the target lock.
// Do not install/heal DDL here: this grades the actual migration replay.
const prisma = new PrismaClient();
const contender = new PrismaClient();
const run = `qrrepair-${nanoid(10)}`;
let tenantA: string, tenantB: string, userId: string, ownerId: string;
let sequence = 0;

async function restricted<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE swift_app');
    await tx.$executeRawUnsafe("SELECT set_config('app.current_tenant', $1, true)", tenantA);
    const facts = await tx.$queryRaw<Array<{ role: string; superuser: boolean; bypass: boolean }>>`
      SELECT current_user::text AS role, rolsuper AS superuser, rolbypassrls AS bypass
      FROM pg_roles WHERE rolname = current_user`;
    expect(facts).toEqual([{ role: 'swift_app', superuser: false, bypass: false }]);
    return fn(tx);
  }, { timeout: 15_000 });
}

async function fixture() {
  const slug = `${run}-${sequence++}`;
  const vendor = await prisma.vendor.create({ data: { tenantId: tenantA, ownerId, name: 'Synthetic QR store', slug,
    vendorType: 'RESTAURANT', status: 'ACTIVE', isVerified: true, phone: `+592040${sequence.toString().padStart(4, '0')}`,
    addressLine1: 'Synthetic street', city: 'Synthetic city', region: 'Synthetic region', latitude: 6.8, longitude: -58.15 } });
  const qr = await new QrService(prisma).getOrCreateForVendor(vendor.id, userId);
  return { vendor, qr };
}

beforeAll(async () => {
  expect((await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`)[0]?.db).toBe('swift_test_qrrepair_20260930');
  const walls = await prisma.$queryRaw<Array<{ rel: string; enabled: boolean; forced: boolean }>>`
    SELECT relname AS rel, relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class
    WHERE oid IN ('booking_exceptions'::regclass, 'vendors'::regclass, 'qr_codes'::regclass, 'attribution_claims'::regclass)`;
  expect(walls).toHaveLength(4);
  expect(walls.every(w => w.enabled && w.forced)).toBe(true);
  tenantA = `${run}-a`; tenantB = `${run}-b`;
  for (const id of [tenantA, tenantB]) await prisma.tenant.create({ data: { id, name: 'Synthetic QR tenant', slug: id, kind: 'PRODUCTION' } });
  const user = await prisma.user.create({ data: { tenantId: tenantA, phone: `+592040${Date.now()}`, firstName: 'Synthetic', lastName: 'Test', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER' } });
  userId = user.id;
  ownerId = (await prisma.vendorOwner.create({ data: { userId } })).id;
});
afterAll(async () => {
  // Preserve synthetic red-state fixtures and immutable token evidence.
  await Promise.all([prisma.$disconnect(), contender.$disconnect()]);
});

describe('AX1: durable dependency lineage in both commit orderings', () => {
  it('refuses a stale old-tenant booking insert after a committed move', async () => {
    const { vendor } = await fixture();
    let resume!: () => void, resolved!: () => void;
    const ready = new Promise<void>(r => { resolved = r; });
    const hold = new Promise<void>(r => { resume = r; });
    const child = restricted(async tx => {
      // This is the authorized old-tenant read performed before insertion.
      expect(await tx.vendor.findUnique({ where: { id: vendor.id } })).not.toBeNull();
      resolved(); await hold;
      return tx.bookingException.create({ data: { tenantId: tenantA, vendorId: vendor.id, date: new Date('2026-10-01') } });
    });
    const result = child.then(() => 'accepted', error => {
      expect(String(error)).toMatch(/lineage|parent|tenant/i); return 'refused';
    });
    await ready;
    try {
      await contender.$executeRawUnsafe('SELECT move_vendor_tenant($1, $2)', vendor.id, tenantB);
      expect((await contender.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).tenantId).toBe(tenantB);
    } finally { resume(); }
    expect(await result).toBe('refused');
    expect(await prisma.bookingException.count({ where: { vendorId: vendor.id, tenantId: tenantA } })).toBe(0);
  });

  it('refuses the move when the old-tenant child commits first', async () => {
    const { vendor } = await fixture();
    let release!: () => void, inserted!: () => void;
    const ready = new Promise<void>(r => { inserted = r; });
    const hold = new Promise<void>(r => { release = r; });
    const child = restricted(async tx => {
      await tx.bookingException.create({ data: { tenantId: tenantA, vendorId: vendor.id, date: new Date('2026-10-02') } });
      inserted(); await hold;
    });
    await ready;
    let pid = 0, settled = false;
    const move = contender.$transaction(async tx => {
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      await tx.$executeRawUnsafe('SELECT move_vendor_tenant($1, $2)', vendor.id, tenantB);
    }, { timeout: 15_000 }).then(() => { settled = true; return 'accepted'; }, error => {
      settled = true; expect(String(error)).toMatch(/non-QR|lineage|cannot change tenant/i); return 'refused';
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!settled) {
        if (pid && (await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`)[0]?.blocked) break;
        if (Date.now() > deadline) throw new Error('Move never reached a database lock');
        await new Promise(r => setTimeout(r, 5));
      }
    } finally { release(); }
    await child;
    expect(await move).toBe('refused');
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).tenantId).toBe(tenantA);
  });

  it('refuses a dependency UPDATE that reattaches an old-tenant row after the target moves', async () => {
    const old = await fixture(), moved = await fixture();
    const block = await restricted(tx => tx.bookingException.create({ data: { tenantId: tenantA, vendorId: old.vendor.id, date: new Date('2026-10-03') } }));
    await contender.$executeRawUnsafe('SELECT move_vendor_tenant($1, $2)', moved.vendor.id, tenantB);
    await expect(restricted(tx => tx.bookingException.update({ where: { id: block.id }, data: { vendorId: moved.vendor.id } }))).rejects.toThrow(/lineage|parent|tenant/i);
  });
});

describe('AX2: printed token and surviving receipt cannot acquire a new identity', () => {
  it('refuses freeing a short code and assigning it to another same-tenant store', async () => {
    const a = await fixture(), b = await fixture();
    await expect(restricted(async tx => {
      await tx.$executeRawUnsafe('UPDATE qr_codes SET "shortCode"=$1 WHERE id=$2', `RESERVED${sequence}`, a.qr.id);
      await tx.$executeRawUnsafe('UPDATE qr_codes SET "shortCode"=$1 WHERE id=$2', a.qr.shortCode, b.qr.id);
    })).rejects.toThrow(/immutable|printed|token/i);
  });
  it('refuses primary-ID changes with a surviving non-FK receipt', async () => {
    const { qr } = await fixture();
    await prisma.attributionClaim.create({ data: { tenantId: tenantA, qrCodeId: qr.id, installId: `${run}-id-change`, platform: 'android', outcome: 'deterministic', destinationPath: '/store/synthetic' } });
    await expect(restricted(tx => tx.$executeRawUnsafe('UPDATE qr_codes SET id=$1 WHERE id=$2', `${run}-replacement-id`, qr.id))).rejects.toThrow(/immutable|printed|token/i);
  });
  it('refuses delete/recreate of the code ID and token for another store', async () => {
    const a = await fixture(), b = await fixture();
    await prisma.qrCode.update({ where: { id: b.qr.id }, data: { status: 'DEACTIVATED' } });
    const svc = new AttributionService(prisma), installId = `${run}-delete-recreate`;
    expect((await svc.claim(installId, 'android', `swift_qr=${a.qr.shortCode}`, { ip: '198.51.100.51', ua: undefined })).destination).toBe(`/store/${a.vendor.slug}`);
    await expect(restricted(async tx => {
      await tx.$executeRawUnsafe('DELETE FROM qr_codes WHERE id=$1', a.qr.id);
      await tx.qrCode.create({ data: { ...a.qr, entityId: b.vendor.id, slug: b.vendor.slug } });
    })).rejects.toThrow(/immutable|printed|token|tombstone/i);
    expect((await svc.claim(installId, 'android', undefined, { ip: '198.51.100.51', ua: undefined })).destination).toBe(`/store/${a.vendor.slug}`);
  });
});
