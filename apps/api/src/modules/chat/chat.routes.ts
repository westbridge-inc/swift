import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { detectOffPlatformContact, OFF_PLATFORM_WARNING } from './off-platform';
import { NotificationService } from '../notification/notification.service';
import { NotFoundError, ForbiddenError } from '../../utils/errors';

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

    // Off-platform contact detection (spec §2): the message still delivers —
    // the sender gets a soft nudge and the flag feeds risk signals. Detection,
    // never censorship.
    const offPlatform = detectOffPlatformContact(message);

    const msg = await app.prisma.chatMessage.create({
      data: {
        chatRoomId: roomId,
        senderId: request.user.userId,
        message,
        messageType,
        mediaUrl,
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
        body: message.substring(0, 100),
        data: { roomId, messageId: msg.id },
      });
    }

    return {
      success: true,
      data: msg,
      ...(offPlatform ? { warning: OFF_PLATFORM_WARNING } : {}),
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

    return { success: true, data: messages.reverse() };
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
