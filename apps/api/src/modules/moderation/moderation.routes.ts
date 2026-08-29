import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getTenantId } from '../../plugins/tenant-context';
import { activateUserBlock, deactivateUserBlock } from './user-block.service';

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

  // -------------------------------------------------------------------------
  // STORE-002: blocking. The third leg of Apple 1.2 / Google's UGC policy, and
  // the one Swift was missing — a person could report someone for harassment
  // and be matched with them again the same evening.
  //
  // These live beside /reports on purpose: report and block are the two things
  // a person reaches for in the same moment, and a client that found one door
  // finds the other.
  // -------------------------------------------------------------------------

  const blockSchema = z.object({
    blockedUserId: z.string().trim().min(1).max(64),
    reason: z.string().trim().max(500).optional(),
  });

  /** GET /blocks — everyone this caller is currently refusing contact with.
   *  Names, because a screen listing cuids is not a screen anyone can use;
   *  nothing else, because a block list is not a directory lookup. */
  app.get('/blocks', { preHandler: [app.authenticate] }, async (request: AuthRequest) => {
    const tenantId = getTenantId() ?? 'swift-default';
    const rows = await app.prisma.userBlock.findMany({
      where: { tenantId, blockerId: request.user.userId, unblockedAt: null },
      select: { id: true, blockedId: true, blockedAt: true, reason: true },
      orderBy: { blockedAt: 'desc' },
    });
    const people = rows.length
      ? await app.prisma.user.findMany({
        where: { id: { in: rows.map((r) => r.blockedId) } },
        select: { id: true, firstName: true, lastName: true },
      })
      : [];
    const byId = new Map(people.map((p) => [p.id, p]));
    return {
      success: true,
      data: rows.map((r) => {
        const person = byId.get(r.blockedId);
        return {
          id: r.id,
          userId: r.blockedId,
          // A deleted account still has a row here. Saying so is better than a
          // blank line the reader cannot interpret, and better than dropping
          // the row, which would read as "the block is gone".
          name: person ? `${person.firstName} ${person.lastName}`.trim() : 'Account no longer on Swift',
          blockedAt: r.blockedAt,
          reason: r.reason,
        };
      }),
    };
  });

  /** POST /blocks — put a block in force. Idempotent. */
  app.post('/blocks', { preHandler: [app.authenticate] }, async (request: AuthRequest, reply: FastifyReply) => {
    const body = blockSchema.parse(request.body);
    const tenantId = getTenantId() ?? 'swift-default';
    const blockerId = request.user.userId;

    if (body.blockedUserId === blockerId) {
      reply.code(400);
      return { success: false, error: { code: 'CANNOT_BLOCK_SELF', message: 'You cannot block your own account.' } };
    }

    // A block on an id that is nobody would sit in the table forever doing
    // nothing, and the caller would believe they were protected. The lookup is
    // tenant-scoped by the Prisma extension, so it cannot confirm the
    // existence of an account belonging to another operator.
    const target = await app.prisma.user.findUnique({
      where: { id: body.blockedUserId },
      select: { id: true },
    });
    if (!target) {
      reply.code(404);
      return { success: false, error: { code: 'USER_NOT_FOUND', message: 'That account could not be found.' } };
    }

    const { block, alreadyBlocked } = await activateUserBlock(app.prisma, {
      tenantId,
      blockerId,
      blockedId: body.blockedUserId,
      reason: body.reason ?? null,
    });
    reply.code(alreadyBlocked ? 200 : 201);
    return { success: true, data: block, alreadyBlocked };
  });

  /** PUT /blocks/:blockedUserId — lift a block. Unblocking someone who is not
   *  blocked is a no-op success: the caller's intent ("I do not want this
   *  block") is satisfied either way, and a 404 here would tell them about a
   *  row they cannot see. */
  app.put('/blocks/:blockedUserId', { preHandler: [app.authenticate] }, async (request: AuthRequest) => {
    const { blockedUserId } = z.object({ blockedUserId: z.string().trim().min(1).max(64) }).parse(request.params);
    const tenantId = getTenantId() ?? 'swift-default';
    const lifted = await deactivateUserBlock(app.prisma, {
      tenantId,
      blockerId: request.user.userId,
      blockedId: blockedUserId,
    });
    return { success: true, data: { unblocked: lifted > 0 } };
  });
}
