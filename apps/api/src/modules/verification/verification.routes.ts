import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { VehicleType, VerificationUploadPurpose } from '@prisma/client';
import { VerificationService } from './verification.service';
import { NotificationService, notifyAdmins, tenantOfUser } from '../notification/notification.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { looksLikeDocument } from '../../utils/images';
import { AppError } from '../../utils/errors';
import { createVerificationUpload } from './verification-upload';

const checklistRoleSchema = z.enum(['MOVER', 'RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE', 'SERVICE_PROVIDER']);

const statusQuerySchema = z.object({
  role: checklistRoleSchema.default('MOVER'),
  // Preview the checklist for a vehicle the mover is selecting but hasn't saved
  // yet. Display-only — gates always use the saved Driver/Rider entity.
  vehicleType: z.nativeEnum(VehicleType).optional(),
});

// DPA §3.5: a document upload is only accepted with explicit consent and the
// version of the privacy notice the applicant acknowledged.
const consentFields = {
  consent: z.literal(true),
  privacyNoticeVersion: z.string().min(1).max(20),
};

const submitDocumentSchema = z.object({
  role: checklistRoleSchema,
  docType: z.string().min(2).max(60),
  // One-use server authority from POST /upload; never a client object key.
  uploadId: z.string().uuid(),
  // Identity-bearing checklist documents require a fresh one-use selfie.
  selfieUploadId: z.string().uuid().optional(),
  ...consentFields,
});

const submitIdentitySchema = z.object({
  idUploadId: z.string().uuid(),
  selfieUploadId: z.string().uuid().optional(),
  ...consentFields,
});

const uploadQuerySchema = z.object({
  purpose: z.nativeEnum(VerificationUploadPurpose),
  role: z.union([z.literal('CUSTOMER'), checklistRoleSchema]).optional(),
  docType: z.string().trim().min(1).max(60).optional(),
});

