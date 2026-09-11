import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { QrService } from '../modules/qr/qr.service';
import { TENANT_LINEAGE_TABLES, tenantLineageDdl, vendorTenantMoveDdl } from '../lib/tenant-rls';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';

grantSuiteCapability('ddl');

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

let tenantA = '', tenantB = '', vendorA = '', vendorB = '', slugB = '', ownerId = '', vendorMove = '';
// One ACTIVE code per (tenant, entityType, entity) is a partial unique index, so a
// block that mints its own code needs its own vendor — which is also what keeps
// these describes independent of each other's fixtures.
let vendorLive = '', vendorCredit = '';
// [review] The old fixture collapsed a nanoid into six digits and collided on
// `+5926777777` about 40% of the time; `User.phone` is unique, so a leftover row
// from a crashed run took the WHOLE file down with an afterAll TypeError that
// hid the real cause. Full random range, and the row is cleared first.
const ownerPhone = `+5926${String(Math.floor(Math.random() * 900000) + 100000)}${String(Date.now()).slice(-4)}`;

const tenant = async (suffix: string) => {
  const id = `lin-${RUN}-${suffix}`;
  await prisma.tenant.create({ data: { id, name: `Lineage ${suffix}`, slug: id, isActive: true } });
  return id;
};

beforeAll(async () => {
  // [PR1197-S1-04 review] The lineage triggers live in a migration, and a
  // db-push environment has never run it. The house contract (tenant-rls.ts:
  // "Mirrors the migration text; the test installer heals db-push environments")
  // is that the suite installs its own DDL rather than assuming a migrated
  // database — otherwise this file passes in CI and silently tests nothing on a
  // fresh dev machine.
  // Only THIS suite's rules. `tenantLineageDdl()` unfiltered is 28 rules x 3
  // statements, each autocommitted by installDdl — so between every
  // DROP TRIGGER and its CREATE, that table's lineage guard is OFF for every
  // other session on the shared database. The advisory lock serialises
  // installers, not the suites writing rows, so a sibling suite's
  // deliberately-mismatched INSERT can succeed in the window and read as a
  // false green. Every other lineage-installing suite filters; this one did not.
  const LINEAGE_TABLES = ['qr_codes', 'slug_redirects', 'pending_attributions', 'attribution_claims', 'scan_events'];
  await installDdl(prisma, tenantLineageDdl().filter((s) => LINEAGE_TABLES.some((t) => s.includes(`${t}_tenant_matches`))));
  await installDdl(prisma, vendorTenantMoveDdl());
  await prisma.user.deleteMany({ where: { phone: ownerPhone } }).catch(() => {});
  tenantA = await tenant('a');
  tenantB = await tenant('b');
  const owner = await prisma.user.create({
    data: { phone: ownerPhone, firstName: 'Lin', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', tenantId: tenantA },
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
  vendorLive = (await mk(tenantA, 'live')).id;
  vendorCredit = (await mk(tenantA, 'credit')).id;
  // [PR1197-S1-04 review] Its OWN vendor. The move block used to call
  // getOrCreateForVendor(vendorA), which returned the row block 1 had inserted —
  // the cross-block dependency a previous review raised and the fix commit
  // claimed to have removed.
  vendorMove = (await mk(tenantA, 'move')).id;
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "qr_codes" WHERE "shortCode" LIKE 'LIN${RUN.slice(0, 4).toUpperCase()}%'`).catch(() => 0);
  await prisma.$executeRawUnsafe(`DELETE FROM "slug_redirects" WHERE "entityId" IN ($1, $2)`, vendorA, vendorB).catch(() => 0);
  await prisma.vendor.deleteMany({ where: { id: { in: [vendorA, vendorB, vendorLive, vendorCredit] } } }).catch(() => {});
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
    ).rejects.toThrow(/STA-1 lineage/);
  });

  it('a QR row pointing at no vendor at all cannot be written', async () => {
    await expect(
      rawQr({ id: `x2-${RUN}`, tenantId: tenantA, entityId: `ghost-${RUN}`, shortCode: code('X2') }),
    ).rejects.toThrow(/STA-1 lineage/);
  });

  it('a well-formed row is accepted — the control is narrow', async () => {
    await rawQr({ id: `ok-${RUN}`, tenantId: tenantA, entityId: vendorA, shortCode: code('OK') });
    const found = await svc.findByShortCode(code('OK'));
    expect(found?.entity?.slug).toBe(`lineage-${RUN}-a`);
  });

  it('UPDATING a good row into a cross-tenant one is refused too', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "qr_codes" SET "entityId" = $1 WHERE "id" = $2`, vendorB, `ok-${RUN}`),
    ).rejects.toThrow(/STA-1 lineage/);
  });

  it('a slug redirect obeys the same rule', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "slug_redirects" ("id","tenantId","entityType","oldSlug","entityId") VALUES ($1,$2,'VENDOR',$3,$4)`,
        `r1-${RUN}`, tenantA, `old-${RUN}`, vendorB,
      ),
    ).rejects.toThrow(/STA-1 lineage/);
  });
});

describe('[PR1197-S1-04] the resolver never discloses a foreign vendor', () => {
  it('a legacy cross-tenant row resolves UNAVAILABLE and leaks no slug', async () => {
    // The trigger cannot fix rows that predate it, so the READ must fail closed
    // independently. A pre-migration row is written with the trigger off — but
    // [review] `ALTER TABLE ... DISABLE TRIGGER` autocommits and is visible to
    // EVERY session, so a worker killed between the disable and the re-enable
    // would leave the shared test database unprotected for every other suite.
    // Inside one transaction the DDL rolls back with everything else.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "qr_codes" DISABLE TRIGGER "qr_codes_tenant_matches_vendor"`);
      await tx.$executeRawUnsafe(
        `INSERT INTO "qr_codes" ("id","tenantId","entityType","entityId","shortCode","slug","createdById") VALUES ($1,$2,$3::"QrEntityType",$4,$5,$6,$7)`,
        `legacy-${RUN}`, tenantA, 'VENDOR', vendorB, code('LG'), 'provenance-only', ownerId,
      );
      await tx.$executeRawUnsafe(`ALTER TABLE "qr_codes" ENABLE TRIGGER "qr_codes_tenant_matches_vendor"`);
    });

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
    // [review] This used to read a row another describe block created, so in
    // isolation it failed and under an unrelated mutation it went red as
    // collateral — a poor localiser. It mints its own row now.
    await rawQr({ id: `live-${RUN}`, tenantId: tenantA, entityId: vendorLive, shortCode: code('LV') });
    expect((await svc.findByShortCode(code('LV')))?.entity?.live, 'live while the tenant is active').toBe(true);

    await prisma.tenant.update({ where: { id: tenantA }, data: { isActive: false } });
    try {
      const found = await svc.findByShortCode(code('LV'));
      expect(found?.entity?.live, 'a code in a deactivated tenant is not live').toBe(false);
    } finally {
      await prisma.tenant.update({ where: { id: tenantA }, data: { isActive: true } });
    }
  });
});

