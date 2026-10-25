/**
 * [ROLE-DOCS · owner ruling 21 Oct 2026 ~16:05Z] The documents Swift no longer asks for, and what happens to the
 * copies it already holds.
 *
 *  - The lists: no CUSTOMER_L2 list (a customer's ID is `identity_l2` on its own, and a customer never gives a
 *    photo); no optional national ID for any vehicle partner (the driver's licence is photo ID; a bicycle rider
 *    still REQUIRES the ID); the optional police clearance is kept for TAXI drivers only.
 *  - The registry: no liquor-licence, pharmacy or NIS employer types, and no alcohol / pharmacy category gate
 *    (alcohol and every medicine are banned outright, GUARDRAILS §8).
 *  - Stored copies (prisma/migrations/20261021160000_role_docs_retired_documents): a delivery rider's police
 *    clearance and a vehicle partner's national ID are due at the next daily retention sweep; a retired licence is
 *    kept 90 days (the business window); GEI_LICENCE qualifications are deleted. Nothing purged, held, or a
 *    customer's own is touched, and a clock is never extended.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { runWithoutTenant } from '../plugins/tenant-context';
import { DEFAULT_DOCUMENT_CHECKLISTS, PLATFORM_CONFIG_VERSION } from '../modules/ops/platform-config';
import { CATEGORY_GATES, EXTRA_DOC_TYPES, FIELD_CATALOGUE, LICENCE_DISCLOSURE_TYPES, AUTO_APPROVE_EXPIRY_DAYS, RETIRED_DOC_TYPES, RETIRED_REGISTRY_LIST_KEYS, REGISTRY_EFFECTIVE_FROM, registryCode, seedDocRegistry } from '../modules/verification/doc-registry';
import { CountryConfigService, RETIRED_LIST_KEYS } from '../modules/country/country-config.service';

const MIGRATION = '20261021160000_role_docs_retired_documents';
const DAY = 86_400_000;
const phoneBase = 592_008_000_000 + Math.floor(Math.random() * 900_000);
const users: string[] = [];
let app: FastifyInstance;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'role-docs-removals-test');

/** The migration's statements, in order (comments stripped; the file has no semicolons inside a statement). */
function statements(file = 'migration.sql'): string[] {
  const sql = readFileSync(join(process.cwd(), 'prisma/migrations', MIGRATION, file), 'utf8');
  return sql.split(/;\s*\n/).map((chunk) => chunk.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  if (!app) return;
  await system(async () => {
    await app.prisma.serviceQualification.deleteMany({ where: { provider: { userId: { in: users } } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.docLegalHold.deleteMany({ where: { reason: { startsWith: 'role-docs-test' } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[ROLE-DOCS] the lists and the registry no longer ask for the removed documents', () => {
  it('no CUSTOMER_L2 list; no optional national ID for any mover; the optional police clearance is the taxi driver\'s only', () => {
    expect(DEFAULT_DOCUMENT_CHECKLISTS['CUSTOMER_L2']).toBeUndefined();
    expect(DEFAULT_DOCUMENT_CHECKLISTS['MOVER_OPTIONAL']).toBeUndefined();
    expect(DEFAULT_DOCUMENT_CHECKLISTS['MOVER_TAXI_EXTRA_OPTIONAL']).toEqual(['police_clearance']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['MOVER_NO_LICENCE']).toEqual(['national_id']);
    // a selfie is named by no list at all
    for (const [key, list] of Object.entries(DEFAULT_DOCUMENT_CHECKLISTS)) expect(list, key).not.toContain('selfie');
    // the change carries its own config version (production picks it up with the next owner-signed seed)
    // (2026-10-21.2 adds the own-name store lists on top: own-name-declaration.test.ts; 2026-10-22.1 the solar
    // installer's GEI licence: role-docs-trades.unit.test.ts)
    expect(PLATFORM_CONFIG_VERSION).toBe('2026-10-22.1');
  });

  it('no liquor licence, pharmacy authorisation or NIS registration is seeded, gated, disclosed or given an expiry', () => {
    for (const retired of ['liquor_licence', 'pharmacy_authorisation', 'nis_employer_reg']) {
      expect(EXTRA_DOC_TYPES.map((t) => t.legacyCode), retired).not.toContain(retired);
      expect(CATEGORY_GATES.map((g) => g.docType), retired).not.toContain(retired);
      expect(FIELD_CATALOGUE[retired], retired).toBeUndefined();
      expect(LICENCE_DISCLOSURE_TYPES, retired).not.toContain(retired);
      expect(AUTO_APPROVE_EXPIRY_DAYS[retired], retired).toBeUndefined();
    }
    expect(CATEGORY_GATES.some((g) => g.categorySlug === 'alcohol' || g.categorySlug === 'pharmacy')).toBe(false);
  });
});

describe('[ROLE-DOCS · COORD 24 Oct] a database seeded before the removal (staging, production) has its old liquor-licence row retired by the seed', () => {
  it('liquor, pharmacy and NIS are retired types: the registry still describes their stored copies, never as a requirement', () => {
    for (const retired of ['liquor_licence', 'pharmacy_authorisation', 'nis_employer_reg']) expect(RETIRED_DOC_TYPES, retired).toContain(retired);
  });

  it('the old row (annual printed expiry, as the earlier seed wrote it) reads no expiry after the seed, with no requirement and no gate', async () => {
    await system(async () => {
      await seedDocRegistry(app.prisma);
      const code = registryCode('GY', 'liquor_licence');
      // What staging and production hold today (CI's fresh database never has this row, so the test writes it).
      const old = { hasExpiry: true, defaultValidityDays: 365, expirySource: 'PRINTED' };
      if (await app.prisma.docType.findUnique({ where: { code }, select: { code: true } })) {
        await app.prisma.docType.update({ where: { code }, data: old });
      } else {
        const sibling = await app.prisma.docType.findFirstOrThrow({ where: { countryCode: 'GY', bucket: 'BUSINESS', NOT: { code } } });
        await app.prisma.docType.create({ data: { ...sibling, code, legacyCode: 'liquor_licence', displayName: 'Liquor licence', issuer: 'GRA / District Licensing Board', isActive: false, ...old } });
      }
      await seedDocRegistry(app.prisma);
      const row = await app.prisma.docType.findUniqueOrThrow({ where: { code }, include: { requirementItems: true, categoryGates: true } });
      expect({ hasExpiry: row.hasExpiry, defaultValidityDays: row.defaultValidityDays, expirySource: row.expirySource })
        .toEqual({ hasExpiry: false, defaultValidityDays: null, expirySource: 'NONE' });
      expect(row.requirementItems).toEqual([]);
      expect(row.categoryGates).toEqual([]);
    });
  });
});

describe('[ROLE-DOCS] production still holds the 2026-10-14.5 seed: its stored lists never bring the removed documents back', () => {
  it('a stored MOVER_OPTIONAL / CUSTOMER_L2 is ignored, and the taxi driver\'s optional police clearance comes from the code', async () => {
    expect([...RETIRED_LIST_KEYS].sort()).toEqual([...RETIRED_REGISTRY_LIST_KEYS].sort());
    await system(async () => {
      const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
      const before = gy.documentChecklists;
      // What production's stored copy looks like (the 2026-10-14.5 seed): the old optional lists, no taxi-only one.
      const old = { ...(before as Record<string, string[]>), MOVER_OPTIONAL: ['national_id', 'police_clearance'], CUSTOMER_L2: ['national_id', 'selfie'] };
      delete (old as Record<string, string[]>)['MOVER_TAXI_EXTRA_OPTIONAL'];
      await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: old } });
      try {
        const lists = new CountryConfigService(app.prisma);
        expect(await lists.getMoverOptionalDocuments('GY', 'MOTORCYCLE')).toEqual([]);
        expect(await lists.getMoverOptionalDocuments('GY', 'BICYCLE')).toEqual([]);
        expect(await lists.getMoverOptionalDocuments('GY', 'CAR')).toEqual(['police_clearance']);
        expect(await lists.getMoverChecklist('GY', 'BICYCLE')).toEqual(['national_id']);
        // [security review · fail closed] a stored row MISSING a required profile key gets the code's list, never [];
        // an explicit (signed) list still wins
        const missing = { ...old } as Record<string, string[]>;
        delete missing['MOVER_MOTOR'];
        await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: missing } });
        expect(await lists.getMoverChecklist('GY', 'MOTORCYCLE')).toEqual(['drivers_licence', 'vehicle_registration', 'vehicle_insurance']);
        await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: { ...missing, MOVER_MOTOR: ['drivers_licence'] } } });
        expect(await lists.getMoverChecklist('GY', 'MOTORCYCLE')).toEqual(['drivers_licence']);
        await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: old } });
        await seedDocRegistry(app.prisma);
        const sets = await app.prisma.requirementSet.findMany({ where: { countryCode: 'GY', effectiveFrom: REGISTRY_EFFECTIVE_FROM, actorRole: { in: ['CUSTOMER_L2', 'MOVER'] } }, include: { items: true } });
        expect(sets.find((x) => x.actorRole === 'CUSTOMER_L2')).toBeUndefined();
        expect(sets.find((x) => x.actorRole === 'MOVER')?.items ?? []).toEqual([]);
        expect(await app.prisma.requirementItem.count({ where: { requirementSet: { actorRole: 'MOVER_TAXI_EXTRA' }, docTypeCode: registryCode('GY', 'police_clearance'), isBlocking: false } })).toBe(1);
      } finally {
        await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: before as never } });
        await seedDocRegistry(app.prisma);
      }
    });
  }, 180_000); // two full registry seeds
});

