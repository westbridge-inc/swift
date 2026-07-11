import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

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
  // Get or create chat room for an order
  app.post('/rooms', { preHandler: [app.authenticate] }, async (request) => {
    const { orderId } = createRoomSchema.parse(request.body);

    // Verify user is part of this order
    const order = await app.prisma.order.findUnique({
      where: { id: orderId },
      select: { customerId: true, riderId: true, driverId: true, rider: { select: { userId: true } }, driver: { select: { userId: true } } },
    });
    if (!order) return { success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } };

    const participantUserIds = [order.customerId];
    if (order.rider?.userId) participantUserIds.push(order.rider.userId);
    if (order.driver?.userId) participantUserIds.push(order.driver.userId);

    if (!participantUserIds.includes(request.user.userId)) {
      return { success: false, error: { code: 'FORBIDDEN', message: 'You are not part of this order' } };
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
    if (!participant) return { success: false, error: { code: 'FORBIDDEN', message: 'Not a participant' } };

    const msg = await app.prisma.chatMessage.create({
      data: {
        chatRoomId: roomId,
        senderId: request.user.userId,
        message,
        messageType,
        mediaUrl,
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

    for (const p of otherParticipants) {
      await app.prisma.notification.create({
        data: {
          userId: p.userId,
          type: 'CHAT_MESSAGE',
          title: `Message from ${sender?.firstName || 'Someone'}`,
          body: message.substring(0, 100),
          data: { roomId, messageId: msg.id },
        },
      });
      app.io.to(`user:${p.userId}`).emit('notification', {
        type: 'CHAT_MESSAGE',
        title: `Message from ${sender?.firstName}`,
        body: message.substring(0, 100),
      });
    }

    return { success: true, data: msg };
  });

  // Get messages
  app.get('/rooms/:roomId/messages', { preHandler: [app.authenticate] }, async (request) => {
    const { roomId } = request.params as { roomId: string };
    const { before, limit } = messagesQuerySchema.parse(request.query);

    const participant = await app.prisma.chatRoomParticipant.findFirst({
      where: { chatRoomId: roomId, userId: request.user.userId },
    });
    if (!participant) return { success: false, error: { code: 'FORBIDDEN', message: 'Not a participant' } };

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
    const { as } = request.query as { as?: string };
    const roleFilter = as === 'customer' || as === 'rider' ? { role: as } : {};
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
