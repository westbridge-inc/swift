import type { FastifyInstance } from 'fastify';

export const REPORT_TARGET_TYPES = [
  'RATING',
  'RATING_RESPONSE',
  'CHAT_MESSAGE',
  'USER',
  'VENDOR',
  'ITEM',
  'CATEGORY',
  'PROMO_CODE',
  'SERVICE_PROVIDER',
  'SERVICE_JOB',
  'ORDER',
  'AD_CREATIVE',
] as const;

export type ModerationTargetType = (typeof REPORT_TARGET_TYPES)[number];

export interface ResolvedModerationTarget {
  targetType: ModerationTargetType;
  targetId: string;
  tenantId: string;
  /** The account whose UGC this is. Null is reserved for system-owned content. */
  authorUserId: string | null;
  /** Minimal evidence snapshot for moderation/block confirmation; never public by default. */
  snapshot: Record<string, unknown>;
}

export interface ResolveModerationTargetInput {
  targetType: ModerationTargetType;
  targetId: string;
  actorUserId: string;
  tenantId: string;
}

function resolved(
  input: ResolveModerationTargetInput,
  authorUserId: string | null,
  snapshot: Record<string, unknown>,
): ResolvedModerationTarget {
  return { ...input, authorUserId, snapshot };
}

/**
 * Resolve a report/block target without trusting an opaque client id.
 *
 * Returning null deliberately combines "missing", "other tenant", and "you
 * cannot see this" so the endpoint never becomes an existence oracle. Public
 * UGC is available to any local account; private job/order/chat UGC requires
 * the actor to be a participant. The returned author lets report and block
 * paths apply the same self-target and ownership rules.
 */