export async function verificationRoutes(app: FastifyInstance) {
  const notifications = new NotificationService(app.prisma, app.io);
  const verification = new VerificationService(app.prisma, notifications, getKycProvider());
  const auth = { preHandler: [app.authenticate] };

  /** Privacy-sensitive collection contract. Clients must ask before capturing
   * a fresh selfie; the kill switch defaults off and intake rejects one while
   * disabled, so an old UI cannot silently collect unused biometric material. */
  app.get('/capabilities', auth, async () => {
    return {
      success: true,
      data: verification.biometricCapabilities(),
    };
  });

  /** GET /status?role= — checklist, submitted docs, what's missing. */
  app.get('/status', auth, async (request) => {
    const { role, vehicleType } = statusQuerySchema.parse(request.query);
    const status = await verification.getStatus(request.user.userId, role, vehicleType);
    return { success: true, data: status };
  });

  /** POST /appeal — "Think this is a mistake?" (trial-integrity Part 4).
   *  Opens the appeal on the caller's own latest appealable enforcement
   *  (trial denials / velocity holds; fraud-tier holds are not user-
   *  appealable — their message carries no appeal path). 24h SLA, same clock
   *  culture as reviews. */
  app.post('/appeal', auth, async (request) => {
    const { note } = z.object({ note: z.string().trim().min(3).max(1000) }).parse(request.body ?? {});
    const { openAppeal } = await import('../integrity/enforcement');
    const opened = await openAppeal(app.prisma, request.user.userId, note);
    if (!opened) {
      throw new AppError(404, 'NOTHING_TO_APPEAL', 'There is no decision on your account to appeal.');
    }
    await notifyAdmins(app.prisma, new NotificationService(app.prisma, app.io), {
      // Follows the appellant [NOC-A F45].
      tenantId: await tenantOfUser(app.prisma, request.user.userId),
      title: 'Trial-integrity appeal opened',
      body: 'A user says an enforcement decision is a mistake. Review it with the identity panel — 24h clock.',
      data: { kind: 'integrity_appeal', enforcementId: opened.id, accountId: request.user.userId },
    }).catch(() => {});
    return { success: true, data: { appealed: true, reference: opened.id } };
  });

  // ── [DOC-1 Part XXV · P25] Data-subject rights against documents ─────────
  /** GET /dsar/documents — everything Swift holds about the caller's documents (their data, categories only for decisions). */
  app.get('/dsar/documents', auth, async (request) => {
    const { exportDocumentsFor } = await import('./dsar');
    return { success: true, data: await exportDocumentsFor(app.prisma, request.user.userId) };
  });

  /** POST /dsar/documents/erase — destroy what can be destroyed now; refuse the rest with the ground stated. */
  app.post('/dsar/documents/erase', auth, async (request) => {
    const { documentIds } = z.object({ documentIds: z.array(z.string().min(1)).min(1).max(50).optional() }).parse(request.body ?? {});
    const { eraseDocumentsFor } = await import('./dsar');
    return { success: true, data: await eraseDocumentsFor(app.prisma, verification, request.user.userId, documentIds) };
  });

  /** POST /dsar/documents/rectify — re-open a review case; the correction is a reviewer action (DOC-INV-34). */
  app.post('/dsar/documents/rectify', auth, async (request, reply) => {
    const body = z.object({ documentId: z.string().min(1), fieldCode: z.string().trim().min(1).max(64), note: z.string().trim().min(3).max(1000) }).parse(request.body);
    const { requestRectification } = await import('./dsar');
    const result = await requestRectification(app.prisma, new NotificationService(app.prisma, app.io), request.user.userId, body);
    reply.code(201);
    return { success: true, data: result };
  });

  /** POST /documents — submit one checklist document for a role. */
  app.post('/documents', auth, async (request, reply) => {
    const body = submitDocumentSchema.parse(request.body);
    const doc = await verification.submitDocument(
      request.user.userId,
      body.role,
      body.docType,
      body.uploadId,
      body.privacyNoticeVersion,
      body.selfieUploadId,
    );
    reply.code(201);
    return { success: true, data: doc };
  });

  /** POST /upload — reserve and store one purpose-bound, one-use upload.
   *  Rate-limited: an authenticated attacker could otherwise fan out 5MB uploads
   *  to fill disk / spam duplicate-document alerts. A real onboarder uploads a
   *  handful of documents. */
  app.post('/upload', { ...auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const query = uploadQuerySchema.parse(request.query);
    if (query.purpose === 'IDENTITY_SELFIE' && !verification.biometricSelfieEnabled()) {
      throw new AppError(
        409,
        'BIOMETRIC_DISABLED',
        'Fresh-selfie collection is disabled for verification.',
      );
    }
    const file = await request.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach a document file');
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
    if (!allowed.has(file.mimetype)) {
      throw new AppError(400, 'BAD_TYPE', 'Only JPEG, PNG, WebP or PDF files are accepted');
    }
    const buffer = await file.toBuffer();
    // Magic-byte sniff (security spec §6): a spoofed Content-Type must not
    // smuggle an executable/HTML into the document store.
    if (!looksLikeDocument(buffer, file.mimetype)) {
      throw new AppError(400, 'BAD_CONTENT', 'File content does not match its declared format');
    }
    const receipt = await createVerificationUpload(app.prisma, getStorageProvider(), app.log, {
      userId: request.user.userId,
      purpose: query.purpose,
      roleKey: query.role,
      docType: query.docType,
      buffer,
      filename: file.filename,
      mimeType: file.mimetype,
    });
    if (receipt.duplicate) {
      await notifyAdmins(app.prisma, notifications, {
        tenantId: await tenantOfUser(app.prisma, request.user.userId),
        title: 'Duplicate verification document',
        body: 'A verification upload is byte-identical to an active upload on another account. Review both before approving.',
        data: { kind: 'dup_doc', uploadId: receipt.uploadId },
      }).catch(() => {});
    }
    return { success: true, data: receipt };
  });

  /** POST /identity — L2 flow: government ID + selfie. Permanent once approved. */
  app.post('/identity', auth, async (request, reply) => {
    const body = submitIdentitySchema.parse(request.body);
    const doc = await verification.submitIdentity(
      request.user.userId,
      body.idUploadId,
      body.selfieUploadId,
      body.privacyNoticeVersion,
    );
    reply.code(201);
    return { success: true, data: doc };
  });
}
