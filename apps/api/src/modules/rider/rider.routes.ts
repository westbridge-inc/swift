import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RiderType, VehicleType, EarningType, EarningStatus, type OrderStatus } from '@prisma/client';
import { OrderService, notHeldFilter } from '../order/order.service';
import { earningsWindow } from '../order/earnings-window';
import { zMoneyMinor } from '../../utils/money-schema';
import { NotificationService } from '../notification/notification.service';
import { VerificationService } from '../verification/verification.service';
import { CashRulesService, customerTrustSummaries } from '../cash/cash-rules.service';
import { BillingService } from '../billing/billing.service';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { DeliveryCashSettlementService, assertSettlementId } from '../cash/delivery-cash-settlement.service';
import { makeDispatchService, vehicleCanCarry } from '../dispatch/dispatch.service';
import { FloatService } from '../dispatch/float.service';
import { startOnlineSession, closeOnlineSession } from './online-hours';
import { refreshLegEta, cachedLegEta } from '../dispatch/live-eta';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { assertShiftLiveness } from '../safety/liveness.service';
import { assertNotSafetySuspended } from '../safety/incident.service';
import { subscriptionOperability } from '../subscription/operate-gate';
import { haversineDistance } from '../../utils/distance';
import { estimateLoad } from '../../utils/load';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { tenantCacheKey } from '../../utils/tenant-cache';
import { AppError, NotFoundError, ConflictError, ValidationError } from '../../utils/errors';
import { withIdempotency } from '../../utils/idempotency';
import { throwForMissingProfile } from '../../utils/role-gate';
import { clampDriverFare } from '../../utils/markup';
import { ALLOWED_IMAGE_TYPES, looksLikeImage } from '../../utils/images';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { startOfDayGY, startOfWeekGY, startOfMonthGY } from '../../utils/time-gy';
import { dailyEarnings } from '../order/daily-earnings';

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

const offerActionSchema = z.object({
  orderId: z.string().min(1),
});

