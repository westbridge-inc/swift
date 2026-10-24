import { discardUnusedCustomerSelfie } from '../user/upload-erasure';
import type { FastifyInstance } from 'fastify';
import { scanUpload } from '../../lib/malware-scan';
import { z } from '../../lib/zod';
import { VehicleType } from '@prisma/client';
import { VerificationService } from './verification.service';
import { NotificationService, notifyAdmins, tenantOfUser } from '../notification/notification.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { decryptBuffer, encryptBuffer, generateDek, getKeyProvider, verifyRenderToken } from '../../providers/storage/envelope';
import { documentReviewerRequired, isActiveDocumentReviewer } from '../admin/document-reviewer';
import { createHash } from 'node:crypto';
import { cleanStoredPhoto, looksLikeDocument } from '../../utils/images';
import { AppError } from '../../utils/errors';
import { consentSurfaceOf } from '../legal/consent-surface';
import { UPLOAD_CONSENT_TICKS, consentSubjectForRole, recordUploadConsent } from './upload-consent';
import { resolveVerificationObject, verificationObjectUnavailable } from './object-authority';
import { liveDuplicateHolders } from './duplicate-holders';

/** How long an identical re-send counts as a retry of the same upload. */
export const UPLOAD_RETRY_WINDOW_MS = 10 * 60_000;

/**
 * [#1449 S4-1] The same person's identical file (same bytes, same type), stored in the
 * last few minutes and not yet claimed by anything, IS the upload a lost reply hid: its
 * key is the answer. Anything already claimed (a document, a mover or recovery pointer)
 * or erased is never reused: a deliberate re-submission gets its own upload.
 */
export async function retriedUpload(
  db: FastifyInstance['prisma'], userId: string, sha256: string, mimeType: string, now = Date.now(),
): Promise<string | null> {
  const recent = await db.encryptedObject.findMany({
    where: { createdBy: userId, sha256, mimeType, shreddedAt: null, wrappedDek: { not: null }, createdAt: { gte: new Date(now - UPLOAD_RETRY_WINDOW_MS) } },
    orderBy: { createdAt: 'desc' }, select: { fileKey: true }, take: 5,
  });
  for (const { fileKey } of recent) {
    const claimed = await db.verificationDocument.count({ where: { fileUrl: fileKey } })
      + await db.rider.count({ where: { OR: [{ nationalIdUrl: fileKey }, { driverLicenseUrl: fileKey }, { vehicleInsuranceUrl: fileKey }, { profilePhotoUrl: fileKey }, { vehiclePhotoUrl: fileKey }] } })
      + await db.driver.count({ where: { OR: [{ nationalIdUrl: fileKey }, { driverLicenseUrl: fileKey }, { vehicleInsuranceUrl: fileKey }, { vehicleInspectionUrl: fileKey }, { profilePhotoUrl: fileKey }, { vehiclePhotoUrl: fileKey }] } })
      + await db.accountRecovery.count({ where: { OR: [{ idDocumentUrl: fileKey }, { selfieUrl: fileKey }] } });
    if (claimed === 0) return fileKey;
  }
  return null;
}

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
  /** [R17] the tick the client showed (website, phone build 12); recorded in the consent ledger. Builds 9-11 omit it. */
  consentTick: z.enum(UPLOAD_CONSENT_TICKS).optional(),
};

const submitDocumentSchema = z.object({
  role: checklistRoleSchema,
  docType: z.string().min(2).max(60),
  // Storage reference from the upload service — never raw document content
  fileUrl: z.string().min(5).max(2048),
  ...consentFields,
});

// [Owner ruling 8 Oct 2026 — CUSTOMER ID] No face match. [ROLE-DOCS · owner 21 Oct 2026] No selfie
// either: store build 9 still sends `selfieUrl`; the schema no longer names it, so zod's default
// (strip) DROPS it here and the old app keeps working — it never reaches the intake. The upload it
// names is erased after the intake when it is the caller's own (below). A newer app sends the ID alone.
const submitIdentitySchema = z.object({
  idDocumentUrl: z.string().min(5).max(2048),
  ...consentFields,
});

