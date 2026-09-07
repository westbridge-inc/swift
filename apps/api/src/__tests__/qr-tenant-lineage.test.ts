import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { QrService } from '../modules/qr/qr.service';

// ---------------------------------------------------------------------------
// [REPORT-086 · PR1197-S1-04] A QR CODE AND ITS TARGET MUST LIVE IN ONE TENANT.
//
// `QrService.findByShortCode` looked the vendor up by `id` ALONE:
//
//     const vendor = await this.prisma.vendor.findUnique({ where: { id: qr.entityId }, … });
//
// The resolver is deliberately unauthenticated — a printed code names its own
// tenant — so nothing else bound the two together. A malformed or migrated row
// could pair tenant A's QR code with tenant B's storefront, and
// AttributionService persists that pairing: tenant A takes the credit for a
// scan that sent a customer to tenant B's shop, and the attribution ledger
// records something that never happened.
//
// Two independent controls, because either alone leaves a hole:
//   * the READ binds `id + tenantId` and validates `entityType`, so a corrupt
//     row that already exists resolves UNAVAILABLE — and, critically, never
//     discloses the foreign vendor's slug;
//   * a constraint TRIGGER refuses to write such a row at all.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const svc = new QrService(prisma);
const RUN = nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const code = (n: string) => `LIN${RUN.slice(0, 4).toUpperCase()}${n}`;

let tenantA = '', tenantB = '', vendorA = '', vendorB = '', slugB = '', ownerId = '';
const madeQr: string[] = [];

const tenant = async (suffix: string, isActive = true) => {
  const id = `lin-${RUN}-${suffix}`;
  await prisma.tenant.create({ data: { id, name: `Lineage ${suffix}`, slug: id, isActive } });
  return id;
};

