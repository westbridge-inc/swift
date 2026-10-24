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
import type { PrismaClient, DocBucket, ValidatorScope, GateEnforcement, DiscoveryCategoryKind, DocImagePolicy } from '@prisma/client';
import { DEFAULT_DOCUMENT_CHECKLISTS } from '../ops/platform-config';
import { isProduction } from '../../utils/runtime-mode';

export const REGISTRY_TIER = 'STANDARD';
/** [ROLE-DOCS · owner 21 Oct 2026] Lists retired by the owner (country-config RETIRED_LIST_KEYS says the same; a test
 *  keeps them equal). Kept here too so the registry never imports the country service. */
export const RETIRED_REGISTRY_LIST_KEYS: ReadonlySet<string> = new Set(['MOVER_OPTIONAL', 'CUSTOMER_L2']);
/** Provisional. The onboarding spec these checklists were built to is dated 2026-06. */
export const REGISTRY_EFFECTIVE_FROM = new Date('2026-06-01T00:00:00.000Z');
/** [R24 · research C4] A persisted (vehicle / business) image is kept while the relationship is
 *  active and 90 days after it ends: "7 years has no basis I found". Was 2555 (FD-DOC-4, provisional).
 *  An AML-classed type still gets its seven years (retention-policy). */
export const PROVISIONAL_RETENTION_DAYS = 90;
/** The window provisional rows were seeded with before R24; reconcileImagePolicy moves them. */
export const LEGACY_PROVISIONAL_RETENTION_DAYS = 2555;

/**
 * [DOC-1 §1.3 · P1-3] The bucket decides what happens to the image: PERSONAL images are
 * purged after review (verify → extract → hash → destroy → receipt), VEHICLE images
 * persist redacted, BUSINESS images persist. Seeded onto every PROVISIONAL registry row
 * (legal facts not yet verified); a row whose legal facts were verified keeps whatever
 * they set. `persist_needs_retention` (CHECK): a purge policy carries no retention days.
 */
export const IMAGE_POLICY_OF_BUCKET: Readonly<Record<DocBucket, DocImagePolicy>> = {
  PERSONAL: 'PURGE_AFTER_REVIEW',
  BUSINESS: 'PERSIST',
  VEHICLE: 'PERSIST_REDACTED',
};
export const retentionFor = (policy: DocImagePolicy): number | null => (policy === 'PURGE_AFTER_REVIEW' ? null : PROVISIONAL_RETENTION_DAYS);

/** Reconcile provisional rows to the bucket doctrine — never a row whose legal facts were verified.
 *  [R24] A provisional row still on the pre-R24 window (2555 days) takes the current one at the
 *  next boot (the seed's update never touches the days). Any other value was set on purpose. */
export async function reconcileImagePolicy(prisma: PrismaClient, countryCode?: string): Promise<number> {
  let changed = 0;
  for (const bucket of Object.keys(IMAGE_POLICY_OF_BUCKET) as DocBucket[]) {
    const imagePolicy = IMAGE_POLICY_OF_BUCKET[bucket];
    const persistRetentionDays = retentionFor(imagePolicy);
    const r = await prisma.docType.updateMany({
      where: {
        ...(countryCode ? { countryCode } : {}), bucket, legalFactsVerifiedAt: null,
        OR: [
          { imagePolicy: { not: imagePolicy } },
          ...(persistRetentionDays === null ? [] : [{ imagePolicy, persistRetentionDays: LEGACY_PROVISIONAL_RETENTION_DAYS }]),
        ],
      },
      data: { imagePolicy, persistRetentionDays },
    });
    changed += r.count;
  }
  return changed;
}
export const PROVISIONAL_NOTE =
  'PROVISIONAL — seeded from CountryConfig.documentChecklists by the agent; bucket/issuer/retention/AML are unverified readings. Activate only by a migration that records legal facts (DOC-1 §4.2, founder-inputs FD-DOC-3b/4).';

/** The agent's reading of each checklist key. Unknown keys are PERSONAL — the most restrictive bucket. */
export const BUCKET_OF: Readonly<Record<string, DocBucket>> = {
  national_id: 'PERSONAL', owner_national_id: 'PERSONAL', selfie: 'PERSONAL', police_clearance: 'PERSONAL',
  drivers_licence: 'PERSONAL', gei_electrical_licence: 'PERSONAL', food_handler_cert: 'PERSONAL',
  business_registration: 'BUSINESS', tin_certificate: 'BUSINESS', gra_restaurant_licence: 'BUSINESS', storefront_photo: 'BUSINESS',
  vehicle_registration: 'VEHICLE', vehicle_insurance: 'VEHICLE', hire_car_permit: 'VEHICLE', vehicle_plate_photo: 'VEHICLE',
  vehicle_exterior_photo: 'VEHICLE', fitness_cert: 'VEHICLE', road_service_licence: 'VEHICLE',
  // [VERIFY-DOCS · ruling 8, 6 Oct 2026] The two licences that replace `hire_car_permit`: the PERSON's
  // Hire Car Driver's Licence (s.80) and the CAR's yearly hire licence (s.79, exhibited on the car).
  hire_car_driver_licence: 'PERSONAL', hire_car_vehicle_licence: 'VEHICLE',
  // [DOC-1 §18.1] the addendum's Guyana types (seeded by EXTRA_DOC_TYPES, not by any checklist)
  sanitary_certificate: 'BUSINESS', trade_licence: 'BUSINESS', digital_id: 'PERSONAL',
  // [ROLE-DOCS · owner 21 Oct 2026] RETIRED: nothing asks for these any more (alcohol and every medicine are
  // banned outright, GUARDRAILS §8; NIS registration is not Swift's concern). The bucket stays so a copy
  // already stored keeps its retention class until the migration's clock deletes it.
  liquor_licence: 'BUSINESS', pharmacy_authorisation: 'BUSINESS', nis_employer_reg: 'BUSINESS',
  // [DOC-1 §3.2 · P3-2] the unregistered trader's signed self-declaration (versioned, hashed, consent-ledger row)
  self_declaration_unregistered: 'BUSINESS',
  // [ROLE-DOCS · owner 21 Oct 2026] the signed "I trade under my own name" declaration (vendor/own-name.ts)
  own_name_declaration: 'BUSINESS',
  // [TRADES · 13 Oct 2026; R15] service-trade documents: a person's licence is PERSONAL; a premises
  // certificate is BUSINESS and always reviewed by a person (ALWAYS_REVIEW_LEGACY_CODES).
  pest_control_operator_licence: 'PERSONAL', pesticide_applicator_certificate: 'PERSONAL',
  eating_house_registration: 'BUSINESS',
};

/** Auto-approved documents must still LAPSE (the "verified ≠ valid now" rule).
 *  A human reviewer keys the real printed expiry; the automatic path applies a
 *  conservative default so the daily sweep + reminders always have a date.
 *  Days by docType; absent = non-expiring (e.g. business registration).
 *
 *  This is registry policy, so it lives with the registry instead of importing
 *  the verification service back into this module. Keeping the dependency one
 *  way prevents registry consumers from initializing through a service cycle.
 */
