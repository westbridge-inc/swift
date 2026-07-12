import type { PrismaClient, OrderStatus, FulfillmentType } from '@prisma/client';
import type { Server } from 'socket.io';
import { calculateDeliveryFee, generateOrderNumber } from '../../utils/markup';
import { estimateDeliveryMinutes } from '../../utils/distance';
import { getMapsProvider, type MapsProvider } from '../../providers/maps/maps-provider';
import { NotificationService } from '../notification/notification.service';
import { CountryConfigService } from '../country/country-config.service';
import { BookingService } from '../booking/booking.service';
import { orderingRestriction, CashRulesService } from '../cash/cash-rules.service';
import { resolveSelectedOptions, optionsUnitPrice, type ResolvedOption } from './options';
import { FloatService } from '../dispatch/float.service';
import { AppError } from '../../utils/errors';
import { randomInt } from 'node:crypto';

interface CheckoutInput {
  userId: string;
  paymentMethod: string;
  deliveryInstructions?: string;
  tipAmount?: number;
  scheduledFor?: string; // ISO date string
  promoCode?: string;
  /** Per-vendor fulfillment choice; DELIVERY when omitted */
  fulfillmentSelections?: Record<string, 'DELIVERY' | 'PICKUP'>;
  /** Priority delivery: 1.5x the delivery fee, dispatched ahead of standard
   *  orders, premium goes to the rider. DELIVERY groups only. */
  express?: boolean;
  /** Requested appointment slots for APPOINTMENT listings in the cart.
   *  mode picks where a BOTH-mode service happens (validated against what
   *  the business actually offers). */
  appointments?: Array<{ itemId: string; slotStart: Date; mode?: 'AT_BUSINESS' | 'MOBILE' }>;
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
  // DELIVERED for delivery; READY_FOR_PICKUP for takeaway (vendor hands it
  // over); ACCEPTED for appointments, which skip prep/dispatch entirely —
  // without it the services vertical could never be closed out (found live:
  // complete-appointment always 409'd).
  COMPLETED: ['DELIVERED', 'READY_FOR_PICKUP', 'ACCEPTED'],
  CANCELLED: [
    'PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED',
    'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
    'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED',
  ],
  REFUNDED: ['CANCELLED', 'DELIVERED', 'COMPLETED'],
  // Failed cash handover — only from the door or en route
  FAILED: ['PENDING', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'],
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
    private maps: MapsProvider = getMapsProvider(),
  ) {
    this.notifications = new NotificationService(prisma, io);
    this.countryConfig = new CountryConfigService(prisma);
    this.booking = new BookingService(prisma);
  }

  async checkout(input: CheckoutInput) {
    const now = input.now ?? new Date();

    const cart = await this.prisma.cart.findUnique({
      where: { customerId: input.userId },
      include: { items: { include: { item: { include: { vendor: true, optionGroups: { include: { options: true } } } } } } },
    });
    if (!cart || cart.items.length === 0) {
      throw new AppError(400, 'EMPTY_CART', 'Your cart is empty');
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { trustLevel: true, countryCode: true, createdAt: true, selfieCapturedAt: true },
    });

    // Strike consequences: repeated failed cash handovers
    // restrict ordering to verified accounts, then ban outright
    const restriction = await orderingRestriction(this.prisma, input.userId);
    if (restriction === 'banned') {
      throw new AppError(403, 'ACCOUNT_RESTRICTED', 'Ordering is disabled on this account after repeated failed deliveries. Contact support.');
    }
    if (restriction === 'restricted') {
      throw new AppError(403, 'STRIKE_RESTRICTED', 'After repeated failed deliveries, ordering requires ID verification. Verify your identity to continue.');
    }

    // Universal signup selfie (master plan §3): every account carries a live
    // profile photo before transacting — the vendor/mover sees who is ordering.
    if (!user.selfieCapturedAt) {
      throw new AppError(403, 'SELFIE_REQUIRED', 'Add your profile photo before placing orders — it takes a few seconds in the app.');
    }

    // Group the cart by vendor — a multi-vendor cart splits into one order each
    const groups = new Map<string, typeof cart.items>();
    for (const ci of cart.items) {
      const list = groups.get(ci.item.vendorId) ?? [];
      list.push(ci);
      groups.set(ci.item.vendorId, list);
    }

