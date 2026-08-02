import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OrderStatus, EarningType, EarningStatus, RideClass } from '@prisma/client';
import { OrderService } from '../order/order.service';
import { earningsWindow } from '../order/earnings-window';
import { zMoneyMinor } from '../../utils/money-schema';
import { NotificationService } from '../notification/notification.service';
import { VerificationService } from '../verification/verification.service';
import { makeDispatchService } from '../dispatch/dispatch.service';
import { TAXI_DEMAND_WINDOW_MIN } from '../dispatch/demand.service';
import { classesAtOrAbove, classesAtOrBelow } from '../rides/fare.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { assertShiftLiveness } from '../safety/liveness.service';
import { assertNotSafetySuspended } from '../safety/incident.service';
import { subscriptionOperability } from '../subscription/operate-gate';
import { BillingService } from '../billing/billing.service';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { haversineDistance, estimateDeliveryMinutes } from '../../utils/distance';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { tenantCacheKey } from '../../utils/tenant-cache';
import { AppError, NotFoundError } from '../../utils/errors';
import { handoverAttemptState } from '../handover/handover-security';
import { throwForMissingProfile } from '../../utils/role-gate';
import { clampDriverFare } from '../../utils/markup';
import { ALLOWED_IMAGE_TYPES, looksLikeImage } from '../../utils/images';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { refreshLegEta, cachedLegEta } from '../dispatch/live-eta';
import { startOfDayGY, startOfWeekGY, startOfMonthGY } from '../../utils/time-gy';
import { dailyEarnings } from '../order/daily-earnings';

const updateDriverProfileSchema = z.object({
  vehicleMake: z.string().max(50).optional(),
  vehicleModel: z.string().max(50).optional(),
  vehicleYear: z.number().int().min(1950).max(2100).optional(),
  vehicleColor: z.string().max(30).optional(),
  licensePlate: z.string().max(20).optional(),
  vehicleCapacity: z.number().int().min(1).max(50).optional(),
  rideClass: z.nativeEnum(RideClass).optional(),
  profilePhotoUrl: z.string().max(2048).optional(),
  nationalIdUrl: z.string().max(2048).optional(),
  driverLicenseUrl: z.string().max(2048).optional(),
  vehicleInsuranceUrl: z.string().max(2048).optional(),
  vehicleInspectionUrl: z.string().max(2048).optional(),
  // The taxi driver's own MMG "pay me" link (opt-in). null/empty clears it.
  mmgPayUrl: z.string().trim().max(500).nullable().optional(),
});

const driverLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  heading: z.number().optional(),
});

const verifyPinSchema = z.object({
  pin: z.string().min(1).max(10),
});

const ridesQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
});

const driverEarningsQuerySchema = z.object({
  type: z.nativeEnum(EarningType).optional(),
  status: z.nativeEnum(EarningStatus).optional(),
});