// ---------------------------------------------------------------------------
// [review finding 4] THE CREDIT IS RECORDED IN THREE OTHER TABLES.
//
// The first version of this fix guarded `qr_codes` and `slug_redirects` only —
// while the harm it describes, tenant A being credited for tenant B's customer,
// is written to `pending_attributions`, `attribution_claims` and `scan_events`.
// All three accepted a cross-tenant row. Closing two of five doors is not
// closing the boundary.
// ---------------------------------------------------------------------------
describe('[PR1197-S1-04] the tables that record the CREDIT obey the same rule', () => {
  it('every attribution table is registered in the lineage wall, not hand-rolled', () => {
    const registered = TENANT_LINEAGE_TABLES.map((r) => r.table);
    for (const t of ['qr_codes', 'slug_redirects', 'pending_attributions', 'attribution_claims', 'scan_events']) {
      expect(registered, `${t} must be in TENANT_LINEAGE_TABLES`).toContain(t);
    }
  });

  it('a scan event cannot credit a tenant that does not own the code', async () => {
    await rawQr({ id: `cred-${RUN}`, tenantId: tenantA, entityId: vendorCredit, shortCode: code('CR') });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "scan_events" ("id","tenantId","qrCodeId","decision") VALUES ($1,$2,$3,'WEB_RENDER')`,
        `se-${RUN}`, tenantB, `cred-${RUN}`,
      ),
    ).rejects.toThrow(/STA-1 lineage/);
  });

  it('a pending attribution cannot credit a tenant that does not own the code', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "pending_attributions" ("id","tenantId","qrCodeId","destinationPath","platform","fpHash","expiresAt") VALUES ($1,$2,$3,'/store/x','ios',$4,now() + interval '1 hour')`,
        `pa-${RUN}`, tenantB, `cred-${RUN}`, `fp-${RUN}`,
      ),
    ).rejects.toThrow(/STA-1 lineage/);
  });

  it('a row with NO code is not held to a lineage it does not have', async () => {
    // `qrCodeId` is nullable on two of these tables: a scan or a claim can
    // legitimately exist without a code, and that must stay writable — a guard
    // that refuses honest rows gets switched off, and then guards nothing.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "scan_events" ("id","tenantId","decision") VALUES ($1,$2,'WEB_RENDER')`,
      `se-nocode-${RUN}`, tenantB,
    );
    const row = await prisma.$queryRawUnsafe<Array<{ tenantId: string }>>(
      `SELECT "tenantId" FROM "scan_events" WHERE id = $1`, `se-nocode-${RUN}`,
    );
    expect(row[0]?.tenantId).toBe(tenantB);
  });
});

