import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { detectOffPlatformContact, OFF_PLATFORM_WARNING } from './off-platform';
import { digitRun, mediaUrlCarriesSecret, redactOrderSecrets, SECRET_REDACTED_WARNING } from './secret-guard';

import { NotificationService } from '../notification/notification.service';
import { assertUsersMayContact } from '../moderation/user-block.service';
import { getTenantId } from '../../plugins/tenant-context';
import { NotFoundError, ForbiddenError } from '../../utils/errors';

/** How far back the split-code check looks. Bounded on BOTH axes on purpose:
 *  an unbounded scan of a long conversation would put an O(history) query on
 *  the send path, which is a denial-of-service surface reachable by anyone who
 *  can chat. Twelve messages inside ten minutes covers a code typed in pieces
 *  without covering a day of ordinary conversation. */
const SPLIT_CODE_LOOKBACK = 12;
const SPLIT_CODE_WINDOW_MS = 10 * 60 * 1000;

/** The digits this sender has recently put into this room, oldest first, so a
 *  code delivered across several messages reads the way the RECIPIENT reads
 *  it: in order, as one string. */
async function recentSenderDigits(app: any, roomId: string, senderId: string): Promise<string> {
  const since = new Date(Date.now() - SPLIT_CODE_WINDOW_MS);
  const rows = await app.prisma.chatMessage.findMany({
    where: { chatRoomId: roomId, senderId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: SPLIT_CODE_LOOKBACK,
    select: { message: true },
  });
  return rows.reverse().map((r: { message: string }) => digitRun(r.message)).join('');
}

const createRoomSchema = z.object({
  orderId: z.string().min(1),
});

const sendMessageSchema = z.object({
  message: z.string().min(1).max(2000),
  messageType: z.string().min(1).max(30).default('text'),
  mediaUrl: z.string().max(2048).optional(),
});

const messagesQuerySchema = z.object({
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function chatRoutes(app: FastifyInstance) {
  const notifications = new NotificationService(app.prisma, app.io);

  // Get or create chat room for an order
  app.post('/rooms', { preHandler: [app.authenticate] }, async (request) => {
    const { orderId } = createRoomSchema.parse(request.body);

    // Verify user is part of this order
    const order = await app.prisma.order.findUnique({
      where: { id: orderId },
      select: { customerId: true, riderId: true, driverId: true, rider: { select: { userId: true } }, driver: { select: { userId: true } } },
    });
    // UG-CRAFT-02: chat previously hand-rolled 200-with-success:false error
    // envelopes — axios clients RESOLVED them as success and rendered broken
    // empties. Thrown AppErrors ride the platform taxonomy like every other
    // module (real status codes, standard client error handling).
    if (!order) throw new NotFoundError('Order', orderId);

    const participantUserIds = [order.customerId];
    if (order.rider?.userId) participantUserIds.push(order.rider.userId);
    if (order.driver?.userId) participantUserIds.push(order.driver.userId);

    if (!participantUserIds.includes(request.user.userId)) {
      throw new ForbiddenError('You are not part of this order');
    }

    // [STORE-002] A block stops contact in BOTH directions. Checked before the
    // room is created rather than only on send, so a blocked party never gets
    // an open room they can watch.
    const tenantId = getTenantId() ?? 'swift-default';
    for (const other of participantUserIds.filter((uid) => uid !== request.user.userId)) {
      await assertUsersMayContact(app.prisma, tenantId, request.user.userId, other);
    }

    // Find existing room
    let room = await app.prisma.chatRoom.findFirst({
      where: { orderId },
      include: {
        participants: { include: { user: { select: { id: true, firstName: true, avatar: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });

    if (!room) {
      room = await app.prisma.chatRoom.create({
        data: {
          orderId,
          participants: {
            create: participantUserIds.map((uid) => ({
              userId: uid,
              role: uid === order.customerId ? 'customer' : 'rider',
            })),
          },
        },
        include: {
          participants: { include: { user: { select: { id: true, firstName: true, avatar: true } } } },
          messages: { orderBy: { createdAt: 'desc' }, take: 50 },
        },
      });
    }

    return { success: true, data: room };
  });

  // Send a message
  app.post('/rooms/:roomId/messages', { preHandler: [app.authenticate] }, async (request) => {
    const { roomId } = request.params as { roomId: string };
    const { message, messageType, mediaUrl } = sendMessageSchema.parse(request.body);

    // Verify participation
    const participant = await app.prisma.chatRoomParticipant.findFirst({
      where: { chatRoomId: roomId, userId: request.user.userId },
    });
    if (!participant) throw new ForbiddenError('Not a participant');

    // [STORE-002] Someone can be blocked mid-conversation — which is exactly
    // when a person reaches for it. Refuse the SEND, in both directions, and
    // say so plainly: a message silently swallowed leaves the sender believing
    // it arrived, and that is its own kind of harm.
    //
    // Reading is deliberately still allowed. The transcript already written is
    // how a customer finds "I left it inside your gate" after they have blocked
    // the person who wrote it; deleting or hiding it would destroy the record
    // at the moment it matters most.
    const roomParticipants = await app.prisma.chatRoomParticipant.findMany({
      where: { chatRoomId: roomId, userId: { not: request.user.userId } },
      select: { userId: true },
    });
    const chatTenantId = getTenantId() ?? 'swift-default';
    for (const other of roomParticipants) {
      await assertUsersMayContact(app.prisma, chatTenantId, request.user.userId, other.userId);
    }

    // Off-platform contact detection (spec §2): the message still delivers —
    // the sender gets a soft nudge and the flag feeds risk signals. Detection,
    // never censorship.
    const offPlatform = detectOffPlatformContact(message);

    // [F-027-12] ...with exactly one exception. The order's pickup/ride code is
    // not content to moderate, it is the proof that the driver physically met
    // the customer. Chat puts the driver in the room and copies message text
    // verbatim into the other participants' PUSH bodies, so an unguarded room
    // both defeats the control and lands the secret on a lock screen. Strip it
    // BEFORE the row is written, the socket fires, or a push is built — a
    // stored original is its own disclosure channel.
    const room = await app.prisma.chatRoom.findUnique({ where: { id: roomId }, select: { orderId: true } });
    const secrets = room?.orderId
      ? await app.prisma.order.findUnique({ where: { id: room.orderId }, select: { ridePin: true, pickupCode: true } })
      : null;
    // [F-028-02] A code split across messages — "481" then "902" — arrives
    // whole in the ordered transcript while each part looks innocent. Judge
    // this message against the digits THIS sender has already put in THIS
    // room recently, so the pieces are read the way the reader reads them.
    // Bounded by count and by time: a guard that walks an entire conversation
    // is a denial-of-service surface on the send path.
    const priorDigits = secrets
      ? await recentSenderDigits(app, roomId, request.user.userId)
      : '';
    const guarded = redactOrderSecrets(message, secrets ?? {}, priorDigits);
    const body = guarded.text;
    // A mediaUrl is an arbitrary sender-supplied string that is stored and
    // emitted to the other participant, so a path naming the code crosses
    // untouched. There is nothing to preserve around a secret in a URL, so
    // the attachment is dropped rather than mangled into a broken link.
    const mediaBlocked = mediaUrlCarriesSecret(mediaUrl, secrets ?? {});
    const safeMediaUrl = mediaBlocked ? undefined : mediaUrl;

    const msg = await app.prisma.chatMessage.create({
      data: {
        chatRoomId: roomId,
        senderId: request.user.userId,
        message: body,
        messageType,
        mediaUrl: safeMediaUrl,
        offPlatformFlag: offPlatform,
      },
    });

    // Broadcast via Socket.IO
    app.io.to(`chat:${roomId}`).emit('chat:message', {
      id: msg.id,
      roomId,
      senderId: request.user.userId,
      message: msg.message,
      messageType: msg.messageType,
      mediaUrl: msg.mediaUrl,
      createdAt: msg.createdAt,
    });

    // Notify other participants
    const otherParticipants = await app.prisma.chatRoomParticipant.findMany({
      where: { chatRoomId: roomId, userId: { not: request.user.userId } },
    });

    const sender = await app.prisma.user.findUnique({ where: { id: request.user.userId }, select: { firstName: true } });

    // SWIFT-101: route through NotificationService — the ONE notification path
    // (rule #17) — so a chat message is delivered as a PUSH (when the provider
    // is live), respects the recipient's prefs, and lands in the failure
    // metrics. The old code wrote a row + a socket emit only, so a backgrounded
    // app never learned about the message.
    for (const p of otherParticipants) {
      await notifications.send({
        userId: p.userId,
        type: 'CHAT_MESSAGE',
        title: `Message from ${sender?.firstName || 'Someone'}`,
        body: body.substring(0, 100),
        data: { roomId, messageId: msg.id },
      });
    }

    return {
      success: true,
      data: msg,
      // [F-027-12] The redaction warning wins: silently mangling someone's
      // text is worse than the nudge it would have replaced, and this is the
      // one they need to read.
      // A dropped attachment needs the same explanation as a redacted line —
      // an image that silently fails to send reads as a broken app, and the
      // sender never learns why [F-028-02].
      ...(guarded.redacted || mediaBlocked
        ? { warning: SECRET_REDACTED_WARNING }
        : offPlatform ? { warning: OFF_PLATFORM_WARNING } : {}),
    };
  });

  // Get messages
  app.get('/rooms/:roomId/messages', { preHandler: [app.authenticate] }, async (request) => {
    const { roomId } = request.params as { roomId: string };
    const { before, limit } = messagesQuerySchema.parse(request.query);

    const participant = await app.prisma.chatRoomParticipant.findFirst({
      where: { chatRoomId: roomId, userId: request.user.userId },
    });
    if (!participant) throw new ForbiddenError('Not a participant');

    const messages = await app.prisma.chatMessage.findMany({
      where: {
        chatRoomId: roomId,
        ...(before && { createdAt: { lt: before } }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Mark as read
    await app.prisma.chatRoomParticipant.update({
      where: { id: participant.id },
      data: { lastReadAt: new Date() },
    });

    // [F-028-02] Rows written BEFORE the guard existed — or before it learned a
    // vector — still hold the live code, and history is a disclosure channel
    // like any other: the driver just scrolls up. Re-redact on the way out, so
    // closing a hole closes it for the whole conversation and not only for
    // messages sent from now on. Stored rows are deliberately left alone: an
    // evidence trail that quietly rewrites itself is worse than one that
    // carries a secret nobody can act on once the code has been used.
    const historyRoom = await app.prisma.chatRoom.findUnique({ where: { id: roomId }, select: { orderId: true } });
    const historySecrets = historyRoom?.orderId
      ? await app.prisma.order.findUnique({ where: { id: historyRoom.orderId }, select: { ridePin: true, pickupCode: true } })
      : null;
    const visible = historySecrets
      ? messages.map((m) => ({
          ...m,
          message: redactOrderSecrets(m.message, historySecrets).text,
          mediaUrl: mediaUrlCarriesSecret(m.mediaUrl, historySecrets) ? null : m.mediaUrl,
        }))
      : messages;

    return { success: true, data: visible.reverse() };
  });

  // Mark room as read
  app.put('/rooms/:roomId/read', { preHandler: [app.authenticate] }, async (request) => {
    const { roomId } = request.params as { roomId: string };
    await app.prisma.chatRoomParticipant.updateMany({
      where: { chatRoomId: roomId, userId: request.user.userId },
      data: { lastReadAt: new Date() },
    });
    return { success: true };
  });

  // Get user's active chat rooms
  app.get('/rooms', { preHandler: [app.authenticate] }, async (request) => {
    // Surfaces are role-scoped: the shopping app lists the rooms you're in AS
    // the customer; a mover's job chats live in the driver app (?as=rider).
    const { as, page, limit } = z
      .object({
        as: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);
    const roleFilter = as === 'customer' || as === 'rider' ? { role: as } : {};
    // UG-CRAFT-02: bounded — a long-lived account accumulates rooms without
    // limit. The response shape stays a plain array (existing clients read it
    // directly), newest first, with opt-in page/limit for deeper history.
    const rooms = await app.prisma.chatRoom.findMany({
      where: {
        isActive: true,
        participants: { some: { userId: request.user.userId, ...roleFilter } },
      },
      include: {
        participants: { include: { user: { select: { id: true, firstName: true, avatar: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      success: true,
      data: rooms.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        participants: r.participants.map((p) => ({
          userId: p.user.id,
          name: p.user.firstName,
          avatar: p.user.avatar,
          role: p.role,
        })),
        lastMessage: r.messages[0] || null,
      })),
    };
  });
}