async function person(profile: 'NONE' | 'BICYCLE' | 'MOTORCYCLE' | 'CAR' | 'MOTORCYCLE+CAR') {
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + users.length}`, firstName: 'Synthetic', lastName: `Retired${users.length}`,
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', countryCode: 'GY', isPhoneVerified: true,
  } });
  users.push(user.id);
  if (profile === 'BICYCLE' || profile === 'MOTORCYCLE' || profile === 'MOTORCYCLE+CAR') {
    await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: profile === 'BICYCLE' ? 'BICYCLE' : 'MOTORCYCLE', documentsVerified: false } });
  }
  if (profile === 'CAR' || profile === 'MOTORCYCLE+CAR') {
    await app.prisma.driver.create({ data: {
      userId: user.id, vehicleType: 'CAR', vehicleMake: 'Synthetic', vehicleModel: 'Car', vehicleYear: 2020, vehicleColor: 'Grey',
      licensePlate: `HD-${nanoid(6)}`, driverLicenseUrl: 'storage://synthetic/dl.jpg', vehicleInsuranceUrl: 'storage://synthetic/ins.jpg',
    } });
  }
  return user.id;
}

const doc = (userId: string, role: 'MOVER' | 'RIDER' | 'DRIVER' | 'CUSTOMER' | 'VENDOR_OWNER', docType: string, extra: Record<string, unknown> = {}) => app.prisma.verificationDocument.create({ data: {
  userId, role, docType, fileUrl: `verification/${userId}/${docType}-${nanoid(4)}.enc`, status: 'APPROVED', reviewedBy: 'test', reviewedAt: new Date(Date.now() - 40 * DAY),
  consentAt: new Date(), privacyNoticeVersion: 'v1', ...extra,
} });

describe('[ROLE-DOCS] the migration decides what happens to the copies already held', () => {
  it('clocks exactly the removed copies, never a needed, held, purged or customer one, and never extends a clock', async () => {
    await system(async () => {
      const rider = await person('MOTORCYCLE');
      const bicycle = await person('BICYCLE');
      const taxi = await person('CAR');
      const both = await person('MOTORCYCLE+CAR');
      const noProfile = await person('NONE');
      const provider = await person('NONE');
      const shopOwner = await person('NONE');
      const hold = await app.prisma.docLegalHold.create({ data: { subjectUserId: rider, reason: `role-docs-test ${nanoid(4)}`, ownerId: 'test', reviewBy: new Date(Date.now() + 30 * DAY), placedBy: 'test' } });
      const sooner = new Date(Date.now() + 5 * DAY);
      const d = {
        riderClearance: await doc(rider, 'MOVER', 'police_clearance'),
        riderClearanceRider: await doc(rider, 'RIDER', 'police_clearance'),
        riderNationalId: await doc(rider, 'MOVER', 'national_id'),
        riderLicence: await doc(rider, 'MOVER', 'drivers_licence', { expiresAt: new Date(Date.now() + 300 * DAY) }),
        bicycleNationalId: await doc(bicycle, 'MOVER', 'national_id'),
        bicycleClearance: await doc(bicycle, 'MOVER', 'police_clearance'),
        taxiClearance: await doc(taxi, 'MOVER', 'police_clearance'),
        taxiNationalId: await doc(taxi, 'DRIVER', 'national_id'),
        bothClearance: await doc(both, 'MOVER', 'police_clearance'),
        noProfileClearance: await doc(noProfile, 'MOVER', 'police_clearance'),
        noProfileNationalId: await doc(noProfile, 'MOVER', 'national_id'),
        providerClearance: await doc(provider, 'CUSTOMER', 'police_clearance'),
        providerNationalId: await doc(provider, 'CUSTOMER', 'national_id'),
        heldClearance: await doc(rider, 'MOVER', 'police_clearance', { legalHoldId: hold.id }),
        purgedNationalId: await doc(rider, 'MOVER', 'national_id', { purgedAt: new Date(Date.now() - DAY), fileUrl: '' }),
        soonerClearance: await doc(rider, 'MOVER', 'police_clearance', { retentionExpiresAt: new Date(Date.now() - 60_000) }),
        liquor: await doc(shopOwner, 'VENDOR_OWNER', 'liquor_licence'),
        liquorSooner: await doc(shopOwner, 'VENDOR_OWNER', 'liquor_licence', { retentionExpiresAt: sooner }),
        nis: await doc(shopOwner, 'VENDOR_OWNER', 'nis_employer_reg'),
        sanitary: await doc(shopOwner, 'VENDOR_OWNER', 'sanitary_certificate', { expiresAt: new Date(Date.now() + 300 * DAY) }),
        rejectedClearance: await doc(rider, 'MOVER', 'police_clearance', { status: 'REJECTED', retentionExpiresAt: new Date(Date.now() + 20 * DAY) }),
      };
      const sp = await app.prisma.serviceProvider.create({ data: { userId: provider, trade: 'electrician' } });
      const gei = await app.prisma.serviceQualification.create({ data: { providerId: sp.id, trade: 'electrician', type: 'GEI_LICENCE', referenceNumber: 'GEI-1', status: 'PENDING' } });
      const cvq = await app.prisma.serviceQualification.create({ data: { providerId: sp.id, trade: 'electrician', type: 'CVQ', referenceNumber: 'CVQ-1', status: 'PENDING' } });

      const ROLLBACK = new Error('role-docs-test rollback');
      const before = Date.now();
      await app.prisma.$transaction(async (tx) => {
        for (const statement of statements()) await tx.$executeRawUnsafe(statement);
        const clock = async (id: string) => (await tx.verificationDocument.findUniqueOrThrow({ where: { id }, select: { retentionExpiresAt: true } })).retentionExpiresAt;
        const dueNow = async (id: string) => {
          const at = await clock(id);
          expect(at, id).not.toBeNull();
          expect(at!.getTime(), id).toBeLessThanOrEqual(Date.now() + 1_000);
          expect(at!.getTime(), id).toBeGreaterThanOrEqual(before - 60_000);
        };
        // removed: a delivery rider's police clearance (any mover role), a vehicle partner's national ID
        await dueNow(d.riderClearance.id);
        await dueNow(d.riderClearanceRider.id);
        await dueNow(d.bicycleClearance.id);
        await dueNow(d.riderNationalId.id);
        await dueNow(d.taxiNationalId.id);
        // kept: the taxi driver's police clearance (taxi or rider+taxi), the bicycle rider's required ID,
        // anything of an account with no vehicle yet, a service provider's own (role CUSTOMER), a required licence
        for (const kept of [d.taxiClearance, d.bothClearance, d.bicycleNationalId, d.noProfileClearance, d.noProfileNationalId,
          d.providerClearance, d.providerNationalId, d.riderLicence, d.sanitary]) expect(await clock(kept.id), kept.docType).toBeNull();
        // never touched: a legal hold, an already-purged copy; an earlier clock is never pushed later
        expect(await clock(d.heldClearance.id)).toBeNull();
        expect(await clock(d.purgedNationalId.id)).toBeNull();
        expect((await clock(d.soonerClearance.id))!.getTime()).toBeLessThan(before);
        // retired licences: the business window, 90 days
        for (const retired of [d.liquor, d.nis]) {
          const at = (await clock(retired.id))!.getTime();
          expect(at, retired.docType).toBeGreaterThan(before + 89 * DAY);
          expect(at, retired.docType).toBeLessThan(Date.now() + 91 * DAY);
        }
        expect((await clock(d.liquorSooner.id))!.getTime()).toBe(sooner.getTime());
        // the duplicate GEI qualification is gone; other qualifications stay
        expect(await tx.serviceQualification.count({ where: { id: gei.id } })).toBe(0);
        expect(await tx.serviceQualification.count({ where: { id: cvq.id } })).toBe(1);
        // idempotent: a second run changes nothing it already decided
        const snapshot = await tx.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true, retentionExpiresAt: true }, orderBy: { id: 'asc' } });
        for (const statement of statements()) await tx.$executeRawUnsafe(statement);
        const again = await tx.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true, retentionExpiresAt: true }, orderBy: { id: 'asc' } });
        for (const [i, row] of snapshot.entries()) {
          const was = row.retentionExpiresAt?.getTime() ?? null; const now = again[i]!.retentionExpiresAt?.getTime() ?? null;
          if (was === null) expect(now, row.id).toBeNull(); else expect(now!, row.id).toBeLessThanOrEqual(was);
        }
        // [REVIEW-G S4] rollback.sql: a copy the reaper has not deleted goes back to "kept while active" (no clock);
        // a clock another rule set (a rejection) is never touched; the deleted qualification cannot come back.
        for (const statement of statements('rollback.sql')) await tx.$executeRawUnsafe(statement);
        for (const undone of [d.riderClearance, d.riderNationalId, d.taxiNationalId, d.liquor, d.nis]) expect(await clock(undone.id), undone.docType).toBeNull();
        expect(await clock(d.rejectedClearance.id)).not.toBeNull();
        expect(await tx.serviceQualification.count({ where: { id: gei.id } })).toBe(0);
        throw ROLLBACK;
      }, { timeout: 60_000 }).catch((err) => { if (err !== ROLLBACK) throw err; });
    });
  });
});