export async function resolveModerationTarget(
  app: FastifyInstance,
  input: ResolveModerationTargetInput,
): Promise<ResolvedModerationTarget | null> {
  const { targetType, targetId, actorUserId, tenantId } = input;

  switch (targetType) {
    case 'USER': {
      const row = await app.prisma.user.findFirst({
        where: { id: targetId, tenantId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatar: true,
          rider: {
            select: {
              vehicleMake: true,
              vehicleModel: true,
              vehicleColor: true,
              licensePlate: true,
              profilePhotoUrl: true,
              vehiclePhotoUrl: true,
            },
          },
          driver: {
            select: {
              vehicleMake: true,
              vehicleModel: true,
              vehicleColor: true,
              licensePlate: true,
              profilePhotoUrl: true,
              vehiclePhotoUrl: true,
            },
          },
        },
      });
      return row ? resolved(input, row.id, row) : null;
    }

    case 'VENDOR': {
      const row = await app.prisma.vendor.findFirst({
        where: { id: targetId, tenantId },
        select: {
          id: true,
          name: true,
          description: true,
          logoUrl: true,
          coverImageUrl: true,
          images: { select: { id: true, url: true, caption: true } },
          owner: { select: { userId: true } },
        },
      });
      return row ? resolved(input, row.owner.userId, row) : null;
    }

    case 'ITEM': {
      const row = await app.prisma.item.findFirst({
        where: { id: targetId, vendor: { tenantId } },
        select: {
          id: true,
          name: true,
          description: true,
          imageUrl: true,
          optionGroups: {
            select: {
              id: true,
              name: true,
              options: { select: { id: true, name: true } },
            },
          },
          vendor: { select: { owner: { select: { userId: true } } } },
        },
      });
      return row ? resolved(input, row.vendor.owner.userId, row) : null;
    }

    case 'CATEGORY': {
      const row = await app.prisma.category.findFirst({
        where: { id: targetId, vendor: { tenantId } },
        select: {
          id: true,
          name: true,
          description: true,
          imageUrl: true,
          vendor: { select: { owner: { select: { userId: true } } } },
        },
      });
      return row ? resolved(input, row.vendor.owner.userId, row) : null;
    }

    case 'PROMO_CODE': {
      // A platform promo is operator-authored, not UGC. Only vendor-created
      // promos enter the user-report queue.
      const row = await app.prisma.promoCode.findFirst({
        where: { id: targetId, vendor: { tenantId } },
        select: {
          id: true,
          code: true,
          description: true,
          vendor: { select: { owner: { select: { userId: true } } } },
        },
      });
      return row?.vendor ? resolved(input, row.vendor.owner.userId, row) : null;
    }

    case 'RATING': {
      const row = await app.prisma.rating.findFirst({
        where: {
          id: targetId,
          rater: { tenantId },
          OR: [
            { raterId: actorUserId },
            { rateeId: actorUserId },
            { isPublic: true, visibleAt: { not: null }, state: 'ACTIVE' },
          ],
        },
        select: {
          id: true,
          raterId: true,
          rateeId: true,
          vendorId: true,
          score: true,
          comment: true,
          response: true,
          createdAt: true,
        },
      });
      return row ? resolved(input, row.raterId, row) : null;
    }

    case 'RATING_RESPONSE': {
      const row = await app.prisma.rating.findFirst({
        where: {
          id: targetId,
          response: { not: null },
          rater: { tenantId },
          OR: [
            { raterId: actorUserId },
            { isPublic: true, visibleAt: { not: null }, state: 'ACTIVE' },
          ],
        },
        select: {
          id: true,
          vendorId: true,
          response: true,
          respondedAt: true,
          respondedBy: true,
        },
      });
      if (!row?.vendorId) return null;
      const vendor = await app.prisma.vendor.findFirst({
        where: { id: row.vendorId, tenantId },
        select: { id: true, name: true, owner: { select: { userId: true } } },
      });
      if (!vendor) return null;
      // Legacy replies predate respondedBy and belong to the owner. For a
      // modern staff-authored reply, never redirect a block to the owner if
      // the actual staff account was later removed: retain the reportable
      // evidence, but make the optional block action unavailable.
      if (!row.respondedBy) {
        return resolved(input, vendor.owner.userId, { ...row, vendor });
      }
      const responseAuthor = await app.prisma.user.findFirst({
        where: { id: row.respondedBy, tenantId },
        select: { id: true },
      });
      return resolved(input, responseAuthor?.id ?? null, { ...row, vendor });
    }

    case 'CHAT_MESSAGE': {
      const row = await app.prisma.chatMessage.findFirst({
        where: {
          id: targetId,
          chatRoom: {
            participants: { some: { userId: actorUserId, user: { tenantId } } },
          },
        },
        select: {
          id: true,
          senderId: true,
          chatRoomId: true,
          message: true,
          messageType: true,
          mediaUrl: true,
          createdAt: true,
        },
      });
      if (!row) return null;
      const author = await app.prisma.user.findFirst({
        where: { id: row.senderId, tenantId },
        select: { id: true },
      });
      // ChatMessage.senderId is intentionally a loose audit id. Retained
      // objectionable content must stay reportable after its author account is
      // removed; only the optional block action becomes unavailable.
      return resolved(input, author?.id ?? null, row);
    }

    case 'SERVICE_PROVIDER': {
      const row = await app.prisma.serviceProvider.findFirst({
        where: {
          id: targetId,
          user: { tenantId },
          OR: [
            { isVerified: true },
            { userId: actorUserId },
            { jobs: { some: { customerId: actorUserId } } },
          ],
        },
        select: {
          id: true,
          userId: true,
          trade: true,
          bio: true,
          portfolioPhotos: true,
          isVerified: true,
        },
      });
      return row ? resolved(input, row.userId, row) : null;
    }

    case 'SERVICE_JOB': {
      const row = await app.prisma.serviceJob.findFirst({
        where: {
          id: targetId,
          customer: { tenantId },
          provider: { user: { tenantId } },
          OR: [
            { customerId: actorUserId },
            { provider: { userId: actorUserId } },
          ],
        },
        select: {
          id: true,
          customerId: true,
          providerId: true,
          description: true,
          photos: true,
          createdAt: true,
        },
      });
      return row ? resolved(input, row.customerId, row) : null;
    }

    case 'ORDER': {
      const row = await app.prisma.order.findFirst({
        where: {
          id: targetId,
          tenantId,
          OR: [
            { customerId: actorUserId },
            { rider: { userId: actorUserId } },
            { driver: { userId: actorUserId } },
            { vendor: { owner: { userId: actorUserId } } },
            { vendor: { staff: { some: { userId: actorUserId } } } },
          ],
        },
        select: {
          id: true,
          orderNumber: true,
          customerId: true,
          deliveryInstructions: true,
          courierPackageDescription: true,
          courierRecipientName: true,
          cancellationReason: true,
          statusHistory: {
            select: { id: true, status: true, note: true, changedBy: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          },
          vendor: { select: { owner: { select: { userId: true } } } },
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          createdAt: true,
        },
      });
      if (!row) return null;
      const counterpartyAuthor = row.driver?.userId
        ?? row.rider?.userId
        ?? row.vendor?.owner.userId
        ?? null;
      const authorUserId = actorUserId === row.customerId
        ? counterpartyAuthor
        : row.customerId;
      return resolved(input, authorUserId, row);
    }

    case 'AD_CREATIVE': {
      const row = await app.prisma.adCreative.findFirst({
        where: { id: targetId, status: 'APPROVED', campaign: { tenantId } },
        select: {
          id: true,
          kind: true,
          fileUrl: true,
          posterUrl: true,
          headline: true,
          body: true,
          ctaLabel: true,
          campaign: {
            select: {
              advertiser: { select: { createdByUserId: true, companyName: true } },
            },
          },
        },
      });
      return row
        ? resolved(input, row.campaign.advertiser.createdByUserId, row)
        : null;
    }
  }
}
