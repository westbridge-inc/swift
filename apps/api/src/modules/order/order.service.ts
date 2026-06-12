import type { PrismaClient, OrderStatus, FulfillmentType } from '@prisma/client';
import type { Server } from 'socket.io';
import { calculateDeliveryFee, generateOrderNumber } from '../../utils/markup';
import { estimateDrivingDistance, estimateDeliveryMinutes } from '../../utils/distance';
import { NotificationService } from '../notification/notification.service';
import { CountryConfigService } from '../country/country-config.service';
import { BookingService } from '../booking/booking.service';
import { AppError } from '../../utils/errors';

interface CheckoutInput {
  userId: string;
  paymentMethod: string;
  deliveryInstructions?: string;
  tipAmount?: number;
  scheduledFor?: string; // ISO date string
  promoCode?: string;
  /** Per-vendor fulfillment choice; DELIVERY when omitted */
  fulfillmentSelections?: Record<string, 'DELIVERY' | 'PICKUP'>;
  /** Requested appointment slots for APPOINTMENT listings in the cart */
  appointments?: Array<{ itemId: string; slotStart: Date }>;
  /** Injectable clock so the risk heuristic is testable */
  now?: Date;
}

// ---------------------------------------------------------------------------
// The locked order state machine. Key = target state, value = states it may
// be entered from. Anything not listed here is impossible — enforced with a
// compare-and-set update so concurrent transitions race safely.
// Canonical chain: placed(PENDING) -> accepted -> preparing -> ready ->
// picked_up -> delivered | cancelled; mover/driver legs are intermediates.
// ---------------------------------------------------------------------------
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: [], // entry state — never transitioned into
  ACCEPTED: ['PENDING'],
  PREPARING: ['ACCEPTED'],
  READY_FOR_PICKUP: ['PREPARING'],
  RIDER_ASSIGNED: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'],
  RIDER_EN_ROUTE_PICKUP: ['RIDER_ASSIGNED'],
  RIDER_ARRIVED_PICKUP: ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP'],
  PICKED_UP: ['READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'],
  EN_ROUTE_DELIVERY: ['PICKED_UP'],
  ARRIVED: ['PICKED_UP', 'EN_ROUTE_DELIVERY'],
  DRIVER_ASSIGNED: ['PENDING'],
  DRIVER_EN_ROUTE: ['DRIVER_ASSIGNED'],
  DRIVER_ARRIVED: ['DRIVER_EN_ROUTE'],
  RIDE_IN_PROGRESS: ['DRIVER_ARRIVED'],
  DELIVERED: ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RIDE_IN_PROGRESS'],
  COMPLETED: ['DELIVERED'],
  CANCELLED: [
    'PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED',
    'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
    'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED',
  ],
  REFUNDED: ['CANCELLED', 'DELIVERED', 'COMPLETED'],
  FAILED: ['PENDING'],
};

/** States where the order is physically with the mover — no cancellation. */
const IN_TRANSIT: OrderStatus[] = ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RIDE_IN_PROGRESS'];

const RISK_NEW_ACCOUNT_HOURS = 72;
/** Guyana is UTC-4 year-round */
const GUYANA_UTC_OFFSET_HOURS = -4;

export class OrderService {
  private notifications: NotificationService;
  private countryConfig: CountryConfigService;
  private booking: BookingService;

  constructor(
    private prisma: PrismaClient,
    private io: Server,
  ) {
    this.notifications = new NotificationService(prisma, io);
    this.countryConfig = new CountryConfigService(prisma);
    this.booking = new BookingService(prisma);
  }

  async checkout(input: CheckoutInput) {
    const now = input.now ?? new Date();

    const cart = await this.prisma.cart.findUnique({
      where: { customerId: input.userId },
      include: { items: { include: { item: { include: { vendor: true } } } } },
    });
    if (!cart || cart.items.length === 0) {
      throw new AppError(400, 'EMPTY_CART', 'Your cart is empty');
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { trustLevel: true, countryCode: true, createdAt: true },
    });

    // Group the cart by vendor — a multi-vendor cart splits into one order each
    const groups = new Map<string, typeof cart.items>();
    for (const ci of cart.items) {
      const list = groups.get(ci.item.vendorId) ?? [];
      list.push(ci);
      groups.set(ci.item.vendorId, list);
    }

    const requestedSlots = new Map((input.appointments ?? []).map((a) => [a.itemId, a.slotStart]));