export async function verificationRoutes(app: FastifyInstance) {
  const notifications = new NotificationService(app.prisma, app.io);
  const verification = new VerificationService(app.prisma, notifications, getKycProvider());
  const auth = { preHandler: [app.authenticate] };

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
    if (body.consentTick && body.consentTick !== 'document_v1') {
      throw new AppError(400, 'CONSENT_TICK_MISMATCH', 'That consent does not belong to a document upload.');
    }
    const doc = await verification.submitDocument(
      request.user.userId,
      body.role,
      body.docType,
      body.fileUrl,
      body.privacyNoticeVersion,
      request.user.role,
    );
    // [R17] the tick the person gave, after the document is on file (a refused upload records no consent)
    if (body.consentTick) {
      await recordUploadConsent(app.prisma, { userId: request.user.userId, tick: body.consentTick, subjectType: consentSubjectForRole(body.role), surface: consentSurfaceOf(request), ip: request.ip, docType: body.docType });
    }
    reply.code(201);
    return { success: true, data: doc };
  });

  /** POST /upload — store one document file behind the StorageProvider; returns the fileUrl.
   *  Rate-limited: an authenticated attacker could otherwise fan out 5MB uploads
   *  to fill disk / spam duplicate-document alerts. A real onboarder uploads a
   *  handful of documents. */
  app.post('/upload', { ...auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
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
    // [Row 108 · Row 238 · GUARDRAILS §2] The storage seam only ever sees this file ENCRYPTED, so the
    // photo is cleaned here, before it is sealed, by the seam's own helper: the metadata a phone camera
    // writes (GPS, capture time, device, serial) removed failing closed, then the clean bytes read by the
    // real decoder. What the bytes ARE decides it (a PDF passed the sniff above as a PDF: not a photo).
    const photo = await cleanStoredPhoto(buffer, file.mimetype);
    const sealedBytes = photo?.buffer ?? buffer;
    // The envelope records what is sealed: a photo's type is what its bytes are, as at the storage seam.
    const sealedType = photo?.mimeType ?? file.mimetype;
    // [Row 312] Scanned as plaintext, before it is encrypted: the store only ever sees ciphertext.
    await scanUpload(buffer, { surface: 'verification', log: request.log });
    const storage = getStorageProvider();

    // Envelope encryption (onboarding spec §5): with a KEK configured the
    // bucket only ever holds AES-256-GCM ciphertext; the wrapped per-file DEK
    // lands in encrypted_objects. Without it no ownership metadata can be
    // proved at submission, so refuse instead of handing back an unusable file.
    const keys = getKeyProvider();
    if (keys) {
      // The fingerprint of the file AS SUBMITTED: the duplicate-document and retry identity, comparable
      // with every row stored before [Row 238]. A one-way digest keeps nothing of the removed metadata.
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      // [#1449 S4-1] A retry after a lost reply sends the same file again: answer with the
      // upload already stored, so no second copy of an ID document is kept (and no second review signal).
      const retried = await retriedUpload(app.prisma, request.user.userId, sha256, sealedType);
      if (retried) return { success: true, data: { url: retried } };
      // SWIFT-078: the SAME physical document already on ANOTHER account is a
      // fraud signal — one person opening several accounts, or a reused/forged
      // ID. Flag it to the reviewers; it must never quietly auto-progress.
      // [Row 331 (c)] Only a LIVE account counts: an erased one is never a duplicate holder.
      const dup = (await liveDuplicateHolders(app.prisma, sha256, request.user.userId)).length > 0;

      const dek = generateDek();
      const { ciphertext, iv, authTag } = encryptBuffer(sealedBytes, dek);
      const { url } = await storage.upload({
        buffer: ciphertext,
        // Multipart normalizes empty/path-only names to ''. Appending .enc
        // would then make a dotfile, which adapters name .bin. The envelope
        // extension is server-owned and must satisfy object authority.
        filename: 'verification.enc',
        mimeType: 'application/octet-stream',
        folder: `verification/${request.user.userId}`,
      });
      await app.prisma.encryptedObject.create({
        data: {
          fileKey: url,
          iv: new Uint8Array(iv),
          authTag: new Uint8Array(authTag),
          wrappedDek: new Uint8Array(await keys.wrapDek(dek)),
          mimeType: sealedType,
          sizeBytes: sealedBytes.length, // what is stored (and what a deletion receipt destroys)
          sha256,
          createdBy: request.user.userId,
        },
      });

      if (dup) {
        // Global correlation is a platform review signal. Tenant-local
        // administrators and applicants must not learn another account's
        // membership, identifier, or document hash from upload completion.
        await notifyAdmins(app.prisma, notifications, {
          // notifyAdmins(null) selects SUPER_ADMIN only, never tenant admins.
          tenantId: null,
          title: 'Verification upload needs review',
          body: 'Review this applicant’s verification submission before approval.',
          data: { kind: 'dup_doc', uploader: request.user.userId },
        }).catch(() => {});
      }
      return { success: true, data: { url } };
    }

    throw new AppError(503, 'VERIFICATION_UPLOAD_UNAVAILABLE', 'Document upload is temporarily unavailable. Try again later.');
  });

  /**
   * GET /render/:docId?expires&sig — decrypting stream for envelope-encrypted
   * documents. HMAC-token gated (not JWT) so the admin console's <img> can load
   * it; tokens are minted ONLY by the audited admin document-url route and live
   * seconds. The bucket object is ciphertext — this is the only way to see it.
   */
  app.get<{ Params: { docId: string } }>('/render/:docId', async (request, reply) => {
    const { docId } = request.params;
    const { expires, sig, reviewer } = z.object({
      expires: z.coerce.number(), sig: z.string().min(16), reviewer: z.string().min(1).max(64).optional(),
    }).parse(request.query);
    if (expires < Math.floor(Date.now() / 1000)) {
      throw new AppError(410, 'LINK_EXPIRED', 'This view link has expired — reopen the document.');
    }
    // [VERIFY-DOCS V3] A link names the reviewer it was minted for, inside the
    // signature: a link without one, or re-aimed at someone else, is refused.
    if (!reviewer || !verifyRenderToken(docId, expires, reviewer, sig)) {
      throw new AppError(403, 'BAD_SIGNATURE', 'Invalid view link.');
    }

    const doc = await app.prisma.verificationDocument.findUnique({
      where: { id: docId },
      select: { userId: true, fileUrl: true, purgedAt: true },
    });
    if (!doc || doc.purgedAt || !doc.fileUrl) {
      throw new AppError(410, 'DOCUMENT_PURGED', 'This document has been deleted under the retention policy');
    }
    // [VERIFY-DOCS V3] ...and that reviewer must STILL be one, on every load:
    // revoking the grant, suspending or demoting the reviewer kills links that
    // are already open. Same tenant as the person whose document it is.
    if (!(await isActiveDocumentReviewer(app.prisma, reviewer, doc.userId))) {
      throw documentReviewerRequired();
    }
    const meta = await resolveVerificationObject(app.prisma, { fileKey: doc.fileUrl, userId: doc.userId, documentId: docId });
    const keys = getKeyProvider();
    if (!keys) throw new AppError(503, 'ENCRYPTION_OFF', 'MASTER_KEK is not configured on this server.');

    let plaintext: Buffer;
    try {
      const ciphertext = await getStorageProvider().getObject(doc.fileUrl);
      const dek = await keys.unwrapDek(Buffer.from(meta.wrappedDek!));
      plaintext = decryptBuffer(ciphertext, dek, Buffer.from(meta.iv), Buffer.from(meta.authTag));
    } catch {
      throw verificationObjectUnavailable();
    }
    reply
      .type(meta.mimeType)
      .header('Cache-Control', 'no-store, max-age=0')
      .header('Content-Disposition', 'inline');
    return reply.send(plaintext);
  });

  /** POST /identity — the customer's ID (L2). [Owner ruling 8 Oct 2026] On file at once unless an
   *  automatic check holds it for a person. `idCheck` (additive) says which, in words an app can
   *  repeat truthfully: ON_FILE (unlocked now, no person reviewed it), WAITING (a person looks
   *  first), NOT_ACCEPTED. */
  app.post('/identity', auth, async (request, reply) => {
    const body = submitIdentitySchema.parse(request.body);
    if (body.consentTick && body.consentTick !== 'customer_id_v1') {
      throw new AppError(400, 'CONSENT_TICK_MISMATCH', 'That consent does not belong to an ID upload.');
    }
    const doc = await verification.submitIdentity(
      request.user.userId,
      body.idDocumentUrl,
      body.privacyNoticeVersion,
    );
    // [R17 · in-app ¶15] the customer's tick to keep the ID photo
    if (body.consentTick) {
      await recordUploadConsent(app.prisma, { userId: request.user.userId, tick: body.consentTick, subjectType: 'customer', surface: consentSurfaceOf(request), ip: request.ip, docType: 'customer_id' });
    }
    // [ROLE-DOCS · REVIEW-F #2001 S3-1] Build 9 uploaded a selfie before calling here; nothing reads it, so the face
    // is erased now (only the caller's own, unclaimed, unheld upload: user/upload-erasure discardUnusedCustomerSelfie).
    const selfieUrl = (request.body as { selfieUrl?: unknown } | null | undefined)?.selfieUrl;
    if (typeof selfieUrl === 'string' && selfieUrl.length > 0 && selfieUrl.length <= 2048 && selfieUrl !== body.idDocumentUrl) {
      await discardUnusedCustomerSelfie(app.prisma, getStorageProvider(), request.user.userId, selfieUrl, request.log);
    }
    reply.code(201);
    const idCheck = doc.status === 'APPROVED' ? 'ON_FILE' : doc.status === 'REJECTED' ? 'NOT_ACCEPTED' : 'WAITING';
    return { success: true, data: { ...doc, idCheck } };
  });
}