export const AUTO_APPROVE_EXPIRY_DAYS: Readonly<Record<string, number>> = {
  police_clearance: 365,   // Certificate of Character — commonly re-issued yearly
  fitness_cert: 365,       // annual fitness
  vehicle_insurance: 365,  // annual policy
  hire_car_permit: 365,    // annual occupational permit (replaced by the two below; kept for approvals already held)
  // [VERIFY-DOCS · ruling 8] The person's Hire Car Driver's Licence is issued for 3 years; the car's hire
  // licence is in force 1 year (s.79(3)). Printed dates win; these are the fallbacks and the ceilings.
  hire_car_driver_licence: 3 * 365,
  hire_car_vehicle_licence: 365,
  road_service_licence: 365, // annual commercial road-service licence
  food_handler_cert: 365,  // annual Food Handler's Permit (Food Safety Act 2019 s.54) — a permit, never a medical certificate
  gra_restaurant_licence: 365,
  // [DOC-1 §18.1] the addendum's annual Guyana licences (submittable through a category gate)
  sanitary_certificate: 365,
  trade_licence: 365,
  // [VERIFY-DOCS · ruling 8] A Guyana driver's licence is valid 5 years (GRA).
  drivers_licence: 5 * 365,
  // [DOC-1 §3.2 · P3-2] the unregistered trader's self-declaration is valid 365 days from signing
  self_declaration_unregistered: 365,
  // [TRADES · 13 Oct 2026] service-trade documents. The reviewer keys the printed date; these are
  // the longest validity each is issued for (a later date is refused as a typo).
  pesticide_applicator_certificate: 730,  // two years (Pesticides regulations, reg. 89)
  // [R15 · research A9/D9] The licences and food certificates checked again every January
  // (CERTIFICATE_YEAR_DOC_TYPES): the reviewer types the certificate's YEAR and the approval lapses
  // at the start of 16 January after it. These days are only the automatic path's default.
  pest_control_operator_licence: 365,
  eating_house_registration: 365,         // calendar year, renewed 1 January (City by-law 63(3))
  gei_electrical_licence: 365,
};

/**
 * [R15 · owner 15 Oct 2026, research A9/D9] The licences and food certificates Swift checks again
 * every January. A person types the YEAR printed on the certificate (never a guessed expiry), and the
 * approval lapses at the start of 16 January of the following year, Guyana time: the holder has the
 * first fortnight of January to bring the new year's certificate (verification.service
 * certificateYearRecheck), and is reminded from 1 December (renewal-schedule). Every food or licence
 * document of a service trade or store is here.
 * [owner 16 Oct 2026] A store's GRA restaurant licence, sanitary certificate and trade licence get the
 * same January re-check as a business name (R16): reminded from 1 December, lapsed on 16 January if not
 * renewed — whatever later date is printed or keyed, the approval never outlasts the coming re-check.
 */
export const CERTIFICATE_YEAR_DOC_TYPES: ReadonlySet<string> = new Set([
  'gei_electrical_licence', 'pest_control_operator_licence', 'food_handler_cert', 'eating_house_registration',
  'gra_restaurant_licence', 'sanitary_certificate', 'trade_licence',
]);
const SUBJECT_OF: Record<DocBucket, 'PERSON' | 'BUSINESS' | 'VEHICLE'> = { PERSONAL: 'PERSON', BUSINESS: 'BUSINESS', VEHICLE: 'VEHICLE' };
/**
 * [DOC-1 §6.9 · FD-DOC-6] Types in the always-review set by registry FACT (not by bucket rule):
 * the insurance certificate — covers_hire_and_reward is a wording judgement a model must not
 * make alone. PERSONAL types and anything needing a specimen are always-review by rule.
 */
// [VERIFY-DOCS · ruling 8] The certificate of fitness has no fixed length in law: its PRINTED date decides,
// so a person always reads it (an unreadable one is never given a 365-day guess by an automatic approval).
export const ALWAYS_REVIEW_LEGACY_CODES: ReadonlySet<string> = new Set([
  'vehicle_insurance', 'fitness_cert',
  // [TRADES] which council issued a premises certificate, and for which premises, is a person's judgement
  'eating_house_registration',
  // [ROLE-DOCS · owner 21 Oct 2026 · security review] whether a store's name is its owner's true surname (BNA s.3)
  // is read from the owner's ID by a person, never by a machine
  'own_name_declaration',
]);

export const registryCode = (countryCode: string, legacyCode: string) => `${countryCode}.${legacyCode}`;

/**
 * [VERIFY-DOCS · owner rulings 5, 7 and 8, 6 Oct 2026] Types no checklist asks for any more: the separate
 * plate photo (merged into the car photo), the TIN certificate (dropped) and the single hire-car permit
 * (split into the person's and the car's licences). Documents of them already exist, so the registry
 * keeps describing them — never as a requirement.
 */