    // Default address (only required when some group is DELIVERY)
    let address = cart.deliveryAddressId
      ? await this.prisma.address.findUnique({ where: { id: cart.deliveryAddressId } })
      : null;
    if (!address) {
      address = await this.prisma.address.findFirst({ where: { userId: input.userId, isDefault: true } });
    }

    // First pass: validate every group and price it (zero markup — §18)
    const plans: Array<{
      vendor: (typeof cart.items)[number]['item']['vendor'];
      fulfillment: FulfillmentType;
      appointmentSlot?: Date;
      distanceKm: number;
      deliveryFee: number;
      subtotal: number;
      orderItems: Array<{
        itemId: string; name: string; quantity: number; basePrice: number;
        totalBase: number; specialInstructions?: string | null;
      }>;
    }> = [];

    for (const [vendorId, items] of groups) {
      const vendor = items[0]!.item.vendor;
      if (!vendor.isCurrentlyOpen || !vendor.acceptingOrders || vendor.status !== 'ACTIVE') {
        throw new AppError(400, 'VENDOR_CLOSED', `${vendor.name} is currently not accepting orders`);
      }

      const appointmentItems = items.filter((ci) => ci.item.fulfillment === 'APPOINTMENT');
      let fulfillment: FulfillmentType;
      let appointmentSlot: Date | undefined;

      if (appointmentItems.length > 0) {
        if (appointmentItems.length !== items.length || items.length !== 1) {
          throw new AppError(400, 'MIXED_FULFILLMENT', 'Book appointments separately from goods');
        }
        const only = appointmentItems[0]!;
        const slot = requestedSlots.get(only.itemId);
        if (!slot) {
          throw new AppError(400, 'SLOT_REQUIRED', `Pick a time slot for ${only.item.name}`);
        }
        // Validates config, day window, alignment, and that it's in the future.
        // The slot is RESERVED at vendor acceptance, not here.
        await this.booking.validateSlot(only.itemId, slot);
        fulfillment = 'APPOINTMENT';
        appointmentSlot = slot;
      } else {
        fulfillment = input.fulfillmentSelections?.[vendorId] ?? 'DELIVERY';
      }

      let distanceKm = 0;
      let deliveryFee = 0;
      if (fulfillment === 'DELIVERY') {
        if (!address) throw new AppError(400, 'NO_ADDRESS', 'Please set a delivery address');
        distanceKm = estimateDrivingDistance(vendor.latitude, vendor.longitude, address.latitude, address.longitude);
        if (distanceKm > vendor.deliveryRadius) {
          throw new AppError(400, 'OUT_OF_RANGE', `${vendor.name} only delivers within ${vendor.deliveryRadius} km. You are ${distanceKm.toFixed(1)} km away.`);
        }
        deliveryFee = calculateDeliveryFee(distanceKm);
      }

      // Zero-commission model: the customer pays exactly the vendor's price
      const orderItems = items.map((ci) => {
        const basePrice = Number(ci.item.basePrice);
        return {
          itemId: ci.item.id,
          name: ci.item.name,
          quantity: ci.quantity,
          basePrice,
          totalBase: basePrice * ci.quantity,
          specialInstructions: ci.specialInstructions,
        };
      });
      const subtotal = orderItems.reduce((s, i) => s + i.totalBase, 0);

      if (subtotal < Number(vendor.minOrderAmount)) {
        throw new AppError(400, 'MIN_ORDER', `Minimum order at ${vendor.name} is $${Number(vendor.minOrderAmount).toLocaleString()} GYD`);
      }

      plans.push({ vendor, fulfillment, appointmentSlot, distanceKm, deliveryFee, subtotal, orderItems });
    }

    const tip = input.tipAmount || Number(cart.tipAmount) || 0;

    let discount = 0;
    let promoCodeId: string | null = null;
    const grandSubtotal = plans.reduce((s, p) => s + p.subtotal, 0);
    if (input.promoCode) {
      const promo = await this.validatePromoCode(input.promoCode, input.userId, grandSubtotal);
      discount = promo.discount;
      promoCodeId = promo.id;
    }

    const grandTotal = plans.reduce((s, p) => s + p.subtotal + p.deliveryFee, 0) + tip - discount;

