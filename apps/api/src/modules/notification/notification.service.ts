import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { getChannels, type NotificationChannels } from '../../providers/notifications/channels';

/** Per-user channel switches; the vendor order alert ignores these. */
interface NotificationPrefs {
  push: boolean;
  sms: boolean;
  email: boolean;
}

const DEFAULT_PREFS: NotificationPrefs = { push: true, sms: true, email: false };

type NotificationType =
  | 'ORDER_UPDATE'
  | 'PROMOTION'
  | 'SUBSCRIPTION_REMINDER'
  | 'SUBSCRIPTION_EXPIRED'
  | 'PAYMENT_RECEIVED'
  | 'EARNING_AVAILABLE'
  | 'RATING_RECEIVED'
  | 'SYSTEM_ANNOUNCEMENT'
  | 'CHAT_MESSAGE'
  | 'LOW_STOCK';

interface NotificationPayload {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Vendor-alert escalation step. The unread alert row is the state:
 * read = acknowledged = stop. Level 0 re-alerts (socket + push); level 1
 * falls back to SMS so the phone makes noise even with the app dead.
 * Exported standalone so the queue worker and tests drive the same code.
 */
export async function escalateVendorAlert(
  prisma: PrismaClient,
  io: Server,
  channels: NotificationChannels,
  orderId: string,
  level: number,
): Promise<'stopped' | 'realerted' | 'sms_sent'> {
  const alert = await prisma.notification.findFirst({
    where: {
      isRead: false,
      AND: [
        { data: { path: ['kind'], equals: 'vendor_order_alert' } },
        { data: { path: ['orderId'], equals: orderId } },
      ],
    },
    include: { user: { select: { id: true, phone: true } } },
  });
  if (!alert) return 'stopped'; // acknowledged (or never existed) — done

  const data = alert.data as { orderNumber?: string } | null;

  if (level === 0) {
    io.to(`user:${alert.userId}`).emit('vendor:order_alert', {
      notificationId: alert.id,
      orderId,
      orderNumber: data?.orderNumber,
      persistent: true,
      reAlert: true,
    });
    const tokens = await prisma.deviceToken.findMany({
      where: { userId: alert.userId, isActive: true },
      select: { token: true },
    });
    if (tokens.length > 0) {
      await channels.push
        .sendPush(tokens.map((t) => t.token), 'Order still waiting!', alert.body, { orderId })
        .catch(() => {});
    }
    return 'realerted';
  }

  await channels.sms
    .sendSms(alert.user.phone, `Swift: order ${data?.orderNumber ?? ''} is still waiting for your response. Open your dashboard now.`)
    .catch(() => {});
  return 'sms_sent';
}

export class NotificationService {
  constructor(
    private prisma: PrismaClient,
    private io: Server,
    private channels: NotificationChannels = getChannels(),
  ) {}

  async send(payload: NotificationPayload): Promise<string> {
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

    // Live socket delivery
    this.io.to(`user:${payload.userId}`).emit('notification', {
      id: notification.id,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      createdAt: notification.createdAt,
    });

    // Channel fan-out through the swappable interface, honouring prefs
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      select: { notificationPrefs: true },
    });
    const prefs = { ...DEFAULT_PREFS, ...((user?.notificationPrefs as Partial<NotificationPrefs> | null) ?? {}) };

    if (prefs.push) {
      const tokens = await this.prisma.deviceToken.findMany({
        where: { userId: payload.userId, isActive: true },
        select: { token: true },
      });
      if (tokens.length > 0) {
        // Channel failures must never break the request path
        await this.channels.push
          .sendPush(tokens.map((t) => t.token), payload.title, payload.body, payload.data)
          .catch(() => {});
      }
    }

    return notification.id;
  }

  /** Direct SMS through the interface (OTPs, vendor-alert fallbacks). */
  async sms(to: string, body: string): Promise<void> {
    await this.channels.sms.sendSms(to, body).catch(() => {});
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

  /**
   * THE vendor order alert: a persistent, unmissable event.
   * The unread notification row IS the alert state — the dashboard shows a
   * full-screen banner until it is acknowledged (accept/reject/ack), and the
   * escalation job re-alerts then falls back to SMS while it stays unread.
   * NOT optional for vendors — prefs are ignored on this path by design.
   */
  async newOrderForVendor(vendorOwnerId: string, orderNumber: string, itemCount: number, total: number, orderId: string): Promise<string> {
    const notificationId = await this.send({
      userId: vendorOwnerId,
      type: 'ORDER_UPDATE',
      title: 'New Order!',
      body: `Order ${orderNumber} — ${itemCount} item(s), $${total.toLocaleString()} GYD`,
      data: { orderId, orderNumber, status: 'PENDING', kind: 'vendor_order_alert' },
    });

    // Dedicated persistent-alert event for the vendor dashboard banner + ring
    this.io.to(`user:${vendorOwnerId}`).emit('vendor:order_alert', {
      notificationId,
      orderId,
      orderNumber,
      total,
      persistent: true,
    });

    return notificationId;
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

  /** Inventory engine (§4.2): stock crossed the owner's threshold or hit zero. */
  async lowStock(
    userId: string,
    ev: { itemId: string; name: string; remaining: number; kind: 'low' | 'out' },
  ): Promise<void> {
    await this.send({
      userId,
      type: 'LOW_STOCK',
      title: ev.kind === 'out' ? 'Item sold out' : 'Low stock',
      body: ev.kind === 'out'
        ? `${ev.name} sold out and was hidden from your menu. Restock to bring it back.`
        : `${ev.name} is down to ${ev.remaining} in stock.`,
      data: { kind: 'low_stock', itemId: ev.itemId, remaining: ev.remaining },
    });
  }
}
