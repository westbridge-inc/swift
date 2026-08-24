import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { getTenantId } from '../../plugins/prisma';
import { REPORT_TARGET_TYPES, resolveModerationTarget } from './moderation-target';

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
  targetType: z.enum(REPORT_TARGET_TYPES),
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
    const tenantId = getTenantId();

    // Auth normally binds this from the live session. Fail closed if a future
    // composition forgets the request tenant hook; an unscoped report is an
    // audit-provenance defect, not a best-effort write.
    if (!tenantId) {
      reply.code(503);
      return { success: false, error: { code: 'TENANT_CONTEXT_REQUIRED', message: 'Unable to verify the reporting account right now.' } };
    }

    const existing = await app.prisma.contentReport.findUnique({
      where: { reporterId_targetType_targetId: { reporterId, targetType: body.targetType, targetId: body.targetId } },
      select: { id: true, status: true, createdAt: true },
    });
    if (existing) {
      // Already on record — idempotent success even if the target was later
      // removed. The audit row outlives the objectionable content by design.
      return { success: true, data: existing, alreadyReported: true };
    }

    const target = await resolveModerationTarget(app, {
      targetType: body.targetType,
      targetId: body.targetId,
      actorUserId: reporterId,
      tenantId,
    });
    if (!target) {
      reply.code(404);
      return { success: false, error: { code: 'REPORT_TARGET_NOT_FOUND', message: 'This content is unavailable or cannot be reported.' } };
    }

    // Self-reporting any surface is gameable, not just a profile. Ownership is
    // resolved server-side from the real target instead of trusted client data.
    if (target.authorUserId === reporterId) {
      reply.code(400);
      return { success: false, error: { code: 'CANNOT_REPORT_SELF', message: 'You cannot report your own content.' } };
    }

    let report: { id: string; status: string; createdAt: Date };
    try {
      report = await app.prisma.contentReport.create({
        data: {
          tenantId,
          reporterId,
          targetType: body.targetType,
          targetId: body.targetId,
          reason: body.reason,
          detail: body.detail ?? null,
          // Preserve what the reporter saw. Live content may be edited or
          // removed before a human opens the queue; the immutable snapshot keeps
          // the report reviewable without making target deletion impossible.
          targetSnapshot: JSON.parse(JSON.stringify(target.snapshot)),
        },
        select: { id: true, status: true, createdAt: true },
      });
    } catch (error) {
      // The unique constraint is the concurrent-tap boundary. Both requests
      // may pass the optimistic read above; the loser still receives the same
      // idempotent success instead of a database-shaped 500.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await app.prisma.contentReport.findUnique({
          where: { reporterId_targetType_targetId: { reporterId, targetType: body.targetType, targetId: body.targetId } },
          select: { id: true, status: true, createdAt: true },
        });
        if (winner) return { success: true, data: winner, alreadyReported: true };
      }
      throw error;
    }
    reply.code(201);
    return { success: true, data: report };
  });
}