    // The ID-gate (locked model): at or above the country's USD-equivalent
    // threshold, an L1 account must verify identity first. L2/L3 flow through.
    const gateLocal = await this.countryConfig.getIdGateThresholdLocal(user.countryCode);
    if (user.trustLevel === 'L1' && grandTotal >= gateLocal) {
      throw new AppError(403, 'ID_VERIFICATION_REQUIRED',
        `Orders of $${Math.round(gateLocal).toLocaleString()} GYD or more need ID verification. Verify once in the app and this limit is gone.`,
        { threshold: gateLocal, total: grandTotal });
    }

    // Deterministic risk heuristic — vendor sees a call-to-confirm prompt
    const accountAgeHours = (now.getTime() - user.createdAt.getTime()) / 3_600_000;
    const localHour = ((now.getUTCHours() + GUYANA_UTC_OFFSET_HOURS) + 24) % 24;
    const oddHours = localHour >= 22 || localHour < 5;
    const highValue = grandTotal >= gateLocal * 0.5;
    const riskFlagged = accountAgeHours < RISK_NEW_ACCOUNT_HOURS && highValue && oddHours;
    const riskReason = riskFlagged
      ? `New account (${Math.floor(accountAgeHours)}h) + high value + odd hours — call to confirm`
      : null;

    // Order numbers: per-day sequence, one per vendor order
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const todayCount = await this.prisma.order.count({ where: { placedAt: { gte: today } } });

    // Atomic: all orders, stats, and the cart deletion commit together
    const orders = await this.prisma.$transaction(async (tx) => {
      const created = [];
      let sequence = todayCount;

      for (const [index, plan] of plans.entries()) {
        sequence += 1;
        const isFirst = index === 0;
        const planTip = isFirst ? tip : 0;
        const planDiscount = isFirst ? discount : 0;
        const totalAmount = Math.max(0, plan.subtotal + plan.deliveryFee + planTip - planDiscount);

        const order = await tx.order.create({
          data: {
            orderNumber: generateOrderNumber(sequence),
            orderType: plan.vendor.vendorType === 'SUPERMARKET' ? 'GROCERY_DELIVERY' : 'FOOD_DELIVERY',
            customerId: input.userId,
            vendorId: plan.vendor.id,
            status: 'PENDING',
            fulfillment: plan.fulfillment,
            appointmentSlot: plan.appointmentSlot,
            riskFlagged,
            riskReason,
            pickupAddress: `${plan.vendor.addressLine1}, ${plan.vendor.city}`,
            pickupLat: plan.vendor.latitude,
            pickupLng: plan.vendor.longitude,
            deliveryAddress: plan.fulfillment === 'DELIVERY'
              ? `${address!.addressLine1}, ${address!.city}`
              : `${plan.vendor.addressLine1}, ${plan.vendor.city}`,
            deliveryLat: plan.fulfillment === 'DELIVERY' ? address!.latitude : plan.vendor.latitude,
            deliveryLng: plan.fulfillment === 'DELIVERY' ? address!.longitude : plan.vendor.longitude,
            deliveryInstructions: input.deliveryInstructions,
            subtotalBase: plan.subtotal,
            subtotalMarkup: 0,
            subtotalCustomer: plan.subtotal,
            deliveryFee: plan.deliveryFee,
            tipAmount: planTip,
            discount: planDiscount,
            totalAmount,
            paymentMethod: input.paymentMethod as 'CASH' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'CARD' | 'WALLET',
            estimatedPrepTime: plan.vendor.estimatedPrepTime,
            estimatedDeliveryTime: plan.fulfillment === 'DELIVERY'
              ? estimateDeliveryMinutes(plan.distanceKm) + (plan.vendor.estimatedPrepTime || 30)
              : null,
            scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined,
            promoCodeId: isFirst ? promoCodeId : null,
            items: {
              create: plan.orderItems.map((oi) => ({
                itemId: oi.itemId,
                name: oi.name,
                quantity: oi.quantity,
                basePrice: oi.basePrice,
                markedUpPrice: oi.basePrice,
                markupAmount: 0,
                totalBase: oi.totalBase,
                totalMarkup: 0,
                totalCustomer: oi.totalBase,
                specialInstructions: oi.specialInstructions,
              })),
            },
            statusHistory: {
              create: { status: 'PENDING', changedBy: input.userId, note: 'Order placed' },
            },
          },
          include: { items: true, vendor: { select: { id: true, name: true, ownerId: true } } },
        });

        await tx.vendor.update({
          where: { id: plan.vendor.id },
          data: { totalOrders: { increment: 1 } },
        });
        await tx.item.updateMany({
          where: { id: { in: plan.orderItems.map((oi) => oi.itemId) } },
          data: { totalOrdered: { increment: 1 } },
        });

        created.push(order);
      }

      if (promoCodeId) {
        await tx.promoCode.update({ where: { id: promoCodeId }, data: { currentUses: { increment: 1 } } });
      }
      await tx.customer.update({
        where: { userId: input.userId },
        data: { totalOrders: { increment: created.length }, totalSpent: { increment: grandTotal } },
      });
      await tx.cart.delete({ where: { id: cart.id } });

      return created;
    });

