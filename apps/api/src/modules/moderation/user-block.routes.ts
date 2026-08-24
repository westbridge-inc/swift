import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getTenantId } from '../../plugins/tenant-context';
import { AppError, NotFoundError } from '../../utils/errors';
import { resolveAvatarUrl, resolveAvatarUrls } from '../../utils/avatar-url';
import { REPORT_TARGET_TYPES, resolveModerationTarget } from './moderation-target';
import {
  activateUserBlock,
  deactivateUserBlock,
  lockUserContactPair,
} from './user-block.service';

const createBlockSchema = z.union([
  z.object({ blockedUserId: z.string().trim().min(1).max(64) }).strict(),
  z.object({
    targetType: z.enum(REPORT_TARGET_TYPES),
    targetId: z.string().trim().min(1).max(64),
  }).strict(),
]);

const setBlockSchema = z.object({ blocked: z.boolean() }).strict();

export async function userBlockRoutes(app: FastifyInstance) {
  function authenticatedTenant(): string {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new AppError(401, 'UNAUTHORIZED', 'No authenticated tenant is bound to this request');
    }
    return tenantId;
  }

  async function requireLocalUser(userId: string, tenantId: string) {
    const user = await app.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    if (!user) throw new NotFoundError('User', userId);
    return { ...user, avatar: await resolveAvatarUrl(user.avatar) };
  }

  async function blockedUserIdFromBody(
    body: z.infer<typeof createBlockSchema>,
    blockerId: string,
    tenantId: string,
  ): Promise<string> {
    if ('blockedUserId' in body) return body.blockedUserId;

    // An order snapshot can contain text from the customer, vendor, rider and
    // status-log author. Reporting the whole evidence bundle is useful, but a
    // target-based block would guess at which participant the user intended.
    // Clients must offer an explicit USER/VENDOR action beside that person.
    if (body.targetType === 'ORDER') {
      throw new AppError(400, 'BLOCK_TARGET_UNAVAILABLE', 'Choose the specific account you want to block.');
    }

    const target = await resolveModerationTarget(app, {
      targetType: body.targetType,
      targetId: body.targetId,
      actorUserId: blockerId,
      tenantId,
    });
    if (!target) {
      throw new AppError(404, 'BLOCK_TARGET_NOT_FOUND', 'This account or content is unavailable.');
    }
    if (!target.authorUserId) {
      throw new AppError(400, 'BLOCK_TARGET_UNAVAILABLE', 'This content does not belong to a blockable account.');
    }
    return target.authorUserId;
  }

  /**
   * Remove live sockets from shared chat rooms immediately after commit. New
   * joins and REST sends independently check the database, so this is delivery
   * cleanup rather than the authority boundary.
   */
  async function evictSharedChatSockets(firstUserId: string, secondUserId: string): Promise<void> {
    const rooms = await app.prisma.chatRoom.findMany({
      where: {
        AND: [
          { participants: { some: { userId: firstUserId } } },
          { participants: { some: { userId: secondUserId } } },
        ],
      },
      select: { id: true },
    });
    for (const room of rooms) {
      app.io.in(`user:${firstUserId}`).socketsLeave(`chat:${room.id}`);
      app.io.in(`user:${secondUserId}`).socketsLeave(`chat:${room.id}`);
    }
  }

  // Active blocks only. Closed episodes remain in the database audit trail but
  // are not exposed as current app settings.
  app.get('/blocks', { preHandler: [app.authenticate] }, async (request) => {
    const tenantId = authenticatedTenant();
    const blockerId = request.user.userId;
    const rows = await app.prisma.userBlock.findMany({
      where: { tenantId, blockerId, unblockedAt: null },
      select: { id: true, blockedId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const users = await app.prisma.user.findMany({
      where: { tenantId, id: { in: rows.map((row) => row.blockedId) } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    const avatars = await resolveAvatarUrls(users.map((user) => user.avatar));
    const byId = new Map(users.map((user) => [user.id, {
      ...user,
      avatar: user.avatar ? avatars.get(user.avatar) ?? null : null,
    }]));

    return {
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        blockedUserId: row.blockedId,
        blockedAt: row.createdAt,
        // A historical id may outlive an account. Keep the active setting
        // reversible even then and avoid fabricating a display identity.
        blockedUser: byId.get(row.blockedId) ?? null,
      })),
    };
  });

  app.post('/blocks', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = createBlockSchema.parse(request.body);
    const tenantId = authenticatedTenant();
    const blockerId = request.user.userId;
    const blockedId = await blockedUserIdFromBody(body, blockerId, tenantId);
    if (blockedId === blockerId) {
      throw new AppError(400, 'CANNOT_BLOCK_SELF', 'You cannot block your own account.');
    }
    const blockedUser = await requireLocalUser(blockedId, tenantId);

    const result = await app.prisma.$transaction(async (tx) => {
      await lockUserContactPair(tx, tenantId, blockerId, blockedId);
      return activateUserBlock(tx, { tenantId, blockerId, blockedId });
    });
    await evictSharedChatSockets(blockerId, blockedId);
    reply.code(result.alreadyBlocked ? 200 : 201);
    return {
      success: true,
      alreadyBlocked: result.alreadyBlocked,
      data: {
        id: result.block.id,
        blockedUserId: blockedId,
        blockedAt: result.block.createdAt,
        blockedUser,
      },
    };
  });

  // PUT, never DELETE: `false` closes the active episode in place; a later
  // `true` creates a fresh episode and preserves the full block/unblock trail.
  app.put('/blocks/:blockedUserId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { blockedUserId } = request.params as { blockedUserId: string };
    const { blocked } = setBlockSchema.parse(request.body);
    const tenantId = authenticatedTenant();
    const blockerId = request.user.userId;
    if (blockedUserId === blockerId) {
      throw new AppError(400, 'CANNOT_BLOCK_SELF', 'You cannot block your own account.');
    }

    if (blocked) {
      const blockedUser = await requireLocalUser(blockedUserId, tenantId);
      const result = await app.prisma.$transaction(async (tx) => {
        await lockUserContactPair(tx, tenantId, blockerId, blockedUserId);
        return activateUserBlock(tx, { tenantId, blockerId, blockedId: blockedUserId });
      });
      await evictSharedChatSockets(blockerId, blockedUserId);
      reply.code(result.alreadyBlocked ? 200 : 201);
      return {
        success: true,
        alreadyBlocked: result.alreadyBlocked,
        data: {
          id: result.block.id,
          blockedUserId,
          blockedAt: result.block.createdAt,
          blockedUser,
        },
      };
    }

    const resolved = await app.prisma.$transaction(async (tx) => {
      await lockUserContactPair(tx, tenantId, blockerId, blockedUserId);
      return deactivateUserBlock(tx, {
        tenantId,
        blockerId,
        blockedId: blockedUserId,
      });
    });
    return { success: true, data: { blockedUserId, blocked: false, alreadyUnblocked: resolved === 0 } };
  });
}
