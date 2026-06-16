import type { PrismaClient, VerificationDocument, UserRole } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { CountryConfigService } from '../country/country-config.service';
import { NotificationService } from '../notification/notification.service';
import type { KycProvider } from '../../providers/kyc/kyc-provider';
import { getStorageProvider } from '../../providers/storage/storage-provider';

/** Checklist keys come from CountryConfig.documentChecklists. */
export type ChecklistRole = 'MOVER' | 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';

/** L2 identity rows use this synthetic docType (not part of any checklist). */
export const IDENTITY_DOC_TYPE = 'identity_l2';

const REMINDER_WINDOW_DAYS = 30;

export class VerificationService {
  private countryConfig: CountryConfigService;

  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
    private kyc: KycProvider,
  ) {
    this.countryConfig = new CountryConfigService(prisma);
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
      select: { id: true, countryCode: true },
    });
    if (!user) throw new NotFoundError('User', userId);

    const checklist = await this.countryConfig.getDocumentChecklist(user.countryCode, roleKey);
    if (!checklist.includes(docType)) {
      throw new AppError(400, 'INVALID_DOC_TYPE', `${docType} is not required for ${roleKey} in your country`);
    }

    const alreadyApproved = await this.prisma.verificationDocument.findFirst({
      where: {
        userId,
        docType,
        status: 'APPROVED',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (alreadyApproved) {
      throw new AppError(409, 'ALREADY_APPROVED', `Your ${docType} is already verified`);
    }

    const result = await this.kyc.verifyDocument({ userId, docType, fileUrl });

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
        ...(result.status === 'approved' && { reviewedBy: 'kyc:auto', reviewedAt: new Date() }),
        ...(result.status === 'rejected' && { reviewedBy: 'kyc:auto', reviewedAt: new Date(), reviewNote: result.reason }),
      },
    });

    if (doc.status === 'APPROVED') await this.afterApproval(userId);
    if (doc.status === 'REJECTED') await this.notifyRejection(userId, docType, result.reason);

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

    if (doc.status === 'APPROVED') await this.promoteToL2(userId);
    if (doc.status === 'REJECTED') await this.notifyRejection(userId, 'identity', result.reason);

    return doc;
  }

  // -------------------------------------------------------------------------
  // Manual review queue (admin)
  // -------------------------------------------------------------------------

  async approveDocument(docId: string, adminId: string, expiresAt?: Date) {
    const doc = await this.requirePending(docId);

    const updated = await this.prisma.verificationDocument.update({
      where: { id: docId },
      data: { status: 'APPROVED', reviewedBy: adminId, reviewedAt: new Date(), expiresAt: expiresAt ?? null },
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
      data: { kind: 'verification_approved', docId },
    });

    return updated;
  }

  async rejectDocument(docId: string, adminId: string, reason: string) {
    const doc = await this.requirePending(docId);

    const updated = await this.prisma.verificationDocument.update({
      where: { id: docId },
      data: { status: 'REJECTED', reviewedBy: adminId, reviewedAt: new Date(), reviewNote: reason },
    });

    await this.notifyRejection(doc.userId, doc.docType, reason);
    return updated;
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

  async getStatus(userId: string, roleKey: ChecklistRole) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { countryCode: true, trustLevel: true },
    });
    if (!user) throw new NotFoundError('User', userId);

    const checklist = await this.countryConfig.getDocumentChecklist(user.countryCode, roleKey);
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

    return {
      roleKey,
      trustLevel: user.trustLevel,
      checklist,
      documents,
      missing,
      roleVerified: missing.length === 0,
    };
  }

  /** Gate check: every checklist document approved and unexpired. */
  async isRoleVerified(userId: string, roleKey: ChecklistRole): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true } });
    if (!user) return false;

    const checklist = await this.countryConfig.getDocumentChecklist(user.countryCode, roleKey);
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

      await this.suspendListingsIfUnverified(doc.userId);

      await this.notifications.send({
        userId: doc.userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Document expired',
        body: `Your ${doc.docType.replace(/_/g, ' ')} has expired. Upload a new one to keep operating.`,
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
    for (const doc of due) {
      if (doc.fileUrl) await storage.delete(doc.fileUrl).catch(() => undefined);
      await this.prisma.verificationDocument.update({
        where: { id: doc.id },
        data: { purgedAt: new Date(), fileUrl: '' },
      });
    }
    return due.length;
  }

  // -------------------------------------------------------------------------
  // Side effects
  // -------------------------------------------------------------------------

  private async promoteToL2(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { trustLevel: 'L2' } });
    await this.notifications.send({
      userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Identity verified',
      body: 'You are now ID-verified and can place orders of any size.',
      data: { kind: 'verification_l2' },
    });
  }

  /** Reflect full verification onto owned vendors (display flag; gates check live). */
  private async afterApproval(userId: string) {
    const owner = await this.prisma.vendorOwner.findUnique({
      where: { userId },
      include: { vendors: { select: { id: true, vendorType: true } } },
    });
    if (!owner) return;

    for (const vendor of owner.vendors) {
      const verified = await this.isRoleVerified(userId, vendor.vendorType as ChecklistRole);
      if (verified) {
        await this.prisma.vendor.update({ where: { id: vendor.id }, data: { isVerified: true } });
      }
    }
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

  private roleKeyToUserRole(roleKey: ChecklistRole): UserRole {
    return roleKey === 'MOVER' ? 'MOVER' : 'VENDOR_OWNER';
  }
}
