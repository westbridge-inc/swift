import type { PrismaClient, VerificationDocument, UserRole, VehicleType } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { CountryConfigService } from '../country/country-config.service';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import type { KycProvider } from '../../providers/kyc/kyc-provider';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { FloatService } from '../dispatch/float.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { SearchService } from '../search/search.service';

/** Checklist keys come from CountryConfig.documentChecklists. */
export type ChecklistRole = 'MOVER' | 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';

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
const AUTO_APPROVE_EXPIRY_DAYS: Record<string, number> = {
  police_clearance: 365,   // Certificate of Character — commonly re-issued yearly
  fitness_cert: 365,       // annual fitness
  vehicle_insurance: 365,  // annual policy
  hire_car_permit: 365,    // annual occupational permit
  food_handler_cert: 365,  // annual health cert
  gra_restaurant_licence: 365,
  drivers_licence: 3 * 365,
  vehicle_registration: 3 * 365,
};

/** Insurance 5-point manual check captured during admin review (spec §3.4). */
export interface InsuranceReview {
  insurerName: string;
  policyNumber: string;
  coverageClass: 'HIRE' | 'PRIVATE';
  hireClassConfirmed: boolean;
  plateCrossChecked: boolean;
}

const REMINDER_WINDOW_DAYS = 30;

/** Rejection reason codes (onboarding spec §9.3) — templated openings so
 *  applicants get consistent, actionable messages across reviewers. */
