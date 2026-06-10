import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RiderType, VehicleType, EarningType, EarningStatus } from '@prisma/client';
import { OrderService } from '../order/order.service';
import { haversineDistance } from '../../utils/distance';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { AppError, NotFoundError, ConflictError, ValidationError } from '../../utils/errors';

const updateRiderProfileSchema = z.object({
  riderType: z.nativeEnum(RiderType).optional(),
  vehicleType: z.nativeEnum(VehicleType).optional(),
  vehicleMake: z.string().max(50).optional(),
  vehicleModel: z.string().max(50).optional(),
  vehicleYear: z.number().int().min(1950).max(2100).optional(),
  vehicleColor: z.string().max(30).optional(),
  licensePlate: z.string().max(20).optional(),
  profilePhotoUrl: z.string().max(2048).optional(),
  nationalIdUrl: z.string().max(2048).optional(),
  driverLicenseUrl: z.string().max(2048).optional(),
  vehicleInsuranceUrl: z.string().max(2048).optional(),
});

const riderLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  heading: z.number().optional(),
  speed: z.number().optional(),
});

const pickupPinSchema = z.object({
  ridePin: z.string().min(1).max(10).optional(),
});

const riderHistoryQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  type: z.nativeEnum(EarningType).optional(),
  status: z.nativeEnum(EarningStatus).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the Rider record for the authenticated user; throws if missing. */
async function getRider(app: FastifyInstance, userId: string) {
  const rider = await app.prisma.rider.findUnique({
    where: { userId },
  });
  if (!rider) throw new NotFoundError('Rider');
  return rider;
}

/** Validate that a given order belongs to the requesting rider. */
async function getOwnedOrder(app: FastifyInstance, orderId: string, riderId: string) {
  const order = await app.prisma.order.findUnique({
    where: { id: orderId },
    include: {
      vendor: { select: { id: true, name: true, latitude: true, longitude: true, addressLine1: true, city: true } },
      items: { select: { name: true, quantity: true, totalCustomer: true, specialInstructions: true } },
    },
  });
  if (!order) throw new NotFoundError('Order', orderId);
  if (order.riderId !== riderId) {
    throw new AppError(403, 'NOT_YOUR_ORDER', 'This order is not assigned to you');
  }
  return order;
}

/** Allowed status transitions for the rider lifecycle. */
const STATUS_TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  'en-route-pickup': { from: ['RIDER_ASSIGNED'], to: 'RIDER_EN_ROUTE_PICKUP' },
  'arrived-pickup':  { from: ['RIDER_EN_ROUTE_PICKUP'], to: 'RIDER_ARRIVED_PICKUP' },
  'picked-up':       { from: ['RIDER_ARRIVED_PICKUP', 'READY_FOR_PICKUP'], to: 'PICKED_UP' },
  'en-route-delivery': { from: ['PICKED_UP'], to: 'EN_ROUTE_DELIVERY' },
  'arrived':         { from: ['EN_ROUTE_DELIVERY'], to: 'ARRIVED' },
};