    // Post-transaction: emit and notify per vendor (best-effort)
    for (const order of orders) {
      this.io.emit('order:new', { orderId: order.id, vendorId: order.vendorId, orderNumber: order.orderNumber });
      const vendorOwner = await this.prisma.vendorOwner.findUnique({ where: { id: order.vendor!.ownerId } });
      if (vendorOwner) {
        await this.notifications.newOrderForVendor(
          vendorOwner.userId,
          order.orderNumber,
          order.items.length,
          Number(order.totalAmount),
          order.id,
        );
      }
    }

    const summaries = orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      fulfillment: order.fulfillment,
      appointmentSlot: order.appointmentSlot,
      riskFlagged: order.riskFlagged,
      vendorName: order.vendor?.name,
      items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, price: Number(i.totalCustomer) })),
      subtotal: Number(order.subtotalCustomer),
      deliveryFee: Number(order.deliveryFee),
      tip: Number(order.tipAmount),
      discount: Number(order.discount),
      total: Number(order.totalAmount),
      paymentMethod: order.paymentMethod,
      estimatedPrepTime: order.estimatedPrepTime,
      estimatedDeliveryTime: order.estimatedDeliveryTime,
      deliveryAddress: order.deliveryAddress,
      placedAt: order.placedAt,
      scheduledFor: order.scheduledFor,
    }));

    return {
      // Single-vendor callers keep their shape; multi-vendor callers get all
      order: summaries[0]!,
      orders: summaries,
      grandTotal,
      message: orders.length > 1
        ? `${orders.length} orders placed — each vendor will confirm shortly.`
        : input.scheduledFor
          ? `Order scheduled! ${orders[0]!.vendor?.name} will prepare it at the right time.`
          : `Order placed! ${orders[0]!.vendor?.name} will confirm shortly.`,
    };
  }

  async cancelOrder(orderId: string, userId: string, reason?: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: userId },
      include: { vendor: { select: { name: true, ownerId: true } } },
    });

    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');

    if (IN_TRANSIT.includes(order.status)) {
      throw new AppError(400, 'IN_TRANSIT', 'Order is already on its way and cannot be cancelled');
    }

    const minutesSincePlaced = (Date.now() - order.placedAt.getTime()) / 60000;
    const freeCancellation = minutesSincePlaced <= 5 && order.status === 'PENDING';
    const cancellationFee = freeCancellation ? 0 : 500;

    // Same compare-and-set machinery as every other transition: if the order
    // moved (e.g. the vendor accepted into a non-cancellable state, or it was
    // already cancelled) this throws instead of silently overwriting.
    const applied = await this.prisma.order.updateMany({
      where: { id: orderId, status: { in: ORDER_TRANSITIONS.CANCELLED } },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: userId,
        cancellationReason: reason,
      },
    });
    if (applied.count === 0) {
      const current = await this.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
      throw new AppError(400, 'INVALID_STATUS', `This order is ${current?.status ?? 'gone'} and cannot be cancelled`);
    }

    // Cancelling an accepted appointment frees its slot
    await this.prisma.booking.updateMany({
      where: { orderId, status: { not: 'CANCELLED' } },
      data: { status: 'CANCELLED' },
    });

    await this.prisma.orderStatusLog.create({
      data: { orderId, status: 'CANCELLED', changedBy: userId, note: reason || 'Cancelled by customer' },
    });

    // Free up assigned rider
    if (order.riderId) {
      await this.prisma.rider.update({
        where: { id: order.riderId },
        data: { isAvailable: true, currentOrderId: null },
      });
    }

    this.io.to(`order:${orderId}`).emit('order:status_changed', { orderId, status: 'CANCELLED' });

    return { message: freeCancellation ? 'Order cancelled — no charge' : 'Order cancelled', cancellationFee };
  }

  async updateStatus(orderId: string, status: string, changedBy: string, note?: string) {
    const target = status as OrderStatus;
    const allowedFrom = ORDER_TRANSITIONS[target];
    if (!allowedFrom || allowedFrom.length === 0) {
      throw new AppError(409, 'INVALID_TRANSITION', `No order may transition into ${status}`);
    }

    const statusTimestamps: Record<string, string> = {
      ACCEPTED: 'acceptedAt',
      PREPARING: 'preparingAt',
      READY_FOR_PICKUP: 'readyAt',
      PICKED_UP: 'pickedUpAt',
      DELIVERED: 'deliveredAt',
      CANCELLED: 'cancelledAt',
    };

    const updateData: Record<string, unknown> = { status: target };
    const tsField = statusTimestamps[status];
    if (tsField) updateData[tsField] = new Date();

    // Compare-and-set: the transition only lands if the order is still in an
    // allowed source state. Concurrent racers (vendor accepting vs customer
    // cancelling) resolve to exactly one winner at the database.
    const applied = await this.prisma.order.updateMany({
      where: { id: orderId, status: { in: allowedFrom } },
      data: updateData,
    });

    if (applied.count === 0) {
      const current = await this.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
      if (!current) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      throw new AppError(409, 'INVALID_TRANSITION', `Cannot move order from ${current.status} to ${status}`);
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        vendor: { select: { name: true, ownerId: true } },
        rider: { include: { user: { select: { firstName: true } } } },
      },
    });

    // Append-only event log — every transition leaves evidence
    await this.prisma.orderStatusLog.create({
      data: { orderId, status: target, changedBy, note },
    });

    this.io.to(`order:${orderId}`).emit('order:status_changed', {
      orderId,
      status,
      timestamp: new Date().toISOString(),
    });

    // Send notifications
    const riderName = order.rider?.user?.firstName || 'Your rider';
    switch (status) {
      case 'ACCEPTED':
        await this.notifications.orderAccepted(order.customerId, order.orderNumber, order.vendor?.name || '', orderId);
        break;
      case 'PREPARING':
        await this.notifications.orderPreparing(order.customerId, order.orderNumber, order.vendor?.name || '', orderId);
        break;
      case 'READY_FOR_PICKUP':
        await this.notifications.orderReady(order.customerId, order.orderNumber, orderId);
        break;
      case 'RIDER_ASSIGNED':
        await this.notifications.riderAssigned(order.customerId, order.orderNumber, riderName, orderId);
        break;
      case 'PICKED_UP': {
        const eta = order.estimatedDeliveryTime ? Math.max(5, order.estimatedDeliveryTime - (order.estimatedPrepTime || 30)) : 15;
        await this.notifications.orderPickedUp(order.customerId, order.orderNumber, riderName, orderId, eta);
        break;
      }
      case 'DELIVERED':
        await this.notifications.orderDelivered(order.customerId, order.orderNumber, orderId);
        break;
    }

    return order;
  }

  async createEarnings(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { riderId: true, driverId: true, deliveryFee: true, tipAmount: true, orderType: true },
    });
    if (!order) return;

    const earnings: Array<{
      riderId?: string;
      driverId?: string;
      orderId: string;
      type: 'DELIVERY_FEE' | 'COURIER_FEE' | 'TAXI_FARE' | 'TIP';
      amount: number;
      status: 'AVAILABLE';
    }> = [];

    if (order.riderId) {
      const feeType = order.orderType === 'COURIER' ? 'COURIER_FEE' : 'DELIVERY_FEE';
      earnings.push({
        riderId: order.riderId,
        orderId,
        type: feeType,
        amount: Number(order.deliveryFee),
        status: 'AVAILABLE',
      });

      if (Number(order.tipAmount) > 0) {
        earnings.push({
          riderId: order.riderId,
          orderId,
          type: 'TIP',
          amount: Number(order.tipAmount),
          status: 'AVAILABLE',
        });
      }
    }

    if (order.driverId) {
      earnings.push({
        driverId: order.driverId,
        orderId,
        type: 'TAXI_FARE',
        amount: Number(order.deliveryFee),
        status: 'AVAILABLE',
      });

      if (Number(order.tipAmount) > 0) {
        earnings.push({
          driverId: order.driverId,
          orderId,
          type: 'TIP',
          amount: Number(order.tipAmount),
          status: 'AVAILABLE',
        });
      }
    }

    if (earnings.length > 0) {
      await this.prisma.earning.createMany({ data: earnings });

      // Notify rider/driver
      for (const earning of earnings) {
        const userId = earning.riderId || earning.driverId;
        if (userId) {
          const entity = earning.riderId
            ? await this.prisma.rider.findUnique({ where: { id: userId }, select: { userId: true } })
            : await this.prisma.driver.findUnique({ where: { id: userId }, select: { userId: true } });
          if (entity) {
            await this.notifications.earningAvailable(entity.userId, earning.amount, earning.type);
          }
        }
      }
    }
  }

  async reorder(userId: string, orderId: string) {
    const original = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: userId },
      include: { items: true },
    });

    if (!original || !original.vendorId) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    const vendor = await this.prisma.vendor.findUnique({ where: { id: original.vendorId } });
    if (!vendor || vendor.status !== 'ACTIVE') {
      throw new AppError(400, 'VENDOR_UNAVAILABLE', 'This restaurant is no longer available');
    }

    // Clear existing cart and create new one
    await this.prisma.cart.deleteMany({ where: { customerId: userId } });

    const cart = await this.prisma.cart.create({
      data: { customerId: userId, vendorId: original.vendorId },
    });

    // Add items to cart, checking availability
    const availableItems = await this.prisma.item.findMany({
      where: { id: { in: original.items.map((i) => i.itemId) }, isAvailable: true },
    });
    const availableIds = new Set(availableItems.map((i) => i.id));

    const cartItems = original.items
      .filter((i) => availableIds.has(i.itemId))
      .map((i) => ({
        cartId: cart.id,
        itemId: i.itemId,
        quantity: i.quantity,
        selectedOptions: {},
        specialInstructions: i.specialInstructions,
      }));

    if (cartItems.length === 0) {
      throw new AppError(400, 'NO_ITEMS', 'None of the items from this order are currently available');
    }

    await this.prisma.cartItem.createMany({ data: cartItems });

    const unavailableCount = original.items.length - cartItems.length;
    return {
      cartId: cart.id,
      itemsAdded: cartItems.length,
      unavailableItems: unavailableCount,
      message: unavailableCount > 0
        ? `${cartItems.length} items added to cart. ${unavailableCount} item(s) were unavailable.`
        : `${cartItems.length} items added to cart. Ready to checkout!`,
    };
  }

  private async validatePromoCode(code: string, userId: string, subtotal: number) {
    const promo = await this.prisma.promoCode.findUnique({ where: { code: code.toUpperCase() } });
    if (!promo) throw new AppError(404, 'INVALID_PROMO', 'Promo code not found');
    if (!promo.isActive) throw new AppError(400, 'INVALID_PROMO', 'This promo code is no longer active');

    const now = new Date();
    if (now < promo.validFrom || now > promo.validUntil) {
      throw new AppError(400, 'EXPIRED_PROMO', 'This promo code has expired');
    }

    if (promo.maxUses && promo.currentUses >= promo.maxUses) {
      throw new AppError(400, 'USED_PROMO', 'This promo code has reached its usage limit');
    }

    // Check per-user usage
    const userUsage = await this.prisma.order.count({
      where: { customerId: userId, promoCodeId: promo.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
    });
    if (userUsage >= promo.maxUsesPerUser) {
      throw new AppError(400, 'USED_PROMO', 'You have already used this promo code');
    }

    if (promo.minOrderAmount && subtotal < Number(promo.minOrderAmount)) {
      throw new AppError(400, 'MIN_ORDER_PROMO', `Minimum order of $${Number(promo.minOrderAmount).toLocaleString()} GYD required for this promo`);
    }

    let discount = 0;
    switch (promo.discountType) {
      case 'PERCENTAGE':
        discount = Math.ceil(subtotal * (Number(promo.discountValue) / 100));
        break;
      case 'FIXED_AMOUNT':
        discount = Number(promo.discountValue);
        break;
      case 'FREE_DELIVERY':
        discount = 0; // Handled separately in checkout
        break;
    }

    if (promo.maxDiscount) {
      discount = Math.min(discount, Number(promo.maxDiscount));
    }

    return { id: promo.id, discount, discountType: promo.discountType };
  }
}