beforeAll(async () => {
  tenantA = await tenant('a');
  tenantB = await tenant('b');
  const owner = await prisma.user.create({
    data: { phone: `+5926${String(Math.floor(Math.random() * 900000) + 100000)}`, firstName: 'Lin', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', tenantId: tenantA },
  });
  ownerId = owner.id;
  const vendorOwner = await prisma.vendorOwner.create({ data: { userId: owner.id } });
  const mk = async (tenantId: string, tag: string) => prisma.vendor.create({
    data: {
      tenantId, ownerId: vendorOwner.id, name: `Lineage ${tag}`, slug: `lineage-${RUN}-${tag}`, vendorType: 'RESTAURANT',
      status: 'ACTIVE', isVerified: true, addressLine1: '1 Lineage Road', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      phone: `+5926${String(Math.floor(Math.random() * 900000) + 100000)}`,
    },
    select: { id: true, slug: true },
  });
  const a = await mk(tenantA, 'a');
  const b = await mk(tenantB, 'b');
  vendorA = a.id; vendorB = b.id; slugB = b.slug;
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "qr_codes" WHERE "shortCode" LIKE 'LIN${RUN.slice(0, 4).toUpperCase()}%'`).catch(() => 0);
  await prisma.$executeRawUnsafe(`DELETE FROM "slug_redirects" WHERE "entityId" IN ($1, $2)`, vendorA, vendorB).catch(() => 0);
  await prisma.vendor.deleteMany({ where: { id: { in: [vendorA, vendorB] } } }).catch(() => {});
  if (ownerId) await prisma.vendorOwner.deleteMany({ where: { userId: ownerId } }).catch(() => {});
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {});
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } }).catch(() => {});
  await prisma.$disconnect();
});

/** Write a QR row straight past Prisma — the shape a migration or a hand fix makes. */
const rawQr = (opts: { id: string; tenantId: string; entityId: string; shortCode: string; entityType?: string }) =>
  prisma.$executeRawUnsafe(
    `INSERT INTO "qr_codes" ("id","tenantId","entityType","entityId","shortCode","slug","createdById") VALUES ($1,$2,$3::"QrEntityType",$4,$5,$6,$7)`,
    opts.id, opts.tenantId, opts.entityType ?? 'VENDOR', opts.entityId, opts.shortCode, 'provenance-only', ownerId,
  );

describe('[PR1197-S1-04] storage refuses a QR row whose target is in another tenant', () => {
  it('a cross-tenant QR row cannot be written at all', async () => {
    await expect(
      rawQr({ id: `x1-${RUN}`, tenantId: tenantA, entityId: vendorB, shortCode: code('X1') }),
    ).rejects.toThrow(/qr_target_tenant_mismatch/);
  });

  it('a QR row pointing at no vendor at all cannot be written', async () => {
    await expect(
      rawQr({ id: `x2-${RUN}`, tenantId: tenantA, entityId: `ghost-${RUN}`, shortCode: code('X2') }),
    ).rejects.toThrow(/qr_target_tenant_mismatch/);
  });

  it('a well-formed row is accepted — the control is narrow', async () => {
    await rawQr({ id: `ok-${RUN}`, tenantId: tenantA, entityId: vendorA, shortCode: code('OK') });
    madeQr.push(`ok-${RUN}`);
    const found = await svc.findByShortCode(code('OK'));
    expect(found?.entity?.slug).toBe(`lineage-${RUN}-a`);
  });

  it('UPDATING a good row into a cross-tenant one is refused too', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "qr_codes" SET "entityId" = $1 WHERE "id" = $2`, vendorB, `ok-${RUN}`),
    ).rejects.toThrow(/qr_target_tenant_mismatch/);
  });

  it('a slug redirect obeys the same rule', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "slug_redirects" ("id","tenantId","entityType","oldSlug","entityId") VALUES ($1,$2,'VENDOR',$3,$4)`,
        `r1-${RUN}`, tenantA, `old-${RUN}`, vendorB,
      ),
    ).rejects.toThrow(/qr_target_tenant_mismatch/);
  });
});

describe('[PR1197-S1-04] the resolver never discloses a foreign vendor', () => {
  it('a legacy cross-tenant row resolves UNAVAILABLE and leaks no slug', async () => {
    // The trigger cannot fix rows that predate it, so the READ must fail closed
    // independently. Written with the trigger disabled for one statement, which
    // is exactly the state a pre-migration row is in.
    await prisma.$executeRawUnsafe(`ALTER TABLE "qr_codes" DISABLE TRIGGER "qr_codes_tenant_lineage"`);
    try {
      await rawQr({ id: `legacy-${RUN}`, tenantId: tenantA, entityId: vendorB, shortCode: code('LG') });
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "qr_codes" ENABLE TRIGGER "qr_codes_tenant_lineage"`);
    }

    const found = await svc.findByShortCode(code('LG'));
    expect(found, 'the row itself still resolves — it is a real code').not.toBeNull();
    expect(found!.tenantId, 'and it still names ITS OWN tenant').toBe(tenantA);
    expect(found!.entity, 'but the foreign target is not resolved').toBeNull();
    expect(JSON.stringify(found), 'and nothing in the answer discloses the other tenant’s storefront').not.toContain(slugB);
  });

  it('an unsupported entityType resolves to nothing and never touches the vendor table', async () => {
    // `QrEntityType` has ONE value today, which is exactly when a polymorphic
    // read gets written without a type check and exactly when the second value
    // breaks it silently. The enum cannot hold another value yet, so the future
    // row is simulated at the client boundary — and the assertion that matters
    // is that the vendor table is never consulted for a type we cannot resolve.
    let vendorLookups = 0;
    const futureType = {
      qrCode: { findUnique: async () => ({ id: 'q1', tenantId: tenantA, shortCode: code('FT'), status: 'ACTIVE', supersededAt: null, version: 1, entityId: vendorB, entityType: 'MARKET_STALL' }) },
      vendor: { findFirst: async () => { vendorLookups += 1; return { slug: slugB, status: 'ACTIVE', isVerified: true, tenant: { isActive: true } }; } },
    } as unknown as PrismaClient;

    const found = await new QrService(futureType).findByShortCode(code('FT'));

    expect(found, 'the code row still resolves').not.toBeNull();
    expect(found!.entity, 'but an unresolvable type yields no entity').toBeNull();
    expect(vendorLookups, 'and the vendor table was never asked').toBe(0);
    expect(JSON.stringify(found)).not.toContain(slugB);
  });

  it('tenant deactivation is still authoritative', async () => {
    await prisma.tenant.update({ where: { id: tenantA }, data: { isActive: false } });
    try {
      const found = await svc.findByShortCode(code('OK'));
      expect(found?.entity?.live, 'a code in a deactivated tenant is not live').toBe(false);
    } finally {
      await prisma.tenant.update({ where: { id: tenantA }, data: { isActive: true } });
    }
  });
});