/** Start-of-day Date for "today" queries. */
function startOfDay(date: Date = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Start of week (Monday 00:00). */
function startOfWeek(date: Date = new Date()): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Start of month. */
function startOfMonth(date: Date = new Date()): Date {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function riderRoutes(app: FastifyInstance) {
  const orderService = new OrderService(app.prisma, app.io);

  // =========================================================================
  // 1. PROFILE
  // =========================================================================

  /** GET /profile — Full rider profile with user info, subscription & stats. */
  app.get('/profile', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await app.prisma.rider.findUnique({
      where: { userId: request.user.userId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            avatar: true,
            createdAt: true,
          },
        },
        subscription: true,
        operatingZones: true,
      },
    });
    if (!rider) throw new NotFoundError('Rider');

    const todayStart = startOfDay();
    const [todayEarnings, todayDeliveries] = await Promise.all([
      app.prisma.earning.aggregate({
        where: { riderId: rider.id, createdAt: { gte: todayStart } },
        _sum: { amount: true },
      }),
      app.prisma.order.count({
        where: { riderId: rider.id, status: 'DELIVERED', deliveredAt: { gte: todayStart } },
      }),
    ]);

    return {
      success: true,
      data: {
        ...rider,
        stats: {
          totalDeliveries: rider.totalDeliveries,
          totalCourierJobs: rider.totalCourierJobs,
          averageRating: rider.averageRating ? Number(rider.averageRating) : null,
          totalRatings: rider.totalRatings,
          completionRate: rider.completionRate ? Number(rider.completionRate) : null,
          todayEarnings: Number(todayEarnings._sum.amount ?? 0),
          todayDeliveries,
        },
      },
    };
  });

  /** PUT /profile — Update vehicle info, profile photo, rider type. */
  app.put('/profile', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);

    const body = updateRiderProfileSchema.parse(request.body);

    const allowedFields = [
      'riderType', 'vehicleType', 'vehicleMake', 'vehicleModel',
      'vehicleYear', 'vehicleColor', 'licensePlate', 'profilePhotoUrl',
      'nationalIdUrl', 'driverLicenseUrl', 'vehicleInsuranceUrl',
    ] as const;

    const updateData: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    }

    // If documents are re-uploaded, reset verification so admin can re-verify.
    const docFields = ['nationalIdUrl', 'driverLicenseUrl', 'vehicleInsuranceUrl'];
    if (docFields.some((f) => updateData[f] !== undefined)) {
      updateData['documentsVerified'] = false;
    }

    if (Object.keys(updateData).length === 0) {
      throw new ValidationError('No valid fields to update');
    }

    const updated = await app.prisma.rider.update({
      where: { id: rider.id },
      data: updateData,
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatar: true },
        },
      },
    });

    return { success: true, data: updated };
  });

  // =========================================================================
  // 2. ONLINE STATUS
  // =========================================================================

  /** POST /go-online — Mark rider as online and available for deliveries. */
  app.post('/go-online', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);

    if (!rider.documentsVerified) {
      throw new AppError(403, 'DOCUMENTS_NOT_VERIFIED', 'Your documents must be verified before you can go online');
    }

    const updated = await app.prisma.rider.update({
      where: { id: rider.id },
      data: { isOnline: true, isAvailable: !rider.currentOrderId },
    });

    // Track online session start in Redis for hours tracking.
    await app.redis.set(`rider:online_since:${rider.id}`, Date.now().toString());

    return { success: true, data: { isOnline: updated.isOnline, isAvailable: updated.isAvailable } };
  });

  /** POST /go-offline — Mark rider as offline. */
  app.post('/go-offline', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);

    if (rider.currentOrderId) {
      throw new ConflictError('You cannot go offline while you have an active delivery. Complete or cancel the current order first.');
    }

    const updated = await app.prisma.rider.update({
      where: { id: rider.id },
      data: { isOnline: false, isAvailable: false },
    });

    // Accumulate today's online hours in Redis.
    const onlineSince = await app.redis.get(`rider:online_since:${rider.id}`);
    if (onlineSince) {
      const sessionMs = Date.now() - parseInt(onlineSince, 10);
      const todayKey = `rider:online_ms:${rider.id}:${startOfDay().toISOString().slice(0, 10)}`;
      await app.redis.incrby(todayKey, sessionMs);
      await app.redis.expire(todayKey, 172800); // TTL 48h
      await app.redis.del(`rider:online_since:${rider.id}`);
    }

    return { success: true, data: { isOnline: updated.isOnline, isAvailable: updated.isAvailable } };
  });

  // =========================================================================
  // 3. LOCATION
  // =========================================================================

  /** PUT /location — Update lat/lng, persist to DB + Redis, broadcast to active order. */
  app.put('/location', { preHandler: [app.authenticate] }, async (request) => {
    const { latitude, longitude, heading, speed } = riderLocationSchema.parse(request.body);

    const rider = await getRider(app, request.user.userId);
    const now = new Date();

    // DB update (batched — not every ping needs to hit PG immediately).
    // We update the DB if 10+ seconds have passed since last DB write.
    const lastDbWrite = await app.redis.get(`rider:location_db_ts:${rider.id}`);
    const shouldWriteDb = !lastDbWrite || Date.now() - parseInt(lastDbWrite, 10) > 10_000;

    if (shouldWriteDb) {
      await app.prisma.rider.update({
        where: { id: rider.id },
        data: { currentLat: latitude, currentLng: longitude, lastLocationUpdate: now },
      });
      await app.redis.set(`rider:location_db_ts:${rider.id}`, Date.now().toString());
    }

    // Redis — always update (fast path for real-time queries).
    const locationPayload = JSON.stringify({
      lat: latitude,
      lng: longitude,
      heading: heading ?? null,
      speed: speed ?? null,
      ts: now.toISOString(),
    });
    await app.redis.set(`rider:location:${rider.id}`, locationPayload, 'EX', 300); // TTL 5 min

    // Broadcast to order room if rider has an active order.
    if (rider.currentOrderId) {
      app.io.to(`order:${rider.currentOrderId}`).emit('rider:location', {
        riderId: rider.id,
        lat: latitude,
        lng: longitude,
        heading: heading ?? null,
        speed: speed ?? null,
        ts: now.toISOString(),
      });
    }

    return { success: true };
  });

  // =========================================================================
  // 4. AVAILABLE ORDERS
  // =========================================================================

  /** GET /orders/available — Nearby orders needing a rider, sorted by distance. */
  app.get('/orders/available', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);

    if (!rider.isOnline) {
      throw new AppError(400, 'OFFLINE', 'You must be online to see available orders');
    }
    if (rider.currentOrderId) {
      return { success: true, data: [], message: 'Complete your current delivery first' };
    }
    if (rider.currentLat === null || rider.currentLng === null) {
      throw new ValidationError('Location not available. Please enable location services.');
    }

    const riderLat = Number(rider.currentLat);
    const riderLng = Number(rider.currentLng);
    const maxRadiusKm = 15;

    // Determine which order types this rider handles.
    const orderTypes: string[] = [];
    if (rider.riderType === 'DELIVERY' || rider.riderType === 'BOTH') {
      orderTypes.push('FOOD_DELIVERY', 'GROCERY_DELIVERY');
    }
    if (rider.riderType === 'COURIER' || rider.riderType === 'BOTH') {
      orderTypes.push('COURIER');
    }

    const orders = await app.prisma.order.findMany({
      where: {
        status: { in: ['READY_FOR_PICKUP', 'ACCEPTED', 'PREPARING'] },
        riderId: null,
        orderType: { in: orderTypes as import('@prisma/client').OrderType[] },
      },
      include: {
        vendor: {
          select: {
            id: true, name: true, logoUrl: true,
            latitude: true, longitude: true,
            addressLine1: true, city: true,
          },
        },
        items: { select: { name: true, quantity: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    // Compute distance from rider to each vendor, filter by radius, sort.
    const withDistance = orders
      .map((order) => {
        const vendorLat = Number(order.vendor?.latitude ?? 0);
        const vendorLng = Number(order.vendor?.longitude ?? 0);
        const pickupDistance = haversineDistance(riderLat, riderLng, vendorLat, vendorLng);
        const deliveryDistance = haversineDistance(
          vendorLat, vendorLng,
          Number(order.deliveryLat), Number(order.deliveryLng),
        );
        return {
          id: order.id,
          orderNumber: order.orderNumber,
          orderType: order.orderType,
          status: order.status,
          vendor: order.vendor,
          pickupAddress: order.pickupAddress,
          deliveryAddress: order.deliveryAddress,
          deliveryInstructions: order.deliveryInstructions,
          items: order.items,
          itemCount: order.items.reduce((s, i) => s + i.quantity, 0),
          deliveryFee: Number(order.deliveryFee),
          tipAmount: Number(order.tipAmount),
          totalEarning: Number(order.deliveryFee) + Number(order.tipAmount),
          pickupDistanceKm: Math.round(pickupDistance * 10) / 10,
          deliveryDistanceKm: Math.round(deliveryDistance * 10) / 10,
          estimatedPrepTime: order.estimatedPrepTime,
          estimatedDeliveryTime: order.estimatedDeliveryTime,
          placedAt: order.placedAt,
        };
      })
      .filter((o) => o.pickupDistanceKm <= maxRadiusKm)
      .sort((a, b) => a.pickupDistanceKm - b.pickupDistanceKm);

    return { success: true, data: withDistance };
  });

  // =========================================================================
  // 5. ACTIVE ORDER
  // =========================================================================

  /** GET /orders/active — Current delivery in progress. */
  app.get('/orders/active', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);

    if (!rider.currentOrderId) {
      return { success: true, data: null };
    }

    const order = await app.prisma.order.findUnique({
      where: { id: rider.currentOrderId },
      include: {
        vendor: {
          select: {
            id: true, name: true, logoUrl: true, phone: true,
            latitude: true, longitude: true,
            addressLine1: true, city: true,
          },
        },
        customer: {
          select: {
            id: true,
            firstName: true, lastName: true, phone: true,
          },
        },
        items: { select: { name: true, quantity: true, totalCustomer: true, specialInstructions: true } },
        statusHistory: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });

    if (!order) {
      // Stale pointer — clean up.
      await app.prisma.rider.update({
        where: { id: rider.id },
        data: { currentOrderId: null, isAvailable: true },
      });
      return { success: true, data: null };
    }

    return {
      success: true,
      data: {
        ...order,
        deliveryFee: Number(order.deliveryFee),
        tipAmount: Number(order.tipAmount),
        totalAmount: Number(order.totalAmount),
        totalEarning: Number(order.deliveryFee) + Number(order.tipAmount),
        ridePin: order.ridePin,
      },
    };
  });

  // =========================================================================
  // 6. ORDER LIFECYCLE
  // =========================================================================

  /** POST /orders/:id/accept — Claim an available order. */
  app.post('/orders/:id/accept', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const rider = await getRider(app, request.user.userId);

    // Must be online.
    if (!rider.isOnline) {
      throw new AppError(400, 'OFFLINE', 'You must be online to accept orders');
    }

    // Must not have an active order already.
    if (rider.currentOrderId) {
      throw new ConflictError('You already have an active delivery. Complete it before accepting a new one.');
    }

    // Atomic check: order must still be unassigned.
    const order = await app.prisma.order.findUnique({
      where: { id },
      include: { vendor: { select: { id: true, name: true } } },
    });
    if (!order) throw new NotFoundError('Order', id);

    if (order.riderId) {
      throw new ConflictError('This order has already been claimed by another rider');
    }

    const acceptableStatuses = ['READY_FOR_PICKUP', 'ACCEPTED', 'PREPARING', 'PENDING'];
    if (!acceptableStatuses.includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS', `Order cannot be accepted in status ${order.status}`);
    }

    // Assign rider first, then update status (sequential to avoid race).
    const updatedOrder = await app.prisma.order.update({
      where: { id },
      data: { riderId: rider.id },
    });

    await Promise.all([
      orderService.updateStatus(id, 'RIDER_ASSIGNED', request.user.userId, 'Rider accepted the order'),
      app.prisma.rider.update({
        where: { id: rider.id },
        data: { isAvailable: false, currentOrderId: id },
      }),
    ]);

    return {
      success: true,
      data: {
        orderId: updatedOrder.id,
        orderNumber: updatedOrder.orderNumber,
        status: 'RIDER_ASSIGNED',
        vendor: order.vendor,
        pickupAddress: updatedOrder.pickupAddress,
        deliveryAddress: updatedOrder.deliveryAddress,
        deliveryFee: Number(updatedOrder.deliveryFee),
        tipAmount: Number(updatedOrder.tipAmount),
      },
    };
  });

  /**
   * Generic transition endpoints:
   *   PUT /orders/:id/en-route-pickup
   *   PUT /orders/:id/arrived-pickup
   *   PUT /orders/:id/picked-up
   *   PUT /orders/:id/en-route-delivery
   *   PUT /orders/:id/arrived
   */
  for (const [slug, { from, to }] of Object.entries(STATUS_TRANSITIONS)) {
    app.put(`/orders/:id/${slug}`, { preHandler: [app.authenticate] }, async (request) => {
      const { id } = request.params as { id: string };
      const rider = await getRider(app, request.user.userId);
      const order = await getOwnedOrder(app, id, rider.id);

      if (!from.includes(order.status)) {
        throw new AppError(
          400,
          'INVALID_TRANSITION',
          `Cannot transition from ${order.status} to ${to}. Expected current status: ${from.join(' or ')}.`,
        );
      }

      const updated = await orderService.updateStatus(id, to, request.user.userId);

      return {
        success: true,
        data: {
          orderId: updated.id,
          orderNumber: updated.orderNumber,
          status: to,
          updatedAt: new Date().toISOString(),
        },
      };
    });
  }

  /** PUT /orders/:id/delivered — Final step: complete delivery, create earnings, free rider. */
  app.put('/orders/:id/delivered', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const { ridePin } = pickupPinSchema.parse(request.body ?? {});
    const rider = await getRider(app, request.user.userId);
    const order = await getOwnedOrder(app, id, rider.id);

    const validFrom = ['ARRIVED', 'EN_ROUTE_DELIVERY'];
    if (!validFrom.includes(order.status)) {
      throw new AppError(
        400,
        'INVALID_TRANSITION',
        `Cannot mark as delivered from status ${order.status}. Rider must be ARRIVED or EN_ROUTE_DELIVERY.`,
      );
    }

    // Verify ride PIN if one was set on the order.
    if (order.ridePin && order.ridePin !== ridePin) {
      throw new AppError(400, 'INVALID_PIN', 'Incorrect delivery PIN. Please ask the customer for the correct PIN.');
    }

    // 1. Update order status (handles notifications + socket).
    await orderService.updateStatus(id, 'DELIVERED', request.user.userId, 'Delivery completed');

    // 2. Create earning records (delivery fee + tip).
    await orderService.createEarnings(id);

    // 3. Free up the rider.
    const updated = await app.prisma.rider.update({
      where: { id: rider.id },
      data: {
        isAvailable: true,
        currentOrderId: null,
        totalDeliveries: { increment: 1 },
      },
    });

    // 4. Calculate this delivery's earnings for the response.
    const deliveryEarning = Number(order.deliveryFee) + Number(order.tipAmount);

    return {
      success: true,
      data: {
        orderId: id,
        orderNumber: order.orderNumber,
        status: 'DELIVERED',
        earning: deliveryEarning,
        deliveryFee: Number(order.deliveryFee),
        tip: Number(order.tipAmount),
        totalDeliveries: updated.totalDeliveries,
        isAvailable: updated.isAvailable,
      },
    };
  });

  // =========================================================================
  // 7. ORDER HISTORY
  // =========================================================================

  /** GET /orders — Paginated past deliveries. */
  app.get('/orders', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);
    const query = request.query as Record<string, string | undefined>;
    const pagination = parsePagination(query);
    const { from, to } = riderHistoryQuerySchema.parse(request.query);

    const where: Record<string, unknown> = {
      riderId: rider.id,
      status: { in: ['DELIVERED', 'COMPLETED', 'CANCELLED'] },
    };

    // Optional date range filters.
    if (from || to) {
      const dateFilter: Record<string, Date> = {};
      if (from) dateFilter['gte'] = from;
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        dateFilter['lte'] = toDate;
      }
      where['deliveredAt'] = dateFilter;
    }

    const [orders, total] = await Promise.all([
      app.prisma.order.findMany({
        where,
        include: {
          vendor: { select: { id: true, name: true, logoUrl: true } },
          items: { select: { name: true, quantity: true } },
        },
        orderBy: { deliveredAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      app.prisma.order.count({ where }),
    ]);

    const data = orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      orderType: o.orderType,
      status: o.status,
      vendor: o.vendor,
      items: o.items,
      itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
      deliveryAddress: o.deliveryAddress,
      deliveryFee: Number(o.deliveryFee),
      tipAmount: Number(o.tipAmount),
      totalEarning: Number(o.deliveryFee) + Number(o.tipAmount),
      placedAt: o.placedAt,
      deliveredAt: o.deliveredAt,
    }));

    return { success: true, ...paginatedResponse(data, total, pagination) };
  });

  // =========================================================================
  // 8. EARNINGS
  // =========================================================================

  /** GET /earnings — Paginated earnings, filterable by date range and type. */
  app.get('/earnings', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);
    const query = request.query as Record<string, string | undefined>;
    const pagination = parsePagination(query);
    const { from, to, type, status } = riderHistoryQuerySchema.parse(request.query);

    const where: Record<string, unknown> = { riderId: rider.id };

    if (from || to) {
      const dateFilter: Record<string, Date> = {};
      if (from) dateFilter['gte'] = from;
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        dateFilter['lte'] = toDate;
      }
      where['createdAt'] = dateFilter;
    }

    if (type) {
      where['type'] = type;
    }

    if (status) {
      where['status'] = status;
    }

    const [earnings, total, aggregate] = await Promise.all([
      app.prisma.earning.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      app.prisma.earning.count({ where }),
      app.prisma.earning.aggregate({ where, _sum: { amount: true } }),
    ]);

    // Look up related order info for each earning
    const orderIds = [...new Set(earnings.map((e) => e.orderId))];
    const relatedOrders = orderIds.length > 0
      ? await app.prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, orderNumber: true, orderType: true, vendor: { select: { name: true } } },
        })
      : [];
    const orderMap = new Map(relatedOrders.map((o) => [o.id, o]));

    const data = earnings.map((e) => {
      const order = orderMap.get(e.orderId);
      return {
        id: e.id,
        orderId: e.orderId,
        orderNumber: order?.orderNumber ?? null,
        orderType: order?.orderType ?? null,
        vendorName: order?.vendor?.name ?? null,
        type: e.type,
        amount: Number(e.amount),
        status: e.status,
        createdAt: e.createdAt,
      };
    });

    return {
      success: true,
      ...paginatedResponse(data, total, pagination),
      totalAmount: Number(aggregate._sum.amount ?? 0),
    };
  });

  /** GET /earnings/today — Today's earnings breakdown. */
  app.get('/earnings/today', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);
    const todayStart = startOfDay();

    const [earnings, aggregate, deliveryCount] = await Promise.all([
      app.prisma.earning.findMany({
        where: { riderId: rider.id, createdAt: { gte: todayStart } },
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.earning.aggregate({
        where: { riderId: rider.id, createdAt: { gte: todayStart } },
        _sum: { amount: true },
      }),
      app.prisma.order.count({
        where: { riderId: rider.id, status: 'DELIVERED', deliveredAt: { gte: todayStart } },
      }),
    ]);

    // Look up related orders for today's earnings
    const todayOrderIds = [...new Set(earnings.map((e) => e.orderId))];
    const todayOrders = todayOrderIds.length > 0
      ? await app.prisma.order.findMany({
          where: { id: { in: todayOrderIds } },
          select: { id: true, orderNumber: true, vendor: { select: { name: true } } },
        })
      : [];
    const todayOrderMap = new Map(todayOrders.map((o) => [o.id, o]));

    // Break down by type.
    const byType: Record<string, number> = {};
    for (const e of earnings) {
      byType[e.type] = (byType[e.type] || 0) + Number(e.amount);
    }

    return {
      success: true,
      data: {
        total: Number(aggregate._sum.amount ?? 0),
        deliveries: deliveryCount,
        breakdown: byType,
        earnings: earnings.map((e) => {
          const relatedOrder = todayOrderMap.get(e.orderId);
          return {
            id: e.id,
            type: e.type,
            amount: Number(e.amount),
            status: e.status,
            orderNumber: relatedOrder?.orderNumber ?? null,
            vendorName: relatedOrder?.vendor?.name ?? null,
            createdAt: e.createdAt,
          };
        }),
      },
    };
  });

  /** GET /earnings/summary — Totals for today, this week, this month, all-time. */
  app.get('/earnings/summary', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);

    const todayStart = startOfDay();
    const weekStart = startOfWeek();
    const monthStart = startOfMonth();

    const [today, week, month, allTime, pendingPayout] = await Promise.all([
      app.prisma.earning.aggregate({
        where: { riderId: rider.id, createdAt: { gte: todayStart } },
        _sum: { amount: true },
        _count: true,
      }),
      app.prisma.earning.aggregate({
        where: { riderId: rider.id, createdAt: { gte: weekStart } },
        _sum: { amount: true },
        _count: true,
      }),
      app.prisma.earning.aggregate({
        where: { riderId: rider.id, createdAt: { gte: monthStart } },
        _sum: { amount: true },
        _count: true,
      }),
      app.prisma.earning.aggregate({
        where: { riderId: rider.id },
        _sum: { amount: true },
        _count: true,
      }),
      app.prisma.earning.aggregate({
        where: { riderId: rider.id, status: 'AVAILABLE' },
        _sum: { amount: true },
      }),
    ]);

    return {
      success: true,
      data: {
        today: { total: Number(today._sum.amount ?? 0), count: today._count },
        thisWeek: { total: Number(week._sum.amount ?? 0), count: week._count },
        thisMonth: { total: Number(month._sum.amount ?? 0), count: month._count },
        allTime: { total: Number(allTime._sum.amount ?? 0), count: allTime._count },
        pendingPayout: Number(pendingPayout._sum.amount ?? 0),
      },
    };
  });

  // =========================================================================
  // 9. SUBSCRIPTION
  // =========================================================================

  /** GET /subscription — Current subscription with payment history. */
  app.get('/subscription', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await app.prisma.rider.findUnique({
      where: { userId: request.user.userId },
      include: {
        subscription: {
          include: {
            payments: {
              orderBy: { createdAt: 'desc' },
              take: 20,
            },
          },
        },
      },
    });
    if (!rider) throw new NotFoundError('Rider');

    if (!rider.subscription) {
      return { success: true, data: null };
    }

    const sub = rider.subscription;
    const now = new Date();
    const isActive = sub.status === 'ACTIVE' && sub.currentPeriodEnd > now;

    return {
      success: true,
      data: {
        ...sub,
        isActive,
        daysRemaining: isActive
          ? Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / 86_400_000)
          : 0,
      },
    };
  });

  // =========================================================================
  // 10. STATS
  // =========================================================================

  /** GET /stats — Dashboard stats for the rider app. */
  app.get('/stats', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);
    const todayStart = startOfDay();

    // Online hours today — accumulated in Redis.
    let onlineMsToday = 0;
    const todayKey = `rider:online_ms:${rider.id}:${todayStart.toISOString().slice(0, 10)}`;
    const stored = await app.redis.get(todayKey);
    if (stored) onlineMsToday = parseInt(stored, 10);

    // If currently online, add the elapsed time since last go-online.
    if (rider.isOnline) {
      const onlineSince = await app.redis.get(`rider:online_since:${rider.id}`);
      if (onlineSince) {
        onlineMsToday += Date.now() - parseInt(onlineSince, 10);
      }
    }

    const onlineHoursToday = Math.round((onlineMsToday / 3_600_000) * 10) / 10;

    // Delivery counts.
    const [todayDeliveries, weekDeliveries, todayEarnings] = await Promise.all([
      app.prisma.order.count({
        where: { riderId: rider.id, status: 'DELIVERED', deliveredAt: { gte: todayStart } },
      }),
      app.prisma.order.count({
        where: { riderId: rider.id, status: 'DELIVERED', deliveredAt: { gte: startOfWeek() } },
      }),
      app.prisma.earning.aggregate({
        where: { riderId: rider.id, createdAt: { gte: todayStart } },
        _sum: { amount: true },
      }),
    ]);

    return {
      success: true,
      data: {
        isOnline: rider.isOnline,
        isAvailable: rider.isAvailable,
        hasActiveOrder: !!rider.currentOrderId,
        currentOrderId: rider.currentOrderId,
        totalDeliveries: rider.totalDeliveries,
        totalCourierJobs: rider.totalCourierJobs,
        averageRating: rider.averageRating ? Number(rider.averageRating) : null,
        totalRatings: rider.totalRatings,
        completionRate: rider.completionRate ? Number(rider.completionRate) : null,
        onlineHoursToday,
        todayDeliveries,
        weekDeliveries,
        todayEarnings: Number(todayEarnings._sum.amount ?? 0),
      },
    };
  });
}
