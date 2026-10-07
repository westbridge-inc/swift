/**
 * [STA-1 Part 6 · REVIEW-PARTNER] The store-review fiction's two partners: a
 * delivery RIDER on a motorbike and a taxi DRIVER in a car with an H plate.
 *
 * Why they exist: App Review (guideline 2.1) must reach every feature, and
 * Google Play's background-location declaration needs a video of the partner
 * app's disclosure → OS permission → going online with location shared. Both
 * need a partner that can really go online on the public test server, without
 * a real sign-in text.
 *
 * The logins are minted by `review:provision` (one RIDER and one DRIVER
 * credential per run, beside the CUSTOMER one). `review:seed` (this file, via
 * content-pack.ts) makes each of those accounts a VERIFIED partner INSIDE the
 * REVIEW tenant, with the production states rather than a shortcut:
 *
 *   - the PROFILE production onboarding creates (partner.service): a Rider
 *     (DELIVERY, MOTORCYCLE) or a Driver (CAR, its taxonomy class and seats,
 *     an H plate — the taxi plate rule), on a fictional "Demo" vehicle;
 *   - the country's MOVER CHECKLIST for that vehicle (country-config
 *     getMoverChecklist — the list the go-online gate reads), each type an
 *     approved submission written by the verification service (the one writer
 *     of VerificationDocument: commitReviewFixtureDocument, which refuses any
 *     account outside a REVIEW tenant) and COMMITTED by the state machine, so
 *     the database's own trigger writes its VALID document_record (the evidence
 *     the gate counts) and its renewal schedule. They are the legacy
 *     APPROVED-insert shape the state machine documents ("a legacy APPROVED
 *     insert gets one too"): no review case and no decision row, because no
 *     human reviewed a fiction — and a decision row would append a fictional
 *     reviewer to the platform-wide audit chain, outside the tenant. Every one
 *     is marked a review fixture (reviewedBy, reviewNote), stores NO file
 *     (fileUrl '' — the code's own "nothing stored" state: no image of any ID
 *     exists, purge touches no storage), and carries no consent row (no person
 *     consented to anything). The taxi's insurance is the HIRE class, confirmed
 *     and plate-cross-checked, exactly the three facts the hire-insurance gate
 *     demands;
 *   - an approved identity document lifts the account to L2 (promoteToL2);
 *   - the profile photo go-online requires is DRAWN here (pack-image.ts:
 *     "DEMO RIDER" / "DEMO DRIVER" lettering on a colour), served from the
 *     public avatars tree like the pack's item pictures. It is never a camera
 *     image, so it can never stand in for a face: the identity flows refuse it
 *     (object-authority resolveSignupSelfie accepts only an owned upload).
 *
 * What the fiction never gets: a subscription row (it has no money rail; see
 * demo-policy weeklyFeeMissingRowPolicy), a trial grant, an identity-graph
 * capture, a notification, an SMS or any provider call. Idempotent: a partner
 * whose evidence is all VALID is left alone; a lapsed or retired type gets a
 * fresh fixture (the newer commit supersedes the older, as a renewal does);
 * the vehicle heals back to the pack's. Only synthetic accounts that hold a
 * RIDER/DRIVER credential of a REVIEW tenant are ever touched — the caller
 * (content-pack seedReviewContentPack) has asserted the tenant first.
 */
import type { CoverageClass, PrismaClient, RiderType, VehicleType } from '@prisma/client';
import { CountryConfigService } from '../country/country-config.service';
import { approvedEvidenceFor } from '../verification/evidence';
import { AUTO_APPROVE_EXPIRY_DAYS, IDENTITY_DOC_TYPES } from '../verification/doc-registry';
import { VEHICLE_CLASSES } from '../../config/vehicle-classes';
import { renderPackPicture } from './pack-image';

export type PartnerRole = 'RIDER' | 'DRIVER';

interface PartnerSpec {
  key: string;
  role: PartnerRole;
  /** The drawn profile photo: lettering and background. */
  portrait: { title: string; colour: string };
  vehicleType: VehicleType;
  riderType?: RiderType;
  vehicle: { make: string; model: string; year: number; colour: string; plate: string };
  insurance: { insurerName: string; policyNumber: string; coverageClass: CoverageClass };
}

/** Fiction only: "Demo" vehicles, plates no Guyana registry issues (letters spelling DEMO). */
export const REVIEW_PACK_PARTNERS: Readonly<Record<PartnerRole, PartnerSpec>> = {
  RIDER: {
    key: 'rider', role: 'RIDER', portrait: { title: 'Demo Rider', colour: '#2e7d4f' },
    vehicleType: 'MOTORCYCLE', riderType: 'DELIVERY',
    vehicle: { make: 'Demo', model: 'Motorbike 125', year: 2022, colour: 'Red', plate: 'DEMO 2' },
    insurance: { insurerName: 'Demo Insurer (fictional)', policyNumber: 'REVIEW-DEMO-RIDER', coverageClass: 'PRIVATE' },
  },
  DRIVER: {
    key: 'driver', role: 'DRIVER', portrait: { title: 'Demo Driver', colour: '#1f6f8b' },
    vehicleType: 'CAR',
    vehicle: { make: 'Demo', model: 'Sedan', year: 2021, colour: 'White', plate: 'H DEMO 1' },
    insurance: { insurerName: 'Demo Insurer (fictional)', policyNumber: 'REVIEW-DEMO-TAXI', coverageClass: 'HIRE' },
  },
};

