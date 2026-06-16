import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { VerificationService } from './verification.service';
import { NotificationService } from '../notification/notification.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';

const checklistRoleSchema = z.enum(['MOVER', 'RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE']);

const statusQuerySchema = z.object({
  role: checklistRoleSchema.default('MOVER'),
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
    const { role } = statusQuerySchema.parse(request.query);
    const status = await verification.getStatus(request.user.userId, role);
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
