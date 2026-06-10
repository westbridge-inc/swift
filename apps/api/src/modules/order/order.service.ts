import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { calculateMarkup, calculateDeliveryFee, generateOrderNumber } from '../../utils/markup';
import { estimateDrivingDistance, estimateDeliveryMinutes } from '../../utils/distance';
import { NotificationService } from '../notification/notification.service';
import { AppError } from '../../utils/errors';

interface CheckoutInput {
  userId: string;
  paymentMethod: string;
  deliveryInstructions?: string;
  tipAmount?: number;
  scheduledFor?: string; // ISO date string
  promoCode?: string;
}

export class OrderService {
  private notifications: NotificationService;

  constructor(
    private prisma: PrismaClient,
    private io: Server,
  ) {
    this.notifications = new NotificationService(prisma, io);
  }

  async checkout(input: CheckoutInput) {
    const cart = await this.prisma.cart.findUnique({
      where: { customerId: input.userId },
      include: {
        vendor: true,
        items: { include: { item: { include: { optionGroups: { include: { options: true } } } } } },
      },
    });

    if (!cart || cart.items.length === 0) {
      throw new AppError(400, 'EMPTY_CART', 'Your cart is empty');
    }

    if (!cart.vendor.isCurrentlyOpen || !cart.vendor.acceptingOrders) {
      throw new AppError(400, 'VENDOR_CLOSED', `${cart.vendor.name} is currently not accepting orders`);
    }

    // Get delivery address
    let address = cart.deliveryAddressId
      ? await this.prisma.address.findUnique({ where: { id: cart.deliveryAddressId } })
      : null;
    if (!address) {
      address = await this.prisma.address.findFirst({ where: { userId: input.userId, isDefault: true } });
    }
    if (!address) {
      throw new AppError(400, 'NO_ADDRESS', 'Please set a delivery address');
    }

    // Check delivery radius
    const distanceKm = estimateDrivingDistance(
      cart.vendor.latitude,
      cart.vendor.longitude,
      address.latitude,
      address.longitude,
    );
    if (distanceKm > cart.vendor.deliveryRadius) {
      throw new AppError(400, 'OUT_OF_RANGE', `This restaurant only delivers within ${cart.vendor.deliveryRadius} km. You are ${distanceKm.toFixed(1)} km away.`);
    }

    const markupPct = 5;

    // Build order items
    const orderItems = cart.items.map((ci) => {
      const basePrice = typeof ci.item.basePrice === 'number' ? ci.item.basePrice : Number(ci.item.basePrice);
      const markup = calculateMarkup(basePrice, markupPct);
      return {
        itemId: ci.item.id,
        name: ci.item.name,
        quantity: ci.quantity,
        basePrice,
        markedUpPrice: basePrice + markup,
        markupAmount: markup,
        totalBase: basePrice * ci.quantity,
        totalMarkup: markup * ci.quantity,
        totalCustomer: (basePrice + markup) * ci.quantity,
        specialInstructions: ci.specialInstructions,
      };
    });

    const subtotalBase = orderItems.reduce((s, i) => s + i.totalBase, 0);
    const subtotalMarkup = orderItems.reduce((s, i) => s + i.totalMarkup, 0);
    const subtotalCustomer = subtotalBase + subtotalMarkup;

    if (subtotalCustomer < Number(cart.vendor.minOrderAmount)) {
      throw new AppError(400, 'MIN_ORDER', `Minimum order is $${Number(cart.vendor.minOrderAmount).toLocaleString()} GYD`);
    }

    // Delivery fee based on actual distance
    const deliveryFee = calculateDeliveryFee(distanceKm);
    const tip = input.tipAmount || Number(cart.tipAmount) || 0;

    // Promo code discount
    let discount = 0;
    let promoCodeId: string | null = null;
    if (input.promoCode) {
      const promo = await this.validatePromoCode(input.promoCode, input.userId, subtotalCustomer);
      discount = promo.discount;
      promoCodeId = promo.id;
    }

    const totalAmount = Math.max(0, subtotalCustomer + deliveryFee + tip - discount);

    // Generate order number
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = await this.prisma.order.count({ where: { placedAt: { gte: today } } });
    const orderNumber = generateOrderNumber(todayCount + 1);

    const orderType = cart.vendor.vendorType === 'SUPERMARKET' ? 'GROCERY_DELIVERY' : 'FOOD_DELIVERY';
    const estimatedDeliveryTime = estimateDeliveryMinutes(distanceKm) + (cart.vendor.estimatedPrepTime || 30);

    // All writes are atomic: order creation, stats, cart deletion all commit or all roll back
    const order = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          orderNumber,
          orderType,
          customerId: input.userId,
          vendorId: cart.vendor.id,
          status: 'PENDING',
          pickupAddress: `${cart.vendor.addressLine1}, ${cart.vendor.city}`,
          pickupLat: cart.vendor.latitude,
          pickupLng: cart.vendor.longitude,
          deliveryAddress: `${address.addressLine1}, ${address.city}`,
          deliveryLat: address.latitude,
          deliveryLng: address.longitude,
          deliveryInstructions: input.deliveryInstructions,
          subtotalBase,
          subtotalMarkup,
          subtotalCustomer,
          deliveryFee,
          tipAmount: tip,
          discount,
          totalAmount,
          paymentMethod: input.paymentMethod as 'CASH' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'CARD' | 'WALLET',
          estimatedPrepTime: cart.vendor.estimatedPrepTime,
          estimatedDeliveryTime,
          scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined,
          promoCodeId,
          items: {
            create: orderItems.map((oi) => ({
              itemId: oi.itemId,
              name: oi.name,
              quantity: oi.quantity,
              basePrice: oi.basePrice,
              markedUpPrice: oi.markedUpPrice,
              markupAmount: oi.markupAmount,
              totalBase: oi.totalBase,
              totalMarkup: oi.totalMarkup,
              totalCustomer: oi.totalCustomer,
              specialInstructions: oi.specialInstructions,
            })),
          },
          statusHistory: {
            create: { status: 'PENDING', changedBy: input.userId, note: 'Order placed' },
          },
        },
        include: { items: true, vendor: { select: { id: true, name: true, ownerId: true } } },
      });

      if (promoCodeId) {
        await tx.promoCode.update({
          where: { id: promoCodeId },
          data: { currentUses: { increment: 1 } },
        });
      }

      await tx.customer.update({
        where: { userId: input.userId },
        data: { totalOrders: { increment: 1 }, totalSpent: { increment: totalAmount } },
      });
      await tx.vendor.update({
        where: { id: cart.vendor.id },
        data: { totalOrders: { increment: 1 } },
      });
      await tx.item.updateMany({
        where: { id: { in: orderItems.map((oi) => oi.itemId) } },
        data: { totalOrdered: { increment: 1 } },
      });
      await tx.cart.delete({ where: { id: cart.id } });

      return order;
    });

    // Post-transaction: emit events and notify (these are best-effort)
    this.io.emit('order:new', { orderId: order.id, vendorId: cart.vendor.id, orderNumber });

    const vendorOwner = await this.prisma.vendorOwner.findUnique({ where: { id: order.vendor!.ownerId } });
    if (vendorOwner) {
      await this.notifications.newOrderForVendor(
        vendorOwner.userId,
        orderNumber,
        orderItems.length,
        totalAmount,
        order.id,
      );
    }

    return {
      order: {
        id: order.id,
        orderNumber,
        status: order.status,
        vendorName: order.vendor?.name,
        items: order.items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          price: Number(i.totalCustomer),
        })),
        subtotal: subtotalCustomer,
        deliveryFee,
        tip,
        discount,
        total: totalAmount,
        paymentMethod: order.paymentMethod,
        estimatedPrepTime: order.estimatedPrepTime,
        estimatedDeliveryTime,
        deliveryAddress: order.deliveryAddress,
        placedAt: order.placedAt,
        scheduledFor: order.scheduledFor,
      },
      message: input.scheduledFor
        ? `Order scheduled! ${cart.vendor.name} will prepare it at the right time.`
        : `Order placed! ${cart.vendor.name} will confirm shortly.`,
    };
  }

  async cancelOrder(orderId: string, userId: string, reason?: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: userId },
      include: { vendor: { select: { name: true, ownerId: true } } },
    });

    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');

    const terminalStatuses = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED'];
    if (terminalStatuses.includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS', 'This order cannot be cancelled');
    }

    const nonCancellableStatuses = ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'];
    if (nonCancellableStatuses.includes(order.status)) {
      throw new AppError(400, 'IN_TRANSIT', 'Order is already on its way and cannot be cancelled');
    }

    const minutesSincePlaced = (Date.now() - order.placedAt.getTime()) / 60000;
    const freeCancellation = minutesSincePlaced <= 5 && order.status === 'PENDING';
    const cancellationFee = freeCancellation ? 0 : 500;

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: userId,
        cancellationReason: reason,
      },
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
    const statusTimestamps: Record<string, string> = {
      ACCEPTED: 'acceptedAt',
      PREPARING: 'preparingAt',
      READY_FOR_PICKUP: 'readyAt',
      PICKED_UP: 'pickedUpAt',
      DELIVERED: 'deliveredAt',
    };

    const updateData: Record<string, unknown> = { status };
    const tsField = statusTimestamps[status];
    if (tsField) updateData[tsField] = new Date();

    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: updateData,
      include: {
        vendor: { select: { name: true, ownerId: true } },
        rider: { include: { user: { select: { firstName: true } } } },
      },
    });

    await this.prisma.orderStatusLog.create({
      data: { orderId, status: status as 'PENDING', changedBy, note },
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