/** Who "approved" a fixture document: the pack itself, never a person. */
export const REVIEW_PACK_REVIEWER = 'review-pack-v1';
export const REVIEW_FIXTURE_NOTE =
  "Store-review fixture (review-pack-v1): a fictional document for the App Review demo partner. No real person, licence or vehicle; no file was uploaded and nobody reviewed it.";
const PORTRAIT_CAPTION = 'Swift App Review demo';

/** Where a partner's drawn profile photo lives (public avatars tree). */
export const REVIEW_PARTNER_PORTRAIT_DIR = 'review-pack/v1/';
export function partnerPortraitUrl(role: PartnerRole): string {
  return `/uploads/avatars/${REVIEW_PARTNER_PORTRAIT_DIR}${REVIEW_PACK_PARTNERS[role].key}.png`;
}

const PORTRAIT = /^([a-z]{1,16})\.png$/;
const portraitCache = new Map<string, Buffer>();

/** The PNG for `<partner>.png` under REVIEW_PARTNER_PORTRAIT_DIR, or null for any name the pack does not declare. */
export function reviewPartnerPortrait(file: string): Buffer | null {
  const m = PORTRAIT.exec(file);
  if (!m) return null;
  const spec = Object.values(REVIEW_PACK_PARTNERS).find((p) => p.key === m[1]);
  if (!spec) return null;
  const cached = portraitCache.get(spec.key);
  if (cached) return cached;
  const png = renderPackPicture({ title: spec.portrait.title, caption: PORTRAIT_CAPTION, background: spec.portrait.colour });
  portraitCache.set(spec.key, png);
  return png;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface PartnerRoleFacts {
  /** RIDER/DRIVER credentials minted for the tenant. */
  credentials: number;
  /** Of those, accounts that would pass the go-online document gate now. */
  ready: number;
}
export interface ReviewPartnerFacts {
  RIDER: PartnerRoleFacts;
  DRIVER: PartnerRoleFacts;
  /** Partner profiles the pack has created at all (ABSENT vs INCOMPLETE). */
  profiles: number;
}

type Db = PrismaClient;

/** The partner accounts a REVIEW tenant's credentials name — synthetic accounts in that tenant only. */
async function partnerAccounts(db: Db, tenantId: string) {
  const creds = await db.reviewCredential.findMany({
    where: { tenantId, role: { in: ['RIDER', 'DRIVER'] }, tenant: { kind: 'REVIEW' } },
    select: { role: true, identifier: true },
    orderBy: { rotatedAt: 'asc' },
  });
  const accounts: Array<{ role: PartnerRole; user: { id: string; isSynthetic: boolean; countryCode: string; selfieCapturedAt: Date | null; avatar: string | null; trustLevel: string } | null }> = [];
  for (const c of creds) {
    const user = await db.user.findFirst({
      where: { tenantId, phone: c.identifier },
      select: { id: true, isSynthetic: true, countryCode: true, selfieCapturedAt: true, avatar: true, trustLevel: true },
    });
    accounts.push({ role: c.role as PartnerRole, user });
  }
  return accounts;
}

/** What the checklist still lacks for this account now — by THE evidence query the gates read. */
async function missingEvidence(db: Db, role: PartnerRole, userId: string, countryCode: string, now: Date): Promise<string[]> {
  const spec = REVIEW_PACK_PARTNERS[role];
  const checklist = await new CountryConfigService(db).getMoverChecklist(countryCode, spec.vehicleType);
  const rows = await approvedEvidenceFor(db, userId, checklist, now);
  const held = new Set(rows.map((r) => r.docType));
  const missing = checklist.filter((t) => !held.has(t));
  if (role === 'DRIVER') {
    // A held policy that is not confirmed hire-class fails the taxi gate: renew it.
    // (The verification service names the policy type: the registry, not this file, owns it.)
    const { hireInsuranceShortfall } = await import('../verification/verification.service');
    const shortfall = hireInsuranceShortfall(rows);
    if (shortfall && !missing.includes(shortfall)) missing.push(shortfall);
  }
  return missing;
}

async function profileOf(db: Db, role: PartnerRole, userId: string): Promise<boolean> {
  return role === 'RIDER'
    ? (await db.rider.count({ where: { userId } })) === 1
    : (await db.driver.count({ where: { userId } })) === 1;
}

export async function reviewPartnerFacts(db: Db, tenantId: string, now = new Date()): Promise<ReviewPartnerFacts> {
  const facts: ReviewPartnerFacts = { RIDER: { credentials: 0, ready: 0 }, DRIVER: { credentials: 0, ready: 0 }, profiles: 0 };
  for (const { role, user } of await partnerAccounts(db, tenantId)) {
    facts[role].credentials += 1;
    if (!user || !user.isSynthetic) continue;
    const hasProfile = await profileOf(db, role, user.id);
    if (hasProfile) facts.profiles += 1;
    if (hasProfile && user.selfieCapturedAt && (await missingEvidence(db, role, user.id, user.countryCode, now)).length === 0) facts[role].ready += 1;
  }
  return facts;
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** A fixture's expiry: the conservative default the automatic path applies; none for a non-expiring type. */
function fixtureExpiry(docType: string, now: Date): Date | null {
  const days = AUTO_APPROVE_EXPIRY_DAYS[docType];
  return days ? new Date(now.getTime() + days * DAY_MS) : null;
}

/** One approved fixture submission, written by the verification service (the one writer of
 *  VerificationDocument) and COMMITTED on insert; the trigger writes its VALID record in the account's tenant.
 *  Loaded at call time: the picture route imports this module and must stay light. */
async function commitFixtureDocument(db: Db, spec: PartnerSpec, userId: string, docType: string, now: Date): Promise<void> {
  const { commitReviewFixtureDocument } = await import('../verification/verification.service');
  await commitReviewFixtureDocument(db, {
    userId, docType, expiresAt: fixtureExpiry(docType, now), reviewedBy: REVIEW_PACK_REVIEWER, reviewedAt: now, reviewNote: REVIEW_FIXTURE_NOTE,
    // Applied by the service to the insurance policy document only.
    insurance: {
      insurerName: spec.insurance.insurerName,
      policyNumber: spec.insurance.policyNumber,
      coverageClass: spec.insurance.coverageClass,
      hireClassConfirmed: spec.insurance.coverageClass === 'HIRE',
      plateCrossChecked: spec.insurance.coverageClass === 'HIRE',
    },
  });
}

async function ensureProfile(db: Db, spec: PartnerSpec, userId: string): Promise<void> {
  const vehicle = {
    vehicleMake: spec.vehicle.make, vehicleModel: spec.vehicle.model, vehicleYear: spec.vehicle.year,
    vehicleColor: spec.vehicle.colour, licensePlate: spec.vehicle.plate,
  };
  if (spec.role === 'RIDER') {
    const profile = { riderType: spec.riderType ?? 'DELIVERY', vehicleType: spec.vehicleType, ...vehicle };
    await db.rider.upsert({ where: { userId }, create: { userId, ...profile }, update: profile });
    return;
  }
  // The taxonomy is the authority for what the vehicle is: its class and seats (partner.service).
  const taxonomy = VEHICLE_CLASSES[spec.vehicleType];
  const profile = { vehicleType: spec.vehicleType, rideClass: taxonomy?.rideClass ?? 'ECONOMY', vehicleCapacity: taxonomy?.seats ?? 4, ...vehicle };
  await db.driver.upsert({
    where: { userId },
    // The legacy URL columns are filled during onboarding; the checklist evidence is what gates GO.
    create: { userId, ...profile, driverLicenseUrl: '', vehicleInsuranceUrl: '' },
    update: profile,
  });
}

export interface PartnerSeedResult extends ReviewPartnerFacts {
  /** Fixture documents committed by this run (0 on an idempotent re-run). */
  documentsCommitted: number;
}

/**
 * Makes every RIDER/DRIVER credential account of `tenantId` a verified partner.
 * The caller has asserted `tenantId` is a purge-protected REVIEW tenant; this
 * also reads credentials only through a REVIEW tenant and touches only
 * synthetic accounts, so it cannot reach a production person whatever it is handed.
 */
export async function seedReviewPartners(db: Db, tenantId: string, now = new Date()): Promise<PartnerSeedResult> {
  let documentsCommitted = 0;
  for (const { role, user } of await partnerAccounts(db, tenantId)) {
    if (!user || !user.isSynthetic) continue;
    const spec = REVIEW_PACK_PARTNERS[role];
    await ensureProfile(db, spec, user.id);
    // The drawn photo stands in for the signup selfie the go-online gate requires.
    // A reviewer's own in-app selfie, if they took one, is left alone.
    if (!user.selfieCapturedAt || !user.avatar) {
      await db.user.update({ where: { id: user.id }, data: { avatar: partnerPortraitUrl(role), selfieCapturedAt: now } });
    }
    for (const docType of await missingEvidence(db, role, user.id, user.countryCode, now)) {
      await commitFixtureDocument(db, spec, user.id, docType, now);
      documentsCommitted += 1;
    }
    // An approved identity document is L2, exactly as the approval path promotes it.
    if (user.trustLevel === 'L1') {
      const checklist = await new CountryConfigService(db).getMoverChecklist(user.countryCode, spec.vehicleType);
      if (checklist.some((t) => IDENTITY_DOC_TYPES.includes(t))) await db.user.update({ where: { id: user.id }, data: { trustLevel: 'L2' } });
    }
  }
  return { ...(await reviewPartnerFacts(db, tenantId, now)), documentsCommitted };
}
