import { Prisma, type PrismaClient, type VerificationDocument, type UserRole, type VehicleType } from '@prisma/client';
import type { ReviewQueue } from '@prisma/client';
import { shredAndProbe, writeDeletionReceipt, NOTHING_STORED } from './purge-receipt';
import { biometricFaceMatchEnabled } from '../../lib/biometric-guard';
import { AppError, NotFoundError } from '../../utils/errors';
import { CountryConfigService } from '../country/country-config.service';
import { isPassengerVehicle } from '../../config/vehicle-classes';
import { NotificationService, notifyAdmins, tenantOfUser } from '../notification/notification.service';
import type { KycProvider, KycVerificationResult } from '../../providers/kyc/kyc-provider';
import { planExtraction, persistExtraction, recordExtractionMetrics, UNKNOWN_ENGINE, type ExtractionPlan } from './extraction-ledger';
import { registryCode } from './doc-registry';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { FloatService } from '../dispatch/float.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { SearchService } from '../search/search.service';
import {
  projectProviderVerificationLocked,
  reconcileProviderVerifications,
  refreshProviderVerification,
} from '../services/services.service';

/** Checklist keys come from CountryConfig.documentChecklists. */
export type ChecklistRole = 'MOVER' | 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE' | 'SERVICE_PROVIDER';

/** L2 identity rows use this synthetic docType (not part of any checklist). */
export const IDENTITY_DOC_TYPE = 'identity_l2';

/** Checklist docTypes that ARE a government identity document. These are not
 *  merely OCR-checked: the portrait is face-matched against the operator's
 *  camera-captured signup selfie (master plan §3 — "face-matched to profile
 *  photo"), through the same KycProvider.verifyIdentity seam the L2 flow uses. */
const IDENTITY_FACE_MATCH_DOCS = new Set(['national_id', 'owner_national_id']);

/** Auto-approved documents must still LAPSE (the "verified ≠ valid now" rule).
 *  A human reviewer keys the real printed expiry; the automatic path applies a
 *  conservative default so the daily sweep + reminders always have a date.
 *  Days by docType; absent = non-expiring (e.g. business registration). */
export const AUTO_APPROVE_EXPIRY_DAYS: Record<string, number> = {
  police_clearance: 365,   // Certificate of Character — commonly re-issued yearly
  fitness_cert: 365,       // annual fitness
  vehicle_insurance: 365,  // annual policy
  hire_car_permit: 365,    // annual occupational permit
  road_service_licence: 365, // annual commercial road-service licence
  food_handler_cert: 365,  // annual health cert
  gra_restaurant_licence: 365,
  drivers_licence: 3 * 365,
  vehicle_registration: 3 * 365,
};

/**
 * [A-19] Which document types carry a printed expiry.
 *
 * DERIVED from the map above rather than re-listed, so the two cannot drift.
 * "Absent = non-expiring" was already this file's rule; it was simply never
 * enforced on the manual path.
 */
export const EXPIRING_DOC_TYPES: readonly string[] = Object.freeze(Object.keys(AUTO_APPROVE_EXPIRY_DAYS));

export function docTypeExpires(docType: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUTO_APPROVE_EXPIRY_DAYS, docType);
}

/**
 * [A-19] The expiry an approval will actually store, or a refusal.
 *
 * Two defects lived on one line — `expiresAt: expiresAt ?? null`:
 *
 *  1. A licence, insurance policy or permit approved with no date became
 *     PERMANENTLY valid. The readiness query treats a null expiry as
 *     never-expiring (`OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]`),
 *     and the daily lapse sweep only looks at rows that HAVE a date, so nothing
 *     downstream would ever catch it.
 *  2. Approving a document that already carried an auto-assigned expiry (the
 *     submission path sets one from the same map) WIPED it back to null. The
 *     admin UI has never sent an expiry, so this was the normal case.
 *
 * A supplied date wins; otherwise the one already on the row stands; and for a
 * type that expires, one of them must exist and must be in the future.
 */
export function resolveApprovalExpiry(
  docType: string,
  supplied: Date | undefined,
  existing: Date | null,
  now: Date = new Date(),
): Date | null {
  const effective = supplied ?? existing ?? null;
  if (!docTypeExpires(docType)) return effective;
  if (!effective) {
    throw new AppError(
      400,
      'EXPIRY_REQUIRED',
      `A ${docType.replace(/_/g, ' ')} carries a printed expiry date. Key the date from the document before approving it.`,
    );
  }
  if (effective.getTime() <= now.getTime()) {
    throw new AppError(
      400,
      'EXPIRY_IN_PAST',
      `That expiry date has already passed. An expired ${docType.replace(/_/g, ' ')} cannot be approved.`,
    );
  }
  return effective;
}

/** Insurance 5-point manual check captured during admin review (spec §3.4). */
export interface InsuranceReview {
  insurerName: string;
  policyNumber: string;
  coverageClass: 'HIRE' | 'PRIVATE';
  hireClassConfirmed: boolean;
  plateCrossChecked: boolean;
}

export interface VerificationReviewObserver {
  /** Deterministic race-test seam. It observes the non-authoritative candidate
   * read; the later conditional transition remains the sole winner boundary. */
  afterPendingRead?: (snapshot: Readonly<{
    docId: string;
    userId: string;
    requestedStatus: 'APPROVED' | 'REJECTED';
  }>) => Promise<void>;
}

const REMINDER_WINDOW_DAYS = 30;

/** Rejection reason codes (onboarding spec §9.3) — templated openings so
 *  applicants get consistent, actionable messages across reviewers. */
export const REJECTION_REASON_CODES = [
  'EXPIRED', 'UNREADABLE', 'WRONG_DOCUMENT', 'FACE_MISMATCH', 'NAME_MISMATCH',
  'INSURANCE_NOT_HIRE', 'NOT_YELLOW', 'SUSPECTED_TAMPERING', 'DUPLICATE', 'INCOMPLETE',
] as const;
export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];
/** [DOC-1 §13] 24 hours from REVIEW_QUEUED to decision. */
export const REVIEW_SLA_HOURS = Number(process.env['REVIEW_SLA_HOURS'] ?? 24);
/**
 * [DOC-1 §8.5] What the actor is told is a CATEGORY — never the reviewer's
 * internal note and never the internal reason. The rows are the spec's table:
 * QUALITY (unreadable / missing page), EXPIRED, REQUIREMENT (the document does
 * not meet the requirement for the account type — wrong type, class, colour,
 * insurance scope), ACCOUNT_MISMATCH (details do not match the account), and
 * UNVERIFIABLE for the fraud class — alteration, duplicate across accounts, not
 * issued to the submitter (a face mismatch is exactly that) — which must read
 * IDENTICALLY: never tell a fraudster which signal caught them.
 */
export const ACTOR_FACING_CATEGORY: Record<RejectionReasonCode, string> = {
  UNREADABLE: 'QUALITY', INCOMPLETE: 'QUALITY',
  EXPIRED: 'EXPIRED',
  WRONG_DOCUMENT: 'REQUIREMENT', INSURANCE_NOT_HIRE: 'REQUIREMENT', NOT_YELLOW: 'REQUIREMENT',
  NAME_MISMATCH: 'ACCOUNT_MISMATCH',
  SUSPECTED_TAMPERING: 'UNVERIFIABLE', DUPLICATE: 'UNVERIFIABLE', FACE_MISMATCH: 'UNVERIFIABLE',
};

const REJECTION_TEMPLATES: Record<RejectionReasonCode, string> = {
  EXPIRED: 'This document has expired — upload a current one.',
  UNREADABLE: 'The photo is too blurry or dark to read — retake it in good light.',
  WRONG_DOCUMENT: 'This is not the document we asked for.',
  FACE_MISMATCH: 'The photo does not match your selfie — upload your own document.',
  NAME_MISMATCH: 'The name on this document does not match your account.',
  INSURANCE_NOT_HIRE: 'This policy does not cover hire/passenger use — taxi work needs HIRE-class insurance.',
  NOT_YELLOW: 'The vehicle must be Corporate Yellow with the H plate visible.',
  SUSPECTED_TAMPERING: 'This document appears edited or altered.',
  DUPLICATE: 'This document is already registered to another account.',
  INCOMPLETE: 'Part of the document is cut off — capture the whole page.',
};