export async function driverRoutes(app: FastifyInstance) {
  const orderService = new OrderService(app.prisma, app.io);
  const notifications = new NotificationService(app.prisma, app.io);
  const verification = new VerificationService(app.prisma, notifications, getKycProvider());
  const dispatch = makeDispatchService(app);

  // Helper: resolve driver record from JWT userId. Missing row = 403 for
  // outsiders (authz answers before anything else), 404 only for movers who
  // haven't onboarded a driver profile yet.
  async function getDriver(userId: string) {
    const driver = await app.prisma.driver.findUnique({
      where: { userId },
      include: { user: true, subscription: true },
    });
    if (!driver) await throwForMissingProfile(app, userId, 'MOVER', 'Driver');
    return driver!;
  }

  // Helper: verify the driver owns this ride
  async function getDriverRide(driverId: string, orderId: string) {
    const order = await app.prisma.order.findFirst({
      where: { id: orderId, driverId, orderType: 'TAXI' },
      include: { customer: { select: { id: true, firstName: true, lastName: true, phone: true, avatar: true } } },
    });
    if (!order) throw new NotFoundError('Ride', orderId);
    return order;
  }

  // ─── Profile ───────────────────────────────────────────────────────────

  app.get('/profile', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await app.prisma.driver.findUnique({
      where: { userId: request.user.userId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, avatar: true } },
        subscription: true,
      },
    });
    if (!driver) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Driver');
    return { success: true, data: driver };
  });

  app.put('/profile', { preHandler: [app.authenticate] }, async (request) => {
    await getDriver(request.user.userId); // authz before validation
    const body = updateDriverProfileSchema.parse(request.body);

    const driver = await app.prisma.driver.update({
      where: { userId: request.user.userId },
      data: {
        ...(body.vehicleMake !== undefined && { vehicleMake: body.vehicleMake }),
        ...(body.vehicleModel !== undefined && { vehicleModel: body.vehicleModel }),
        ...(body.vehicleYear !== undefined && { vehicleYear: body.vehicleYear }),
        ...(body.vehicleColor !== undefined && { vehicleColor: body.vehicleColor }),
        ...(body.licensePlate !== undefined && { licensePlate: body.licensePlate }),
        ...(body.vehicleCapacity !== undefined && { vehicleCapacity: body.vehicleCapacity }),
        ...(body.rideClass !== undefined && { rideClass: body.rideClass }),
        ...(body.profilePhotoUrl !== undefined && { profilePhotoUrl: body.profilePhotoUrl }),
        ...(body.nationalIdUrl !== undefined && { nationalIdUrl: body.nationalIdUrl }),
        ...(body.driverLicenseUrl !== undefined && { driverLicenseUrl: body.driverLicenseUrl }),
        ...(body.vehicleInsuranceUrl !== undefined && { vehicleInsuranceUrl: body.vehicleInsuranceUrl }),
        ...(body.vehicleInspectionUrl !== undefined && { vehicleInspectionUrl: body.vehicleInspectionUrl }),
        ...(body.mmgPayUrl !== undefined && { mmgPayUrl: body.mmgPayUrl || null }),
      },
      include: { user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, avatar: true } } },
    });
    return { success: true, data: driver };
  });

  /** POST /vehicle-photo — the PUBLIC exterior car photo riders see on
   *  acceptance (master plan §5). Stored in the public vehicles/ tree —
   *  distinct from the private vehicle_exterior_photo KYC document. */
  app.post('/vehicle-photo', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await getDriver(request.user.userId);

    const file = await request.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach a photo of your car');
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
      folder: `vehicles/${driver.id}`,
    });

    const updated = await app.prisma.driver.update({
      where: { id: driver.id },
      data: { vehiclePhotoUrl: url },
      select: { id: true, vehiclePhotoUrl: true },
    });
    return { success: true, data: updated };
  });

  // ─── Online / Offline ──────────────────────────────────────────────────

  app.post('/go-online', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await getDriver(request.user.userId);

    // Universal signup selfie (master plan §3): riders see the driver's photo
    // on acceptance, so a live profile photo is required before going online.
    if (!driver.user.selfieCapturedAt) {
      throw new AppError(403, 'SELFIE_REQUIRED', 'Add your profile photo before going online — riders see it when you accept.');
    }

    // Live-operation gate (spec §3.4): the taxi checklist must be approved AND a
    // current, hire-class motor insurance confirmed before carrying passengers.
    // The legacy documentsVerified flag only grandfathers the base documents.
    const live = await verification.getLiveOperationStatus(request.user.userId, {
      vehicleType: 'CAR',
      legacyVerified: driver.documentsVerified,
    });
    if (!live.allowed) {
      if (live.reason === 'insurance') {
        throw new AppError(403, 'INSURANCE_HIRE_CLASS_REQUIRED', 'A current hire-class motor insurance must be verified before you can carry passengers');
      }
      throw new AppError(403, 'VERIFICATION_REQUIRED', 'Your documents must be verified before going online');
    }

    // THE canOperate rule (operate-gate.ts, G-BILL-03) — drivers require a
    // subscription row; the verdict maps onto this route's historical codes.
    const operability = subscriptionOperability(driver.subscription, { missingRow: 'BLOCK' });
    if (!operability.operable) {
      if (operability.why === 'GRACE_LAPSED') {
        throw new AppError(403, 'SUBSCRIPTION_PAST_DUE', 'Your grace period has ended — pay this week’s fee to go back online.');
      }
      throw new AppError(400, 'SUBSCRIPTION_REQUIRED', 'An active subscription is required to go online');
    }

    // Identity assurance (safety spec §7.1): when the tenant enables liveness,
    // a shift needs a fresh face-match PASS (428 tells the client to run the
    // selfie check first); repeated failures lock until ops clears.
    assertShiftLiveness(driver);
    // §8.3 — an interim safety suspension blocks go-online until ops lifts it.
    assertNotSafetySuspended(driver);

    // A driver already on a ride who re-opens the app and taps GO must NOT be
    // advertised as free supply — otherwise dispatch offers them a second ride
    // mid-trip (phantom supply). Mirror the rider guard [SWIFT-066]: online,
    // yes; available only if not mid-ride. Availability returns on completion.
    const updated = await app.prisma.driver.update({
      where: { id: driver.id },
      data: { isOnline: true, isAvailable: !driver.currentRideId },
    });

    return { success: true, data: updated };
  });

  app.post('/go-offline', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await getDriver(request.user.userId);

    if (driver.currentRideId) {
      throw new AppError(400, 'ACTIVE_RIDE', 'You cannot go offline while you have an active ride');
    }

    // A driver holding a live offer (not yet accepted) is still isAvailable and
    // passes the guard above. Release that offer NOW so the ride re-dispatches
    // immediately instead of the passenger's countdown burning on a driver who
    // quit — and so the reconciler isn't blinded by a zombie offer key.
    await dispatch.releaseHeldOffer(driver.id);

    const updated = await app.prisma.driver.update({
      where: { id: driver.id },
      data: { isOnline: false, isAvailable: false },
    });

    return { success: true, data: updated };
  });

  // ─── Location ──────────────────────────────────────────────────────────

  app.put('/location', { preHandler: [app.authenticate] }, async (request) => {
    const found = await app.prisma.driver.findUnique({ where: { userId: request.user.userId } });
    if (!found) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Driver');
    const driver = found!;

    const { latitude, longitude, heading } = driverLocationSchema.parse(request.body);

    // DB write debounced to ≥10 s (same policy as the rider route): dispatch
    // reads the persisted fix, and a <10 s-stale point is noise at ride speeds —
    // this keeps a busy fleet from hitting PG on every ping.
    const lastDbWrite = await app.redis.get(`driver:location_db_ts:${driver.id}`);
    const shouldWriteDb = !lastDbWrite || Date.now() - parseInt(lastDbWrite, 10) > 10_000;
    if (shouldWriteDb) {
      await app.prisma.driver.update({
        where: { id: driver.id },
        data: {
          currentLat: latitude,
          currentLng: longitude,
          lastLocationUpdate: new Date(),
        },
      });
      await app.redis.set(`driver:location_db_ts:${driver.id}`, Date.now().toString());
    }

    // (No Redis geo set here — dispatch queries the persisted PostGIS point;
    // a parallel geo index nobody reads is a bug waiting to disagree.)

    // Broadcast location to anyone tracking this ride
    if (driver.currentRideId) {
      // Live-leg ETA [SWIFT-UG-RT-01]: pickup ETA while en route to the
      // passenger, dropoff ETA once the ride is in progress — refreshed on
      // the throttled branch, cached in between (same policy as the rider).
      const etaMinutes = shouldWriteDb
        ? await refreshLegEta(app, driver.currentRideId, { lat: latitude, lng: longitude })
        : await cachedLegEta(app, driver.currentRideId);
      app.io.to(`order:${driver.currentRideId}`).emit('driver:location', {
        driverId: driver.id,
        orderId: driver.currentRideId,
        latitude,
        longitude,
        heading: heading || null,
        etaMinutes,
        timestamp: new Date().toISOString(),
      });
    }

    return { success: true };
  });

  // ─── Available Rides ───────────────────────────────────────────────────

  app.get('/rides/available', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await getDriver(request.user.userId);

    if (!driver.isOnline || !driver.isAvailable) {
      return { success: true, data: [] };
    }

    // Only show requests still within the freshness window. Without this the
    // board returned the 20 OLDEST PENDING taxi orders forever — once 20 stale
    // requests piled up (riders who gave up but whose orders never cancelled),
    // brand-new requests never surfaced and drivers saw a frozen, dead board
    // [SWIFT-064]. The demand heatmap uses the same window (one source of
    // truth); actually CANCELLING abandoned requests is SWIFT-021.
    const freshSince = new Date(Date.now() - TAXI_DEMAND_WINDOW_MIN * 60_000);
    const orders = await app.prisma.order.findMany({
      where: {
        orderType: 'TAXI',
        status: 'PENDING',
        driverId: null,
        placedAt: { gte: freshSince },
        // SWIFT-063: only rides this driver's class can serve — their tier and
        // below (an Economy car never sees an XL request). Legacy null-class
        // rides are Economy, so everyone sees them. The cascade already gates
        // this; the OPEN BOARD must too.
        OR: [
          { rideClass: { in: classesAtOrBelow(driver.rideClass ?? 'ECONOMY') } },
          { rideClass: null },
        ],
      },
      include: {
        customer: { select: { id: true, firstName: true, avatar: true } },
      },
      orderBy: { placedAt: 'asc' },
      take: 20,
    });

    // Enrich with distance from driver to pickup
    const enriched = orders.map((order) => {
      const distanceToPickup =
        driver.currentLat && driver.currentLng && order.pickupLat && order.pickupLng
          ? haversineDistance(driver.currentLat, driver.currentLng, order.pickupLat, order.pickupLng)
          : null;
      const etaMinutes = distanceToPickup !== null ? estimateDeliveryMinutes(distanceToPickup) : null;

      return {
        id: order.id,
        orderNumber: order.orderNumber,
        pickupAddress: order.taxiPickupAddress || order.pickupAddress,
        dropoffAddress: order.taxiDropoffAddress || order.deliveryAddress,
        pickupLat: order.pickupLat,
        pickupLng: order.pickupLng,
        dropoffLat: order.deliveryLat,
        dropoffLng: order.deliveryLng,
        passengerCount: order.taxiPassengerCount || 1,
        estimatedDistance: order.taxiDistance,
        estimatedDuration: order.taxiDuration,
        fareTotal: order.taxiFareTotal,
        fareSurge: order.taxiFareSurge,
        distanceToPickup: distanceToPickup !== null ? Math.round(distanceToPickup * 10) / 10 : null,
        etaToPickup: etaMinutes,
        customer: order.customer,
        createdAt: order.createdAt,
      };
    });

    // Sort by distance to pickup (nearest first)
    enriched.sort((a, b) => (a.distanceToPickup ?? 999) - (b.distanceToPickup ?? 999));

    return { success: true, data: enriched };
  });

  // ─── Active Ride ───────────────────────────────────────────────────────

  app.get('/rides/active', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await getDriver(request.user.userId);

    if (!driver.currentRideId) {
      return { success: true, data: null };
    }

    const order = await app.prisma.order.findUnique({
      where: { id: driver.currentRideId },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true, avatar: true } },
        statusHistory: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });

    return { success: true, data: order };
  });

  // ─── Ride Lifecycle ────────────────────────────────────────────────────

  // 1. Accept ride
  app.post('/rides/:id/accept', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const { fare } = z.object({ fare: zMoneyMinor.optional() }).parse(request.body ?? {});
    const driver = await getDriver(request.user.userId);

    if (!driver.isOnline) {
      throw new AppError(400, 'OFFLINE', 'You must be online to accept rides');
    }
    if (!driver.isAvailable || driver.currentRideId) {
      throw new AppError(400, 'UNAVAILABLE', 'You already have an active ride');
    }

    // findFirst so the tenant-scope extension applies [SWIFT-SEC-CT-01]: an
    // unassigned ride has no owner yet; the tenant filter is the only barrier
    // stopping a driver from reading another operator's ride by id.
    const order = await app.prisma.order.findFirst({ where: { id } });
    if (!order) throw new NotFoundError('Ride', id);
    if (order.orderType !== 'TAXI') throw new AppError(400, 'INVALID_TYPE', 'This is not a taxi ride');

    // SWIFT-063: the accept path enforces ride class too — the board filter is a
    // convenience, this is the barrier. An Economy driver cannot claim an XL ride
    // (mirrors the cascade's classesAtOrAbove eligibility).
    const rideClass = order.rideClass ?? 'ECONOMY';
    if (!classesAtOrAbove(rideClass).includes(driver.rideClass ?? 'ECONOMY')) {
      throw new AppError(400, 'WRONG_RIDE_CLASS', `This is a ${rideClass} ride; your ${driver.rideClass ?? 'ECONOMY'} vehicle can't serve it.`);
    }

    // Shared claim: the DB compare-and-set means two drivers tapping
    // accept at the same instant resolve to exactly one winner — the old
    // check-then-update here could double-assign.
    const updatedOrder = await dispatch.claimOrder(id, driver.id, 'DRIVER');

    // Driver-set price, capped at the market rate Swift computed (taxiFareTotal).
    // The driver charges UP TO market and no more — Swift never sets the final price.
    let responseOrder: any = updatedOrder;
    if (fare != null) {
      const chosen = clampDriverFare(fare, Number(order.taxiFareTotal));
      if (chosen !== Number(order.taxiFareTotal)) {
        await app.prisma.order.update({
          where: { id },
          data: { taxiFareTotal: chosen, totalAmount: chosen },
        });
        responseOrder = { ...updatedOrder, taxiFareTotal: chosen, totalAmount: chosen };
      }
    }

    // Notify customer
    app.io.to(`order:${id}`).emit('order:status_changed', {
      orderId: id,
      status: 'DRIVER_ASSIGNED',
      driver: {
        id: driver.id,
        firstName: driver.user.firstName,
        lastName: driver.user.lastName,
        phone: driver.user.phone,
        avatar: driver.user.avatar,
        vehicleMake: driver.vehicleMake,
        vehicleModel: driver.vehicleModel,
        vehicleColor: driver.vehicleColor,
        licensePlate: driver.licensePlate,
        vehiclePhotoUrl: driver.vehiclePhotoUrl,
        rating: driver.averageRating,
        currentLat: driver.currentLat,
        currentLng: driver.currentLng,
      },
    });

    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Driver Found!',
      body: `${driver.user.firstName} is heading to pick you up in a ${driver.vehicleColor} ${driver.vehicleMake} ${driver.vehicleModel} (${driver.licensePlate}).`,
      data: { orderId: id, status: 'DRIVER_ASSIGNED' },
    });

    return { success: true, data: responseOrder };
  });

  /** POST /offers/decline — pass on a live dispatch offer. The cascade moves
   *  to the next driver immediately instead of waiting out the 20s timeout.
   *  (Parity with the rider route — this side simply didn't exist before, so
   *  a driver tapping Decline only dismissed the card locally.) */
  app.post('/offers/decline', { preHandler: [app.authenticate] }, async (request) => {
    await getDriver(request.user.userId); // authz before validation
    const { orderId } = z.object({ orderId: z.string().min(1).max(64) }).parse(request.body);
    await dispatch.declineOffer(orderId, request.user.userId);
    return { success: true, data: { message: 'Offer declined' } };
  });

  /** POST /offers/accept — atomic claim of a live dispatch offer, the offer-CARD
   *  path [SWIFT-016]. acceptOffer acknowledges the offer alert and records a
   *  POSITIVE acceptance, so accepting is never scored as a timeout. (Parity
   *  with the rider route — this side didn't exist, so a driver accepting from
   *  the offer card fell through to board-grab and had their acceptance rate
   *  quietly decayed by the un-acked offer's timeout.) */
  app.post('/offers/accept', { preHandler: [app.authenticate] }, async (request) => {
    await getDriver(request.user.userId); // authz before validation
    const { orderId, fare } = z.object({
      orderId: z.string().min(1).max(64),
      fare: zMoneyMinor.optional(),
    }).parse(request.body);
    const order = await dispatch.acceptOffer(orderId, request.user.userId);
    // Driver-set price, capped at the market fare — applied after the claim,
    // matching /rides/:id/accept.
    if (fare != null) {
      const chosen = clampDriverFare(fare, Number(order.taxiFareTotal));
      if (chosen !== Number(order.taxiFareTotal)) {
        await app.prisma.order.update({
          where: { id: orderId },
          data: { taxiFareTotal: chosen, totalAmount: chosen },
        });
      }
    }
    return { success: true, data: { orderId: order.id, status: order.status, orderNumber: order.orderNumber } };
  });

  /** POST /rides/:id/rate-customer — post-trip rating goes both ways (§4.2). */
  app.post('/rides/:id/rate-customer', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await getDriver(request.user.userId); // authz before validation
    const body = z.object({
      score: z.number().int().min(1).max(5),
      comment: z.string().max(500).optional(),
    }).parse(request.body);
    const order = await app.prisma.order.findFirst({
      where: { id, driverId: driver.id, orderType: 'TAXI', status: { in: ['DELIVERED', 'COMPLETED'] } },
      select: { id: true, customerId: true },
    });
    if (!order) throw new NotFoundError('Completed ride', id);

    const existing = await app.prisma.rating.findFirst({
      where: { orderId: id, raterId: request.user.userId, type: 'DRIVER_TO_CUSTOMER' },
    });
    if (existing) throw new AppError(409, 'ALREADY_RATED', 'You already rated this passenger');

    const rating = await app.prisma.rating.create({
      data: {
        orderId: id,
        raterId: request.user.userId,
        rateeId: order.customerId,
        type: 'DRIVER_TO_CUSTOMER',
        score: body.score,
        comment: body.comment,
        tags: [],
      },
    });
    // Double-blind: if the passenger already rated, both sides release now.
    const { RatingService } = await import('../rating/rating.service');
    await new RatingService(app.prisma).releaseIfBothSidesRated(id);
    return { success: true, data: rating };
  });

  // Driver bails on an ACCEPTED ride (breakdown, gridlock, no-show) BEFORE the
  // passenger is aboard. Without this the driver was trapped — the only exits were
  // /complete (recording a fare for a trip that never happened) or phoning support,
  // and go-offline is hard-blocked while currentRideId is set. This frees the
  // driver AND re-dispatches the ride so the rider isn't stranded. Never allowed
  // once RIDE_IN_PROGRESS (passenger in the car). [SWIFT taxi-lifecycle]
  const driverCancelSchema = z.object({ reason: z.string().trim().min(3).max(200) });
  app.post('/rides/:id/cancel', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await getDriver(request.user.userId); // authz before body validation
    const { reason } = driverCancelSchema.parse(request.body ?? {});
    const order = await getDriverRide(driver.id, id);

    const cancellable: OrderStatus[] = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];
    if (!cancellable.includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS',
        order.status === 'RIDE_IN_PROGRESS'
          ? 'You cannot cancel once the trip has started — end the trip instead.'
          : `Cannot cancel a ride in ${order.status} status`);
    }

    // Controlled release, atomic: CAS the ride back to PENDING (unassigned) and
    // free the driver together. The order becomes re-dispatchable; the driver is
    // un-trapped. A concurrent transition (customer cancel, complete) makes the
    // CAS miss and we 409 cleanly.
    const released = await app.prisma.$transaction(async (tx) => {
      const cas = await tx.order.updateMany({
        where: { id, driverId: driver.id, status: { in: cancellable } },
        data: { status: 'PENDING', driverId: null, acceptedAt: null },
      });
      if (cas.count === 0) return false;
      await tx.driver.updateMany({
        where: { id: driver.id, currentRideId: id },
        data: { isAvailable: true, currentRideId: null },
      });
      // Accountability: a cancel-AFTER-accept is far more harmful to the rider
      // than an ignored offer, so it feeds a dedicated cancellationRate (was a
      // dead 0.0 field). EMA toward 100 (rate*0.8 + 20), capped; it decays back
      // on each completed ride. Raw SQL so the EMA is one atomic write.
      await tx.$executeRaw`UPDATE "drivers" SET "cancellationRate" = LEAST(100, "cancellationRate" * 0.8 + 20) WHERE "id" = ${driver.id}`;
      await tx.orderStatusLog.create({
        data: { orderId: id, status: 'PENDING', changedBy: request.user.userId, note: `Driver cancelled: ${reason}` },
      });
      return true;
    });
    if (!released) throw new AppError(409, 'INVALID_STATUS', 'This ride can no longer be cancelled');

    // Tell the rider honestly, then re-dispatch so their ride survives.
    app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: 'PENDING', reason: 'driver_cancelled' });
    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Finding you another driver',
      body: 'Your driver had to cancel — we’re matching you with the nearest available driver now.',
      data: { orderId: id, status: 'PENDING' },
    });

    if (app.dispatchQueue) {
      await app.dispatchQueue.add('dispatch-order', { orderId: id }, { priority: 5, removeOnComplete: 100, removeOnFail: 50 });
    } else {
      await dispatch.dispatchOrder(id);
    }

    return { success: true, data: { orderId: id, status: 'PENDING', reDispatched: true } };
  });

  // 2. En route to pickup
  app.put('/rides/:id/en-route', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await getDriver(request.user.userId);
    const order = await getDriverRide(driver.id, id);

    if (order.status !== 'DRIVER_ASSIGNED') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot mark en-route from status ${order.status}`);
    }

    // Compare-and-set: exactly one transition wins, so a double-tap / retry
    // can't double-fire notifications or clobber a concurrent transition.
    const claimed = await app.prisma.order.updateMany({
      where: { id, status: 'DRIVER_ASSIGNED' },
      data: { status: 'DRIVER_EN_ROUTE' },
    });
    if (claimed.count === 0) throw new AppError(409, 'INVALID_STATUS', `Cannot mark en-route from status ${order.status}`);
    await app.prisma.orderStatusLog.create({ data: { orderId: id, status: 'DRIVER_EN_ROUTE', changedBy: request.user.userId } });
    const updatedOrder = await app.prisma.order.findUniqueOrThrow({ where: { id } });

    // Compute ETA to pickup
    let etaMinutes: number | null = null;
    if (driver.currentLat && driver.currentLng && order.pickupLat && order.pickupLng) {
      const dist = haversineDistance(driver.currentLat, driver.currentLng, order.pickupLat, order.pickupLng);
      etaMinutes = estimateDeliveryMinutes(dist);
    }

    app.io.to(`order:${id}`).emit('order:status_changed', {
      orderId: id,
      status: 'DRIVER_EN_ROUTE',
      eta: etaMinutes,
    });

    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Driver En Route',
      body: etaMinutes
        ? `Your driver is on the way. Arriving in ~${etaMinutes} minutes.`
        : 'Your driver is on the way to pick you up.',
      data: { orderId: id, status: 'DRIVER_EN_ROUTE', eta: etaMinutes },
    });

    return { success: true, data: updatedOrder };
  });

  // 3. Arrived at pickup
  app.put('/rides/:id/arrived', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await getDriver(request.user.userId);
    const order = await getDriverRide(driver.id, id);

    if (order.status !== 'DRIVER_EN_ROUTE') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot mark arrived from status ${order.status}`);
    }

    const claimed = await app.prisma.order.updateMany({
      where: { id, status: 'DRIVER_EN_ROUTE' },
      data: { status: 'DRIVER_ARRIVED' },
    });
    if (claimed.count === 0) throw new AppError(409, 'INVALID_STATUS', `Cannot mark arrived from status ${order.status}`);
    await app.prisma.orderStatusLog.create({ data: { orderId: id, status: 'DRIVER_ARRIVED', changedBy: request.user.userId } });
    const updatedOrder = await app.prisma.order.findUniqueOrThrow({ where: { id } });

    app.io.to(`order:${id}`).emit('order:status_changed', {
      orderId: id,
      status: 'DRIVER_ARRIVED',
    });

    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Driver Arrived',
      body: `Your driver has arrived. Please share your ride PIN to begin the trip.`,
      data: { orderId: id, status: 'DRIVER_ARRIVED' },
    });

    return { success: true, data: updatedOrder };
  });

  // 4. Verify ride PIN
  app.put('/rides/:id/verify-pin', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await getDriver(request.user.userId); // authz before validation
    const { pin } = verifyPinSchema.parse(request.body);
    const order = await getDriverRide(driver.id, id);

    if (order.status !== 'DRIVER_ARRIVED') {
      throw new AppError(400, 'INVALID_STATUS', 'Driver must be at pickup location to verify PIN');
    }

    if (order.ridePinVerified) {
      throw new AppError(400, 'ALREADY_VERIFIED', 'Ride PIN has already been verified');
    }

    // HND-004: the SAME lockout rule the pickup code uses (one handover engine).
    const { locked, remaining } = handoverAttemptState(order.ridePinAttempts);
    if (locked) {
      throw new AppError(400, 'MAX_ATTEMPTS', 'Maximum PIN verification attempts exceeded. Please contact support.');
    }

    // Increment attempts
    await app.prisma.order.update({
      where: { id },
      data: { ridePinAttempts: { increment: 1 } },
    });

    if (order.ridePin !== pin) {
      throw new AppError(400, 'INVALID_PIN', `Incorrect PIN. ${remaining} attempt(s) remaining.`);
    }

    // PIN matches
    const updatedOrder = await app.prisma.order.update({
      where: { id },
      data: { ridePinVerified: true, ridePinVerifiedAt: new Date() },
    });

    app.io.to(`order:${id}`).emit('ride:pin_verified', { orderId: id });

    return { success: true, data: updatedOrder, message: 'PIN verified successfully. You may now start the ride.' };
  });

  // 5. Start ride
  app.put('/rides/:id/start', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await getDriver(request.user.userId);
    const order = await getDriverRide(driver.id, id);

    if (order.status !== 'DRIVER_ARRIVED') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot start ride from status ${order.status}`);
    }

    if (!order.ridePinVerified) {
      throw new AppError(400, 'PIN_REQUIRED', 'Ride PIN must be verified before starting the ride');
    }

    const claimed = await app.prisma.order.updateMany({
      where: { id, status: 'DRIVER_ARRIVED' },
      data: { status: 'RIDE_IN_PROGRESS', pickedUpAt: new Date() },
    });
    if (claimed.count === 0) throw new AppError(409, 'INVALID_STATUS', `Cannot start ride from status ${order.status}`);
    await app.prisma.orderStatusLog.create({ data: { orderId: id, status: 'RIDE_IN_PROGRESS', changedBy: request.user.userId, note: 'Ride started' } });
    const updatedOrder = await app.prisma.order.findUniqueOrThrow({ where: { id } });

    app.io.to(`order:${id}`).emit('order:status_changed', {
      orderId: id,
      status: 'RIDE_IN_PROGRESS',
      estimatedDuration: order.taxiDuration,
    });

    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Ride Started',
      body: order.taxiDuration
        ? `Your ride has started. Estimated arrival in ~${order.taxiDuration} minutes.`
        : 'Your ride has started. Enjoy the trip!',
      data: { orderId: id, status: 'RIDE_IN_PROGRESS' },
    });

    return { success: true, data: updatedOrder };
  });

  // 6. Complete ride
  app.put('/rides/:id/complete', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await getDriver(request.user.userId);
    const order = await getDriverRide(driver.id, id);

    if (order.status !== 'RIDE_IN_PROGRESS') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot complete ride from status ${order.status}`);
    }

    // Calculate actual duration
    const actualDuration = order.pickedUpAt
      ? Math.round((Date.now() - order.pickedUpAt.getTime()) / 60000)
      : order.taxiDuration;

    // Compare-and-set so two concurrent completes can't both increment
    // totalRides / double-free the driver (earnings are separately idempotent).
    const claimed = await app.prisma.order.updateMany({
      where: { id, status: 'RIDE_IN_PROGRESS' },
      data: { status: 'DELIVERED', deliveredAt: new Date(), actualDeliveryTime: actualDuration },
    });
    if (claimed.count === 0) throw new AppError(409, 'INVALID_STATUS', `Cannot complete ride from status ${order.status}`);
    // Only the winner frees the driver + counts the ride (guarded on this ride).
    // A completed ride decays the cancellationRate EMA toward 0 (multiply 0.8,
    // the event=0 case), so a driver who cancelled once recovers by finishing
    // trips instead of being penalised forever.
    await app.prisma.driver.updateMany({
      where: { id: driver.id, currentRideId: id },
      data: { isAvailable: true, currentRideId: null, totalRides: { increment: 1 }, cancellationRate: { multiply: 0.8 } },
    });
    await app.prisma.orderStatusLog.create({ data: { orderId: id, status: 'DELIVERED', changedBy: request.user.userId, note: 'Ride completed' } });
    const updatedOrder = await app.prisma.order.findUniqueOrThrow({ where: { id }, include: { customer: { select: { id: true, firstName: true } } } });

    // Create earnings (idempotent via @@unique([orderId, type]))
    await orderService.createEarnings(id);

    app.io.to(`order:${id}`).emit('order:status_changed', {
      orderId: id,
      status: 'DELIVERED',
      fare: {
        base: order.taxiFareBase,
        perKm: order.taxiFarePerKm,
        perMin: order.taxiFarePerMin,
        surge: order.taxiFareSurge,
        total: order.taxiFareTotal,
      },
      actualDuration,
    });

    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Ride Complete',
      body: `You have arrived at your destination. Total fare: $${Number(order.taxiFareTotal || order.totalAmount).toLocaleString()} GYD.`,
      data: { orderId: id, status: 'DELIVERED' },
    });

    return { success: true, data: updatedOrder };
  });

  // ─── Ride History ──────────────────────────────────────────────────────

  app.get('/rides', { preHandler: [app.authenticate] }, async (request) => {
    const found = await app.prisma.driver.findUnique({ where: { userId: request.user.userId } });
    if (!found) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Driver');
    const driver = found!;

    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status } = ridesQuerySchema.parse(request.query);

    const where = {
      driverId: driver.id,
      orderType: 'TAXI' as const,
      ...(status && { status }),
    };

    const [rides, total] = await Promise.all([
      app.prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          taxiPickupAddress: true,
          taxiDropoffAddress: true,
          taxiDistance: true,
          taxiDuration: true,
          taxiFareTotal: true,
          taxiFareSurge: true,
          tipAmount: true,
          totalAmount: true,
          ridePin: false,
          customer: { select: { id: true, firstName: true, avatar: true } },
          placedAt: true,
          deliveredAt: true,
          createdAt: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.order.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(rides, total, { page, limit, skip }) };
  });

  // ─── Earnings ──────────────────────────────────────────────────────────

  app.get('/earnings', { preHandler: [app.authenticate] }, async (request) => {
    const found = await app.prisma.driver.findUnique({ where: { userId: request.user.userId } });
    if (!found) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Driver');
    const driver = found!;

    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { type, status } = driverEarningsQuerySchema.parse(request.query);

    const where = {
      driverId: driver.id,
      ...(type && { type }),
      ...(status && { status }),
    };

    const [earnings, total, aggregate] = await Promise.all([
      app.prisma.earning.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      app.prisma.earning.count({ where }),
      app.prisma.earning.aggregate({
        where: { driverId: driver.id },
        _sum: { amount: true },
      }),
    ]);

    return {
      success: true,
      ...paginatedResponse(earnings, total, { page, limit, skip }),
      // DASH-07: Number() — a raw Prisma Decimal serializes oddly and `|| 0`
      // can't default a Decimal(0). The rider routes already wrap every amount.
      totalEarnings: Number(aggregate._sum.amount ?? 0),
    };
  });

  /** GET /earnings/daily — per-Guyana-day totals for the Home trend chart
   *  [DASH-03], server-aggregated so older days aren't truncated. */
  app.get('/earnings/daily', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await getDriver(request.user.userId);
    const days = Math.min(31, Math.max(1, Number((request.query as { days?: string }).days ?? 7)));
    return { success: true, data: await dailyEarnings(app.prisma, { driverId: driver.id }, days) };
  });

  app.get('/earnings/today', { preHandler: [app.authenticate] }, async (request) => {
    const found = await app.prisma.driver.findUnique({ where: { userId: request.user.userId } });
    if (!found) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Driver');
    const driver = found!;

    const today = startOfDayGY(); // DASH-06: Guyana-local "today", not UTC midnight

    const [earnings, aggregate, ridesCount] = await Promise.all([
      app.prisma.earning.findMany({
        where: { driverId: driver.id, createdAt: { gte: today } },
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.earning.aggregate({
        where: { driverId: driver.id, createdAt: { gte: today } },
        _sum: { amount: true },
      }),
      app.prisma.order.count({
        where: { driverId: driver.id, orderType: 'TAXI', status: 'DELIVERED', deliveredAt: { gte: today } },
      }),
    ]);

    return {
      success: true,
      data: {
        earnings,
        total: Number(aggregate._sum.amount ?? 0), // DASH-07: number, not raw Decimal
        ridesCompleted: ridesCount,
      },
    };
  });

  /** GET /demand — waiting taxi requests + supply-watchers near the driver
   *  (dashboard plan Phase A): real demand, ~300 m rounded, zero customer
   *  fields. 10s cache per ~1 km cell. */
  app.get('/demand', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await getDriver(request.user.userId);
    const q = z
      .object({ lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() })
      .parse(request.query);
    const lat = q.lat ?? Number(driver.currentLat);
    const lng = q.lng ?? Number(driver.currentLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new AppError(400, 'NO_POSITION', 'Send lat/lng or go online so Swift knows where you are.');
    }
    const cacheKey = tenantCacheKey(`demand:DRIVER:${lat.toFixed(2)}:${lng.toFixed(2)}`);
    const cached = await app.redis.get(cacheKey);
    if (cached) return { success: true, data: JSON.parse(cached) };
    const { driverDemand } = await import('../dispatch/demand.service');
    const data = await driverDemand(app.prisma, { lat, lng });
    await app.redis.set(cacheKey, JSON.stringify(data), 'EX', 10).catch(() => {});
    return { success: true, data };
  });

  /** GET /earnings/statement — print-ready HTML earnings statement (the
   *  receipt's sibling, marketplace §12). Default period 30 days. */
  app.get('/earnings/statement', { preHandler: [app.authenticate] }, async (request, reply) => {
    const found = await app.prisma.driver.findUnique({ where: { userId: request.user.userId } });
    if (!found) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Driver');
    const driver = found!;
    const { statementPeriod, buildDriverStatement, mintStatementPath } = await import('../order/statement');
    const q = request.query as { from?: string; to?: string; link?: string };
    const period = statementPeriod(q);
    // ?link=1 → a short-lived signed URL the in-app browser can open (share/print).
    if (q.link === '1') {
      return { success: true, data: mintStatementPath('driver', driver.id, period) };
    }
    reply.type('text/html; charset=utf-8');
    return buildDriverStatement(app.prisma, driver.id, request.user.userId, period);
  });

  app.get('/earnings/summary', { preHandler: [app.authenticate] }, async (request) => {
    const found = await app.prisma.driver.findUnique({ where: { userId: request.user.userId } });
    if (!found) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Driver');
    const driver = found!;

    // DASH-06/07: Guyana-local boundaries, and week starts MONDAY (matching the
    // rider) — was UTC midnight + Sunday-start, so "today"/"this week" money
    // read wrong and disagreed with the rider's week.
    const today = startOfDayGY();
    const weekStart = startOfWeekGY();
    const monthStart = startOfMonthGY();

    const [todayEarnings, weekEarnings, monthEarnings, allTimeEarnings, pendingPayout, todayRides, totalRides] =
      await Promise.all([
        app.prisma.earning.aggregate({
          where: { driverId: driver.id, createdAt: { gte: today } },
          _sum: { amount: true },
          _count: true,
        }),
        app.prisma.earning.aggregate({
          where: { driverId: driver.id, createdAt: { gte: weekStart } },
          _sum: { amount: true },
          _count: true,
        }),
        app.prisma.earning.aggregate({
          where: { driverId: driver.id, createdAt: { gte: monthStart } },
          _sum: { amount: true },
          _count: true,
        }),
        app.prisma.earning.aggregate({
          where: { driverId: driver.id },
          _sum: { amount: true },
          _count: true,
        }),
        app.prisma.earning.aggregate({
          where: { driverId: driver.id, status: 'AVAILABLE' },
          _sum: { amount: true },
        }),
        app.prisma.order.count({
          where: { driverId: driver.id, orderType: 'TAXI', status: 'DELIVERED', deliveredAt: { gte: today } },
        }),
        app.prisma.order.count({
          where: { driverId: driver.id, orderType: 'TAXI', status: 'DELIVERED' },
        }),
      ]);

    return {
      success: true,
      data: {
        // SWIFT-080: each window is { total, count } — the SAME shape the rider
        // route returns and the mover EarningsScreen/MoverAccountScreen read.
        // Was a bare Number(), so a driver's tiles silently showed $0.
        today: earningsWindow(todayEarnings),
        thisWeek: earningsWindow(weekEarnings),
        thisMonth: earningsWindow(monthEarnings),
        allTime: earningsWindow(allTimeEarnings),
        pendingPayout: Number(pendingPayout._sum.amount ?? 0),
        todayRides,
        totalRides,
        averageRating: driver.averageRating,
        acceptanceRate: driver.acceptanceRate,
        cancellationRate: driver.cancellationRate,
      },
    };
  });

  // ─── Subscription ──────────────────────────────────────────────────────

  app.get('/subscription', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await app.prisma.driver.findUnique({
      where: { userId: request.user.userId },
      include: {
        subscription: {
          include: {
            payments: { take: 10, orderBy: { createdAt: 'desc' } },
          },
        },
      },
    });
    if (!driver) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Driver');
    const sub = driver!.subscription;
    if (!sub) return { success: true, data: null };
    const { sanDisplay } = await import('../billing/san.service');
    const { payInfo } = await import('../billing/agent-cash.service');
    // "My Swift Number" + Pay-screen block [san spec 2.4/6.1].
    return { success: true, data: { ...sub, ...(await sanDisplay(app.prisma, sub)), ...(await payInfo(app.prisma, sub)) } };
  });

  /** PUT /subscription/billing-method — §13 rail selection (CASH prepaid vs
   *  MOBILE_MONEY merchant-initiated with the driver's MMG account). */
  app.put('/subscription/billing-method', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await getDriver(request.user.userId);
    const body = z.object({
      method: z.enum(['CASH', 'MOBILE_MONEY']),
      mmgPayerMsisdn: z.string().trim().min(5).max(30).optional(),
    }).parse(request.body);
    const sub = await app.prisma.subscription.findFirst({ where: { driverId: driver.id } });
    if (!sub) throw new NotFoundError('Subscription');
    const billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
    const updated = await billing.setBillingRail(sub.id, body.method, body.mmgPayerMsisdn);
    return { success: true, data: { billingMethod: updated.billingMethod, mmgPayerMsisdn: updated.mmgPayerMsisdn } };
  });
}
