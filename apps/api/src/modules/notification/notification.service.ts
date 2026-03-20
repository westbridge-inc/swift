import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';

type NotificationType =
  | 'ORDER_UPDATE'
  | 'PROMOTION'
  | 'SUBSCRIPTION_REMINDER'
  | 'SUBSCRIPTION_EXPIRED'
  | 'PAYMENT_RECEIVED'
  | 'EARNING_AVAILABLE'
  | 'RATING_RECEIVED'
  | 'SYSTEM_ANNOUNCEMENT'
  | 'CHAT_MESSAGE';

interface NotificationPayload {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export class NotificationService {
  constructor(
    private prisma: PrismaClient,
    private io: Server,
  ) {}

  async send(payload: NotificationPayload): Promise<void> {
    // Persist to DB
    const notification = await this.prisma.notification.create({
      data: {
        userId: payload.userId,
        type: payload.type,
        title: payload.title,
        body: payload.body,
        data: (payload.data ?? undefined) as any,
      },
    });

    // Push via Socket.IO
    this.io.to(`user:${payload.userId}`).emit('notification', {
      id: notification.id,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      createdAt: notification.createdAt,
    });

    // TODO: Firebase push notification for mobile when user is offline
    // const tokens = await this.prisma.deviceToken.findMany({
    //   where: { userId: payload.userId, isActive: true },
    // });
    // if (tokens.length > 0) await this.sendPushNotification(tokens, payload);
  }

  async sendToMany(userIds: string[], payload: Omit<NotificationPayload, 'userId'>): Promise<void> {
    await Promise.all(
      userIds.map((userId) => this.send({ ...payload, userId })),
    );
  }

  async markAsRead(userId: string, notificationId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async markAllAsRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, isRead: false },
    });
  }

  // Order-specific notification helpers
  async orderAccepted(customerId: string, orderNumber: string, vendorName: string, orderId: string): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'Order Accepted!',
      body: `${vendorName} has accepted your order ${orderNumber} and is preparing it.`,
      data: { orderId, orderNumber, status: 'ACCEPTED' },
    });
  }

  async orderPreparing(customerId: string, orderNumber: string, vendorName: string, orderId: string): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'Being Prepared',
      body: `${vendorName} is preparing your order ${orderNumber}.`,
      data: { orderId, orderNumber, status: 'PREPARING' },
    });
  }

  async orderReady(customerId: string, orderNumber: string, orderId: string): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'Food Ready!',
      body: `Your order ${orderNumber} is ready and waiting for a rider.`,
      data: { orderId, orderNumber, status: 'READY_FOR_PICKUP' },
    });
  }

  async riderAssigned(customerId: string, orderNumber: string, riderName: string, orderId: string): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'Rider On The Way!',
      body: `${riderName} is heading to pick up your order ${orderNumber}.`,
      data: { orderId, orderNumber, status: 'RIDER_ASSIGNED' },
    });
  }

  async orderPickedUp(customerId: string, orderNumber: string, riderName: string, orderId: string, eta: number): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'On Its Way!',
      body: `${riderName} picked up your order ${orderNumber}. Arriving in ~${eta} min.`,
      data: { orderId, orderNumber, status: 'PICKED_UP', eta },
    });
  }

  async orderDelivered(customerId: string, orderNumber: string, orderId: string): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'Delivered!',
      body: `Your order ${orderNumber} has been delivered. Enjoy your meal!`,
      data: { orderId, orderNumber, status: 'DELIVERED' },
    });
  }

  async newOrderForVendor(vendorOwnerId: string, orderNumber: string, itemCount: number, total: number, orderId: string): Promise<void> {
    await this.send({
      userId: vendorOwnerId,
      type: 'ORDER_UPDATE',
      title: 'New Order!',
      body: `Order ${orderNumber} — ${itemCount} item(s), $${total.toLocaleString()} GYD`,
      data: { orderId, orderNumber, status: 'PENDING' },
    });
  }

  async newDeliveryForRider(riderId: string, orderNumber: string, vendorName: string, deliveryFee: number, orderId: string): Promise<void> {
    await this.send({
      userId: riderId,
      type: 'ORDER_UPDATE',
      title: 'Delivery Available',
      body: `Pickup from ${vendorName} — $${deliveryFee.toLocaleString()} GYD fee`,
      data: { orderId, orderNumber },
    });
  }

  async earningAvailable(userId: string, amount: number, type: string): Promise<void> {
    await this.send({
      userId,
      type: 'EARNING_AVAILABLE',
      title: 'Earning Available',
      body: `You earned $${amount.toLocaleString()} GYD from ${type.toLowerCase().replace('_', ' ')}.`,
      data: { amount, earningType: type },
    });
  }

  async ratingReceived(userId: string, score: number, from: string): Promise<void> {
    await this.send({
      userId,
      type: 'RATING_RECEIVED',
      title: 'New Rating',
      body: `You received a ${score}-star rating from ${from}.`,
      data: { score },
    });
  }

  async subscriptionReminder(userId: string, dueDate: string, amount: number): Promise<void> {
    await this.send({
      userId,
      type: 'SUBSCRIPTION_REMINDER',
      title: 'Subscription Due Soon',
      body: `Your weekly subscription of $${amount.toLocaleString()} GYD is due on ${dueDate}.`,
      data: { dueDate, amount },
    });
  }
}
