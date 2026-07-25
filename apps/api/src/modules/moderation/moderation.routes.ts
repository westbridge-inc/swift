import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

type AuthRequest = FastifyRequest & { user: { userId: string; role: string } };

// ---------------------------------------------------------------------------
// STORE-001: in-app UGC reporting (store-compliance §5.4).
//
// Apple 1.2 and Google's UGC + CSAE policies REQUIRE that a user be able to
// flag objectionable content — a rating, a chat message, a profile, a listing —
// from inside the app, and that reports go somewhere actionable (the admin
// moderation queue in admin.routes). This is the report side; the queue is the
// admin side. Both are launch gates for the stores.
// ---------------------------------------------------------------------------

const reportSchema = z.object({
  targetType: z.enum(['RATING', 'CHAT_MESSAGE', 'USER', 'VENDOR', 'ITEM']),
  targetId: z.string().trim().min(1).max(64),
  reason: z.enum(['SPAM', 'HARASSMENT', 'HATE_SPEECH', 'VIOLENCE', 'SEXUAL_CONTENT', 'CSAE', 'ILLEGAL_GOODS', 'OTHER']),
  detail: z.string().trim().max(1000).optional(),
});

export async function moderationRoutes(app: FastifyInstance) {
  // POST /reports — any authenticated user flags a piece of UGC. Re-reporting
  // the SAME target is idempotent (a unique constraint on reporter+target), so
  // a jumpy tap never creates duplicate rows or looks like an error.
  app.post('/reports', { preHandler: [app.authenticate] }, async (request: AuthRequest, reply: FastifyReply) => {
    const body = reportSchema.parse(request.body);
    const reporterId = request.user.userId;

    // A user can't report their own profile (the one self-target that's gameable).
    if (body.targetType === 'USER' && body.targetId === reporterId) {
      reply.code(400);
      return { success: false, error: { code: 'CANNOT_REPORT_SELF', message: 'You cannot report your own profile.' } };
    }

    const existing = await app.prisma.contentReport.findUnique({
      where: { reporterId_targetType_targetId: { reporterId, targetType: body.targetType, targetId: body.targetId } },
      select: { id: true, status: true, createdAt: true },
    });
    if (existing) {
      // Already on record — idempotent success, not a duplicate and not an error.
      return { success: true, data: existing, alreadyReported: true };
    }

    const report = await app.prisma.contentReport.create({
      data: {
        reporterId,
        targetType: body.targetType,
        targetId: body.targetId,
        reason: body.reason,
        detail: body.detail ?? null,
      },
      select: { id: true, status: true, createdAt: true },
    });
    reply.code(201);
    return { success: true, data: report };
  });
}