export const RETIRED_DOC_TYPES: readonly string[] = ['vehicle_plate_photo', 'tin_certificate', 'hire_car_permit'];
const humanize = (code: string) => code.split('_').map((w) => (w === 'id' || w === 'tin' || w === 'gra' || w === 'gei' ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(' ');

export interface RegistrySeedResult { docTypes: number; requirementSets: number; requirementItems: number; validators: number; extraDocTypes: number; categoryGates: number }

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
 * depend on them (DOC-INV-2). One row is retired by ruling, not waiting: V_VEHICLE_COLOUR.
 */
export const VALIDATOR_CATALOGUE: readonly ValidatorRow[] = [
  // §7.2 field-level
  { code: 'V_MRZ_CHECKSUM', scope: 'FIELD', isBlocking: true, detailCode: 'SUSPECTED_ALTERATION' },
  { code: 'V_DATE_ORDER', scope: 'FIELD', isBlocking: true, detailCode: 'UNREADABLE_CAPTURE' },
  { code: 'V_NOT_EXPIRED', scope: 'FIELD', isBlocking: true, detailCode: 'EXPIRED_DOCUMENT', implRef: 'validators#V_NOT_EXPIRED' },
  // [self-test C · ruling 2026-09-06] §7.2 listed this as non-blocking; a non-blocking FAIL still auto-approves, which is
  // exactly the confident-wrong-expiry hole the self-test names. BLOCKING here means review by a person, never a rejection.
  { code: 'V_EXPIRY_PLAUSIBLE', scope: 'FIELD', isBlocking: true, detailCode: 'UNREADABLE_CAPTURE', implRef: 'validators#V_EXPIRY_PLAUSIBLE' },
  { code: 'V_DOB_ADULT', scope: 'FIELD', isBlocking: true, detailCode: 'REQUIREMENT_NOT_MET' },
  { code: 'V_TIN_FORMAT', scope: 'FIELD', isBlocking: true, detailCode: 'UNREADABLE_CAPTURE', docTypeLegacy: 'tin_certificate' },
  { code: 'V_PLATE_FORMAT', scope: 'FIELD', isBlocking: true, detailCode: 'UNREADABLE_CAPTURE' },
  { code: 'V_PLATE_CLASS', scope: 'FIELD', isBlocking: true, detailCode: 'WRONG_PLATE_CLASS' , implRef: 'validators#V_PLATE_CLASS' },
  // RETIRED by the owner's ruling of 2026-10-01: a taxi may be any colour (overrides §3.7 "hire cars are
  // Corporate Yellow"; the H plate stays — V_PLATE_CLASS). Declared, never blocking, never implemented:
  // the row stays only so validation results written before the ruling still name a known rule.
  { code: 'V_VEHICLE_COLOUR', scope: 'FIELD', isBlocking: false, detailCode: 'VEHICLE_COLOUR_NON_COMPLIANT' },
  // RETIRED by the owner's ruling of 6 Oct 2026 (ruling 8): the hire right is the person's Hire Car Driver's
  // Licence, a separate document — not a class printed on the ordinary licence. Declared, never blocking, never
  // implemented: the row stays only so validation results written before the ruling still name a known rule.
  { code: 'V_LICENCE_CLASS', scope: 'FIELD', isBlocking: false, detailCode: 'LICENCE_CLASS_MISMATCH', docTypeLegacy: 'drivers_licence' },
  { code: 'V_INSURANCE_SCOPE', scope: 'FIELD', isBlocking: true, detailCode: 'INSURANCE_SCOPE_INSUFFICIENT', docTypeLegacy: 'vehicle_insurance', implRef: 'validators#V_INSURANCE_SCOPE' },
  { code: 'V_FIELD_CONFIDENCE', scope: 'FIELD', isBlocking: false, detailCode: 'UNREADABLE_CAPTURE' },
  // §7.3 document-level
  { code: 'V_TYPE_MATCH', scope: 'DOCUMENT', isBlocking: true, detailCode: 'WRONG_DOCUMENT_TYPE' },
  { code: 'V_ALL_REQUIRED_PRESENT', scope: 'DOCUMENT', isBlocking: true, detailCode: 'UNREADABLE_CAPTURE', implRef: 'validators#V_ALL_REQUIRED_PRESENT' },
  { code: 'V_PAGE_COMPLETE', scope: 'DOCUMENT', isBlocking: true, detailCode: 'MISSING_PAGE' },
  { code: 'V_TAMPER_HEURISTIC', scope: 'DOCUMENT', isBlocking: false, detailCode: 'SUSPECTED_ALTERATION' },
  // §7.4 subject-level
  { code: 'V_NAME_CONSISTENCY', scope: 'SUBJECT', isBlocking: false, detailCode: 'NAME_MISMATCH' },
  { code: 'V_PLATE_CROSS_MATCH', scope: 'SUBJECT', isBlocking: true, detailCode: 'PLATE_CROSS_MISMATCH' , implRef: 'validators#V_PLATE_CROSS_MATCH' },
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

export interface ExtraDocType {
  legacyCode: string; displayName: string; bucket: DocBucket; issuer: string;
  hasExpiry: boolean; defaultValidityDays: number | null; expirySource: string; needsSpecimen: boolean; note: string;
}
/**
 * [DOC-1 §18.1] The addendum's Guyana document types — data. Inactive until a
 * specimen / legal facts are reviewed, like every registry row; NEEDS_RESEARCH
 * types carry needsSpecimen so nothing can be submitted against them (FD-DOC-15).
 */
export const EXTRA_DOC_TYPES: readonly ExtraDocType[] = [
  { legacyCode: 'self_declaration_unregistered', displayName: 'Unregistered trader self-declaration', bucket: 'BUSINESS', issuer: 'The trader (signed in-app; attestation version + content hash in the consent ledger)', hasExpiry: true, defaultValidityDays: 365, expirySource: 'DEFAULT', needsSpecimen: false, note: '§3.2/§3.6 · P3-2: blocking for the MICRO_VENDOR set; 365 d; fields trading_name, activity_class, declared_address, signed_at, attestation_version' },
  { legacyCode: 'sanitary_certificate', displayName: 'Sanitary certificate', bucket: 'BUSINESS', issuer: 'Public health / local authority', hasExpiry: true, defaultValidityDays: 365, expirySource: 'PRINTED', needsSpecimen: false, note: '§18.1: printed expiry, else 365 days' },
  { legacyCode: 'trade_licence', displayName: 'Trade licence', bucket: 'BUSINESS', issuer: 'GRA', hasExpiry: true, defaultValidityDays: 365, expirySource: 'PRINTED', needsSpecimen: false, note: '§18.1: annual; licence_type per the GRA schedule' },
  { legacyCode: 'digital_id', displayName: 'Guyana digital ID', bucket: 'PERSONAL', issuer: 'Government of Guyana', hasExpiry: false, defaultValidityDays: null, expirySource: 'NONE', needsSpecimen: true, note: '§18.1: stub until a specimen is reviewed (Digital Identity Card Act 2023, commenced 31 Mar 2026)' },
];
export const EXTRA_DOC_TYPES_COUNTRY = 'GY';

export interface GateSeed {
  code: string; categorySlug?: string; categoryKind?: DiscoveryCategoryKind; docType: string;
  enforcement: GateEnforcement; requiredField?: string; requiredValues?: string[]; note: string;
}
/**
 * [DOC-1 §18.3] Seed rules, mapped onto the discovery taxonomy: a slug for one
 * category, a kind for a family. Rulings: grocery / general shop is WARN until
 * the vendor tier signal (P3-2) can make it BLOCK_LISTING at the registered tier.
 * [ROLE-DOCS · owner 21 Oct 2026] No alcohol or pharmacy gate: alcohol and every
 * medicine are banned outright (GUARDRAILS §8, compliance/prohibited-items), so
 * no licence can unlock them and none is collected. seedCategoryGates removes
 * the two rows a database already holds, and with them the liquor licence's
 * last way in (a gate document type is submittable: category-gate.ts).
 */
export const CATEGORY_GATES: readonly GateSeed[] = [
  { code: 'GY:slug:meat-poultry:sanitary_certificate', categorySlug: 'meat-poultry', docType: 'sanitary_certificate', enforcement: 'BLOCK_LISTING', note: '§18.3: meat / butcher' },
  { code: 'GY:kind:CUISINE:gra_restaurant_licence', categoryKind: 'CUISINE', docType: 'gra_restaurant_licence', enforcement: 'BLOCK_LISTING', note: '§18.3: prepared food' },
  { code: 'GY:kind:DISH:gra_restaurant_licence', categoryKind: 'DISH', docType: 'gra_restaurant_licence', enforcement: 'BLOCK_LISTING', note: '§18.3: prepared food' },
  { code: 'GY:kind:CUISINE:food_handler_cert', categoryKind: 'CUISINE', docType: 'food_handler_cert', enforcement: 'BLOCK_LISTING', note: '§18.3: prepared food — at least one food handler permit' },
  { code: 'GY:kind:DISH:food_handler_cert', categoryKind: 'DISH', docType: 'food_handler_cert', enforcement: 'BLOCK_LISTING', note: '§18.3: prepared food — at least one food handler permit' },
  { code: 'GY:kind:AISLE:trade_licence', categoryKind: 'AISLE', docType: 'trade_licence', enforcement: 'WARN', note: '§18.3: grocery — WARN at micro tier; registered tier BLOCK_LISTING awaits the tier signal (ruling)' },
  { code: 'GY:kind:RETAIL:trade_licence', categoryKind: 'RETAIL', docType: 'trade_licence', enforcement: 'WARN', note: '§18.3: general shop — WARN at micro tier; registered tier BLOCK_LISTING awaits the tier signal (ruling)' },
];

/** Idempotent: the §18.1 types for Guyana, inactive and provisional like every seeded row. */
export async function seedExtraDocTypes(prisma: PrismaClient): Promise<number> {
  const c = EXTRA_DOC_TYPES_COUNTRY;
  if (!(await prisma.countryConfig.findUnique({ where: { code: c }, select: { code: true } }))) return 0;
  let n = 0;
  for (const t of EXTRA_DOC_TYPES) {
    const bucket = t.bucket;
    await prisma.docType.upsert({
      where: { code: registryCode(c, t.legacyCode) },
      create: {
        code: registryCode(c, t.legacyCode), countryCode: c, legacyCode: t.legacyCode, displayName: t.displayName,
        bucket, subjectKind: SUBJECT_OF[bucket], issuer: t.issuer,
        imagePolicy: IMAGE_POLICY_OF_BUCKET[bucket], persistRetentionDays: retentionFor(IMAGE_POLICY_OF_BUCKET[bucket]),
        hasExpiry: t.hasExpiry, defaultValidityDays: t.defaultValidityDays, expirySource: t.expirySource,
        extractionProfile: 'UNPROFILED', externalProcessingAllowed: false, needsSpecimen: t.needsSpecimen,
        legalFactsSourceNote: `${PROVISIONAL_NOTE} ${t.note}`, isActive: false,
        alwaysReview: ALWAYS_REVIEW_LEGACY_CODES.has(t.legacyCode),
      },
      update: { displayName: t.displayName, issuer: t.issuer, hasExpiry: t.hasExpiry, defaultValidityDays: t.defaultValidityDays, expirySource: t.expirySource, needsSpecimen: t.needsSpecimen },
    });
    n += 1;
  }
  return n;
}

/** Idempotent and reconciling: the §18.3 rows exist with their facts; a row the seed no longer declares is removed. */
export async function seedCategoryGates(prisma: PrismaClient): Promise<number> {
  const c = EXTRA_DOC_TYPES_COUNTRY;
  let n = 0;
  for (const g of CATEGORY_GATES) {
    const requiredDocTypeCode = registryCode(c, g.docType);
    if (!(await prisma.docType.findUnique({ where: { code: requiredDocTypeCode }, select: { code: true } }))) continue;
    const facts = {
      countryCode: c, categorySlug: g.categorySlug ?? null, categoryKind: g.categoryKind ?? null, requiredDocTypeCode,
      requiredField: g.requiredField ?? null, requiredValues: g.requiredValues ?? [], enforcement: g.enforcement, note: g.note,
    };
    await prisma.categoryDocumentGate.upsert({ where: { code: g.code }, create: { code: g.code, ...facts }, update: facts });
    n += 1;
  }
  await prisma.categoryDocumentGate.deleteMany({ where: { code: { notIn: CATEGORY_GATES.map((g) => g.code) } } });
  return n;
}

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
export async function registryCompletenessGaps(
  prisma: PrismaClient,
  resolves: (implRef: string | null) => boolean,
  opts: { /** P10-4: judge these codes as if they were active — a rehearsal, not a write */ treatActive?: readonly string[] } = {},
): Promise<RegistryGap[]> {
  const gaps: RegistryGap[] = [];
  const validators = await prisma.validator.findMany({ select: { code: true, docTypeCode: true, isBlocking: true, implRef: true } });
  for (const v of validators) if (v.implRef !== null && !resolves(v.implRef)) gaps.push({ docTypeCode: '*', gap: 'IMPL_MISSING', detail: `${v.code} → ${v.implRef}` });
  const declared = new Set(VALIDATOR_CATALOGUE.map((v) => v.code));
  for (const v of validators) if (!declared.has(v.code)) gaps.push({ docTypeCode: '*', gap: 'STALE_VALIDATOR', detail: v.code });
  const byCode = new Map(validators.map((v) => [v.code, v] as const));
  const active = await prisma.docType.findMany({
    where: opts.treatActive && opts.treatActive.length > 0 ? { OR: [{ isActive: true }, { code: { in: [...opts.treatActive] } }] } : { isActive: true },
    select: { code: true, extractionProfile: true, fields: { select: { fieldCode: true, isRequired: true, validatorRef: true } } },
  });
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

/**
 * [DOC-INV-2 · T2] The boot gate server.ts runs after seeding the registry and before it
 * marks the boot contract complete. An ACTIVE document type the registry cannot validate
 * is a lie about verification: in production this THROWS, naming the first gaps, so the
 * boot contract stays incomplete (readiness 503); elsewhere it warns with every gap, so the
 * seed that closes them can be written, and boot goes on. Returns the gaps.
 */
export async function enforceRegistryCompletenessAtBoot(
  prisma: PrismaClient,
  log: { warn: (obj: { gaps: RegistryGap[] }, msg: string) => void },
  resolves: (implRef: string | null) => boolean,
): Promise<RegistryGap[]> {
  const gaps = await registryCompletenessGaps(prisma, resolves);
  if (gaps.length > 0) {
    if (isProduction()) {
      throw new Error(`document registry incomplete for active types: ${gaps.slice(0, 8).map((g) => `${g.docTypeCode}:${g.gap}${g.detail ? `(${g.detail})` : ''}`).join(', ')}`);
    }
    log.warn({ gaps }, 'documents: registry incomplete for active types — production refuses to boot like this');
  }
  return gaps;
}

/** Idempotent: upserts every document class and requirement set the country checklists describe. */
export async function seedDocRegistry(prisma: PrismaClient): Promise<RegistrySeedResult> {
  const countries = await prisma.countryConfig.findMany({ select: { code: true, documentChecklists: true } });
  let docTypes = 0; let requirementSets = 0; let requirementItems = 0;
  for (const c of countries) {
    // Code defaults under the stored JSON (P3-2): a list added in code is seeded everywhere; an edited stored list wins.
    const lists: Record<string, string[]> = { ...DEFAULT_DOCUMENT_CHECKLISTS, ...((c.documentChecklists ?? {}) as Record<string, string[]>) };
    // [ROLE-DOCS · owner 21 Oct 2026] a retired list in a stored copy from an older seed declares nothing
    for (const key of RETIRED_REGISTRY_LIST_KEYS) delete lists[key];
    // [VERIFY-DOCS] A type no list asks for any more keeps its registry row: documents of it already
    // exist (approved permits, TIN certificates) and their bucket and retention still have to be read.
    // A never-accepted type (a medical document) is never minted, whatever a stored list says.
    const legacyCodes = [...new Set([...Object.values(lists).flat(), ...RETIRED_DOC_TYPES])].filter((code) => !isNeverAcceptedDocType(code));
    for (const legacyCode of legacyCodes) {
      const bucket = BUCKET_OF[legacyCode] ?? 'PERSONAL';
      const validity = AUTO_APPROVE_EXPIRY_DAYS[legacyCode];
      await prisma.docType.upsert({
        where: { code: registryCode(c.code, legacyCode) },
        create: {
          code: registryCode(c.code, legacyCode), countryCode: c.code, legacyCode, displayName: humanize(legacyCode),
          bucket, subjectKind: SUBJECT_OF[bucket], issuer: 'UNVERIFIED (legal facts pending)',
          imagePolicy: IMAGE_POLICY_OF_BUCKET[bucket], persistRetentionDays: retentionFor(IMAGE_POLICY_OF_BUCKET[bucket]),
          hasExpiry: validity !== undefined, defaultValidityDays: validity ?? null, expirySource: validity !== undefined ? 'PRINTED' : 'NONE',
          extractionProfile: 'UNPROFILED', externalProcessingAllowed: false, legalFactsSourceNote: PROVISIONAL_NOTE, isActive: false,
          alwaysReview: ALWAYS_REVIEW_LEGACY_CODES.has(legacyCode),
        },
        update: { legacyCode, hasExpiry: validity !== undefined, defaultValidityDays: validity ?? null, alwaysReview: ALWAYS_REVIEW_LEGACY_CODES.has(legacyCode) },
      });
      docTypes += 1;
    }
    // [VERIFY-DOCS] One requirement set per (role, tier): its required list's items are BLOCKING in
    // their published order; its `<KEY>_OPTIONAL` list's items join the same set as NON-blocking
    // (a type both lists name stays blocking). The set is RECONCILED to the lists — an item they no
    // longer name is removed — so the registry never keeps a requirement the owner has lifted.
    const declared = new Map<string, { actorRole: string; tier: string; items: Map<string, { isBlocking: boolean; sortOrder: number }> }>();
    for (const [listKey, codes] of Object.entries(lists)) {
      // [DOC-1 §3.6 · P3-2] A <ROLE>_UNREGISTERED list is the same role's requirement set at the
      // UNREGISTERED tier — the registry's own tier column, not a second role.
      const { actorRole, tier, optional } = splitChecklistKey(listKey);
      const key = `${actorRole}|${tier}`;
      const entry = declared.get(key) ?? { actorRole, tier, items: new Map() };
      declared.set(key, entry);
      for (const [i, legacyCode] of codes.entries()) {
        // [VERIFY-DOCS · ruling 5] A never-accepted type (a medical document), named in a required OR an
        // `_OPTIONAL` list, was never minted above: requiring it would be a foreign-key error at boot.
        if (isNeverAcceptedDocType(legacyCode)) continue;
        const code = registryCode(c.code, legacyCode);
        const had = entry.items.get(code);
        if (optional) { if (!had) entry.items.set(code, { isBlocking: false, sortOrder: 1000 + i }); }
        else entry.items.set(code, { isBlocking: true, sortOrder: i });
      }
    }
    for (const { actorRole, tier, items } of declared.values()) {
      const set = await prisma.requirementSet.upsert({
        where: { countryCode_actorRole_tier_effectiveFrom: { countryCode: c.code, actorRole, tier, effectiveFrom: REGISTRY_EFFECTIVE_FROM } },
        create: { countryCode: c.code, actorRole, tier, effectiveFrom: REGISTRY_EFFECTIVE_FROM },
        update: {},
      });
      requirementSets += 1;
      for (const [docTypeCode, { isBlocking, sortOrder }] of items) {
        await prisma.requirementItem.upsert({
          where: { requirementSetId_docTypeCode: { requirementSetId: set.id, docTypeCode } },
          create: { requirementSetId: set.id, docTypeCode, isBlocking, minCount: 1, sortOrder },
          update: { isBlocking, sortOrder },
        });
        requirementItems += 1;
      }
      await prisma.requirementItem.deleteMany({ where: { requirementSetId: set.id, docTypeCode: { notIn: [...items.keys()] } } });
    }
    // [ROLE-DOCS · owner 21 Oct 2026] A seeded set whose list no longer exists goes too (CUSTOMER_L2): the
    // registry never keeps a requirement nobody asks for. Only the seed's own sets (REGISTRY_EFFECTIVE_FROM)
    // are judged; a set a migration inserted with verified facts is never touched here.
    const declaredKeys = new Set([...declared.values()].map((d) => `${d.actorRole}|${d.tier}`));
    const seeded = await prisma.requirementSet.findMany({ where: { countryCode: c.code, effectiveFrom: REGISTRY_EFFECTIVE_FROM }, select: { id: true, actorRole: true, tier: true } });
    const stale = seeded.filter((set) => !declaredKeys.has(`${set.actorRole}|${set.tier}`)).map((set) => set.id);
    if (stale.length > 0) {
      await prisma.requirementItem.deleteMany({ where: { requirementSetId: { in: stale } } });
      await prisma.requirementSet.deleteMany({ where: { id: { in: stale } } });
    }
  }
  const extraDocTypes = await seedExtraDocTypes(prisma);
  const validators = await seedValidatorRegistry(prisma);
  const categoryGates = await seedCategoryGates(prisma);
  // [P4-1 EXPAND] the declared fields, after the validators they reference exist
  await seedDocFields(prisma);
  // [DOC-1 §1.3 · P1-3] provisional rows follow the bucket doctrine for the image
  await reconcileImagePolicy(prisma);
  return { docTypes, requirementSets, requirementItems, validators, extraDocTypes, categoryGates };
}


// ---------------------------------------------------------------------------
// [DOC-1 §3 · §18.1 · DOC-INV-2 · P4-1 EXPAND] The field catalogue — what each document type
// DECLARES. A processor key that is not declared is dropped and counted (DOC-INV-6); a
// declared field the processor did not return is an ABSENT row. Every field ships
// `isRequired: false` (ruling 2026-09-07): required-ness is the switch that ends auto-approval
// for a type until its extraction profile actually reads the field, and no profile is built
// yet (UNPROFILED) — flipping a field to required is a per-type policy step, recorded when
// the profile lands. `identifier` names the field a processor's `documentNumber` lands in.
// ---------------------------------------------------------------------------
export interface FieldRow { fieldCode: string; dataType: 'text' | 'date' | 'enum' | 'number' | 'geo' | 'bool'; isPii?: boolean; blind?: boolean; validatorRef?: string; identifier?: boolean; enumValues?: string[] }
const DATES = (issue = 'issue_date', expiry = 'expiry_date'): FieldRow[] => [
  { fieldCode: issue, dataType: 'date', validatorRef: 'V_DATE_ORDER' },
  { fieldCode: expiry, dataType: 'date', validatorRef: 'V_EXPIRY_PLAUSIBLE' },
];
// [VERIFY-DOCS · owner ruling 5, 6 Oct 2026] An ID proves who someone is and that they are an adult:
// number, name, date of birth, dates. Sex and nationality are not needed and are not declared (RETIRED_FIELDS).
const IDENTITY: FieldRow[] = [
  { fieldCode: 'doc_number', dataType: 'text', isPii: true, blind: true, identifier: true, validatorRef: 'V_MRZ_CHECKSUM' },
  { fieldCode: 'full_name', dataType: 'text', isPii: true },
  { fieldCode: 'dob', dataType: 'date', isPii: true, validatorRef: 'V_DOB_ADULT' },
  ...DATES(),
];
/** [TRADES] A licence or registration a person holds for their trade. */
const TRADE_LICENCE: FieldRow[] = [
  { fieldCode: 'licence_number', dataType: 'text', isPii: true, blind: true, identifier: true },
  { fieldCode: 'holder_name', dataType: 'text', isPii: true },
  ...DATES(),
  { fieldCode: 'issuing_body', dataType: 'text' },
];
/** [TRADES] A council certificate for premises (an eating-house). */
const PREMISES_CERTIFICATE: FieldRow[] = [
  { fieldCode: 'certificate_number', dataType: 'text', blind: true, identifier: true },
  // a home caterer's premises are their home
  { fieldCode: 'premises_address', dataType: 'text', isPii: true },
  ...DATES(),
  { fieldCode: 'issuing_body', dataType: 'text' },
];
export const FIELD_CATALOGUE: Readonly<Record<string, readonly FieldRow[]>> = {
  national_id: IDENTITY,
  owner_national_id: IDENTITY,
  passport: IDENTITY,
  digital_id: IDENTITY,
  self_declaration_unregistered: [
    { fieldCode: 'trading_name', dataType: 'text', identifier: true },
    { fieldCode: 'activity_class', dataType: 'enum' },
    { fieldCode: 'declared_address', dataType: 'text', isPii: true },
    { fieldCode: 'signed_at', dataType: 'date' },
    { fieldCode: 'attestation_version', dataType: 'text' },
  ],
  // A photo declares no EXTRACTED fields: its capture metadata (captured_at, geo_point, device_attestation —
  // §3.2) is recorded by the capture attestation (P22), not read from the image. Photo types stay field-less.
  storefront_photo: [],
  // [ROLE-DOCS] the own-name declaration: the store name it was signed for, when, which words
  own_name_declaration: [
    { fieldCode: 'trading_name', dataType: 'text', identifier: true },
    { fieldCode: 'signed_at', dataType: 'date' },
    { fieldCode: 'attestation_version', dataType: 'text' },
  ],
  food_handler_cert: [
    { fieldCode: 'permit_number', dataType: 'text', isPii: true, blind: true, identifier: true },
    { fieldCode: 'holder_name', dataType: 'text', isPii: true },
    ...DATES(),
    { fieldCode: 'issuing_office', dataType: 'text' },
  ],
  tin_certificate: [
    { fieldCode: 'tin', dataType: 'text', isPii: true, blind: true, identifier: true, validatorRef: 'V_TIN_FORMAT' },
    { fieldCode: 'registered_name', dataType: 'text' },
  ],
  business_registration: [
    { fieldCode: 'registration_number', dataType: 'text', blind: true, identifier: true },
    { fieldCode: 'business_name', dataType: 'text' },
    { fieldCode: 'proprietor_name', dataType: 'text', isPii: true },
    { fieldCode: 'nature_of_business', dataType: 'text' },
    { fieldCode: 'principal_place', dataType: 'text' },
    { fieldCode: 'registration_date', dataType: 'date' },
  ],
  gra_restaurant_licence: [
    { fieldCode: 'licence_number', dataType: 'text', blind: true, identifier: true },
    { fieldCode: 'premises_name', dataType: 'text' },
    { fieldCode: 'premises_address', dataType: 'text' },
    ...DATES(),
    { fieldCode: 'issuing_body', dataType: 'text' },
  ],
  drivers_licence: [
    { fieldCode: 'licence_number', dataType: 'text', isPii: true, blind: true, identifier: true },
    { fieldCode: 'holder_name', dataType: 'text', isPii: true },
    { fieldCode: 'dob', dataType: 'date', isPii: true, validatorRef: 'V_DOB_ADULT' },
    { fieldCode: 'classes', dataType: 'text' }, // recorded, never judged (ruling 8: no "H class" check)
    ...DATES(),
  ],
  hire_car_permit: [
    { fieldCode: 'licence_number', dataType: 'text', isPii: true, blind: true, identifier: true },
    { fieldCode: 'holder_name', dataType: 'text', isPii: true },
    ...DATES(),
  ],
  // [VERIFY-DOCS · ruling 8] The person's licence (same name as the driver's licence) and the car's (plate matches).
  hire_car_driver_licence: [
    { fieldCode: 'licence_number', dataType: 'text', isPii: true, blind: true, identifier: true },
    { fieldCode: 'holder_name', dataType: 'text', isPii: true },
    ...DATES(),
  ],
  hire_car_vehicle_licence: [
    { fieldCode: 'licence_number', dataType: 'text', blind: true, identifier: true },
    { fieldCode: 'registration_mark', dataType: 'text', validatorRef: 'V_PLATE_CROSS_MATCH' },
    ...DATES(),
  ],
  police_clearance: [], // routed by IDV-1; DOC-1 declares nothing (§3.7)
  vehicle_registration: [
    { fieldCode: 'registration_mark', dataType: 'text', blind: true, identifier: true, validatorRef: 'V_PLATE_CLASS' },
    { fieldCode: 'chassis', dataType: 'text', blind: true },
    { fieldCode: 'make', dataType: 'text' },
    { fieldCode: 'model', dataType: 'text' },
    { fieldCode: 'year', dataType: 'number' },
    { fieldCode: 'colour', dataType: 'text' }, // recorded, never judged (owner ruling 2026-10-01: any colour)
    // [VERIFY-DOCS · ruling 5] no owner_name: the registered owner can be a third party (RETIRED_FIELDS)
  ],
  road_service_licence: [
    { fieldCode: 'licence_number', dataType: 'text', blind: true, identifier: true },
    { fieldCode: 'registration_mark', dataType: 'text', validatorRef: 'V_PLATE_CROSS_MATCH' },
    { fieldCode: 'class', dataType: 'text' },
    ...DATES(),
  ],
  fitness_cert: [
    { fieldCode: 'certificate_number', dataType: 'text', blind: true, identifier: true },
    { fieldCode: 'registration_mark', dataType: 'text', validatorRef: 'V_PLATE_CROSS_MATCH' },
    ...DATES(),
  ],
  vehicle_insurance: [
    { fieldCode: 'policy_number', dataType: 'text', blind: true, identifier: true },
    { fieldCode: 'insurer', dataType: 'text' },
    { fieldCode: 'registration_mark', dataType: 'text', validatorRef: 'V_PLATE_CROSS_MATCH' },
    { fieldCode: 'cover_type', dataType: 'text' },
    { fieldCode: 'covers_hire_and_reward', dataType: 'bool', validatorRef: 'V_INSURANCE_SCOPE' },
    ...DATES('effective_date', 'expiry_date'),
  ],
  vehicle_plate_photo: [],
  vehicle_exterior_photo: [],
  selfie: [],
  sanitary_certificate: [
    { fieldCode: 'certificate_ref', dataType: 'text', blind: true, identifier: true },
    { fieldCode: 'premises_address', dataType: 'text' },
    ...DATES(),
    { fieldCode: 'inspecting_officer', dataType: 'text', isPii: true },
  ],
  trade_licence: [
    { fieldCode: 'licence_number', dataType: 'text', blind: true, identifier: true },
    { fieldCode: 'licence_type', dataType: 'enum', enumValues: ['GENERAL_SHOP', 'BUTCHER', 'PHARMACY', 'INTERNET_CAFE', 'CINEMA', 'LUMBER_YARD', 'OTHER'] },
    { fieldCode: 'holder_name', dataType: 'text', isPii: true },
    { fieldCode: 'premises_address', dataType: 'text' },
    { fieldCode: 'year', dataType: 'number' },
  ],
  gei_electrical_licence: [
    { fieldCode: 'licence_number', dataType: 'text', blind: true, identifier: true },
    { fieldCode: 'holder_name', dataType: 'text', isPii: true },
    ...DATES(),
  ],
  // [TRADES · 13 Oct 2026] the service-trade licences and registrations: who holds it, its number, its dates
  pest_control_operator_licence: TRADE_LICENCE,
  pesticide_applicator_certificate: TRADE_LICENCE,
  eating_house_registration: PREMISES_CERTIFICATE,
};

/**
 * [VERIFY-DOCS · owner ruling 5, 6 Oct 2026] Fields an older registry declared and Swift no longer
 * collects: a person's sex and nationality on identity documents, and the registered owner's name on a
 * vehicle registration (it can be a third party's). The seed RETIRES their declarations (seedDocFields),
 * so no extraction creates them again, and the subject's export and the custody trail never show an
 * empty placeholder an older extraction left for them. A value under one (none is ever written: the
 * processor contract carries only the document number) would still be exported to its subject.
 */
export const RETIRED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  national_id: ['sex', 'nationality'],
  owner_national_id: ['sex', 'nationality'],
  passport: ['sex', 'nationality'],
  digital_id: ['sex', 'nationality'],
  vehicle_registration: ['owner_name'],
};
/** An empty placeholder for a retired field: nothing to show anyone. */
export function isRetiredPlaceholder(legacyCode: string, fieldCode: string, valueCt: unknown): boolean {
  return valueCt === null && (RETIRED_FIELDS[legacyCode]?.includes(fieldCode) ?? false);
}

/**
 * [VERIFY-DOCS · owner ruling 5] Swift never accepts a medical certificate or any health record — health
 * data is sensitive personal data (Data Protection Act 2023 s.2), and nothing Swift does needs it (the food
 * handler's permit is a permit). No list may name one, the registry never mints one, and an upload of one
 * is refused before any document is recorded, whatever a stored list says.
 */
export const NEVER_ACCEPTED_DOC_TYPES: ReadonlySet<string> = new Set(['medical_certificate', 'health_certificate', 'medical_report', 'doctors_note', 'fitness_to_work_certificate']);
export function isNeverAcceptedDocType(code: string): boolean {
  return NEVER_ACCEPTED_DOC_TYPES.has(code) || /medic|health|doctor|physician|clinic|hospital/i.test(code);
}

/** The field a processor's generic `documentNumber` lands in for a type: a declared `doc_number` first (the legacy convention), else the type's identifier. */
export function identifierFieldOf(legacyCode: string, declared: ReadonlyArray<{ fieldCode: string }>): string | null {
  if (declared.some((f) => f.fieldCode === 'doc_number')) return 'doc_number';
  const id = FIELD_CATALOGUE[legacyCode]?.find((f) => f.identifier)?.fieldCode ?? null;
  return id && declared.some((f) => f.fieldCode === id) ? id : null;
}

/** Seed the declared fields of every seeded document type. Expand-only: rows are upserted, never removed (a type's own test may add fields for a run)
 *  — except a RETIRED field, whose declaration is removed so no extraction creates it again [VERIFY-DOCS]. */
export async function seedDocFields(prisma: PrismaClient): Promise<number> {
  for (const [legacyCode, fieldCodes] of Object.entries(RETIRED_FIELDS)) {
    await prisma.docField.deleteMany({ where: { docType: { legacyCode }, fieldCode: { in: [...fieldCodes] } } });
  }
  const types = await prisma.docType.findMany({ select: { code: true, legacyCode: true } });
  const validators = new Set((await prisma.validator.findMany({ select: { code: true } })).map((v) => v.code));
  let n = 0;
  for (const t of types) {
    const rows = FIELD_CATALOGUE[t.legacyCode] ?? [];
    for (const [i, f] of rows.entries()) {
      const validatorRef = f.validatorRef && validators.has(f.validatorRef) ? f.validatorRef : null;
      const facts = { dataType: f.dataType, isPii: f.isPii ?? false, isBlindIndexed: f.blind ?? false, validatorRef, enumValues: f.enumValues ?? [], displayOrder: i + 1 };
      await prisma.docField.upsert({
        where: { docTypeCode_fieldCode: { docTypeCode: t.code, fieldCode: f.fieldCode } },
        create: { docTypeCode: t.code, fieldCode: f.fieldCode, isRequired: false, ...facts },
        update: facts, // isRequired is a policy flag another step may have set; the seed never lowers or raises it
      });
      n += 1;
    }
  }
  return n;
}

/**
 * The registry's answer for (country, role) — or null when the registry does
 * not yet speak for it: no requirement set in effect today, or any of its
 * document types still inactive (legal facts unverified). The facade falls
 * back to the JSON on null, so behaviour is unchanged until activation.
 */
export const UNREGISTERED_TIER = 'UNREGISTERED';
export const UNREGISTERED_LIST_SUFFIX = '_UNREGISTERED';
/** [ROLE-DOCS · owner 21 Oct 2026] A store trading under its owner's own name: `<ROLE>_OWN_NAME`, the registry's OWN_NAME tier. */
export const OWN_NAME_TIER = 'OWN_NAME';
export const OWN_NAME_LIST_SUFFIX = '_OWN_NAME';
/** [VERIFY-DOCS] `<KEY>_OPTIONAL` names documents the same role MAY add: never a gate. */
export const OPTIONAL_LIST_SUFFIX = '_OPTIONAL';
/** RESTAURANT_UNREGISTERED → { actorRole: 'RESTAURANT', tier: 'UNREGISTERED' }; MOVER_OPTIONAL → { actorRole: 'MOVER', optional };
 *  anything else is the STANDARD tier's required list. */
export function splitChecklistKey(listKey: string): { actorRole: string; tier: string; optional: boolean } {
  const optional = listKey.endsWith(OPTIONAL_LIST_SUFFIX);
  const key = optional ? listKey.slice(0, -OPTIONAL_LIST_SUFFIX.length) : listKey;
  if (key.endsWith(UNREGISTERED_LIST_SUFFIX)) return { actorRole: key.slice(0, -UNREGISTERED_LIST_SUFFIX.length), tier: UNREGISTERED_TIER, optional };
  if (key.endsWith(OWN_NAME_LIST_SUFFIX)) return { actorRole: key.slice(0, -OWN_NAME_LIST_SUFFIX.length), tier: OWN_NAME_TIER, optional };
  return { actorRole: key, tier: REGISTRY_TIER, optional };
}

export async function registryChecklist(prisma: Pick<PrismaClient, 'requirementSet'>, countryCode: string, actorRole: string, now = new Date(), tier: string = REGISTRY_TIER): Promise<string[] | null> {
  const set = await prisma.requirementSet.findFirst({
    where: {
      countryCode, actorRole, tier,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    include: { items: { include: { docType: { select: { legacyCode: true, isActive: true } } }, orderBy: { sortOrder: 'asc' } } },
  });
  // [VERIFY-DOCS] The checklist is the BLOCKING items; an optional item never becomes a requirement.
  const blocking = set?.items.filter((i) => i.isBlocking) ?? [];
  if (!set || blocking.length === 0) return null;
  if (!blocking.every((i) => i.docType.isActive)) return null;
  return blocking.map((i) => i.docType.legacyCode);
}

/** [DOC-1 Part XIX · P19] The identity types whose VALID record lets a proprietor's verified name stand in for a business name ("trading as"). Registry text (DOC-INV-2). */
export const IDENTITY_DOC_TYPES: readonly string[] = ['owner_national_id', 'national_id', 'passport'];
/** [Item 98 · owner ruling 13 Oct 2026, row 30] The photo IDs a reviewer compares with the applicant's signup selfie, by
 *  eye and never by a machine: whichever was sent, a national ID, an owner's national ID, a passport or a driver's
 *  licence (a motorised mover's licence is their photo ID). Registry text (DOC-INV-2). */
export const SELFIE_COMPARE_DOC_TYPES: ReadonlySet<string> = new Set([...IDENTITY_DOC_TYPES, 'drivers_licence']);
/** [VERIFY-DOCS · owner ruling 6 Oct 2026 ~21:25 GYT] The licence whose NUMBER a reviewer types at approval (kept only as a
 *  blind index, for the duplicate-account check — verification/identity-signal-policy.ts). Registry text (DOC-INV-2). */
export const LICENCE_NUMBER_DOC_TYPES: ReadonlySet<string> = new Set(['drivers_licence']);
/** [VERIFY-DOCS · same ruling] The documents whose ISSUE date a reviewer types at approval (the yearly re-check). Registry text (DOC-INV-2). */
export const ISSUE_DATE_DOC_TYPES: ReadonlySet<string> = new Set(['police_clearance']);
/** [DOC-1 Part XIX · P19] Licence-class types disclosed on the storefront while VALID (number when read, else "on file"). Registry text (DOC-INV-2). */
/** [DOC-1 §3.6 · P3-2] The registration records that promote an UNREGISTERED store, and the declaration that puts it there. */
export const REGISTRATION_DOC_TYPES: readonly string[] = ['business_registration'];
/**
 * [R16 · owner 15 Oct 2026, research D7] What a business registration certificate is, decided by the
 * reviewer who reads it: a business NAME registered by a sole trader or a partnership (Business Names
 * Act: renewed every year — recorded by its YEAR and checked again every January, like the certificate-year
 * documents), or a COMPANY's certificate of incorporation, which never expires.
 */
export const REGISTRATION_KINDS = ['BUSINESS_NAME', 'COMPANY'] as const;
export type RegistrationKind = (typeof REGISTRATION_KINDS)[number];
export const DECLARATION_DOC_TYPE = 'self_declaration_unregistered';
/** [ROLE-DOCS · owner 21 Oct 2026] The signed "I trade under my own name" declaration. Registry text (DOC-INV-2). */
export const OWN_NAME_DOC_TYPE = 'own_name_declaration';
/** [FOOD-PERMIT · owner ruling 24 Oct 2026] A food handler's certificate. Required of a home cook (the self-declared
 *  tier), a chef and a caterer; OPTIONAL for a registered restaurant, which ticks the statement below instead. */
export const FOOD_HANDLER_CERT_DOC_TYPE = 'food_handler_cert';
/** [FOOD-PERMIT · owner ruling 24 Oct 2026] A registered restaurant's owner ticks "Everyone who handles food here holds
 *  a current food handler's certificate." (vendor/food-handlers.ts). Not a document and on no list: a statement in the
 *  consent ledger, asked of the store by code, which the store status shows as a step. Registry text (DOC-INV-2). */
export const FOOD_HANDLER_ATTESTATION_TYPE = 'food_handler_attestation';
/** The motor insurance a passenger-vehicle driver must hold at HIRE class to go online or take work. Registry text (DOC-INV-2). */
export const VEHICLE_INSURANCE_DOC_TYPE = 'vehicle_insurance';
/** [VERIFY-DOCS · owner rulings 1–3, 6 Oct 2026] The character document: optional for movers (an approved, current one is
 *  the "Police-cleared" flag), still required where a list names it. Registry text (DOC-INV-2). */
export const POLICE_CLEARANCE_DOC_TYPE = 'police_clearance';
/** [VERIFY-DOCS · owner ruling 8, 6 Oct 2026] The single hire-car permit, and the PERSON's Hire Car Driver's Licence (s.80)
 *  and the CAR's yearly hire licence (s.79) that replace it (verification/hire-permit-grace.ts). Registry text (DOC-INV-2). */
export const HIRE_PERMIT_DOC_TYPE = 'hire_car_permit';
export const HIRE_DRIVER_LICENCE_DOC_TYPE = 'hire_car_driver_licence';
export const HIRE_VEHICLE_LICENCE_DOC_TYPE = 'hire_car_vehicle_licence';

/**
 * [TRADES · 13 Oct 2026] What each service-provider document is, in the provider's own words — the
 * services catalogue lists these before anyone signs up, so older apps show them too.
 */
export const SERVICE_DOCUMENT_WORDS: Readonly<Record<string, string>> = {
  national_id: 'National ID or Digital ID card',
  police_clearance: 'Police clearance certificate',
  pest_control_operator_licence: 'Pest-control operator licence from the Pesticides and Toxic Chemicals Control Board (PTCCB)',
  pesticide_applicator_certificate: 'Your PTCCB commercial applicator certificate (valid two years)',
  drivers_licence: 'Driver’s licence for the class of machine you drive on a road',
  food_handler_cert: 'This year’s food handler’s certificate from the Mayor and City Council of Georgetown',
  eating_house_registration: 'This year’s eating-house registration from the Town Clerk in Georgetown',
};

export const LICENCE_DISCLOSURE_TYPES: readonly string[] = ['trade_licence', 'sanitary_certificate', 'food_handler_cert', 'gra_restaurant_licence'];

/** [L06 · #1551] The vehicle's registration — the document a vehicle subject is resolved from. Registry text (DOC-INV-2). */
export const VEHICLE_REGISTRATION_DOC_TYPE = 'vehicle_registration';