    const requestedSlots = new Map((input.appointments ?? []).map((a) => [a.itemId, a.slotStart]));
    const requestedModes = new Map((input.appointments ?? []).map((a) => [a.itemId, a.mode]));

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
        unitPrice: number; totalBase: number; specialInstructions?: string | null;
        options: ResolvedOption[]; tracksStock: boolean;
      }>;
    }> = [];

    for (const [vendorId, items] of groups) {
      const vendor = items[0]!.item.vendor;
      if (!vendor.isCurrentlyOpen || !vendor.acceptingOrders || vendor.status !== 'ACTIVE') {
        throw new AppError(400, 'VENDOR_CLOSED', `${vendor.name} is currently not accepting orders`);
      }

      // Inventory (§4.2): a tracked item can't be ordered beyond the shelf.
      // The race-proof guard is the conditional decrement in the transaction
      // below — this is the friendly early error for the common case.
      for (const ci of items) {
        if (ci.item.stockQuantity !== null && ci.quantity > ci.item.stockQuantity) {
          throw new AppError(409, 'INSUFFICIENT_STOCK',
            ci.item.stockQuantity <= 0
              ? `${ci.item.name} is sold out`
              : `Only ${ci.item.stockQuantity} of ${ci.item.name} left — reduce the quantity`,
            { itemId: ci.item.id, available: ci.item.stockQuantity });
        }
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
        // Real road km when OSRM is configured; deterministic estimate otherwise.
        distanceKm = (await this.maps.routeKm(
          { lat: vendor.latitude, lng: vendor.longitude },
          { lat: address.latitude, lng: address.longitude },
        )).km;
        if (distanceKm > vendor.deliveryRadius) {
          throw new AppError(400, 'OUT_OF_RANGE', `${vendor.name} only delivers within ${vendor.deliveryRadius} km. You are ${distanceKm.toFixed(1)} km away.`);
        }
        deliveryFee = calculateDeliveryFee(distanceKm);
        // Express mirrors the courier EXPRESS multiplier (1.5x). The premium
        // is part of the fee the rider collects in cash — it is THEIR upside.
        if (input.express) deliveryFee = Math.round(deliveryFee * 1.5);
      } else if (fulfillment === 'APPOINTMENT') {
        // MOBILE / BOTH services travel to the customer — require their address and
        // enforce the provider's service radius (mirrors the DELIVERY gate above).
        const bcfg = (appointmentItems[0]!.item.bookingConfig ?? {}) as { serviceMode?: string; serviceRadiusKm?: number };
        const offered = bcfg.serviceMode ?? 'AT_BUSINESS';
        // Where it happens: the business's setting, narrowed by the customer's
        // choice when the business offers BOTH. Asking for a mode the business
        // does not offer is a 400, never a silent fallback.
        const requestedMode = requestedModes.get(appointmentItems[0]!.itemId);
        if (requestedMode === 'MOBILE' && offered === 'AT_BUSINESS') {
          throw new AppError(400, 'MODE_NOT_OFFERED', `${vendor.name} does not travel to customers for this service`);
        }
        if (requestedMode === 'AT_BUSINESS' && offered === 'MOBILE') {
          throw new AppError(400, 'MODE_NOT_OFFERED', `${vendor.name} only offers this service at your address`);
        }
        const mobileVisit = requestedMode ? requestedMode === 'MOBILE' : offered === 'MOBILE' || offered === 'BOTH';
        if (mobileVisit) {
          if (!address) throw new AppError(400, 'NO_ADDRESS', `Add your address — ${vendor.name} travels to you`);
          const travelKm = (await this.maps.routeKm(
            { lat: vendor.latitude, lng: vendor.longitude },
            { lat: address.latitude, lng: address.longitude },
          )).km;
          const radius = Number(bcfg.serviceRadiusKm ?? 0);
          if (radius > 0 && travelKm > radius) {
            throw new AppError(400, 'OUT_OF_SERVICE_AREA', `${vendor.name} travels within ${radius} km. You are ${travelKm.toFixed(1)} km away.`);
          }
          distanceKm = travelKm;
        }
      }

      // Zero-commission model: the customer pays exactly the vendor's price
      const orderItems = items.map((ci) => {
        const basePrice = Number(ci.item.basePrice);
        const options = resolveSelectedOptions(ci.item, ci.selectedOptions);
        const unitPrice = basePrice + optionsUnitPrice(options);
        return {
          itemId: ci.item.id,
          name: ci.item.name,
          quantity: ci.quantity,
          basePrice,
          unitPrice,
          totalBase: unitPrice * ci.quantity,
          specialInstructions: ci.specialInstructions,
          options,
          tracksStock: ci.item.stockQuantity !== null,
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
    let promoVendorId: string | null = null;
    if (input.promoCode) {
      const promo = await this.validatePromoCode(
        input.promoCode,
        input.userId,
        plans.map((p) => ({ vendorId: p.vendor.id, subtotal: p.subtotal })),
      );
      discount = promo.discount;
      promoCodeId = promo.id;
      promoVendorId = promo.vendorId;
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

    // Inventory alerts collected inside the transaction, delivered after it
    // commits (notifications are best-effort and never roll an order back).
    const stockEventsByVendor = new Map<string, Array<{ itemId: string; name: string; remaining: number; kind: 'low' | 'out' }>>();

    // Atomic: all orders, stock movements, stats, and the cart deletion commit together
    const orders = await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent checkouts of one cart: the row lock makes a rapid
      // double-submit deterministic (the loser waits, then rolls back on the
      // now-deleted cart) instead of leaning on the delete's P2025 by accident.
      await tx.$queryRaw`SELECT id FROM "carts" WHERE id = ${cart.id} FOR UPDATE`;
      const created = [];
      let sequence = todayCount;

      // A vendor promotion discounts (and records against) THAT vendor's order;
      // platform-wide codes keep landing on the first order of the batch.
      const promoPlanIndex = promoVendorId
        ? plans.findIndex((p) => p.vendor.id === promoVendorId)
        : 0;

      for (const [index, plan] of plans.entries()) {
        sequence += 1;
        const isFirst = index === 0;
        const planTip = isFirst ? tip : 0;
        const planDiscount = index === promoPlanIndex ? discount : 0;
        const totalAmount = Math.max(0, plan.subtotal + plan.deliveryFee + planTip - planDiscount);
        // DELIVERY and MOBILE appointments go to the customer's address; PICKUP and
        // AT_BUSINESS appointments use the store (distanceKm>0 marks a mobile service).
        const toCustomer = plan.fulfillment === 'DELIVERY' || (plan.fulfillment === 'APPOINTMENT' && plan.distanceKm > 0);

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
            deliveryAddress: toCustomer
              ? `${address!.addressLine1}, ${address!.city}`
              : `${plan.vendor.addressLine1}, ${plan.vendor.city}`,
            deliveryLat: toCustomer ? address!.latitude : plan.vendor.latitude,
            deliveryLng: toCustomer ? address!.longitude : plan.vendor.longitude,
            deliveryInstructions: input.deliveryInstructions,
            subtotalBase: plan.subtotal,
            subtotalMarkup: 0,
            subtotalCustomer: plan.subtotal,
            deliveryFee: plan.deliveryFee,
            isExpress: input.express === true && plan.fulfillment === 'DELIVERY',
            tipAmount: planTip,
            discount: planDiscount,
            totalAmount,
            paymentMethod: input.paymentMethod as 'CASH' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'CARD' | 'WALLET',
            estimatedPrepTime: plan.vendor.estimatedPrepTime,
            estimatedDeliveryTime: plan.fulfillment === 'DELIVERY'
              ? estimateDeliveryMinutes(plan.distanceKm) + (plan.vendor.estimatedPrepTime || 30)
              : null,
            scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined,
            // Takeaway: a collection code the customer shows the vendor at pickup.
            // 6-digit, CSPRNG (not Math.random); handover is vendor-mediated in person.
            pickupCode: plan.fulfillment === 'PICKUP' ? String(randomInt(100000, 1000000)) : null,
            promoCodeId: index === promoPlanIndex ? promoCodeId : null,
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
                ...(oi.options.length > 0 && {
                  selectedOptions: {
                    create: oi.options.map((o) => ({
                      optionGroupName: o.optionGroupName,
                      optionName: o.optionName,
                      basePrice: o.additionalPrice,
                      markedUpPrice: o.additionalPrice,
                      markupAmount: 0,
                    })),
                  },
                }),
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

        // Inventory (§4.2): conditional decrement — the WHERE guard makes
        // overselling impossible under concurrency; the losing checkout's
        // whole transaction rolls back. Items at zero auto-hide from browse.
        for (const oi of plan.orderItems) {
          if (!oi.tracksStock) continue;
          const hit = await tx.item.updateMany({
            where: { id: oi.itemId, stockQuantity: { gte: oi.quantity } },
            data: { stockQuantity: { decrement: oi.quantity } },
          });
          if (hit.count === 0) {
            throw new AppError(409, 'INSUFFICIENT_STOCK', `${oi.name} just sold out — remove it from your cart and try again`, { itemId: oi.itemId });
          }
          const after = await tx.item.findUniqueOrThrow({
            where: { id: oi.itemId },
            select: { stockQuantity: true, lowStockThreshold: true, isAvailable: true },
          });
          const remaining = after.stockQuantity ?? 0;
          if (remaining <= 0 && after.isAvailable) {
            await tx.item.update({
              where: { id: oi.itemId },
              data: { isAvailable: false, autoHiddenAt: new Date() },
            });
          }
          const events = stockEventsByVendor.get(plan.vendor.id) ?? [];
          if (remaining <= 0) {
            events.push({ itemId: oi.itemId, name: oi.name, remaining: 0, kind: 'out' });
          } else if (
            after.lowStockThreshold !== null &&
            remaining <= after.lowStockThreshold &&
            remaining + oi.quantity > after.lowStockThreshold
          ) {
            // Crossing edge only — the owner is alerted once, not on every
            // subsequent order below the threshold.
            events.push({ itemId: oi.itemId, name: oi.name, remaining, kind: 'low' });
          }
          if (events.length > 0) stockEventsByVendor.set(plan.vendor.id, events);
        }

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

    // Post-transaction: emit and notify per vendor (best-effort). The socket
    // event goes to that vendor's room only — a global emit would fan out to
    // every connected client and leak order metadata platform-wide.
    for (const order of orders) {
      this.io
        .to(`vendor:${order.vendorId}`)
        .emit('order:new', { orderId: order.id, vendorId: order.vendorId, orderNumber: order.orderNumber });
      const vendorOwner = await this.prisma.vendorOwner.findUnique({ where: { id: order.vendor!.ownerId } });
      if (vendorOwner) {
        await this.notifications.newOrderForVendor(
          vendorOwner.userId,
          order.orderNumber,
          order.items.length,
          Number(order.totalAmount),
          order.id,
        );
        if (order.vendorId) {
          for (const ev of stockEventsByVendor.get(order.vendorId) ?? []) {
            await this.notifications.lowStock(vendorOwner.userId, ev);
          }
          stockEventsByVendor.delete(order.vendorId);
        }
      }
    }

    const summaries = orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      fulfillment: order.fulfillment,
      appointmentSlot: order.appointmentSlot,
      pickupCode: order.pickupCode,
      riskFlagged: order.riskFlagged,
      vendorName: order.vendor?.name,
      items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, price: Number(i.totalCustomer) })),
      subtotal: Number(order.subtotalCustomer),
      deliveryFee: Number(order.deliveryFee),
      isExpress: order.isExpress,
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

  /**
   * Put a cancelled order's tracked stock back on the shelf. Every state an
   * order may be CANCELLED from precedes physical handover (see
   * ORDER_TRANSITIONS), so the goods never left the store. FAILED handovers
   * deliberately do NOT restock — returned food is the vendor's manual call.
   * Pure auto-hides (stock hit 0) un-hide once stock is back above zero.
   */
  /** Put tracked stock back on the shelf for a cancelled order. Public: the
   *  vendor reject route does its own status write (for reason fields) and
   *  must restock too — goods never left the store either way. */
  async restockCancelledOrder(orderId: string) {
    const items = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: { itemId: true, quantity: true },
    });
    for (const oi of items) {
      if (!oi.itemId) continue;
      const restocked = await this.prisma.item.updateMany({
        // Only items still tracking stock — a vendor may have stopped tracking
        // since the order was placed, and null must stay null.
        where: { id: oi.itemId, stockQuantity: { not: null } },
        data: { stockQuantity: { increment: oi.quantity } },
      });
      if (restocked.count > 0) {
        await this.prisma.item.updateMany({
          where: { id: oi.itemId, autoHiddenAt: { not: null }, stockQuantity: { gt: 0 } },
          data: { isAvailable: true, autoHiddenAt: null },
        });
      }
    }
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

    // The goods never left the store — tracked stock goes back on the shelf
    await this.restockCancelledOrder(orderId);

    await this.prisma.orderStatusLog.create({
      data: { orderId, status: 'CANCELLED', changedBy: userId, note: reason || 'Cancelled by customer' },
    });

    // Free up assigned rider — and give back the float they committed for a
    // CASH order (this path does its own CAS and never reaches updateStatus).
    if (order.riderId) {
      if (order.paymentMethod === 'CASH') {
        await new FloatService(this.prisma).release(this.prisma, order.riderId, Number(order.subtotalBase));
      }
      await this.prisma.rider.update({
        where: { id: order.riderId },
        data: { isAvailable: true, currentOrderId: null },
      });
    }

    // A taxi cancelled after assignment frees its driver the same way.
    if (order.driverId) {
      await this.prisma.driver.updateMany({
        where: { id: order.driverId, currentRideId: orderId },
        data: { isAvailable: true, currentRideId: null },
      });
    }

    this.io.to(`order:${orderId}`).emit('order:status_changed', { orderId, status: 'CANCELLED' });
    if (order.vendorId) {
      this.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', { orderId, status: 'CANCELLED' });
    }

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

    // D.3 — release the rider's committed float on a terminal CASH transition.
    // FAILED is terminal too (no_show/refused handover) — the cash never left
    // the rider's float, so it must come back.
    const terminal = status === 'DELIVERED' || status === 'CANCELLED' || status === 'FAILED';
    if (terminal && order.riderId && order.paymentMethod === 'CASH') {
      await new FloatService(this.prisma).release(this.prisma, order.riderId, Number(order.subtotalBase));
    }

    // Free the mover on ANY terminal transition. Guarded on currentOrderId /
    // currentRideId so it is idempotent with route-level freeing and never
    // clobbers a mover who already moved on to a new job. Without this, a
    // delivery completed through the cash handover left the rider invisible
    // to dispatch forever (isAvailable=false, currentOrderId stuck).
    if (terminal) {
      if (order.riderId) {
        await this.prisma.rider.updateMany({
          where: { id: order.riderId, currentOrderId: orderId },
          data: {
            isAvailable: true,
            currentOrderId: null,
            ...(status === 'DELIVERED' ? { totalDeliveries: { increment: 1 } } : {}),
          },
        });
      }
      if (order.driverId) {
        await this.prisma.driver.updateMany({
          where: { id: order.driverId, currentRideId: orderId },
          data: {
            isAvailable: true,
            currentRideId: null,
            ...(status === 'DELIVERED' ? { totalRides: { increment: 1 } } : {}),
          },
        });
      }
    }

    // Every CANCELLED source state precedes handover — restock tracked items.
    // Exactly-once: only the CAS winner above reaches this line.
    if (status === 'CANCELLED') {
      await this.restockCancelledOrder(orderId);
    }

    // Append-only event log — every transition leaves evidence
    await this.prisma.orderStatusLog.create({
      data: { orderId, status: target, changedBy, note },
    });

    const statusEvent = { orderId, status, timestamp: new Date().toISOString() };
    this.io.to(`order:${orderId}`).emit('order:status_changed', statusEvent);
    // The vendor board listens on its own room so it sees every transition
    // live without subscribing to each order individually.
    if (order.vendorId) {
      this.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', statusEvent);
    }

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

    // L3 — earned trust (master plan §5): completed history may promote the
    // customer. Cheap no-op unless they're L2 with a clean record; best-effort.
    if (status === 'DELIVERED' || status === 'COMPLETED') {
      const account = await this.prisma.user.findUnique({
        where: { id: order.customerId },
        select: { countryCode: true },
      });
      if (account) {
        await new CashRulesService(this.prisma, this.notifications, this)
          .maybePromoteToL3(order.customerId, account.countryCode)
          .catch(() => undefined);
      }
    }

    return order;
  }

  async createEarnings(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { riderId: true, driverId: true, deliveryFee: true, tipAmount: true, orderType: true, taxiFareTotal: true },
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
        // Zero-commission model: the driver keeps the whole fare. A taxi
        // order's money lives in taxiFareTotal — deliveryFee is 0 for rides,
        // which silently paid drivers $0 before this read the right field.
        amount: Number(order.taxiFareTotal ?? order.deliveryFee),
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

  /**
   * Validate a code against the checkout's per-vendor plans. Platform-wide
   * codes (vendorId null) discount the whole basket; a VENDOR's code
   * (master plan §4.2) is valid only when that vendor is in the cart and
   * discounts only their subtotal.
   */
  private async validatePromoCode(
    code: string,
    userId: string,
    plans: Array<{ vendorId: string; subtotal: number }>,
  ) {
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

    // The discount basis: the promo vendor's plan, or the whole basket.
    let subtotal: number;
    if (promo.vendorId) {
      const plan = plans.find((p) => p.vendorId === promo.vendorId);
      if (!plan) {
        throw new AppError(400, 'PROMO_WRONG_VENDOR', 'This code belongs to a different store — add their items to use it');
      }
      subtotal = plan.subtotal;
    } else {
      subtotal = plans.reduce((s, p) => s + p.subtotal, 0);
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

    return { id: promo.id, discount, discountType: promo.discountType, vendorId: promo.vendorId };
  }
}
