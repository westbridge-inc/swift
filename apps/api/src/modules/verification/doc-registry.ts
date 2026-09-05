/**
 * [DOC-1 §4.2] The document registry — data, not code — and the one place the
 * checklist facade reads it from.
 *
 * REUSE / REWIRE, never a parallel system (§10): the registry is seeded FROM
 * the country checklists that already exist (CountryConfig.documentChecklists)
 * and the facade keeps returning exactly those lists until a requirement set's
 * document types are ACTIVE — which needs `legalFactsVerifiedAt` (a CHECK).
 * Every seeded row is therefore inactive and PROVISIONAL: bucket, issuer,
 * retention and AML class are the agent's best reading, flagged as such in
 * `legalFactsSourceNote`, to be verified by the founder / attorney and
 * activated by a migration that inserts facts, not by code.
 */
import type { PrismaClient, DocBucket } from '@prisma/client';
import { AUTO_APPROVE_EXPIRY_DAYS } from './verification.service';

export const REGISTRY_TIER = 'STANDARD';
/** Provisional. The onboarding spec these checklists were built to is dated 2026-06. */
export const REGISTRY_EFFECTIVE_FROM = new Date('2026-06-01T00:00:00.000Z');
/** Provisional (FD-DOC-4: 7 years from relationship end, recorded for BUSINESS; applied to all pending a PERSONAL ruling). */
export const PROVISIONAL_RETENTION_DAYS = 2555;
export const PROVISIONAL_NOTE =
  'PROVISIONAL — seeded from CountryConfig.documentChecklists by the agent; bucket/issuer/retention/AML are unverified readings. Activate only by a migration that records legal facts (DOC-1 §4.2, founder-inputs FD-DOC-3b/4).';

/** The agent's reading of each checklist key. Unknown keys are PERSONAL — the most restrictive bucket. */
export const BUCKET_OF: Readonly<Record<string, DocBucket>> = {
  national_id: 'PERSONAL', owner_national_id: 'PERSONAL', selfie: 'PERSONAL', police_clearance: 'PERSONAL',
  drivers_licence: 'PERSONAL', gei_electrical_licence: 'PERSONAL', food_handler_cert: 'PERSONAL',
  business_registration: 'BUSINESS', tin_certificate: 'BUSINESS', gra_restaurant_licence: 'BUSINESS', storefront_photo: 'BUSINESS',
  vehicle_registration: 'VEHICLE', vehicle_insurance: 'VEHICLE', hire_car_permit: 'VEHICLE', vehicle_plate_photo: 'VEHICLE',
  vehicle_exterior_photo: 'VEHICLE', fitness_cert: 'VEHICLE', road_service_licence: 'VEHICLE',
};
const SUBJECT_OF: Record<DocBucket, 'PERSON' | 'BUSINESS' | 'VEHICLE'> = { PERSONAL: 'PERSON', BUSINESS: 'BUSINESS', VEHICLE: 'VEHICLE' };

export const registryCode = (countryCode: string, legacyCode: string) => `${countryCode}.${legacyCode}`;
const humanize = (code: string) => code.split('_').map((w) => (w === 'id' || w === 'tin' || w === 'gra' || w === 'gei' ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(' ');

export interface RegistrySeedResult { docTypes: number; requirementSets: number; requirementItems: number }

/** Idempotent: upserts every document class and requirement set the country checklists describe. */
export async function seedDocRegistry(prisma: PrismaClient): Promise<RegistrySeedResult> {
  const countries = await prisma.countryConfig.findMany({ select: { code: true, documentChecklists: true } });
  let docTypes = 0; let requirementSets = 0; let requirementItems = 0;
  for (const c of countries) {
    const lists = (c.documentChecklists ?? {}) as Record<string, string[]>;
    const legacyCodes = [...new Set(Object.values(lists).flat())];
    for (const legacyCode of legacyCodes) {
      const bucket = BUCKET_OF[legacyCode] ?? 'PERSONAL';
      const validity = AUTO_APPROVE_EXPIRY_DAYS[legacyCode];
      await prisma.docType.upsert({
        where: { code: registryCode(c.code, legacyCode) },
        create: {
          code: registryCode(c.code, legacyCode), countryCode: c.code, legacyCode, displayName: humanize(legacyCode),
          bucket, subjectKind: SUBJECT_OF[bucket], issuer: 'UNVERIFIED (legal facts pending)',
          imagePolicy: 'PERSIST', persistRetentionDays: PROVISIONAL_RETENTION_DAYS,
          hasExpiry: validity !== undefined, defaultValidityDays: validity ?? null, expirySource: validity !== undefined ? 'PRINTED' : 'NONE',
          extractionProfile: 'UNPROFILED', externalProcessingAllowed: false, legalFactsSourceNote: PROVISIONAL_NOTE, isActive: false,
        },
        update: { legacyCode, hasExpiry: validity !== undefined, defaultValidityDays: validity ?? null },
      });
      docTypes += 1;
    }
    for (const [actorRole, codes] of Object.entries(lists)) {
      const set = await prisma.requirementSet.upsert({
        where: { countryCode_actorRole_tier_effectiveFrom: { countryCode: c.code, actorRole, tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM } },
        create: { countryCode: c.code, actorRole, tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM },
        update: {},
      });
      requirementSets += 1;
      for (const [i, legacyCode] of codes.entries()) {
        await prisma.requirementItem.upsert({
          where: { requirementSetId_docTypeCode: { requirementSetId: set.id, docTypeCode: registryCode(c.code, legacyCode) } },
          create: { requirementSetId: set.id, docTypeCode: registryCode(c.code, legacyCode), isBlocking: true, minCount: 1, sortOrder: i },
          update: { sortOrder: i },
        });
        requirementItems += 1;
      }
    }
  }
  return { docTypes, requirementSets, requirementItems };
}

/**
 * The registry's answer for (country, role) — or null when the registry does
 * not yet speak for it: no requirement set in effect today, or any of its
 * document types still inactive (legal facts unverified). The facade falls
 * back to the JSON on null, so behaviour is unchanged until activation.
 */
export async function registryChecklist(prisma: PrismaClient, countryCode: string, actorRole: string, now = new Date()): Promise<string[] | null> {
  const set = await prisma.requirementSet.findFirst({
    where: {
      countryCode, actorRole, tier: REGISTRY_TIER,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    include: { items: { include: { docType: { select: { legacyCode: true, isActive: true } } }, orderBy: { sortOrder: 'asc' } } },
  });
  if (!set || set.items.length === 0) return null;
  if (!set.items.every((i) => i.docType.isActive)) return null;
  return set.items.map((i) => i.docType.legacyCode);
}