/** Golden-rule handover: GPS is mandatory — a claim is impossible without it. */
const handoverSchema = z.object({
  outcome: z.enum(['paid', 'no_show', 'refused']),
  gps: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  photoUrl: z.string().max(2048).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the Rider record for the authenticated user. Missing row = 403 for
 *  outsiders (authz answers before anything else), 404 only for movers who
 *  haven't onboarded a rider profile yet. */
async function getRider(app: FastifyInstance, userId: string) {
  const rider = await app.prisma.rider.findUnique({
    where: { userId },
  });
  if (!rider) await throwForMissingProfile(app, userId, 'MOVER', 'Rider');
  return rider!;
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

// DASH-06: "today"/"this week"/"this month" for earnings are Guyana-local
// boundaries (UTC-4), not the server's UTC midnight. Shared helpers.
const startOfDay = startOfDayGY;
const startOfWeek = startOfWeekGY;
const startOfMonth = startOfMonthGY;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function riderRoutes(app: FastifyInstance) {
  const orderService = new OrderService(app.prisma, app.io);
  const floatService = new FloatService(app.prisma);
  const verification = new VerificationService(
    app.prisma,
    new NotificationService(app.prisma, app.io),
    getKycProvider(),
  );
  const dispatch = makeDispatchService(app);
  const cashRules = new CashRulesService(
    app.prisma,
    new NotificationService(app.prisma, app.io),
    orderService,
  );
  const settlements = new DeliveryCashSettlementService(app.prisma, new NotificationService(app.prisma, app.io));
  const billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());

  /** POST /orders/:id/handover — the golden rule at the door.
   *  'paid' completes the delivery; 'no_show'/'refused' fails it with GPS
   *  evidence, strikes the customer, and opens the guarantee claim. */
  app.post('/orders/:id/handover', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    await getRider(app, request.user.userId); // authz before validation
    const body = handoverSchema.parse(request.body);
    // Idempotent on Idempotency-Key: a network-retried handover returns the
    // original result instead of failing the (now-terminal) transition.
    const { data, replayed } = await withIdempotency(app, request, 'handover', id, async () => {
      const result = await cashRules.handover(id, request.user.userId, body);
      return {
        orderId: id,
        status: result.order.status,
        claim: result.claim
          ? { id: result.claim.id, status: result.claim.status, amount: Number(result.claim.amount), flags: result.claim.flags }
          : null,
      };
    });
    return { success: true, data, replayed };
  });

  /** POST /offers/accept — atomic claim of a live dispatch offer. This is the
   *  path the offer CARD uses [SWIFT-016]: acceptOffer acknowledges the offer
   *  alert (so accepting is never scored as a timeout) and records a POSITIVE
   *  acceptance — unlike the board-grab entrance, which is for the open list. */
  app.post('/offers/accept', { preHandler: [app.authenticate] }, async (request) => {
    await getRider(app, request.user.userId); // authz before validation
    const { orderId, fare } = offerActionSchema.extend({ fare: zMoneyMinor.optional() }).parse(request.body);
    const order = await dispatch.acceptOffer(orderId, request.user.userId);
    // Rider-set delivery fee, capped at market — the same rule as the board-grab
    // accept, applied AFTER the offer claim (which already acked the alert and
    // committed the float). Lowering the fee lowers the customer's total 1:1.
    if (fare != null) {
      const marketFee = Number(order.deliveryFee);
      const chosenFee = clampDriverFare(fare, marketFee);
      if (chosenFee !== marketFee) {
        await app.prisma.order.update({
          where: { id: orderId },
          data: { deliveryFee: chosenFee, totalAmount: Number(order.totalAmount) - (marketFee - chosenFee) },
        });
      }
    }
    return { success: true, data: { orderId: order.id, status: order.status, orderNumber: order.orderNumber } };
  });

  /** POST /offers/decline — pass; the cascade moves to the next mover. */
  app.post('/offers/decline', { preHandler: [app.authenticate] }, async (request) => {
    await getRider(app, request.user.userId); // authz before validation
    const { orderId } = offerActionSchema.parse(request.body);
    await dispatch.declineOffer(orderId, request.user.userId);
    return { success: true, data: { message: 'Offer declined' } };
  });

  // =========================================================================
  // 1. PROFILE
  // =========================================================================

  /** GET /profile — Full rider profile with user info, subscription & stats. */
  app.get('/profile', { preHandler: [app.authenticate] }, async (request) => {
    const found = await app.prisma.rider.findUnique({
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
    if (!found) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Rider');
    const rider = found!;

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
        // D.3 float exposure — surfaced so the app can explain "why no offers".
        float: {
          limit: Number(rider.floatLimit),
          committed: Number(rider.committedFloat),
          available: Number(rider.floatLimit) - Number(rider.committedFloat),
        },
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

  /** POST /vehicle-photo — the PUBLIC delivery-vehicle photo customers see on
   *  acceptance (master plan §3.3). Stored in the public vehicles/ tree. */
  app.post('/vehicle-photo', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);

    const file = await request.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach a photo of your vehicle');
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      throw new AppError(400, 'BAD_IMAGE_TYPE', 'Only JPEG, PNG, or WebP images are accepted');
    }
    const buffer = await file.toBuffer();
    if (!looksLikeImage(buffer)) {
      throw new AppError(400, 'BAD_IMAGE', 'File content does not match an image format');
    }

    const { url } = await getStorageProvider().upload({
      buffer,
      filename: file.filename,
      mimeType: file.mimetype,
      folder: `vehicles/${rider.id}`,
    });

    const updated = await app.prisma.rider.update({
      where: { id: rider.id },
      data: { vehiclePhotoUrl: url },
      select: { id: true, vehiclePhotoUrl: true },
    });
    return { success: true, data: updated };
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

    // Universal signup selfie (master plan §3): customers see the courier's
    // photo on acceptance, so a live profile photo must exist before going online.
    const account = await app.prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
      select: { selfieCapturedAt: true },
    });
    if (!account.selfieCapturedAt) {
      throw new AppError(403, 'SELFIE_REQUIRED', 'Add your profile photo before going online — customers see it when you accept.');
    }

    // Verification gate: the country's MOVER checklist must be fully approved.
    // Legacy documentsVerified flag grandfathers pre-checklist accounts.
    const verified = rider.documentsVerified
      || await verification.isRoleVerified(request.user.userId, 'MOVER');
    if (!verified) {
      throw new AppError(403, 'VERIFICATION_REQUIRED', 'Your documents must be verified before you can go online');
    }

    // THE canOperate rule (operate-gate.ts, G-BILL-03) — a missing row is
    // grandfathered (legacy accounts pre-dating birth-on-verification); the
    // verdict maps onto this route's historical codes.
    const sub = await app.prisma.subscription.findFirst({
      where: { riderId: rider.id },
      select: { status: true, gracePeriodEnd: true },
    });
    const operability = subscriptionOperability(sub, { missingRow: 'GRANDFATHER' });
    if (!operability.operable) {
      if (operability.why === 'GRACE_LAPSED') {
        throw new AppError(403, 'SUBSCRIPTION_PAST_DUE', 'Your grace period has ended — pay this week’s fee to go back online.');
      }
      throw new AppError(403, 'SUBSCRIPTION_SUSPENDED', 'Your subscription is unpaid. Top up or pay to go back online.');
    }

    // Identity assurance (safety spec §7.1): when the tenant enables liveness,
    // a shift needs a fresh face-match PASS (428 tells the client to run the
    // selfie check first); repeated failures lock until ops clears.
    assertShiftLiveness(rider);
    // §8.3 — an interim safety suspension blocks go-online until ops lifts it.
    assertNotSafetySuspended(rider);

    const updated = await app.prisma.rider.update({
      where: { id: rider.id },
      data: { isOnline: true, isAvailable: !rider.currentOrderId },
    });

    // Track online session start in Redis for hours tracking.
    await startOnlineSession(app.redis, rider.id);

    return { success: true, data: { isOnline: updated.isOnline, isAvailable: updated.isAvailable } };
  });

  /** POST /go-offline — Mark rider as offline. */
  app.post('/go-offline', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);

    if (rider.currentOrderId) {
      throw new ConflictError('You cannot go offline while you have an active delivery. Complete or cancel the current order first.');
    }

    // A rider holding a live offer (not yet accepted) is still isAvailable and
    // passes the guard above. Release it now so the delivery re-dispatches at
    // once rather than sitting on a rider who quit for the offer's full window.
    await dispatch.releaseHeldOffer(rider.id);

    const updated = await app.prisma.rider.update({
      where: { id: rider.id },
      data: { isOnline: false, isAvailable: false },
    });

    // Accumulate today's online hours in Redis (SWIFT-143: same helper the
    // force-offline paths use, so a session closes the same way however it ends).
    await closeOnlineSession(app.redis, rider.id);

    return { success: true, data: { isOnline: updated.isOnline, isAvailable: updated.isAvailable } };
  });

  // =========================================================================
  // 3. LOCATION
  // =========================================================================

  /** PUT /location — Update lat/lng, persist to DB + Redis, broadcast to active order. */
  app.put('/location', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId); // authz before validation
    const { latitude, longitude, heading, speed } = riderLocationSchema.parse(request.body);
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

    // SWIFT-141: the `rider:location:<id>` Redis write was a "fast path for
    // real-time queries" with ZERO readers — every ping serialized + wrote a
    // payload nothing consumed. Deleted (rule 17). The live path is the socket
    // emit below; the persistent path is the throttled DB write above
    // (currentLat/Lng, read by dispatch/presence). There is no third copy.

    // Broadcast to order room if rider has an active order.
    if (rider.currentOrderId) {
      // Live-leg ETA [SWIFT-UG-RT-01]: recomputed on the same ≥10 s throttle
      // as the DB write, served from cache on the pings in between — the
      // tracking screen gets a moving ETA without a maps call per ping.
      const etaMinutes = shouldWriteDb
        ? await refreshLegEta(app, rider.currentOrderId, { lat: latitude, lng: longitude })
        : await cachedLegEta(app, rider.currentOrderId);
      app.io.to(`order:${rider.currentOrderId}`).emit('rider:location', {
        riderId: rider.id,
        lat: latitude,
        lng: longitude,
        heading: heading ?? null,
        speed: speed ?? null,
        etaMinutes,
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
        // LIFECYCLE_V2: a held courier job isn't offerable yet.
        ...notHeldFilter(),
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

    // §4d trust badge: WHO the rider would front cash for — trust level,
    // completed orders, strikes. One batch (3 queries), never per-row.
    const trust = await customerTrustSummaries(app.prisma, orders.map((o) => o.customerId));

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
          estLoad: estimateLoad(order.items.reduce((s, i) => s + i.quantity, 0)),
          deliveryFee: Number(order.deliveryFee),
          tipAmount: Number(order.tipAmount),
          totalEarning: Number(order.deliveryFee) + Number(order.tipAmount),
          isExpress: order.isExpress,
          paymentMethod: order.paymentMethod,
          customerTrust: trust.get(order.customerId) ?? null,
          pickupDistanceKm: Math.round(pickupDistance * 10) / 10,
          deliveryDistanceKm: Math.round(deliveryDistance * 10) / 10,
          estimatedPrepTime: order.estimatedPrepTime,
          estimatedDeliveryTime: order.estimatedDeliveryTime,
          placedAt: order.placedAt,
        };
      })
      .filter((o) => o.pickupDistanceKm <= maxRadiusKm)
      // Express (bigger fee, customer paid to jump the queue) surfaces first;
      // distance breaks ties within each tier.
      .sort((a, b) => Number(b.isExpress) - Number(a.isExpress) || a.pickupDistanceKm - b.pickupDistanceKm);

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
    const { fare } = z.object({ fare: zMoneyMinor.optional() }).parse(request.body ?? {});
    const rider = await getRider(app, request.user.userId);

    // Must be online.
    if (!rider.isOnline) {
      throw new AppError(400, 'OFFLINE', 'You must be online to accept orders');
    }

    // Must not have an active order already.
    if (rider.currentOrderId) {
      throw new ConflictError('You already have an active delivery. Complete it before accepting a new one.');
    }

    // Atomic check: order must still be unassigned. findFirst (not findUnique)
    // so the tenant-scope extension applies [SWIFT-SEC-CT-01]: an unassigned
    // order has no owner yet, so the ONLY isolation on this pre-claim read is
    // the tenant filter — a mover must never read another operator's order PII
    // (customer name/phone, pickup+delivery addresses) by id.
    const order = await app.prisma.order.findFirst({
      where: { id },
      include: { vendor: { select: { id: true, name: true } } },
    });
    if (!order) throw new NotFoundError('Order', id);

    if (order.riderId) {
      throw new ConflictError('This order has already been claimed by another rider');
    }

    // RIDER_ASSIGNED is only reachable from these states — NOT PENDING (the vendor
    // hasn't accepted yet). Kept in sync with the order transition table; accepting
    // a PENDING order used to strand the rider stuck-busy after the throw below.
    const acceptableStatuses: OrderStatus[] = ['READY_FOR_PICKUP', 'ACCEPTED', 'PREPARING'];
    if (!acceptableStatuses.includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS', `Order cannot be accepted in status ${order.status}`);
    }

    // SWIFT-062: the board-grab entrance must respect vehicle capability too — a
    // parcel can't be grabbed by a mover whose vehicle can't carry it (the offer
    // cascade already filters candidates this way in findCandidates).
    if (order.orderType === 'COURIER' && order.courierPackageSize && !vehicleCanCarry(rider.vehicleType, order.courierPackageSize)) {
      throw new AppError(400, 'VEHICLE_TOO_SMALL', `A ${order.courierPackageSize.toLowerCase().replace(/_/g, ' ')} parcel needs a bigger vehicle than your ${rider.vehicleType.toLowerCase()}.`);
    }

    // Rider-set delivery fee, capped at the market rate (deliveryFee). The rider
    // charges UP TO market and no more; lowering it lowers the customer's total by
    // the same delta. Swift never sets the final price.
    const marketFee = Number(order.deliveryFee);
    const chosenFee = fare != null ? clampDriverFare(fare, marketFee) : marketFee;

    // D.3 cash-exposure parity with dispatch.claimOrder [debug-ledger P2]: a
    // board-grab accept must respect the same float gate the offer cascade
    // enforces — the rider fronts the vendor the CASH subtotal at pickup — and
    // commit the float it consumes, or the cap is bypassable through this
    // entrance and a later release decrements float never committed.
    const floatAmt = order.paymentMethod === 'CASH' ? Number(order.subtotalBase) : 0;
    // Fast-fail hint only — this reads a possibly-stale committedFloat. The
    // authoritative cap is the guarded commit below.
    if (floatAmt > 0) {
      const headroom = Number(rider.floatLimit) - Number(rider.committedFloat);
      if (headroom < floatAmt) {
        throw new AppError(
          400,
          'FLOAT_EXCEEDED',
          `This cash order needs $${floatAmt.toLocaleString()} float headroom (you front the vendor at pickup); you have $${Math.max(0, headroom).toLocaleString()} available`,
        );
      }
    }

    // SWIFT-104: reserve the float FIRST with an ATOMIC guarded commit. The JS
    // check above cannot cap concurrency — two board-grabs of DIFFERENT orders by
    // the same rider each read the same committedFloat and both pass. The DB
    // predicate (floatLimit − committedFloat ≥ amount) is what actually bounds the
    // cash a rider fronts. Reserve before claiming so a lost float race never
    // leaves an order half-assigned; a lost ORDER race releases it (below).
    if (floatAmt > 0) {
      const reserved = await floatService.commit(app.prisma, rider.id, floatAmt);
      if (!reserved) {
        throw new AppError(
          400,
          'FLOAT_EXCEEDED',
          `This cash order needs $${floatAmt.toLocaleString()} float headroom (you front the vendor at pickup); your other live orders have used it up.`,
        );
      }
    }

    // Claim the order AND reserve the rider ATOMICALLY, mirroring
    // dispatch.claimOrder. The order updateMany is the single-winner per-ORDER
    // lock (only one caller flips riderId from null under an acceptable status).
    // The rider updateMany (guarded on isAvailable + currentOrderId:null) is the
    // one-job-per-MOVER lock — WITHOUT it a single rider grabbing two DIFFERENT
    // orders at once wins both: the float commit caps cash fronted, not job
    // COUNT, and a MOBILE_MONEY order commits no float at all. Both writes ride in
    // one tx so a crash between them can never strand an order on a busy rider.
    const outcome = await app.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id, riderId: null, status: { in: acceptableStatuses } },
        data: {
          riderId: rider.id,
          ...(chosenFee !== marketFee
            ? { deliveryFee: chosenFee, totalAmount: Number(order.totalAmount) - (marketFee - chosenFee) }
            : {}),
        },
      });
      if (claimed.count === 0) return 'ORDER_TAKEN' as const;

      const reserved = await tx.rider.updateMany({
        where: { id: rider.id, isAvailable: true, currentOrderId: null },
        data: { isAvailable: false, currentOrderId: id },
      });
      if (reserved.count === 0) {
        // The rider already holds a live order — undo the claim (revert the fee
        // too) so this order goes back on the board for another mover.
        await tx.order.updateMany({
          where: { id, riderId: rider.id },
          data: { riderId: null, deliveryFee: marketFee, totalAmount: Number(order.totalAmount) },
        });
        return 'RIDER_BUSY' as const;
      }
      return 'OK' as const;
    });

    if (outcome !== 'OK') {
      // Nothing committed — release any float we reserved for this attempt.
      if (floatAmt > 0) await floatService.release(app.prisma, rider.id, floatAmt);
      if (outcome === 'RIDER_BUSY') {
        throw new ConflictError('You already have an active order — finish it before taking another one.');
      }
      throw new ConflictError('This order was just claimed by another rider, or is no longer available');
    }

    // Winner of BOTH locks — the rider is already marked busy and the float
    // committed; advance the order to RIDER_ASSIGNED.
    await orderService.updateStatus(id, 'RIDER_ASSIGNED', request.user.userId, 'Rider accepted the order');

    const updatedOrder = await app.prisma.order.findUniqueOrThrow({ where: { id } });

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
    // Idempotent on Idempotency-Key: a retried final step returns the original
    // result instead of failing the now-terminal transition. The whole effect
    // (incl. the transition / payment / PIN checks) runs inside the claim so a
    // replay short-circuits to the stored result.
    const { data, replayed } = await withIdempotency(app, request, 'delivered', id, async () => {
      const order = await getOwnedOrder(app, id, rider.id);

      const validFrom = ['ARRIVED', 'EN_ROUTE_DELIVERY'];
      if (!validFrom.includes(order.status)) {
        throw new AppError(
          400,
          'INVALID_TRANSITION',
          `Cannot mark as delivered from status ${order.status}. Rider must be ARRIVED or EN_ROUTE_DELIVERY.`,
        );
      }

      // Golden rule: a CASH order can't be closed until the money is in hand.
      // Cash is captured only via POST /handover {outcome:'paid'} (which then
      // completes the delivery); /delivered is the final step for orders already
      // paid (MMG is CAPTURED at checkout). Without this gate a rider could mark
      // a cash order delivered without collecting — skipping the strike/guarantee
      // flow and leaving the books saying "delivered" while nothing was paid.
      if (order.paymentMethod === 'CASH' && order.paymentStatus !== 'CAPTURED') {
        throw new AppError(
          409,
          'PAYMENT_NOT_CAPTURED',
          'Collect the cash first — use “Confirm payment & hand over” to record it, which completes the delivery.',
        );
      }

      // Verify ride PIN if one was set on the order.
      if (order.ridePin && order.ridePin !== ridePin) {
        throw new AppError(400, 'INVALID_PIN', 'Incorrect delivery PIN. Please ask the customer for the correct PIN.');
      }

      // 1. Update order status — handles notifications, sockets, float release,
      //    and freeing the rider (isAvailable/currentOrderId/totalDeliveries)
      //    centrally, so every terminal path behaves the same.
      await orderService.updateStatus(id, 'DELIVERED', request.user.userId, 'Delivery completed');

      // 2. Create earning records (delivery fee + tip).
      await orderService.createEarnings(id);

      // 3. Read the freed rider back for the response payload.
      const updated = await app.prisma.rider.findUniqueOrThrow({
        where: { id: rider.id },
        select: { totalDeliveries: true, isAvailable: true },
      });

      // 4. Calculate this delivery's earnings for the response.
      const deliveryEarning = Number(order.deliveryFee) + Number(order.tipAmount);

      return {
        orderId: id,
        orderNumber: order.orderNumber,
        status: 'DELIVERED' as const,
        earning: deliveryEarning,
        deliveryFee: Number(order.deliveryFee),
        tip: Number(order.tipAmount),
        totalDeliveries: updated.totalDeliveries,
        isAvailable: updated.isAvailable,
      };
    });
    return { success: true, data, replayed };
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

  /** GET /earnings/daily — per-Guyana-day totals for the Home trend chart
   *  [DASH-03]: server-aggregated, so older days aren't truncated by the
   *  paginated earnings list. */
  app.get('/earnings/daily', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);
    const days = Math.min(31, Math.max(1, Number((request.query as { days?: string }).days ?? 7)));
    return { success: true, data: await dailyEarnings(app.prisma, { riderId: rider.id }, days) };
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
        // SWIFT-080: { total, count } per window via the shared earningsWindow
        // helper — the single source the driver route now also uses.
        today: earningsWindow(today),
        thisWeek: earningsWindow(week),
        thisMonth: earningsWindow(month),
        allTime: earningsWindow(allTime),
        pendingPayout: Number(pendingPayout._sum.amount ?? 0),
      },
    };
  });

  /** GET /demand — unassigned deliveries near the rider, grouped by store
   *  (dashboard plan Phase A): READY to collect now vs SOON, with the fees
   *  waiting at each store. Held orders invisible. 10s cache per ~1 km cell. */
  app.get('/demand', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);
    const q = z
      .object({ lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() })
      .parse(request.query);
    const lat = q.lat ?? Number(rider.currentLat);
    const lng = q.lng ?? Number(rider.currentLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new AppError(400, 'NO_POSITION', 'Send lat/lng or go online so Swift knows where you are.');
    }
    const cacheKey = tenantCacheKey(`demand:RIDER:${lat.toFixed(2)}:${lng.toFixed(2)}`);
    const cached = await app.redis.get(cacheKey);
    if (cached) return { success: true, data: JSON.parse(cached) };
    const { riderDemand } = await import('../dispatch/demand.service');
    const data = await riderDemand(app.prisma, { lat, lng });
    await app.redis.set(cacheKey, JSON.stringify(data), 'EX', 10).catch(() => {});
    return { success: true, data };
  });

  /** GET /earnings/statement — print-ready HTML earnings statement (the
   *  receipt's sibling, marketplace §12): what an earner shows a bank.
   *  Derived from the earnings ledger on demand; default period 30 days. */
  app.get('/earnings/statement', { preHandler: [app.authenticate] }, async (request, reply) => {
    const rider = await getRider(app, request.user.userId);
    const { statementPeriod, buildRiderStatement, mintStatementPath } = await import('../order/statement');
    const q = request.query as { from?: string; to?: string; link?: string };
    const period = statementPeriod(q);
    // ?link=1 → a short-lived signed URL the in-app browser can open (share/print).
    if (q.link === '1') {
      return { success: true, data: mintStatementPath('rider', rider.id, period) };
    }
    reply.type('text/html; charset=utf-8');
    return buildRiderStatement(app.prisma, rider.id, request.user.userId, period);
  });

  /** PUT /subscription/billing-method — §13 rail selection: pay the weekly fee
   *  from the prepaid balance (CASH) or by approving an MMG request on my
   *  phone (MOBILE_MONEY + my MMG account number). */
  app.put('/subscription/billing-method', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);
    const body = z.object({
      method: z.enum(['CASH', 'MOBILE_MONEY']),
      mmgPayerMsisdn: z.string().trim().min(5).max(30).optional(),
    }).parse(request.body);
    const sub = await app.prisma.subscription.findFirst({ where: { riderId: rider.id } });
    if (!sub) throw new NotFoundError('Subscription');
    const updated = await billing.setBillingRail(sub.id, body.method, body.mmgPayerMsisdn);
    return { success: true, data: { billingMethod: updated.billingMethod, mmgPayerMsisdn: updated.mmgPayerMsisdn } };
  });

  // =========================================================================
  // 8b. MMG CASH SETTLEMENTS — delivery fees stores owe me
  // =========================================================================

  /** GET /cash-settlements — MMG direct-pay ledger: delivery fees stores owe
   *  me in cash (customer paid the store, not me). Swift tracks the debt only. */
  app.get('/cash-settlements', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);
    const data = await settlements.listForRider(rider.id);
    return { success: true, data };
  });

  /** POST /cash-settlements/:id/confirm — "the store handed me the cash".
   *  First confirm marks my half; the store's confirm settles it. Idempotent. */
  app.post('/cash-settlements/:id/confirm', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const rider = await getRider(app, request.user.userId);
    const data = await settlements.confirm(assertSettlementId(id), 'RIDER', { riderId: rider.id });
    return { success: true, data };
  });

  // =========================================================================
  // 9. SUBSCRIPTION
  // =========================================================================

  /** GET /subscription — Current subscription with payment history. */
  app.get('/subscription', { preHandler: [app.authenticate] }, async (request) => {
    const found = await app.prisma.rider.findUnique({
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
    if (!found) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Rider');
    const rider = found!;

    if (!rider.subscription) {
      return { success: true, data: null };
    }

    const sub = rider.subscription;
    const now = new Date();
    // THE canOperate rule (operate-gate.ts): the badge must show exactly what
    // the go-online switch allows — including the grace-lapse cutoff, which
    // this display copy used to miss.
    const isActive = subscriptionOperability(sub, { missingRow: 'BLOCK' }, now).operable && sub.currentPeriodEnd > now;

    const { sanDisplay } = await import('../billing/san.service');
    return {
      success: true,
      data: {
        ...sub,
        // "My Swift Number" [san spec 2.4/6.1] — the cash-at-agent payment
        // reference; heal-on-read covers pre-SAN rows.
        ...(await sanDisplay(app.prisma, sub)),
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