// ---------------------------------------------------------------------------
// [review finding 1] A PRINTED CODE MUST NOT SILENTLY DIE.
//
// Binding the resolver to `id + tenantId` is right, but on its own it turned a
// cross-tenant DISCLOSURE into a permanent, silent OUTAGE: a vendor moved
// between tenants kept its old code, `getOrCreateForVendor` matched on
// entityId alone and handed the same dead code back forever, and every scan
// resolved to nothing. Worse than what it replaced.
// ---------------------------------------------------------------------------
describe('[PR1197-S1-04] a vendor cannot walk away from its printed codes', () => {
  const restore = async () => {
    await prisma.$executeRawUnsafe(`SELECT move_vendor_tenant($1, $2)`, vendorMove, tenantA);
    await prisma.$executeRawUnsafe(`DELETE FROM "qr_codes" WHERE "entityId" = $1 AND "tenantId" = $2`, vendorMove, tenantB);
  };

  it('REFUSES an unaccompanied move — the statement that used to strand every sticker', async () => {
    const minted = await svc.getOrCreateForVendor(vendorMove, ownerId);
    expect(minted.tenantId).toBe(tenantA);
    await expect(
      prisma.vendor.update({ where: { id: vendorMove }, data: { tenantId: tenantB } }),
      'a bare UPDATE of vendors.tenantId must not be allowed to leave lineage rows behind',
    ).rejects.toThrow(/cannot change tenant while/i);
    // ...and the vendor did not move.
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorMove }, select: { tenantId: true } });
    expect(v.tenantId).toBe(tenantA);
  });

  it('the supported move carries the printed code with it — the sticker keeps working', async () => {
    const minted = await svc.getOrCreateForVendor(vendorMove, ownerId);
    expect((await svc.findByShortCode(minted.shortCode))?.entity).not.toBeNull();
    try {
      await prisma.$executeRawUnsafe(`SELECT move_vendor_tenant($1, $2)`, vendorMove, tenantB);

      // THE POINT OF THE WHOLE CHANGE. A sticker already on a shop window
      // resolves after the move. The first attempt at this fix turned a
      // cross-tenant disclosure into a permanent dead code, which is worse.
      const resolved = await svc.findByShortCode(minted.shortCode);
      expect(resolved?.entity, 'the ALREADY-PRINTED code still resolves after the move').not.toBeNull();
      const row = await prisma.qrCode.findUniqueOrThrow({ where: { id: minted.id }, select: { tenantId: true, status: true } });
      expect(row.tenantId, 'the code moved with its vendor').toBe(tenantB);
      expect(row.status, 'and it is still the live code, not deactivated history').toBe('ACTIVE');
    } finally {
      await restore();
    }
  });

  it('leaves no row of any credit table behind in the old tenant', async () => {
    const minted = await svc.getOrCreateForVendor(vendorMove, ownerId);
    await prisma.scanEvent.create({ data: { tenantId: tenantA, qrCodeId: minted.id, decision: 'WEB_RENDER' } }).catch(() => {});
    try {
      await prisma.$executeRawUnsafe(`SELECT move_vendor_tenant($1, $2)`, vendorMove, tenantB);
      const stranded = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT (SELECT count(*) FROM qr_codes WHERE "entityId" = $1 AND "tenantId" = $2)
              + (SELECT count(*) FROM scan_events s JOIN qr_codes q ON q.id = s."qrCodeId" WHERE q."entityId" = $1 AND s."tenantId" = $2)::bigint AS n`,
        vendorMove, tenantA,
      );
      expect(Number(stranded[0]!.n), 'a row left in the old tenant is a row the resolver can never see').toBe(0);
    } finally {
      await restore();
    }
  });
});