/** Which app surface a document notification belongs to: operator docs go to
 *  the driver/business surface, never the shopping feed; L2 identity is the
 *  customer's own. */
function audienceForRole(role: string): 'customer' | 'earner' | 'business' {
  if (role === 'MOVER') return 'earner';
  if (role === 'CUSTOMER') return 'customer';
  return 'business';
}

export class VerificationService {
  private countryConfig: CountryConfigService;
  private subscriptions: SubscriptionService;

  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
    private kyc: KycProvider,
    private reviewObserver?: VerificationReviewObserver,
  ) {
    this.countryConfig = new CountryConfigService(prisma);
    this.subscriptions = new SubscriptionService(prisma);
  }

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------


  /** [REPORT-022 F-022-09] The write-side of the deletion barrier: a FOR SHARE
   *  read of the User row inside the same transaction as a PII insert blocks
   *  against deletion's FOR UPDATE — so a request that observed ACTIVE, then
   *  paused (KYC latency), cannot land new PII after the purge committed. */
  private async createDocumentLively(
    data: Prisma.VerificationDocumentUncheckedCreateInput,
    review: { queue: ReviewQueue; extraction?: ExtractionPlan } = { queue: 'STANDARD' },
  ) {
    const doc = await this.prisma.$transaction(async (tx) => {
      const alive = await tx.$queryRaw<{ status: string; tenantId: string }[]>(
        Prisma.sql`SELECT status, "tenantId" FROM users WHERE id = ${data.userId} FOR SHARE`,
      );
      const status = alive[0]?.status;
      if (!status || ['DEACTIVATED', 'BANNED', 'SUSPENDED'].includes(status)) {
        throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active — documents cannot be submitted.');
      }
      const doc = await tx.verificationDocument.create({ data });
      // [DOC-1 P4-5] A document waiting on a human has ONE open case, with the
      // SLA clock started here — in the same transaction, so a pending document
      // without a case cannot exist.
      if (doc.status === 'PENDING') {
        const queuedAt = new Date(); // one clock for both: the SLA is exactly REVIEW_SLA_HOURS from queueing
        await tx.reviewCase.create({ data: {
          submissionId: doc.id, tenantId: alive[0]!.tenantId, queue: review.queue,
          createdAt: queuedAt, slaDueAt: new Date(queuedAt.getTime() + REVIEW_SLA_HOURS * 3_600_000),
        } });
      }
      // [DOC-1 P4-4] The processor result lands as rows in the same transaction:
      // a submission without its extraction ledger cannot exist.
      if (review.extraction) {
        await persistExtraction(tx, { submissionId: doc.id, tenantId: alive[0]!.tenantId, plan: review.extraction });
      }
      return doc;
    });
    if (review.extraction) recordExtractionMetrics(review.extraction);
    return doc;
  }

  /**
   * [DOC-1 P4-4] Plan the ledger rows for a processor result: the registry's
   * declared fields for this document type, the engine that ran, its timing,
   * and the cross-subject collision flag. Pure over its inputs (one registry read).
   */
  private async planExtractionFor(
    countryCode: string,
    docType: string,
    result: KycVerificationResult & { collided?: boolean },
    timing: { startedAt: Date; finishedAt: Date },
  ): Promise<ExtractionPlan> {
    const type = await this.prisma.docType.findUnique({
      where: { code: registryCode(countryCode, docType) },
      select: { extractionProfile: true, fields: { select: { fieldCode: true, isRequired: true, isBlindIndexed: true } } },
    });
    return planExtraction({
      declared: type?.fields ?? [],
      profileCode: type?.extractionProfile ?? 'UNPROFILED',
      engine: this.kyc.engine ?? UNKNOWN_ENGINE,
      extracted: result.extracted,
      startedAt: timing.startedAt,
      finishedAt: timing.finishedAt,
      collided: result.collided === true,
    });
  }

  async submitDocument(
    userId: string,
    roleKey: ChecklistRole,
    docType: string,
    fileUrl: string,
    privacyNoticeVersion: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, countryCode: true, avatar: true, selfieCapturedAt: true, status: true },
    });
    if (!user) throw new NotFoundError('User', userId);
    // [NR-3 gap 3, REPORT-022 F-022-13] Deletion write barrier as a DENY-LIST:
    // deletion-terminal states never grow identity documents, but
    // PENDING_VERIFICATION is exactly the state that MUST submit documents —
    // the same set auth.ts cuts off, nothing more.
    if (['DEACTIVATED', 'BANNED', 'SUSPENDED'].includes(user.status)) {
      throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active — documents cannot be submitted.');
    }

    // Movers (riders + taxi drivers) may submit any doc required for a vehicle
    // class they actually hold; other roles validate against their named
    // checklist. [STRAND-3] The old hard-coded CAR list made country-required
    // COMMERCIAL types (road_service_licence for BUS/cargo classes)
    // UNSUBMITTABLE through this API — the mover's persisted profiles decide.
    const checklist = roleKey === 'MOVER'
      ? await this.moverSubmittableChecklist(user.countryCode, userId)
      : await this.checklistFor(userId, user.countryCode, roleKey);
    if (!checklist.includes(docType)) {
      throw new AppError(400, 'INVALID_DOC_TYPE', `${docType} is not required for ${roleKey} in your country`);
    }

    // A document valid beyond the renewal window can't be re-submitted; once it
    // enters the 30-day reminder window the renewal is accepted early, so the
    // operator is never forced offline waiting for a lapse-then-reupload cycle.
    const renewalOpensAt = new Date(Date.now() + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const alreadyApproved = await this.prisma.verificationDocument.findFirst({
      where: {
        userId,
        docType,
        status: 'APPROVED',
        OR: [{ expiresAt: null }, { expiresAt: { gt: renewalOpensAt } }],
      },
    });
    if (alreadyApproved) {
      // A retry after a prior side-effect failure is also a projection replay:
      // repair any stale provider flag before returning the same 409 contract.
      await refreshProviderVerification(this.prisma, userId);
      throw new AppError(409, 'ALREADY_APPROVED', `Your ${docType} is already verified`);
    }

    // Identity documents get the full ID + face-match check against the
    // operator's signup selfie; every other document is a plain doc check.
    let result;
    const startedAt = new Date();
    // [DOC-1 §0.5 · FD-D5 · CONFLICT-DOC-2] The biometric leg runs only while
    // the kill switch is on (default); off, an identity document is verified
    // like any other document — no face leaves the building.
    if (IDENTITY_FACE_MATCH_DOCS.has(docType) && biometricFaceMatchEnabled()) {
      if (!user.avatar || !user.selfieCapturedAt) {
        throw new AppError(400, 'SELFIE_REQUIRED', 'Take your profile selfie before submitting your ID — we match the two faces.');
      }
      result = await this.kyc.verifyIdentity({ userId, idDocumentUrl: fileUrl, selfieUrl: user.avatar });
    } else {
      result = await this.kyc.verifyDocument({ userId, docType, fileUrl });
    }
    const finishedAt = new Date();

    // Enforcement ladder rung 2/3 (trial-integrity Part 4): a HELD account
    // (velocity REVIEW_FIRST / fraud-tier hold) is never auto-approved — the
    // document goes to a HUMAN with the identity panel open. Auto-reject
    // stays: a bad document is a bad document.
    if (result.status === 'approved') {
      const { hasActiveHold } = await import('../integrity/enforcement');
      const hold = await hasActiveHold(this.prisma, userId);
      if (hold.held) {
        result = { ...result, status: 'pending_manual' as const };
      }
    }
    result = await this.holdOnCrossSubjectCollision(userId, roleKey, fileUrl, result);

    // [DOC-1 P4-4 · §0.5] The result lands as rows; a blocking validator FAIL (a
    // required field the processor could not read) forbids auto-approval — never
    // past a FAIL. The human sees the empty field set and keys it (T6).
    const extraction = await this.planExtractionFor(user.countryCode, docType, result, { startedAt, finishedAt });
    if (extraction.blockingFail && result.status === 'approved') {
      result = { ...result, status: 'pending_manual' as const, reason: 'Required fields could not be read from the document — human review' };
    }

    const autoExpiryDays = AUTO_APPROVE_EXPIRY_DAYS[docType];
    const doc = await this.createDocumentLively({
        userId,
        role: this.roleKeyToUserRole(roleKey),
        docType,
        fileUrl,
        kycRef: result.referenceToken,
        consentAt: new Date(),
        privacyNoticeVersion,
        status:
          result.status === 'approved' ? 'APPROVED'
          : result.status === 'rejected' ? 'REJECTED'
          : 'PENDING',
        ...(result.status === 'approved' && {
          reviewedBy: 'kyc:auto',
          reviewedAt: new Date(),
          // Auto-approvals lapse on a conservative default so the expiry
          // sweep + 30-day reminders always fire; humans key the real date.
          ...(autoExpiryDays && { expiresAt: new Date(Date.now() + autoExpiryDays * 24 * 60 * 60 * 1000) }),
        }),
        ...(result.status === 'rejected' && { reviewedBy: 'kyc:auto', reviewedAt: new Date(), reviewNote: result.reason }),
    }, { queue: (result as { collided?: boolean }).collided ? 'SECOND_REVIEW' : 'STANDARD', extraction });

    // Provider listability is the first post-document projection. Everything
    // below (audit, integrity, notifications, trials) may fail independently;
    // none may strand an approved provider hidden or a rejected provider live.
    if (doc.status !== 'PENDING') {
      await refreshProviderVerification(this.prisma, userId);
    }

    await this.recordDecision(userId, doc.id, docType, doc.status, result.reason);

    // Identity-integrity capture (silent): the analyzer's parsed document
    // number is hashed and discarded — never stored raw. AWAITED so the
    // signal exists before afterApproval reaches the trial decision; the
    // service swallows its own failures (capture never breaks verification).
    if (result.extracted?.documentNumber) {
      const { IdentityService } = await import('../integrity/identity.service');
      const { normalizeDocNumber } = await import('../integrity/normalize');
      await new IdentityService(this.prisma).capture({
        accountId: userId, actorRole: roleKey,
        type: 'ID_DOC_NUMBER', normalizedValue: normalizeDocNumber(result.extracted.documentNumber), source: 'AI_ID_ANALYZER',
      });
    }

    if (doc.status === 'APPROVED') await this.afterApproval(userId);
    if (doc.status === 'REJECTED') await this.notifyRejection(userId, docType, result.reason);
    // Manual-review path: the queue is invisible until an admin is told about
    // it — found live: documents (and whole onboardings) sat PENDING for weeks.
    if (doc.status === 'PENDING') {
      await notifyAdmins(this.prisma, this.notifications, {
        // Follows the submitter [NOC-A F45].
        tenantId: await tenantOfUser(this.prisma, userId),
        title: 'Verification review needed',
        body: `A ${docType.replace(/_/g, ' ')} (${roleKey}) is waiting in the review queue.`,
        data: { kind: 'verification_pending', docId: doc.id },
      });
    }

    return doc;
  }

  /** L2 customer verification: ID + selfie. Approval is permanent. */
  async submitIdentity(
    userId: string,
    idDocumentUrl: string,
    selfieUrl: string,
    privacyNoticeVersion: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, trustLevel: true, countryCode: true } });
    if (!user) throw new NotFoundError('User', userId);
    if (user.trustLevel !== 'L1') {
      throw new AppError(409, 'ALREADY_VERIFIED', 'Identity is already verified');
    }

    // [DOC-1 §0.5 · FD-D5] Biometric off → the L2 identity document is verified
    // document-only; the selfie is not sent anywhere.
    const startedAt = new Date();
    let result = biometricFaceMatchEnabled()
      ? await this.kyc.verifyIdentity({ userId, idDocumentUrl, selfieUrl })
      : await this.kyc.verifyDocument({ userId, docType: 'national_id', fileUrl: idDocumentUrl });
    const finishedAt = new Date();
    result = await this.holdOnCrossSubjectCollision(userId, 'MOVER', idDocumentUrl, result);
    // Rung 2/3: held accounts are never auto-approved (see submitDocument).
    if (result.status === 'approved') {
      const { hasActiveHold } = await import('../integrity/enforcement');
      if ((await hasActiveHold(this.prisma, userId)).held) {
        result = { ...result, status: 'pending_manual' as const };
      }
    }
    // [DOC-1 P4-4 · §0.5] Ledger rows for the identity check; a blocking FAIL is never auto-approved.
    const extraction = await this.planExtractionFor(user.countryCode, IDENTITY_DOC_TYPE, result, { startedAt, finishedAt });
    if (extraction.blockingFail && result.status === 'approved') {
      result = { ...result, status: 'pending_manual' as const, reason: 'Required fields could not be read from the document — human review' };
    }

    const doc = await this.createDocumentLively({
        userId,
        role: 'CUSTOMER',
        docType: IDENTITY_DOC_TYPE,
        fileUrl: idDocumentUrl,
        kycRef: result.referenceToken,
        consentAt: new Date(),
        privacyNoticeVersion,
        status:
          result.status === 'approved' ? 'APPROVED'
          : result.status === 'rejected' ? 'REJECTED'
          : 'PENDING',
        ...(result.status !== 'pending_manual' && { reviewedBy: 'kyc:auto', reviewedAt: new Date() }),
        ...(result.status === 'rejected' && { reviewNote: result.reason }),
    }, { queue: (result as { collided?: boolean }).collided ? 'SECOND_REVIEW' : 'STANDARD', extraction });

    await this.recordDecision(userId, doc.id, IDENTITY_DOC_TYPE, doc.status, result.reason);

    // Identity-integrity capture (silent) — hash-and-discard, never stored raw.
    if (result.extracted?.documentNumber) {
      const { IdentityService } = await import('../integrity/identity.service');
      const { normalizeDocNumber } = await import('../integrity/normalize');
      await new IdentityService(this.prisma).capture({
        accountId: userId, actorRole: 'CUSTOMER',
        type: 'ID_DOC_NUMBER', normalizedValue: normalizeDocNumber(result.extracted.documentNumber), source: 'AI_ID_ANALYZER',
      });
    }

    if (doc.status === 'APPROVED') await this.promoteToL2(userId);
    if (doc.status === 'REJECTED') await this.notifyRejection(userId, 'identity', result.reason);
    if (doc.status === 'PENDING') {
      await notifyAdmins(this.prisma, this.notifications, {
        // Follows the submitter [NOC-A F45].
        tenantId: await tenantOfUser(this.prisma, userId),
        title: 'Verification review needed',
        body: 'An identity check (L2) is waiting in the review queue.',
        data: { kind: 'verification_pending', docId: doc.id },
      });
    }

    return doc;
  }

  /** [STRAND-2 belt] Reconcile vendor activation projections against document
   *  truth. The decision transaction keeps NEW decisions atomic; this heals
   *  history — a pre-slice-1 stranded vendor (checklist complete, still
   *  PENDING_APPROVAL), a crash-era stale flag, or a manual DB change. Same
   *  semantics as the in-transaction projection: two-way isVerified,
   *  acceptingOrders on the false→true edge, PENDING_APPROVAL→ACTIVE CAS. */
  async reconcileVendorActivations(cap = 500): Promise<number> {
    const owners = await this.prisma.vendorOwner.findMany({
      where: { vendors: { some: { OR: [{ isVerified: true }, { status: 'PENDING_APPROVAL' }] } } },
      select: { userId: true },
      take: cap,
    });
    for (const owner of owners) {
      await this.projectVendorActivation(this.prisma, owner.userId);
    }
    return owners.length;
  }

  /** [STRAND-3] Union of every checklist for vehicle classes this user's
   *  persisted rider/driver profiles actually hold (plus the CAR base so a
   *  profile-less prospective mover can still start with base docs). A BUS or
   *  cargo mover can submit its commercial types; nobody can submit a type no
   *  class of theirs requires. */
  private async moverSubmittableChecklist(countryCode: string, userId: string): Promise<string[]> {
    const [rider, driver] = await Promise.all([
      this.prisma.rider.findUnique({ where: { userId }, select: { vehicleType: true } }),
      this.prisma.driver.findUnique({ where: { userId }, select: { vehicleType: true } }),
    ]);
    const classes = new Set<VehicleType>(['CAR']);
    if (rider?.vehicleType) classes.add(rider.vehicleType);
    if (driver?.vehicleType) classes.add(driver.vehicleType);
    const lists = await Promise.all(
      [...classes].map((vehicleType) => this.countryConfig.getMoverChecklist(countryCode, vehicleType)),
    );
    return [...new Set(lists.flat())];
  }

  // -------------------------------------------------------------------------
  // Manual review queue (admin)
  // -------------------------------------------------------------------------

  async approveDocument(docId: string, adminId: string, expiresAt?: Date, insurance?: InsuranceReview) {
    // [A-19] Read the candidate first: the expiry decision needs the document's
    // TYPE and any date it already carries. This read is not the winner
    // boundary — the conditional transition below still is.
    const candidate = await this.prisma.verificationDocument.findUnique({
      where: { id: docId },
      select: { docType: true, expiresAt: true, status: true },
    });
    if (!candidate) throw new NotFoundError('VerificationDocument', docId);
    // An already-decided document must report NOT_PENDING, not an expiry
    // complaint — the transition below owns that refusal, so only a genuine
    // candidate is asked for its date.
    const effectiveExpiry =
      candidate.status === 'PENDING'
        ? resolveApprovalExpiry(candidate.docType, expiresAt, candidate.expiresAt)
        : (expiresAt ?? candidate.expiresAt ?? null);

    const updated = await this.transitionPendingDocument(docId, 'APPROVED', {
        status: 'APPROVED',
        reviewedBy: adminId,
        reviewedAt: new Date(),
        expiresAt: effectiveExpiry,
        ...(insurance && {
          insurerName: insurance.insurerName,
          policyNumber: insurance.policyNumber,
          coverageClass: insurance.coverageClass,
          hireClassConfirmed: insurance.hireClassConfirmed,
          plateCrossChecked: insurance.plateCrossChecked,
        }),
    }, { reviewerId: adminId });

    if (updated.docType === IDENTITY_DOC_TYPE) {
      await this.promoteToL2(updated.userId);
    } else {
      await this.afterApproval(updated.userId);
    }

    await this.notifications.send({
      userId: updated.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Document approved',
      body: `Your ${updated.docType.replace(/_/g, ' ')} has been approved.`,
      audience: audienceForRole(updated.role),
      data: { kind: 'verification_approved', docId },
    });

    return updated;
  }

  async rejectDocument(docId: string, adminId: string, reason: string, reasonCode?: RejectionReasonCode) {
    // Templated reason codes (onboarding spec §9.3): the code drives a clear,
    // consistent opening line; the reviewer's free text adds the specifics.
    const template = reasonCode ? REJECTION_TEMPLATES[reasonCode] : null;
    const fullReason = template ? (reason ? `${template} ${reason}` : template) : reason;

    const updated = await this.transitionPendingDocument(docId, 'REJECTED', {
        status: 'REJECTED',
        reviewedBy: adminId,
        reviewedAt: new Date(),
        reviewNote: reasonCode ? `[${reasonCode}] ${fullReason}` : fullReason,
    }, { reviewerId: adminId, reasonCode, note: fullReason });

    await this.notifyRejection(updated.userId, updated.docType, fullReason);
    return updated;
  }

  private async transitionPendingDocument(
    docId: string,
    requestedStatus: 'APPROVED' | 'REJECTED',
    data: Prisma.VerificationDocumentUpdateManyMutationInput,
    review: { reviewerId: string; reasonCode?: RejectionReasonCode; note?: string },
  ): Promise<VerificationDocument> {
    const candidate = await this.prisma.verificationDocument.findUnique({
      where: { id: docId },
      select: { userId: true },
    });
    if (!candidate) throw new NotFoundError('VerificationDocument', docId);
    await this.reviewObserver?.afterPendingRead?.({ docId, userId: candidate.userId, requestedStatus });

    const outcome = await this.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "users"
        WHERE "id" = ${candidate.userId}
        FOR UPDATE /* verification-document-decision-authority */
      `;
      if (!users[0]) throw new NotFoundError('User', candidate.userId);

      // This conditional write, not the earlier read, is the decision point.
      // At most one competing approve/reject can transition PENDING. Losers
      // preserve NOT_PENDING and may only reconcile already-committed evidence.
      const won = await tx.verificationDocument.updateMany({
        where: { id: docId, userId: candidate.userId, status: 'PENDING' },
        data,
      });
      if (won.count !== 1) {
        const current = await tx.verificationDocument.findUnique({
          where: { id: docId },
          select: { status: true },
        });
        if (!current) throw new NotFoundError('VerificationDocument', docId);
        // [REPORT-007 / STRAND-2] A terminal retry is a repair opportunity for
        // stale derived state (the duplicate-submission path already repairs
        // before ALREADY_APPROVED). RETURN instead of throwing inside the
        // transaction — an in-transaction throw would roll the repair back —
        // then preserve the unchanged 400 NOT_PENDING contract outside it.
        await projectProviderVerificationLocked(tx, candidate.userId);
        await this.projectVendorActivation(tx, candidate.userId);
        return { kind: 'NOT_PENDING' as const, status: current.status };
      }
      // [DOC-1 P4-5] The decision and the case close with the status change or
      // not at all. A document that predates cases gets one here, so every
      // decision has a case.
      const now = new Date();
      const open = await tx.reviewCase.findFirst({ where: { submissionId: docId, closedAt: null }, orderBy: { createdAt: 'desc' } })
        ?? await tx.reviewCase.create({ data: {
          submissionId: docId, queue: 'STANDARD', slaDueAt: now,
          tenantId: (await tx.user.findUniqueOrThrow({ where: { id: candidate.userId }, select: { tenantId: true } })).tenantId,
        } });
      const approve = requestedStatus === 'APPROVED';
      await tx.reviewDecision.create({ data: {
        caseId: open.id, tenantId: open.tenantId, reviewerId: review.reviewerId,
        outcome: approve ? 'APPROVE' : 'REJECT',
        reasonCode: approve ? 'APPROVED' : (review.reasonCode ?? 'UNSPECIFIED'),
        actorFacingCategory: approve ? 'APPROVED' : (review.reasonCode ? ACTOR_FACING_CATEGORY[review.reasonCode] : 'OTHER'),
        internalNote: review.note ?? null,
        timeOnCaseMs: Math.max(0, now.getTime() - (open.assignedAt ?? open.createdAt).getTime()),
      } });
      await tx.reviewCase.update({ where: { id: open.id }, data: { closedAt: now } });

      const updated = await tx.verificationDocument.findUniqueOrThrow({ where: { id: docId } });
      // The document decision and provider public/hire projection commit as one
      // authority transition under the same User lock used by hire/profile.
      // [STRAND-1/2] The vendor activation projection commits in the SAME
      // transaction: checklist completion → isVerified + PENDING_APPROVAL→
      // ACTIVE promotion can no longer be stranded by a post-commit callback
      // crash, and a rejection de-verifies atomically with its decision.
      await projectProviderVerificationLocked(tx, updated.userId);
      await this.projectVendorActivation(tx, updated.userId);
      return { kind: 'UPDATED' as const, document: updated };
    });
    if (outcome.kind === 'NOT_PENDING') {
      throw new AppError(400, 'NOT_PENDING', `Document is ${outcome.status}, only PENDING documents can be reviewed`);
    }
    return outcome.document;
  }

  /**
   * Review-SLA watchdog (spec §13): documents waiting on a human for more than
   * SLA_HOURS get surfaced to every admin once per sweep — a queue nobody
   * opens is how "24h review" promises die.
   */
  async alertReviewSlaBreaches(slaHours = REVIEW_SLA_HOURS): Promise<number> {
    // [DOC-1 P4-5 · §13] The case table is the queue of record. A breached case
    // is escalated (queue ESCALATED, priority raised) and every admin is told
    // once per sweep — a queue nobody opens is how "24h review" promises die.
    const now = new Date();
    // A pending document with no open case is itself an anomaly (a row that
    // bypassed the submit path, or predates cases): heal it into an ESCALATED
    // case with the SLA it has had since it was queued, so the case table stays
    // the queue of record and nothing waits unseen.
    const caseless = await this.prisma.verificationDocument.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - slaHours * 3600_000) } },
      select: { id: true, createdAt: true, user: { select: { tenantId: true } } },
    });
    for (const d of caseless) {
      const hasOpen = await this.prisma.reviewCase.findFirst({ where: { submissionId: d.id, closedAt: null }, select: { id: true } });
      if (!hasOpen) {
        await this.prisma.reviewCase.create({ data: {
          submissionId: d.id, tenantId: d.user.tenantId, queue: 'ESCALATED', priority: 10,
          createdAt: d.createdAt, slaDueAt: new Date(d.createdAt.getTime() + slaHours * 3600_000),
        } });
      }
    }
    // The converse anomaly: an open case whose document is no longer PENDING
    // (decided or purged outside the transition path). Close it — without a
    // decision, because none was recorded — so the queue of record stays true.
    const staleOpen = await this.prisma.reviewCase.findMany({
      where: { closedAt: null },
      select: { id: true, submissionId: true },
    });
    if (staleOpen.length > 0) {
      const stillPending = new Set((await this.prisma.verificationDocument.findMany({
        where: { id: { in: staleOpen.map((c) => c.submissionId) }, status: 'PENDING' }, select: { id: true },
      })).map((d) => d.id));
      const orphaned = staleOpen.filter((c) => !stillPending.has(c.submissionId)).map((c) => c.id);
      if (orphaned.length > 0) await this.prisma.reviewCase.updateMany({ where: { id: { in: orphaned } }, data: { closedAt: now } });
    }
    const breachedCases = await this.prisma.reviewCase.findMany({
      where: { closedAt: null, slaDueAt: { lt: now } },
      select: { id: true, createdAt: true, priority: true, queue: true },
    });
    if (breachedCases.length === 0) return 0;
    await this.prisma.reviewCase.updateMany({
      where: { id: { in: breachedCases.map((c) => c.id) } },
      data: { priority: 10 },
    });
    await this.prisma.reviewCase.updateMany({
      where: { id: { in: breachedCases.filter((c) => c.queue === 'STANDARD').map((c) => c.id) } },
      data: { queue: 'ESCALATED' },
    });
    const oldest = breachedCases.reduce((a, c) => (c.createdAt < a ? c.createdAt : a), breachedCases[0]!.createdAt);
    const oldestHours = Math.floor((now.getTime() - oldest.getTime()) / 3600_000);
    const breached = breachedCases.length;
    await notifyAdmins(this.prisma, this.notifications, {
      // An aggregate queue-health sweep — platform-wide [NOC-A F45].
      tenantId: null,
      title: 'Verification queue is breaching SLA',
      body: `${breached} review case${breached === 1 ? '' : 's'} ${breached === 1 ? 'has' : 'have'} waited over ${slaHours}h for a decision (oldest ${oldestHours}h). People cannot work until these are decided.`,
      data: { kind: 'verification_sla_breach', breached, slaHours },
    });
    return breached;
  }

  // -------------------------------------------------------------------------
  // Status & gating
  // -------------------------------------------------------------------------

  /**
   * The mover's saved vehicle, or null if no Driver/Rider entity exists yet: a
   * Driver is a taxi (CAR); a Rider carries its own vehicleType. Callers that
   * gate apply a stricter MOTORCYCLE default for the null case.
   */
  private async getMoverVehicleType(userId: string): Promise<VehicleType | null> {
    const driver = await this.prisma.driver.findUnique({ where: { userId }, select: { vehicleType: true } });
    if (driver) return driver.vehicleType;
    const rider = await this.prisma.rider.findUnique({ where: { userId }, select: { vehicleType: true } });
    return rider?.vehicleType ?? null;
  }

  /**
   * The document checklist a role must satisfy. Movers scale to their vehicle so
   * onboarding never asks for documents a vehicle can't have (a bicycle has no
   * licence/insurance) AND what's SHOWN equals what the go-online gate REQUIRES.
   * `vehicleHint` lets the onboarding screen preview a selection before the
   * vehicle is saved; gates pass no hint, so they always use the real entity.
   */
  private async checklistFor(
    userId: string,
    countryCode: string,
    roleKey: ChecklistRole,
    vehicleHint?: VehicleType,
  ): Promise<string[]> {
    if (roleKey === 'MOVER') {
      const vehicleType = vehicleHint ?? (await this.getMoverVehicleType(userId)) ?? 'MOTORCYCLE';
      return this.countryConfig.getMoverChecklist(countryCode, vehicleType);
    }
    if (roleKey === 'SERVICE_PROVIDER') {
      // The standalone services marketplace is not a SERVICE vendor. Its gate
      // is the provider's base country checklist plus any trade-specific legal
      // extension (for example Guyana's GEI electrician licence). Reuse the
      // exact projection that controls public listability.
      const { providerChecklist } = await import('../services/services.service');
      return providerChecklist(this.prisma, userId);
    }
    return this.countryConfig.getDocumentChecklist(countryCode, roleKey);
  }

  async getStatus(userId: string, roleKey: ChecklistRole, vehicleHint?: VehicleType) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { countryCode: true, trustLevel: true },
    });
    if (!user) throw new NotFoundError('User', userId);

    const checklist = await this.checklistFor(userId, user.countryCode, roleKey, vehicleHint);
    const documents = await this.prisma.verificationDocument.findMany({
      where: { userId, docType: { in: [...checklist, IDENTITY_DOC_TYPE] } },
      orderBy: { createdAt: 'desc' },
    });

    const approved = new Set(
      documents
        .filter((d) => d.status === 'APPROVED' && (!d.expiresAt || d.expiresAt > new Date()))
        .map((d) => d.docType),
    );
    const missing = checklist.filter((docType) => !approved.has(docType));

    // The mover's saved vehicle (null until they provision one) — lets the
    // onboarding screen initialise its selector and know whether to re-prompt.
    const vehicleType = roleKey === 'MOVER' ? await this.getMoverVehicleType(userId) : null;

    // Trial-integrity Part 4: told BEFORE they commit — what activation will
    // do for this human (copy #2/#3). Read-only preview: no side effects; the
    // apps render `trial.message` verbatim when present. Vendor checklists are
    // keyed by vendor TYPE; the trial role for all of them is VENDOR.
    const { previewTrial } = await import('../integrity/enforcement');
    const trialRole =
      roleKey === 'MOVER'
        ? (await this.prisma.driver.findUnique({ where: { userId }, select: { id: true } })) ? 'DRIVER' : 'RIDER'
        : 'VENDOR';
    const trial = await previewTrial(this.prisma, userId, trialRole, 'swift-default').catch(() => null);

    return {
      roleKey,
      trustLevel: user.trustLevel,
      checklist,
      documents,
      missing,
      vehicleType,
      roleVerified: missing.length === 0,
      trial,
    };
  }

  /** Gate check: every checklist document approved and unexpired.
   *
   *  [ACTIVATION AUTHORITY — EV-ACT-05 hardening] Fail-closed like the
   *  provider evaluator: an empty/unknown checklist is a CONFIG ERROR, never
   *  vacuous success (a market missing its documentChecklists row must not
   *  silently verify everyone); purged rows, empty file references, and
   *  retention-expired evidence do not count. Accepts a transaction client so
   *  document-decision transactions can project actor activation from the
   *  SAME locked read they commit (role-binding of evidence rows stays a
   *  registered follow-up — cross-role reuse policy is a founder decision). */
  async isRoleVerified(
    userId: string,
    roleKey: ChecklistRole,
    db: Prisma.TransactionClient | PrismaClient = this.prisma,
  ): Promise<boolean> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { countryCode: true } });
    if (!user) return false;

    const checklist = await this.checklistFor(userId, user.countryCode, roleKey);
    if (checklist.length === 0) return false;

    const now = new Date();
    const approvedDocs = await db.verificationDocument.findMany({
      where: {
        userId,
        docType: { in: checklist },
        status: 'APPROVED',
        purgedAt: null,
        fileUrl: { not: '' },
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          { OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: now } }] },
        ],
      },
      select: { docType: true },
    });
    const approved = new Set(approvedDocs.map((d) => d.docType));
    return checklist.every((docType) => approved.has(docType));
  }

  /**
   * [STRAND-1 — the single vendor activation projection] Reconcile every store
   * this user owns against the canonical checklist:
   *  - checklist complete → `isVerified: true`; the false→true edge also
   *    restores `acceptingOrders` (a routine renewal never overrides a
   *    deliberate pause), and a `PENDING_APPROVAL` store is PROMOTED to
   *    `ACTIVE` by CAS — every checklist document was individually approved
   *    through restricted admin review, so completion IS activation. No other
   *    status is ever touched (SUSPENDED/CLOSED stay admin/billing-owned).
   *  - checklist incomplete → `isVerified: false` (cache truth follows
   *    document truth in BOTH directions; listing darkening/notifications
   *    remain with the rejection/expiry flows).
   * Callers inside a document-decision transaction pass `tx` so the projection
   * commits atomically with the decision (STRAND-2); post-commit callers pass
   * the plain client (auto-approval path, repair replays).
   */
  /** [REPORT-013 F-013-06] The wall-clock bound of a role's document
   *  authority: each doc's validity ends at the earliest of its own
   *  expiresAt/retentionExpiresAt (null = unbounded); a checklist type is
   *  bounded by its furthest-out valid approval (a renewal extends it, an
   *  unbounded approval unbinds the type); the role's bound is the tightest
   *  type. Null = nothing expiring bounds the authority. */
  private async checklistEvidenceValidUntil(
    userId: string,
    roleKey: ChecklistRole,
    db: Prisma.TransactionClient | PrismaClient = this.prisma,
  ): Promise<Date | null> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { countryCode: true } });
    if (!user) return null;
    const checklist = await this.checklistFor(userId, user.countryCode, roleKey);
    if (checklist.length === 0) return null;
    const now = new Date();
    const docs = await db.verificationDocument.findMany({
      where: {
        userId, docType: { in: checklist }, status: 'APPROVED', purgedAt: null, fileUrl: { not: '' },
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          { OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: now } }] },
        ],
      },
      select: { docType: true, expiresAt: true, retentionExpiresAt: true },
    });
    const docEnd = (d: { expiresAt: Date | null; retentionExpiresAt: Date | null }): Date | null => {
      if (d.expiresAt == null) return d.retentionExpiresAt;
      if (d.retentionExpiresAt == null) return d.expiresAt;
      return d.expiresAt < d.retentionExpiresAt ? d.expiresAt : d.retentionExpiresAt;
    };
    let bound: Date | null = null;
    for (const docType of checklist) {
      const ofType = docs.filter((d) => d.docType === docType);
      if (ofType.length === 0) continue; // isRoleVerified already refused this state
      const ends = ofType.map(docEnd);
      if (ends.some((e) => e == null)) continue; // an unbounded approval unbinds the type
      const typeBest = ends.reduce((a, b) => (a! > b! ? a : b))!;
      if (bound == null || typeBest < bound) bound = typeBest;
    }
    return bound;
  }

  private async projectVendorActivation(
    db: Prisma.TransactionClient | PrismaClient,
    userId: string,
  ): Promise<void> {
    const owner = await db.vendorOwner.findUnique({
      where: { userId },
      include: { vendors: { select: { id: true, vendorType: true, isVerified: true } } },
    });
    if (!owner) return;
    for (const vendor of owner.vendors) {
      const verified = await this.isRoleVerified(userId, vendor.vendorType as ChecklistRole, db);
      if (verified) {
        const activationValidUntil = await this.checklistEvidenceValidUntil(userId, vendor.vendorType as ChecklistRole, db);
        await db.vendor.update({
          where: { id: vendor.id },
          data: { isVerified: true, activationValidUntil, ...(vendor.isVerified ? {} : { acceptingOrders: true }) },
        });
        await db.vendor.updateMany({
          where: { id: vendor.id, status: 'PENDING_APPROVAL' },
          data: { status: 'ACTIVE' },
        });
      } else if (vendor.isVerified) {
        // [REPORT-012 F-012-05] A negative projection revokes ORDERING too:
        // leaving acceptingOrders on kept an existing cart checkout-able
        // (the checkout gate reads status/open/acceptingOrders, not
        // isVerified) after the store's document authority was gone.
        await db.vendor.update({
          where: { id: vendor.id },
          data: { isVerified: false, acceptingOrders: false, activationValidUntil: null },
        });
      }
    }
  }

  /**
   * Live-operation gate (provisional access ≠ live). A mover may set up a
   * profile while documents are pending, but cannot operate live until the
   * required documents are approved — and a taxi driver also needs current,
   * hire-class motor insurance (spec §3.4, load-bearing rules #5 + #6).
   */
  async getLiveOperationStatus(
    userId: string,
    opts: { vehicleType: VehicleType; legacyVerified?: boolean },
    db: Prisma.TransactionClient | PrismaClient = this.prisma,
  ): Promise<{ allowed: boolean; reason: 'ok' | 'docs' | 'insurance' }> {
    // [EV-ACT-16/17 TOCTOU] Accepts a transaction client so GO can evaluate
    // documents INSIDE its User/profile-locked transaction — an expiry or
    // rejection committing between a pre-transaction check and the online
    // write can no longer slip a stale verdict through. Same fail-closed
    // evidence filters as isRoleVerified (purge/file/retention).
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { countryCode: true },
    });
    if (!user) return { allowed: false, reason: 'docs' };

    const now = new Date();
    let baseOk = opts.legacyVerified ?? false;
    if (!baseOk) {
      const required = await this.countryConfig.getMoverChecklist(user.countryCode, opts.vehicleType);
      if (required.length === 0) {
        baseOk = true;
      } else {
        const approvedDocs = await db.verificationDocument.findMany({
          where: {
            userId,
            docType: { in: required },
            status: 'APPROVED',
            purgedAt: null,
            fileUrl: { not: '' },
            AND: [
              { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
              { OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: now } }] },
            ],
          },
          select: { docType: true },
        });
        const approved = new Set(approvedDocs.map((d) => d.docType));
        baseOk = required.every((docType) => approved.has(docType));
      }
    }
    if (!baseOk) return { allowed: false, reason: 'docs' };

    // Any PASSENGER vehicle (car, wagon, bus): a current, manually-confirmed
    // HIRE-class policy is mandatory before carrying passengers, and the reviewer
    // must have cross-checked the policy's plate against the plate on the
    // registration + photos. PRIVATE insurance never qualifies. Cargo-only movers
    // (bike/motorbike/canter/box-truck) are not gated on hire insurance.
    if (isPassengerVehicle(opts.vehicleType)) {
      const insurance = await db.verificationDocument.findFirst({
        where: {
          userId,
          docType: 'vehicle_insurance',
          status: 'APPROVED',
          purgedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { coverageClass: true, hireClassConfirmed: true, plateCrossChecked: true },
        orderBy: { reviewedAt: 'desc' },
      });
      if (
        !insurance ||
        insurance.coverageClass !== 'HIRE' ||
        !insurance.hireClassConfirmed ||
        !insurance.plateCrossChecked
      ) {
        return { allowed: false, reason: 'insurance' };
      }
    }

    return { allowed: true, reason: 'ok' };
  }

  // -------------------------------------------------------------------------
  // Expiry automation (daily job)
  // -------------------------------------------------------------------------

  /** APPROVED/PENDING docs past their expiry lapse; dependent listings suspend. */
  async expireLapsedDocuments(): Promise<number> {
    // Reconcile first so a prior process failure after marking EXPIRED cannot
    // remain invisible forever merely because the next query skips terminal rows.
    await reconcileProviderVerifications(this.prisma);
    // [STRAND-2 belt] Vendor projections ride the same daily heal.
    await this.reconcileVendorActivations();
    const now = new Date();
    const lapsed = await this.prisma.verificationDocument.findMany({
      where: { status: { in: ['APPROVED', 'PENDING'] }, expiresAt: { lt: now } },
    });

    let expired = 0;
    for (const doc of lapsed) {
      const transitioned = await this.prisma.$transaction(async (tx) => {
        const users = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "users"
          WHERE "id" = ${doc.userId}
          FOR UPDATE /* verification-document-expiry-authority */
        `;
        if (!users[0]) return false;
        const won = await tx.verificationDocument.updateMany({
          where: {
            id: doc.id,
            userId: doc.userId,
            status: { in: ['APPROVED', 'PENDING'] },
            expiresAt: { lt: now },
          },
          data: { status: 'EXPIRED' },
        });
        if (won.count !== 1) return false;
        await projectProviderVerificationLocked(tx, doc.userId);
        // [REPORT-012 F-012-05] The vendor projection rides the SAME expiry
        // transaction — document truth and the derived vendor flags are one
        // generation, not "EXPIRED now, store closes at some later sweep".
        await this.projectVendorActivation(tx, doc.userId);
        return true;
      });
      if (!transitioned) continue;
      expired += 1;

      // L2 is permanent once earned — an expired ID does not demote the user
      if (doc.docType === IDENTITY_DOC_TYPE) continue;

      // A lapsed document takes effect IMMEDIATELY: vendors' listings go dark,
      // and a mover whose live-operation status broke is pulled offline now —
      // not "after they next toggle" (an uninsured taxi must stop getting jobs).
      if (doc.role === 'MOVER') {
        await this.forceMoverOfflineIfNotLive(doc.userId);
      } else {
        await this.suspendListingsIfUnverified(doc.userId);
      }
      await this.notifications.send({
        userId: doc.userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Document expired',
        body: `Your ${doc.docType.replace(/_/g, ' ')} has expired. Upload a new one to keep operating.`,
        audience: audienceForRole(doc.role),
        data: { kind: 'verification_expired', docId: doc.id },
      });
    }

    return expired;
  }

  /** One reminder per document, 30 days before expiry. */
  async sendExpiryReminders(): Promise<number> {
    const soon = new Date(Date.now() + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const expiring = await this.prisma.verificationDocument.findMany({
      where: { status: 'APPROVED', expiresAt: { gt: new Date(), lte: soon } },
    });

    let sent = 0;
    for (const doc of expiring) {
      const alreadyReminded = await this.prisma.notification.findFirst({
        where: {
          userId: doc.userId,
          data: { path: ['docId'], equals: doc.id },
          AND: { data: { path: ['kind'], equals: 'verification_expiry_reminder' } },
        },
        select: { id: true },
      });
      if (alreadyReminded) continue;

      await this.notifications.send({
        userId: doc.userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Document expiring soon',
        body: `Your ${doc.docType.replace(/_/g, ' ')} expires on ${doc.expiresAt!.toISOString().slice(0, 10)}. Renew it to avoid suspension.`,
        audience: audienceForRole(doc.role),
        data: { kind: 'verification_expiry_reminder', docId: doc.id },
      });
      sent += 1;
    }

    return sent;
  }

  // -------------------------------------------------------------------------
  // Retention (DPA §3.5 — delete documents after a participant leaves)
  // -------------------------------------------------------------------------

  /** Schedule a leaving participant's documents for deletion after the
   *  country's retention window. Idempotent; skips already-purged rows. */
  async scheduleDocumentRetention(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { countryCode: true },
    });
    if (!user) return 0;

    const config = await this.countryConfig.getByCode(user.countryCode);
    const deleteAt = new Date(Date.now() + config.dataRetentionDays * 24 * 60 * 60 * 1000);

    const res = await this.prisma.verificationDocument.updateMany({
      where: { userId, purgedAt: null },
      data: { retentionExpiresAt: deleteAt },
    });
    return res.count;
  }

  /**
   * [DOC-1 §7 V_SHA_COLLISION · DOC-INV-11] The SAME bytes already on ANOTHER
   * account never auto-approve: one person opening several accounts, or a
   * reused/forged document. The upload route already tells the reviewers
   * (SWIFT-078); this is the rule at the decision — the provider's verdict is
   * overruled to a human review, and both accounts are linked in the identity
   * graph with a HARD signal (the file's hash — never the document). A bad
   * document is still a bad document: an auto-reject stands.
   */
  private async holdOnCrossSubjectCollision<T extends { status: string; reason?: string }>(
    userId: string,
    roleKey: string,
    fileKey: string,
    result: T,
  ): Promise<T & { collided?: boolean }> {
    if (!fileKey) return result;
    const mine = await this.prisma.encryptedObject.findUnique({ where: { fileKey }, select: { sha256: true } });
    if (!mine) return result; // no envelope row (no KEK configured): nothing to compare
    const other = await this.prisma.encryptedObject.findFirst({
      where: { sha256: mine.sha256, createdBy: { not: userId } },
      select: { createdBy: true },
    });
    if (!other) return result;
    const { IdentityService } = await import('../integrity/identity.service');
    const identity = new IdentityService(this.prisma);
    const otherRole = (await this.prisma.user.findUnique({ where: { id: other.createdBy }, select: { activeRole: true } }))?.activeRole ?? 'CUSTOMER';
    await identity.capture({ accountId: userId, actorRole: roleKey, type: 'DOC_CONTENT', normalizedValue: mine.sha256, source: 'ONBOARDING_DOC' });
    await identity.capture({ accountId: other.createdBy, actorRole: otherRole, type: 'DOC_CONTENT', normalizedValue: mine.sha256, source: 'ONBOARDING_DOC' });
    // The case this document opens goes to the SECOND_REVIEW queue (P4-5).
    const flagged = { ...result, collided: true };
    if (result.status !== 'approved') return flagged;
    return { ...flagged, status: 'pending_manual', reason: 'Duplicate of a document already on another account — second review required' };
  }

  /** Purge documents whose retention window elapsed: delete the stored object,
   *  clear the fileKey, and leave an auditable purgedAt marker. Daily job. */
  async purgeExpiredDocuments(): Promise<number> {
    const now = new Date();
    const due = await this.prisma.verificationDocument.findMany({
      where: { retentionExpiresAt: { lt: now }, purgedAt: null },
      select: { id: true, userId: true, fileUrl: true, docType: true, user: { select: { tenantId: true } } },
    });
    if (due.length === 0) return 0;

    const storage = getStorageProvider();
    let purged = 0;
    for (const doc of due) {
      // [DOC-INV-7] Delete the bytes, shred the key, then PROBE — a real read
      // attempt. Never mark a row purged while the object may still be
      // readable: a FAILED probe is recorded as such and the row stays due for
      // tomorrow's sweep (DPA §3.5). A receipt without a passing probe is not
      // a receipt.
      const evidence = doc.fileUrl ? await shredAndProbe(this.prisma, storage, doc.fileUrl) : NOTHING_STORED;
      const receipt = { submissionId: doc.id, subjectId: doc.userId, tenantId: doc.user.tenantId, docTypeCode: doc.docType, deletedBy: 'reaper', evidence };
      if (evidence.probe === 'FAILED') {
        await writeDeletionReceipt(this.prisma, receipt);
        continue;
      }
      const transitioned = await this.prisma.$transaction(async (tx) => {
        const users = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "users"
          WHERE "id" = ${doc.userId}
          FOR UPDATE /* verification-document-purge-authority */
        `;
        if (!users[0]) return false;
        const won = await tx.verificationDocument.updateMany({
          where: { id: doc.id, userId: doc.userId, purgedAt: null, retentionExpiresAt: { lt: now } },
          data: { purgedAt: new Date(), fileUrl: '' },
        });
        if (won.count !== 1) return false;
        // The receipt commits with the purge or not at all.
        await writeDeletionReceipt(tx, receipt);
        await projectProviderVerificationLocked(tx, doc.userId);
        // [REPORT-012 F-012-05] Purge invalidates evidence — the vendor
        // projection must land in the same transaction, not never.
        await this.projectVendorActivation(tx, doc.userId);
        return true;
      });
      if (!transitioned) continue;
      purged += 1;
    }
    return purged;
  }

  // -------------------------------------------------------------------------
  // Side effects
  // -------------------------------------------------------------------------

  private async promoteToL2(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { trustLevel: 'L2' } });
    // D.3 — a higher trust level means a higher float limit (no-op for non-riders).
    await new FloatService(this.prisma).recomputeForUser(userId);
    await this.notifications.send({
      userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Identity verified',
      body: 'You are now ID-verified and can place orders of any size.',
      audience: 'customer',
      data: { kind: 'verification_l2' },
    });
  }

  /**
   * Verification-completion side effects. A weekly subscription is BORN as a
   * 14-day trial the moment a participant is fully verified (idempotent — the
   * admin entity-verify endpoints feed the same seams), so the KYC
   * auto-approval path can never strand a verified operator without a
   * subscription. Vendors additionally get their display flag, and a store
   * suspended by a lapsed document re-opens when verification is restored.
   */
  private async afterApproval(userId: string) {
    // [STRAND-1] One projection owns vendor activation truth (flags + the
    // PENDING_APPROVAL→ACTIVE promotion). Manual review already ran it inside
    // the decision transaction; the auto-approval path reaches it here. It is
    // idempotent, so the double run after manual review is harmless.
    await this.projectVendorActivation(this.prisma, userId);
    const owner = await this.prisma.vendorOwner.findUnique({
      where: { userId },
      include: { vendors: { select: { id: true, isVerified: true } } },
    });
    if (owner) {
      for (const vendor of owner.vendors) {
        if (!vendor.isVerified) continue;
        // A newly-live vendor must be searchable now, not at the next boot [SWIFT-UG-SRCH-01].
        const search = new SearchService(this.prisma);
        void search.syncVendor(vendor.id).then(() => search.syncVendorItems(vendor.id)).catch(() => {});
        await this.subscriptions.startTrialForVendor(vendor.id);
      }
    }

    const [driver, rider] = await Promise.all([
      this.prisma.driver.findUnique({ where: { userId }, select: { id: true, licensePlate: true } }),
      this.prisma.rider.findUnique({ where: { userId }, select: { id: true } }),
    ]);
    if ((driver || rider) && (await this.isRoleVerified(userId, 'MOVER'))) {
      // PLATE capture (identity integrity §2.1 — HARD) AWAITED here so the
      // link exists before the trial decision runs; capture failures are
      // swallowed inside the service and never block activation.
      if (driver?.licensePlate) {
        const { IdentityService } = await import('../integrity/identity.service');
        const { normalizePlate } = await import('../integrity/normalize');
        await new IdentityService(this.prisma).capture({
          accountId: userId, actorRole: 'DRIVER',
          type: 'PLATE', normalizedValue: normalizePlate(driver.licensePlate), source: 'ONBOARDING_DOC',
        });
      }
      if (driver) await this.subscriptions.startTrialForDriver(driver.id);
      if (rider) await this.subscriptions.startTrialForRider(rider.id);
    }

  }

  /**
   * When a lapsed document breaks a mover's live-operation status, pull them
   * offline immediately. Respects the same rules as go-online (legacy
   * documentsVerified flag, taxi hire-insurance requirement), so a mover the
   * gate would still admit is left alone.
   */
  /** Public: the compliance audit reuses the exact same force-offline the
   *  expiry sweep applies — one behavior, one notification copy. */
  async forceMoverOfflineIfNotLive(userId: string) {
    // [EV-ACT-18] BOTH profiles' legacy grandfather flags count — the same
    // authority GO honours. The old shape read only the driver's flag, so a
    // legacy-verified RIDER could be forced offline for checklist evidence
    // their GO gate never required.
    const [driver, rider] = await Promise.all([
      this.prisma.driver.findUnique({
        where: { userId },
        select: { vehicleType: true, documentsVerified: true },
      }),
      this.prisma.rider.findUnique({
        where: { userId },
        select: { vehicleType: true, documentsVerified: true },
      }),
    ]);
    const vehicleType = driver?.vehicleType ?? rider?.vehicleType ?? (await this.getMoverVehicleType(userId));
    if (!vehicleType) return;

    const live = await this.getLiveOperationStatus(userId, {
      vehicleType,
      legacyVerified: driver?.documentsVerified || rider?.documentsVerified,
    });
    if (live.allowed) return;

    const [driverOff, riderOff] = await Promise.all([
      this.prisma.driver.updateMany({ where: { userId, isOnline: true }, data: { isOnline: false } }),
      this.prisma.rider.updateMany({ where: { userId, isOnline: true }, data: { isOnline: false } }),
    ]);
    if (driverOff.count + riderOff.count === 0) return;

    await this.notifications.send({
      userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'You have been taken offline',
      body: 'A required document has expired, so you can no longer take jobs. Renew it to go back online.',
      audience: 'earner',
      data: { kind: 'verification_forced_offline' },
    });
  }

  /** When a lapsed doc breaks a vendor-type checklist, listings go dark. */
  private async suspendListingsIfUnverified(userId: string) {
    const owner = await this.prisma.vendorOwner.findUnique({
      where: { userId },
      include: { vendors: { select: { id: true, vendorType: true } } },
    });
    if (!owner) return;

    for (const vendor of owner.vendors) {
      const stillVerified = await this.isRoleVerified(userId, vendor.vendorType as ChecklistRole);
      if (!stillVerified) {
        await this.prisma.vendor.update({
          where: { id: vendor.id },
          data: { isVerified: false, acceptingOrders: false },
        });
        await this.prisma.item.updateMany({
          where: { vendorId: vendor.id },
          data: { isAvailable: false },
        });
        // A darkened vendor's items must leave search now, not at the next
        // boot [SWIFT-UG-SRCH-01] — same direct sync as afterApproval (this
        // sweep runs from jobs; no queue-decorated app in reach).
        const search = new SearchService(this.prisma);
        void search.syncVendor(vendor.id).then(() => search.syncVendorItems(vendor.id)).catch(() => {});
      }
    }
  }

  private async notifyRejection(userId: string, docType: string, reason?: string) {
    await this.notifications.send({
      userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Document rejected',
      body: `Your ${docType.replace(/_/g, ' ')} was rejected${reason ? `: ${reason}` : ''}. Please fix it and resubmit.`,
      data: { kind: 'verification_rejected' },
    });
  }

  /** Append an immutable audit entry for an automated KYC decision (§3.6). */
  private async recordDecision(
    userId: string,
    docId: string,
    docType: string,
    status: VerificationDocument['status'],
    reason?: string,
  ) {
    const action =
      status === 'APPROVED' ? 'KYC_AUTO_APPROVE'
      : status === 'REJECTED' ? 'KYC_AUTO_REJECT'
      : 'VERIFICATION_SUBMIT';
    await this.prisma.auditLog.create({
      data: {
        userId,
        action,
        entity: 'VerificationDocument',
        entityId: docId,
        changes: { docType, status, ...(reason && { reason }) },
      },
    });
  }

  private roleKeyToUserRole(roleKey: ChecklistRole): UserRole {
    if (roleKey === 'MOVER') return 'MOVER';
    // Individual providers live inside the customer's super-app account; the
    // ServiceProvider profile grants capability without inventing a second
    // login role. Persisting CUSTOMER also routes document notices back to the
    // surface where this onboarding is actually executable.
    if (roleKey === 'SERVICE_PROVIDER') return 'CUSTOMER';
    return 'VENDOR_OWNER';
  }
}
