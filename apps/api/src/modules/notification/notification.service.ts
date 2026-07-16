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

/** Providers report dead tokens (app uninstalled) — flip them off so future
 *  sends stop paying for ghosts. Best-effort by design. */
async function deactivateDeadTokens(prisma: PrismaClient, invalidTokens?: string[]): Promise<void> {
  if (!invalidTokens?.length) return;
  await prisma.deviceToken
    .updateMany({ where: { token: { in: invalidTokens } }, data: { isActive: false } })
    .catch(() => {});
}

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

/** Which app-within-the-app a notification belongs to. One ACCOUNT spans
 *  roles, but SURFACES are role-scoped: the shopping app must not feed a
 *  driver's operator alerts. Untagged = legacy rows; clients fall back to a
 *  kind deny-list for those. */
export type NotificationAudience = 'customer' | 'earner' | 'business';

interface NotificationPayload {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Surface this belongs to — merged into data.audience. */
  audience?: NotificationAudience;
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
        .then((r) => deactivateDeadTokens(prisma, r.invalidTokens))
        .catch(() => {});
    }
    return 'realerted';
  }

  await channels.sms
    .sendSms(alert.user.phone, `Swift: order ${data?.orderNumber ?? ''} is still waiting for your response. Open your dashboard now.`)
    .catch(() => {});
  return 'sms_sent';
}

/** Ops trigger for review queues: PENDING work is invisible until someone is
 *  told it exists — "we review within 24 hours" needs a tap on the shoulder,
 *  not a dashboard someone remembers to open. Fans one notification (row +
 *  live socket) to every active ADMIN/SUPER_ADMIN account. */
/** Stamp acknowledgment on an alert delivery — the recipient ACTED. Idempotent,
 *  fire-and-caught at call sites (tracking never blocks the action). */
export async function acknowledgeAlert(
  prisma: PrismaClient,
  kind: 'VENDOR_ORDER' | 'MOVER_OFFER',
  subjectId: string,
  recipientId?: string,
): Promise<void> {
  await prisma.alertDelivery.updateMany({
    where: { kind, subjectId, ...(recipientId ? { recipientId } : {}), acknowledgedAt: null },
    data: { acknowledgedAt: new Date() },
  });
}

export async function notifyAdmins(
  prisma: PrismaClient,
  notifications: NotificationService,
  input: { title: string; body: string; data?: Record<string, unknown> },
): Promise<number> {
  const admins = await prisma.user.findMany({
    where: { roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
    select: { id: true },
  });
  for (const admin of admins) {
    await notifications.send({
      userId: admin.id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: input.title,
      body: input.body,
      data: input.data,
    });
  }
  return admins.length;
}

export class NotificationService {
  constructor(
    private prisma: PrismaClient,
    private io: Server,
    private channels: NotificationChannels = getChannels(),
  ) {}

  async send(payload: NotificationPayload): Promise<string> {
    const data = payload.audience ? { ...(payload.data ?? {}), audience: payload.audience } : payload.data;

    // Persist to DB
    const notification = await this.prisma.notification.create({
      data: {
        userId: payload.userId,
        type: payload.type,
        title: payload.title,
        body: payload.body,
        data: (data ?? undefined) as any,
      },
    });

    // Live socket delivery
    this.io.to(`user:${payload.userId}`).emit('notification', {
      id: notification.id,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      data,
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
          .then((r) => deactivateDeadTokens(this.prisma, r.invalidTokens))
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
    // Alert-delivery tracking (alerts spec §A4) — a row per money-critical
    // alert; the vendor's accept/reject/ack stamps acknowledgedAt. Tracking
    // must never fail the alert itself.
    await this.prisma.alertDelivery
      .create({ data: { kind: 'VENDOR_ORDER', subjectId: orderId, recipientId: vendorOwnerId } })
      .catch(() => {});
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