export const REJECTION_REASON_CODES = [
  'EXPIRED', 'UNREADABLE', 'WRONG_DOCUMENT', 'FACE_MISMATCH', 'NAME_MISMATCH',
  'INSURANCE_NOT_HIRE', 'NOT_YELLOW', 'SUSPECTED_TAMPERING', 'DUPLICATE', 'INCOMPLETE',
] as const;
export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

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
  ) {
    this.countryConfig = new CountryConfigService(prisma);
    this.subscriptions = new SubscriptionService(prisma);
  }

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  async submitDocument(
    userId: string,
    roleKey: ChecklistRole,
    docType: string,
    fileUrl: string,
    privacyNoticeVersion: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, countryCode: true, avatar: true, selfieCapturedAt: true },
    });
    if (!user) throw new NotFoundError('User', userId);

    // Movers (riders + taxi drivers) may submit any base or taxi-extra doc;
    // other roles validate against their named checklist.
    const checklist = roleKey === 'MOVER'
      ? await this.countryConfig.getMoverChecklist(user.countryCode, 'CAR') // permissive: any mover may submit any base/motor/taxi doc
      : await this.countryConfig.getDocumentChecklist(user.countryCode, roleKey);
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
      throw new AppError(409, 'ALREADY_APPROVED', `Your ${docType} is already verified`);
    }

    // Identity documents get the full ID + face-match check against the
    // operator's signup selfie; every other document is a plain doc check.
    let result;
    if (IDENTITY_FACE_MATCH_DOCS.has(docType)) {
      if (!user.avatar || !user.selfieCapturedAt) {
        throw new AppError(400, 'SELFIE_REQUIRED', 'Take your profile selfie before submitting your ID — we match the two faces.');
      }
      result = await this.kyc.verifyIdentity({ userId, idDocumentUrl: fileUrl, selfieUrl: user.avatar });
    } else {
      result = await this.kyc.verifyDocument({ userId, docType, fileUrl });
    }

    const autoExpiryDays = AUTO_APPROVE_EXPIRY_DAYS[docType];
    const doc = await this.prisma.verificationDocument.create({
      data: {
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
      },
    });

    await this.recordDecision(userId, doc.id, docType, doc.status, result.reason);

    if (doc.status === 'APPROVED') await this.afterApproval(userId);
    if (doc.status === 'REJECTED') await this.notifyRejection(userId, docType, result.reason);
    // Manual-review path: the queue is invisible until an admin is told about
    // it — found live: documents (and whole onboardings) sat PENDING for weeks.
    if (doc.status === 'PENDING') {
      await notifyAdmins(this.prisma, this.notifications, {
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
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, trustLevel: true } });
    if (!user) throw new NotFoundError('User', userId);
    if (user.trustLevel !== 'L1') {
      throw new AppError(409, 'ALREADY_VERIFIED', 'Identity is already verified');
    }

    const result = await this.kyc.verifyIdentity({ userId, idDocumentUrl, selfieUrl });

    const doc = await this.prisma.verificationDocument.create({
      data: {
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
      },
    });

    await this.recordDecision(userId, doc.id, IDENTITY_DOC_TYPE, doc.status, result.reason);

    if (doc.status === 'APPROVED') await this.promoteToL2(userId);
    if (doc.status === 'REJECTED') await this.notifyRejection(userId, 'identity', result.reason);
    if (doc.status === 'PENDING') {
      await notifyAdmins(this.prisma, this.notifications, {
        title: 'Verification review needed',
        body: 'An identity check (L2) is waiting in the review queue.',
        data: { kind: 'verification_pending', docId: doc.id },
      });
    }

    return doc;
  }

  // -------------------------------------------------------------------------
  // Manual review queue (admin)
  // -------------------------------------------------------------------------

  async approveDocument(docId: string, adminId: string, expiresAt?: Date, insurance?: InsuranceReview) {
    const doc = await this.requirePending(docId);

    const updated = await this.prisma.verificationDocument.update({
      where: { id: docId },
      data: {
        status: 'APPROVED',
        reviewedBy: adminId,
        reviewedAt: new Date(),
        expiresAt: expiresAt ?? null,
        ...(insurance && {
          insurerName: insurance.insurerName,
          policyNumber: insurance.policyNumber,
          coverageClass: insurance.coverageClass,
          hireClassConfirmed: insurance.hireClassConfirmed,
          plateCrossChecked: insurance.plateCrossChecked,
        }),
      },
    });

    if (doc.docType === IDENTITY_DOC_TYPE) {
      await this.promoteToL2(doc.userId);
    } else {
      await this.afterApproval(doc.userId);
    }

    await this.notifications.send({
      userId: doc.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Document approved',
      body: `Your ${doc.docType.replace(/_/g, ' ')} has been approved.`,
      audience: audienceForRole(doc.role),
      data: { kind: 'verification_approved', docId },
    });

    return updated;
  }

  async rejectDocument(docId: string, adminId: string, reason: string, reasonCode?: RejectionReasonCode) {
    const doc = await this.requirePending(docId);

    // Templated reason codes (onboarding spec §9.3): the code drives a clear,
    // consistent opening line; the reviewer's free text adds the specifics.
    const template = reasonCode ? REJECTION_TEMPLATES[reasonCode] : null;
    const fullReason = template ? (reason ? `${template} ${reason}` : template) : reason;

    const updated = await this.prisma.verificationDocument.update({
      where: { id: docId },
      data: {
        status: 'REJECTED',
        reviewedBy: adminId,
        reviewedAt: new Date(),
        reviewNote: reasonCode ? `[${reasonCode}] ${fullReason}` : fullReason,
      },
    });

    await this.notifyRejection(doc.userId, doc.docType, fullReason);
    // A rejection can break a provider's live checklist (e.g. GEI licence).
    const { refreshProviderVerification } = await import('../services/services.service');
    await refreshProviderVerification(this.prisma, doc.userId);
    return updated;
  }

  /**
   * Review-SLA watchdog (spec §13): documents waiting on a human for more than
   * SLA_HOURS get surfaced to every admin once per sweep — a queue nobody
   * opens is how "24h review" promises die.
   */
  async alertReviewSlaBreaches(slaHours = Number(process.env['REVIEW_SLA_HOURS'] ?? 24)): Promise<number> {
    const cutoff = new Date(Date.now() - slaHours * 3600 * 1000);
    const [breached, oldest] = await Promise.all([
      this.prisma.verificationDocument.count({ where: { status: 'PENDING', createdAt: { lt: cutoff } } }),
      this.prisma.verificationDocument.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    if (breached === 0) return 0;
    const oldestHours = oldest ? Math.floor((Date.now() - oldest.createdAt.getTime()) / 3600_000) : slaHours;
    await notifyAdmins(this.prisma, this.notifications, {
      title: 'Verification queue is breaching SLA',
      body: `${breached} document${breached === 1 ? '' : 's'} have waited over ${slaHours}h for review (oldest ${oldestHours}h). People cannot work until these are decided.`,
      data: { kind: 'verification_sla_breach', breached, slaHours },
    });
    return breached;
  }

  private async requirePending(docId: string): Promise<VerificationDocument> {
    const doc = await this.prisma.verificationDocument.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundError('VerificationDocument', docId);
    if (doc.status !== 'PENDING') {
      throw new AppError(400, 'NOT_PENDING', `Document is ${doc.status}, only PENDING documents can be reviewed`);
    }
    return doc;
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
    const driver = await this.prisma.driver.findUnique({ where: { userId }, select: { id: true } });
    if (driver) return 'CAR';
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

    return {
      roleKey,
      trustLevel: user.trustLevel,
      checklist,
      documents,
      missing,
      vehicleType,
      roleVerified: missing.length === 0,
    };
  }

  /** Gate check: every checklist document approved and unexpired. */
  async isRoleVerified(userId: string, roleKey: ChecklistRole): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true } });
    if (!user) return false;

    const checklist = await this.checklistFor(userId, user.countryCode, roleKey);
    if (checklist.length === 0) return true;

    const approvedDocs = await this.prisma.verificationDocument.findMany({
      where: {
        userId,
        docType: { in: checklist },
        status: 'APPROVED',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { docType: true },
    });
    const approved = new Set(approvedDocs.map((d) => d.docType));
    return checklist.every((docType) => approved.has(docType));
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
  ): Promise<{ allowed: boolean; reason: 'ok' | 'docs' | 'insurance' }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { countryCode: true },
    });
    if (!user) return { allowed: false, reason: 'docs' };

    let baseOk = opts.legacyVerified ?? false;
    if (!baseOk) {
      const required = await this.countryConfig.getMoverChecklist(user.countryCode, opts.vehicleType);
      if (required.length === 0) {
        baseOk = true;
      } else {
        const approvedDocs = await this.prisma.verificationDocument.findMany({
          where: {
            userId,
            docType: { in: required },
            status: 'APPROVED',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { docType: true },
        });
        const approved = new Set(approvedDocs.map((d) => d.docType));
        baseOk = required.every((docType) => approved.has(docType));
      }
    }
    if (!baseOk) return { allowed: false, reason: 'docs' };

    // Taxi (CAR): a current, manually-confirmed HIRE-class policy is mandatory
    // before carrying passengers, and the reviewer must have cross-checked the
    // policy's plate against the H plate on the registration + photos.
    // PRIVATE insurance never qualifies.
    if (opts.vehicleType === 'CAR') {
      const insurance = await this.prisma.verificationDocument.findFirst({
        where: {
          userId,
          docType: 'vehicle_insurance',
          status: 'APPROVED',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
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
    const lapsed = await this.prisma.verificationDocument.findMany({
      where: { status: { in: ['APPROVED', 'PENDING'] }, expiresAt: { lt: new Date() } },
    });

    for (const doc of lapsed) {
      await this.prisma.verificationDocument.update({
        where: { id: doc.id },
        data: { status: 'EXPIRED' },
      });

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
      // A lapsed GEI licence (or clearance) must also pull a service provider
      // off the marketplace immediately — no-op for everyone else.
      const { refreshProviderVerification } = await import('../services/services.service');
      await refreshProviderVerification(this.prisma, doc.userId);

      await this.notifications.send({
        userId: doc.userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Document expired',
        body: `Your ${doc.docType.replace(/_/g, ' ')} has expired. Upload a new one to keep operating.`,
        audience: audienceForRole(doc.role),
        data: { kind: 'verification_expired', docId: doc.id },
      });
    }

    return lapsed.length;
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

  /** Purge documents whose retention window elapsed: delete the stored object,
   *  clear the fileKey, and leave an auditable purgedAt marker. Daily job. */
  async purgeExpiredDocuments(): Promise<number> {
    const due = await this.prisma.verificationDocument.findMany({
      where: { retentionExpiresAt: { lt: new Date() }, purgedAt: null },
      select: { id: true, fileUrl: true },
    });
    if (due.length === 0) return 0;

    const storage = getStorageProvider();
    let purged = 0;
    for (const doc of due) {
      // Never mark a row purged while the stored object may still exist — a
      // failed delete stays due and retries on tomorrow's sweep (DPA §3.5).
      if (doc.fileUrl) {
        const deleted = await storage.delete(doc.fileUrl).then(() => true).catch(() => false);
        if (!deleted) continue;
        // Crypto-shred (spec §5.5): null the wrapped DEK so even a backup of
        // the ciphertext is permanently unrecoverable. Shred FIRST-class —
        // the object delete above is belt, this is braces.
        await this.prisma.encryptedObject.updateMany({
          where: { fileKey: doc.fileUrl },
          data: { wrappedDek: null, shreddedAt: new Date() },
        });
      }
      await this.prisma.verificationDocument.update({
        where: { id: doc.id },
        data: { purgedAt: new Date(), fileUrl: '' },
      });
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
    const owner = await this.prisma.vendorOwner.findUnique({
      where: { userId },
      include: { vendors: { select: { id: true, vendorType: true, isVerified: true } } },
    });
    if (owner) {
      for (const vendor of owner.vendors) {
        const verified = await this.isRoleVerified(userId, vendor.vendorType as ChecklistRole);
        if (!verified) continue;
        // Restore acceptingOrders only on the unverified -> verified edge; a
        // routine renewal approval must not override a deliberate pause.
        await this.prisma.vendor.update({
          where: { id: vendor.id },
          data: { isVerified: true, ...(vendor.isVerified ? {} : { acceptingOrders: true }) },
        });
        // A newly-live vendor must be searchable now, not at the next boot [SWIFT-UG-SRCH-01].
        const search = new SearchService(this.prisma);
        void search.syncVendor(vendor.id).then(() => search.syncVendorItems(vendor.id)).catch(() => {});
        await this.subscriptions.startTrialForVendor(vendor.id);
      }
    }

    const [driver, rider] = await Promise.all([
      this.prisma.driver.findUnique({ where: { userId }, select: { id: true } }),
      this.prisma.rider.findUnique({ where: { userId }, select: { id: true } }),
    ]);
    if ((driver || rider) && (await this.isRoleVerified(userId, 'MOVER'))) {
      if (driver) await this.subscriptions.startTrialForDriver(driver.id);
      if (rider) await this.subscriptions.startTrialForRider(rider.id);
    }

    // Service providers flip live the moment their checklist completes —
    // previously the flag only refreshed when they re-saved their profile.
    const { refreshProviderVerification } = await import('../services/services.service');
    await refreshProviderVerification(this.prisma, userId);
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
    const driver = await this.prisma.driver.findUnique({
      where: { userId },
      select: { id: true, documentsVerified: true },
    });
    const vehicleType = driver ? 'CAR' as const : (await this.getMoverVehicleType(userId));
    if (!vehicleType) return;

    const live = await this.getLiveOperationStatus(userId, {
      vehicleType,
      legacyVerified: driver?.documentsVerified,
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
    return roleKey === 'MOVER' ? 'MOVER' : 'VENDOR_OWNER';
  }
}
