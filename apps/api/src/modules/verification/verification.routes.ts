import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { VerificationService } from './verification.service';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { decryptBuffer, encryptBuffer, generateDek, getKeyProvider, signRenderToken } from '../../providers/storage/envelope';
import { createHash } from 'node:crypto';
import { looksLikeDocument } from '../../utils/images';
import { AppError } from '../../utils/errors';

const checklistRoleSchema = z.enum(['MOVER', 'RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE']);

const statusQuerySchema = z.object({
  role: checklistRoleSchema.default('MOVER'),
  // Preview the checklist for a vehicle the mover is selecting but hasn't saved
  // yet. Display-only — gates always use the saved Driver/Rider entity.
  vehicleType: z.enum(['BICYCLE', 'MOTORCYCLE', 'CAR']).optional(),
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
  // Storage reference from the upload service — never raw document content
  fileUrl: z.string().min(5).max(2048),
  ...consentFields,
});

const submitIdentitySchema = z.object({
  idDocumentUrl: z.string().min(5).max(2048),
  selfieUrl: z.string().min(5).max(2048),
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

  /** POST /documents — submit one checklist document for a role. */
  app.post('/documents', auth, async (request, reply) => {
    const body = submitDocumentSchema.parse(request.body);
    const doc = await verification.submitDocument(
      request.user.userId,
      body.role,
      body.docType,
      body.fileUrl,
      body.privacyNoticeVersion,
    );
    reply.code(201);
    return { success: true, data: doc };
  });

  /** POST /upload — store one document file behind the StorageProvider; returns the fileUrl. */
  app.post('/upload', auth, async (request) => {
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
    const storage = getStorageProvider();

    // Envelope encryption (onboarding spec §5): with a KEK configured the
    // bucket only ever holds AES-256-GCM ciphertext; the wrapped per-file DEK
    // lands in encrypted_objects. Without one, behavior is unchanged
    // (private object + provider-side SSE) — encryption is config, not code.
    const keys = getKeyProvider();
    if (keys) {
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      // SWIFT-078: the SAME physical document already on ANOTHER account is a
      // fraud signal — one person opening several accounts, or a reused/forged
      // ID. Flag it to the reviewers; it must never quietly auto-progress.
      const dup = await app.prisma.encryptedObject.findFirst({
        where: { sha256, createdBy: { not: request.user.userId } },
        select: { createdBy: true },
      });

      const dek = generateDek();
      const { ciphertext, iv, authTag } = encryptBuffer(buffer, dek);
      const { url } = await storage.upload({
        buffer: ciphertext,
        filename: `${file.filename}.enc`,
        mimeType: 'application/octet-stream',
        folder: `verification/${request.user.userId}`,
      });
      await app.prisma.encryptedObject.create({
        data: {
          fileKey: url,
          iv: new Uint8Array(iv),
          authTag: new Uint8Array(authTag),
          wrappedDek: new Uint8Array(await keys.wrapDek(dek)),
          mimeType: file.mimetype,
          sizeBytes: buffer.length,
          sha256,
          createdBy: request.user.userId,
        },
      });

      if (dup) {
        // The hash, not the document, goes to admins — never the PII itself.
        await notifyAdmins(app.prisma, notifications, {
          title: 'Duplicate verification document',
          body: 'A document just uploaded is byte-identical to one already on another account. Review both before approving — possible multi-accounting or a reused/forged document.',
          data: { kind: 'dup_doc', sha256, uploader: request.user.userId, matchesUser: dup.createdBy },
        }).catch(() => {});
      }
      return { success: true, data: { url, duplicate: !!dup } };
    }

    const { url } = await storage.upload({
      buffer,
      filename: file.filename,
      mimeType: file.mimetype,
      folder: `verification/${request.user.userId}`,
    });
    return { success: true, data: { url } };
  });

  /**
   * GET /render/:docId?expires&sig — decrypting stream for envelope-encrypted
   * documents. HMAC-token gated (not JWT) so the admin console's <img> can load
   * it; tokens are minted ONLY by the audited admin document-url route and live
   * seconds. The bucket object is ciphertext — this is the only way to see it.
   */
  app.get<{ Params: { docId: string } }>('/render/:docId', async (request, reply) => {
    const { docId } = request.params;
    const { expires, sig } = z.object({ expires: z.coerce.number(), sig: z.string().min(16) }).parse(request.query);
    if (expires < Math.floor(Date.now() / 1000)) {
      throw new AppError(410, 'LINK_EXPIRED', 'This view link has expired — reopen the document.');
    }
    if (sig !== signRenderToken(docId, expires)) {
      throw new AppError(403, 'BAD_SIGNATURE', 'Invalid view link.');
    }

    const doc = await app.prisma.verificationDocument.findUnique({
      where: { id: docId },
      select: { fileUrl: true, purgedAt: true },
    });
    if (!doc || doc.purgedAt || !doc.fileUrl) {
      throw new AppError(410, 'DOCUMENT_PURGED', 'This document has been deleted under the retention policy');
    }
    const meta = await app.prisma.encryptedObject.findUnique({ where: { fileKey: doc.fileUrl } });
    if (!meta) throw new AppError(404, 'NOT_ENCRYPTED', 'No encrypted object for this document.');
    if (!meta.wrappedDek || meta.shreddedAt) {
      throw new AppError(410, 'DOCUMENT_SHREDDED', 'This document was crypto-shredded and cannot be recovered.');
    }
    const keys = getKeyProvider();
    if (!keys) throw new AppError(503, 'ENCRYPTION_OFF', 'MASTER_KEK is not configured on this server.');

    const ciphertext = await getStorageProvider().getObject(doc.fileUrl);
    const dek = await keys.unwrapDek(Buffer.from(meta.wrappedDek));
    const plaintext = decryptBuffer(ciphertext, dek, Buffer.from(meta.iv), Buffer.from(meta.authTag));
    reply
      .type(meta.mimeType)
      .header('Cache-Control', 'no-store, max-age=0')
      .header('Content-Disposition', 'inline');
    return reply.send(plaintext);
  });

  /** POST /identity — L2 flow: government ID + selfie. Permanent once approved. */
  app.post('/identity', auth, async (request, reply) => {
    const body = submitIdentitySchema.parse(request.body);
    const doc = await verification.submitIdentity(
      request.user.userId,
      body.idDocumentUrl,
      body.selfieUrl,
      body.privacyNoticeVersion,
    );
    reply.code(201);
    return { success: true, data: doc };
  });
}
