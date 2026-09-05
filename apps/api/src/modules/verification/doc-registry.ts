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
import type { PrismaClient, DocBucket, ValidatorScope } from '@prisma/client';
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
/**
 * [DOC-1 §6.9 · FD-DOC-6] Types in the always-review set by registry FACT (not by bucket rule):
 * the insurance certificate — covers_hire_and_reward is a wording judgement a model must not
 * make alone. PERSONAL types and anything needing a specimen are always-review by rule.
 */
export const ALWAYS_REVIEW_LEGACY_CODES: ReadonlySet<string> = new Set(['vehicle_insurance']);

export const registryCode = (countryCode: string, legacyCode: string) => `${countryCode}.${legacyCode}`;
const humanize = (code: string) => code.split('_').map((w) => (w === 'id' || w === 'tin' || w === 'gra' || w === 'gei' ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(' ');

export interface RegistrySeedResult { docTypes: number; requirementSets: number; requirementItems: number; validators: number }

export interface ValidatorRow {
  code: string;
  scope: ValidatorScope;
  isBlocking: boolean;
  /** The §8.5 reason a FAIL carries (P8-5 aliases these onto the legacy enum). */
  detailCode: string;
  /** Applies to one Guyana document class; absent = every type. */
  docTypeLegacy?: string;
  /** Implementation in validators.ts; absent = declared by the spec, not yet implemented. */
  implRef?: string;
}
/**
 * [DOC-1 §7.2–7.5] The 24 validators as the spec lists them — data. Blocking per the
 * spec's tables (WARN and routing rows are non-blocking). Only rows with an implRef
 * judge anything today; the rest wait for their implementation and no ACTIVE type may
 * depend on them (DOC-INV-2).
 */
export const VALIDATOR_CATALOGUE: readonly ValidatorRow[] = [
  // §7.2 field-level
  { code: 'V_MRZ_CHECKSUM', scope: 'FIELD', isBlocking: true, detailCode: 'SUSPECTED_ALTERATION' },
  { code: 'V_DATE_ORDER', scope: 'FIELD', isBlocking: true, detailCode: 'UNREADABLE_CAPTURE' },
  { code: 'V_NOT_EXPIRED', scope: 'FIELD', isBlocking: true, detailCode: 'EXPIRED_DOCUMENT' },
  { code: 'V_EXPIRY_PLAUSIBLE', scope: 'FIELD', isBlocking: false, detailCode: 'UNREADABLE_CAPTURE' },
  { code: 'V_DOB_ADULT', scope: 'FIELD', isBlocking: true, detailCode: 'REQUIREMENT_NOT_MET' },
  { code: 'V_TIN_FORMAT', scope: 'FIELD', isBlocking: true, detailCode: 'UNREADABLE_CAPTURE', docTypeLegacy: 'tin_certificate' },
  { code: 'V_PLATE_FORMAT', scope: 'FIELD', isBlocking: true, detailCode: 'UNREADABLE_CAPTURE' },
  { code: 'V_PLATE_CLASS', scope: 'FIELD', isBlocking: true, detailCode: 'WRONG_PLATE_CLASS' },
  { code: 'V_VEHICLE_COLOUR', scope: 'FIELD', isBlocking: true, detailCode: 'VEHICLE_COLOUR_NON_COMPLIANT' },
  { code: 'V_LICENCE_CLASS', scope: 'FIELD', isBlocking: true, detailCode: 'LICENCE_CLASS_MISMATCH' },
  { code: 'V_INSURANCE_SCOPE', scope: 'FIELD', isBlocking: true, detailCode: 'INSURANCE_SCOPE_INSUFFICIENT', docTypeLegacy: 'vehicle_insurance' },
  { code: 'V_FIELD_CONFIDENCE', scope: 'FIELD', isBlocking: false, detailCode: 'UNREADABLE_CAPTURE' },
  // §7.3 document-level
  { code: 'V_TYPE_MATCH', scope: 'DOCUMENT', isBlocking: true, detailCode: 'WRONG_DOCUMENT_TYPE' },
  { code: 'V_ALL_REQUIRED_PRESENT', scope: 'DOCUMENT', isBlocking: true, detailCode: 'UNREADABLE_CAPTURE', implRef: 'validators#V_ALL_REQUIRED_PRESENT' },
  { code: 'V_PAGE_COMPLETE', scope: 'DOCUMENT', isBlocking: true, detailCode: 'MISSING_PAGE' },
  { code: 'V_TAMPER_HEURISTIC', scope: 'DOCUMENT', isBlocking: false, detailCode: 'SUSPECTED_ALTERATION' },
  // §7.4 subject-level
  { code: 'V_NAME_CONSISTENCY', scope: 'SUBJECT', isBlocking: false, detailCode: 'NAME_MISMATCH' },
  { code: 'V_PLATE_CROSS_MATCH', scope: 'SUBJECT', isBlocking: true, detailCode: 'PLATE_CROSS_MISMATCH' },
  { code: 'V_SELF_REPORTED_MATCH', scope: 'SUBJECT', isBlocking: false, detailCode: 'DETAILS_DO_NOT_MATCH_ACCOUNT' },
  { code: 'V_REQUIREMENT_COMPLETE', scope: 'SUBJECT', isBlocking: true, detailCode: 'REQUIREMENT_NOT_MET' },
  // §7.5 cross-subject
  { code: 'V_SHA_COLLISION', scope: 'CROSS_SUBJECT', isBlocking: false, detailCode: 'DUPLICATE_ACROSS_ACCOUNTS', implRef: 'validators#V_SHA_COLLISION' },
  { code: 'V_NUMBER_COLLISION', scope: 'CROSS_SUBJECT', isBlocking: false, detailCode: 'DUPLICATE_ACROSS_ACCOUNTS' },
  { code: 'V_PHASH_NEAR', scope: 'CROSS_SUBJECT', isBlocking: false, detailCode: 'DUPLICATE_ACROSS_ACCOUNTS' },
  { code: 'V_VELOCITY', scope: 'CROSS_SUBJECT', isBlocking: false, detailCode: 'INTAKE_VELOCITY_EXCEEDED' },
];
/** Type-specific validators are declared against the Guyana registry class. */
export const VALIDATOR_HOME_COUNTRY = 'GY';

/**
 * Idempotent and RECONCILING: every catalogue row exists with the spec's facts (a
 * type-specific row waits for its type); a row the catalogue no longer declares is
 * removed — unless a field still names it, in which case it stays and the
 * completeness checker reports it as STALE_VALIDATOR. The registry is the catalogue,
 * not the catalogue plus whatever an older build left behind.
 */
export async function seedValidatorRegistry(prisma: PrismaClient): Promise<number> {
  let n = 0;
  for (const v of VALIDATOR_CATALOGUE) {
    const docTypeCode = v.docTypeLegacy ? registryCode(VALIDATOR_HOME_COUNTRY, v.docTypeLegacy) : null;
    if (docTypeCode && !(await prisma.docType.findUnique({ where: { code: docTypeCode }, select: { code: true } }))) continue;
    const facts = { scope: v.scope, isBlocking: v.isBlocking, detailCode: v.detailCode, implRef: v.implRef ?? null, docTypeCode };
    await prisma.validator.upsert({ where: { code: v.code }, create: { code: v.code, ...facts }, update: facts });
    n += 1;
  }
  const declared = VALIDATOR_CATALOGUE.map((v) => v.code);
  await prisma.validator.deleteMany({ where: { code: { notIn: declared }, fields: { none: {} } } });
  return n;
}

export type RegistryGapKind = 'UNPROFILED' | 'NO_FIELDS' | 'REQUIRED_FIELD_WITHOUT_VALIDATOR' | 'VALIDATOR_NOT_IMPLEMENTED' | 'IMPL_MISSING' | 'STALE_VALIDATOR';
export interface RegistryGap { docTypeCode: string; gap: RegistryGapKind; detail: string | null }

/**
 * [DOC-INV-2] What stands between the registry and the truth it claims: every ACTIVE
 * document type has an extraction profile, a field list, a validator on each required
 * field, and no blocking validator it depends on is a phantom; and no validator row
 * anywhere names an implementation that does not exist. Empty = complete.
 */
export async function registryCompletenessGaps(prisma: PrismaClient, resolves: (implRef: string | null) => boolean): Promise<RegistryGap[]> {
  const gaps: RegistryGap[] = [];
  const validators = await prisma.validator.findMany({ select: { code: true, docTypeCode: true, isBlocking: true, implRef: true } });
  for (const v of validators) if (v.implRef !== null && !resolves(v.implRef)) gaps.push({ docTypeCode: '*', gap: 'IMPL_MISSING', detail: `${v.code} → ${v.implRef}` });
  const declared = new Set(VALIDATOR_CATALOGUE.map((v) => v.code));
  for (const v of validators) if (!declared.has(v.code)) gaps.push({ docTypeCode: '*', gap: 'STALE_VALIDATOR', detail: v.code });
  const byCode = new Map(validators.map((v) => [v.code, v] as const));
  const active = await prisma.docType.findMany({ where: { isActive: true }, select: { code: true, extractionProfile: true, fields: { select: { fieldCode: true, isRequired: true, validatorRef: true } } } });
  for (const t of active) {
    if (t.extractionProfile === 'UNPROFILED') gaps.push({ docTypeCode: t.code, gap: 'UNPROFILED', detail: null });
    if (t.fields.length === 0) gaps.push({ docTypeCode: t.code, gap: 'NO_FIELDS', detail: null });
    for (const f of t.fields.filter((x) => x.isRequired)) {
      if (!f.validatorRef) { gaps.push({ docTypeCode: t.code, gap: 'REQUIRED_FIELD_WITHOUT_VALIDATOR', detail: f.fieldCode }); continue; }
      const v = byCode.get(f.validatorRef);
      if (!v || !resolves(v.implRef)) gaps.push({ docTypeCode: t.code, gap: 'VALIDATOR_NOT_IMPLEMENTED', detail: `${f.fieldCode} → ${f.validatorRef}` });
    }
    for (const v of validators) {
      if (!v.isBlocking || (v.docTypeCode !== null && v.docTypeCode !== t.code)) continue;
      if (!resolves(v.implRef)) gaps.push({ docTypeCode: t.code, gap: 'VALIDATOR_NOT_IMPLEMENTED', detail: v.code });
    }
  }
  return gaps;
}

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
          alwaysReview: ALWAYS_REVIEW_LEGACY_CODES.has(legacyCode),
        },
        update: { legacyCode, hasExpiry: validity !== undefined, defaultValidityDays: validity ?? null, alwaysReview: ALWAYS_REVIEW_LEGACY_CODES.has(legacyCode) },
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
  const validators = await seedValidatorRegistry(prisma);
  return { docTypes, requirementSets, requirementItems, validators };
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
