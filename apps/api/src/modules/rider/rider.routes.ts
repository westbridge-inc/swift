import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RiderType, VehicleType, EarningType, EarningStatus, type OrderStatus } from '@prisma/client';
import { OrderService, notHeldFilter } from '../order/order.service';
import { earningsWindow } from '../order/earnings-window';
import { zMoneyMinor } from '../../utils/money-schema';
import { NotificationService } from '../notification/notification.service';
import { VerificationService } from '../verification/verification.service';
import { CashRulesService, customerTrustSummaries, gpsEvidence } from '../cash/cash-rules.service';
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
import { HANDOVER_SECRETS_OMIT } from '../handover/handover-security';
import { notSelfDeliveredFilter } from '../fulfillment/fulfillment-mode';
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
import {
  assertMoverRoleAuthority,
  assertActiveMoverAccount,
  lockAndRetireDriverSupply,
  lockUserRoleAuthority,
  staleMoverAuthorityError,
} from '../mover-authority';

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

const riderGoOnlineSchema = riderLocationSchema.pick({ latitude: true, longitude: true });

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
  /** [F-014-04] Optional echo of the offer card's generation; binds
   *  accept/decline/seen to exactly that attempt. Older clients omit it. */
  offerAttemptId: z.string().min(1).max(64).optional(),
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
    // [F-0011] Feeds every rider transition route. The rider VERIFIES the
    // delivery PIN at /delivered — this object must never carry it.
    omit: HANDOVER_SECRETS_OMIT,
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

/**
 * Allowed status transitions for the rider lifecycle.
 *
 * `note` IS REQUIRED, and that is the point. Every one of these transitions was
 * writing an audit row with a null note, because the generic handler below
 * called `updateStatus` without the fourth argument. Measured on the database:
 * RIDER_EN_ROUTE_PICKUP, RIDER_ARRIVED_PICKUP, PICKED_UP, EN_ROUTE_DELIVERY and
 * ARRIVED were 17/17 null each — while every vendor- and dispatch-driven status
 * carried a note on ~100% of rows. The trail was blind on exactly the moves a
 * courier makes alone, unobserved, which are exactly the moves that get
 * disputed. Typing `note` as required means a sixth transition cannot be added
 * without one.
 *
 * THE WORDING DISTINGUISHES A DEED FROM A CLAIM. "Accepted by vendor" is
 * accurate because pressing accept IS the acceptance. Pressing "I've arrived"
 * is not an arrival — it is the rider's assertion about the physical world, and
 * `arrived` still has no GPS check to test it against. So the arrival rows say
 * "reported". The enforcement ladder reads these logs when a customer and a
 * rider disagree, and a log that records a claim as a fact is worse than one
 * that records nothing.
 */
const STATUS_TRANSITIONS: Record<string, { from: string[]; to: string; note: string }> = {
  'en-route-pickup': { from: ['RIDER_ASSIGNED'], to: 'RIDER_EN_ROUTE_PICKUP', note: 'Rider started the run to pickup' },
  'arrived-pickup':  { from: ['RIDER_EN_ROUTE_PICKUP'], to: 'RIDER_ARRIVED_PICKUP', note: 'Rider reported arriving at pickup' },
  'picked-up':       { from: ['RIDER_ARRIVED_PICKUP', 'READY_FOR_PICKUP'], to: 'PICKED_UP', note: 'Rider confirmed collecting the order' },
  'en-route-delivery': { from: ['PICKED_UP'], to: 'EN_ROUTE_DELIVERY', note: 'Rider started the run to the customer' },
  'arrived':         { from: ['EN_ROUTE_DELIVERY'], to: 'ARRIVED', note: 'Rider reported arriving at the customer' },
};

/** The two rungs that assert a position. Which endpoint the claim is about
 *  decides which point the distance is measured to. */
const ARRIVAL_TARGET: Record<string, 'pickup' | 'dropoff'> = {
  'arrived-pickup': 'pickup',
  arrived: 'dropoff',
};

/** How old a fix may be and still describe where someone is standing. Beyond
 *  this the age is recorded instead of a distance — an hour-old ping turned
 *  into "12 m from the door" is a fabricated measurement, and a fabricated one
 *  is worse than none because it looks like proof. */
const ARRIVAL_FIX_MAX_AGE_MS = 3 * 60_000;

type ArrivalOrder = {
  pickupLat: number | null; pickupLng: number | null;
  deliveryLat: number | null; deliveryLng: number | null;
  vendor: { latitude: number | null; longitude: number | null } | null;
};
type ArrivalRider = { currentLat: number | null; currentLng: number | null; lastLocationUpdate: Date | null };

/**
 * What the platform knew about the rider's position when they said they had
 * arrived — as a note fragment, or null when the rung makes no such claim.
 *
 * ADVISORY ONLY. This decides nothing: no radius is enforced, no transition is
 * refused. `arrived` still has no GPS check, and choosing the radius that would
 * add one is a founder decision (§7.4b) that engineering does not make by
 * default. What this does is stop throwing the evidence away, so that decision
 * can eventually be made from a measured distribution of real arrivals rather
 * than from a number someone liked the sound of.
 *
 * Every degraded case is NAMED rather than omitted, because a note that simply
 * lacks a distance is indistinguishable from one written before this existed.
 */
function arrivalEvidence(slug: string, order: ArrivalOrder, rider: ArrivalRider, now = new Date()): string | null {
  const target = ARRIVAL_TARGET[slug];
  if (!target) return null;

  // Pickup point: the order's own coordinates, falling back to the vendor's.
  const to = target === 'pickup'
    ? { lat: order.pickupLat ?? order.vendor?.latitude ?? null, lng: order.pickupLng ?? order.vendor?.longitude ?? null }
    : { lat: order.deliveryLat, lng: order.deliveryLng };

  if (rider.currentLat == null || rider.currentLng == null || !rider.lastLocationUpdate) {
    return 'no GPS fix on file';
  }
  const ageMs = now.getTime() - rider.lastLocationUpdate.getTime();
  // ONE author of this format (kerb-anti-fork K3) — imported, never re-typed.
  const fix = gpsEvidence(rider.currentLat, rider.currentLng);
  if (ageMs > ARRIVAL_FIX_MAX_AGE_MS) {
    return `${fix} (stale, ${Math.round(ageMs / 60_000)} min old — distance not computed)`;
  }
  if (to.lat == null || to.lng == null) {
    // A courier drop with no geocoded destination: the fix is still worth
    // keeping, there is simply nothing to measure it against.
    return `${fix} (${Math.round(ageMs / 1000)}s old; ${target} not geocoded)`;
  }
  const metres = Math.round(haversineDistance(rider.currentLat, rider.currentLng, to.lat, to.lng) * 1000);
  return `${fix} (${metres} m from the ${target}, fix ${Math.round(ageMs / 1000)}s old)`;
}

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
    const { orderId, fare, offerAttemptId } = offerActionSchema.extend({ fare: zMoneyMinor.optional() }).parse(request.body);
    // Rider-set delivery fee (CASH only) rides INSIDE the locked claim
    // transaction [REPORT-005 F-005-01]: assignment, price, float, and audit
    // commit or roll back together — never a post-assignment second commit
    // that can fail after a durable assignment or apply a stale total.
    // [REPORT-010 F-07] fare 0 is NEVER a legitimate choice (the floor is 60%
    // of market): a recovered offer card whose board row hadn't loaded used
    // to submit 0 and silently clamp the mover's pay to the floor — and on
    // MMG it consumed the offer with MMG_PRICE_LOCKED. Zero means "no
    // choice"; the market rate applies.
    const chosenFare = fare && fare > 0 ? fare : undefined;
    const order = await dispatch.acceptOffer(orderId, request.user.userId, chosenFare, offerAttemptId);
    return { success: true, data: { orderId: order.id, status: order.status, orderNumber: order.orderNumber } };
  });

  /** POST /offers/decline — pass; the cascade moves to the next mover. */
  app.post('/offers/decline', { preHandler: [app.authenticate] }, async (request) => {
    await getRider(app, request.user.userId); // authz before validation
    const { orderId, offerAttemptId } = offerActionSchema.parse(request.body);
    await dispatch.declineOffer(orderId, request.user.userId, offerAttemptId);
    return { success: true, data: { message: 'Offer declined' } };
  });

  /** GET /offers/current — [E27 / danger #37] recover the live exclusive
   *  offer after a socket drop/app restart: the card rebuilds with its real
   *  remaining seconds instead of the job silently timing out against the
   *  mover's acceptance ranking. Null when no live offer is owned. */
  app.get('/offers/current', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);
    const offer = await dispatch.currentOfferFor(rider.id);
    return { success: true, data: { offer } };
  });

  /** POST /offers/seen — [danger #21] the offer card RENDERED on this device.
   *  Render proof (seenAt) keeps timeout accounting honest: an unrendered
   *  ping never decays the acceptance rate. Fire-and-forget from the client. */
  app.post('/offers/seen', { preHandler: [app.authenticate] }, async (request) => {
    await getRider(app, request.user.userId); // authz before validation
    const { orderId, offerAttemptId } = offerActionSchema.parse(request.body);
    await dispatch.markOfferSeen(orderId, request.user.userId, offerAttemptId);
    return { success: true, data: { seen: true } };
  });

  // =========================================================================
  // 1. PROFILE
  // =========================================================================

  /** GET /profile — Full rider profile with user info, subscription & stats. */
  /** Movement R9: the Standing module — daily-folded, subject = the user
   *  (rider ratings key on rateeId). Role-gated like every rider route:
   *  no rider profile = no standing (the authz matrix drills this). */
  app.get('/standing', { preHandler: [app.authenticate] }, async (request) => {
    await getRider(app, request.user.userId);
    const { actorStandingView } = await import('../rating/rating-standing');
    return { success: true, data: await actorStandingView(app.prisma, 'RIDER', request.user.userId) };
  });

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
            activeRole: true,
            lastMoverRole: true,
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
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            avatar: true,
            activeRole: true,
            lastMoverRole: true,
          },
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
    const locationSessionId = request.authSessionId;
    if (!locationSessionId) {
      throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
    }

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
    // Fast-fail preview for honest copy — the AUTHORITATIVE check re-runs
    // inside the locked transaction below [EV-ACT-16 TOCTOU].
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
    const location = riderGoOnlineSchema.parse(request.body ?? {});

    // Serialize GO against role switching, then CAS the profile generation
    // captured before verification/subscription checks. A concurrent accept,
    // offline, safety action, or switch invalidates this request instead of
    // allowing stale work to resurrect delivery supply.
    const { updated, retiredDriverId } = await app.prisma.$transaction(async (tx) => {
      const authority = await lockUserRoleAuthority(tx, request.user.userId);
      assertActiveMoverAccount(authority.status);
      assertMoverRoleAuthority(authority.activeRole, 'RIDER');

      // Authentication can be revoked after the Fastify pre-handler but while
      // verification checks are still running. Lock/revalidate this exact
      // session in the same transaction as GO so a logged-out request cannot
      // recreate a dangling location owner.
      const sessions = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "sessions"
        WHERE "id" = ${locationSessionId}
          AND "userId" = ${request.user.userId}
          AND "expiresAt" > NOW()
        FOR SHARE
      `;
      if (!sessions[0]) {
        throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
      }

      const snapshots = await tx.$queryRaw<Array<{ currentOrderId: string | null; documentsVerified: boolean; updatedAt: Date }>>`
        SELECT "currentOrderId", "documentsVerified", "updatedAt"
        FROM "riders"
        WHERE "id" = ${rider.id}
        FOR UPDATE
      `;
      const snapshot = snapshots[0];
      if (!snapshot || snapshot.updatedAt.getTime() !== rider.updatedAt.getTime()) {
        throw staleMoverAuthorityError();
      }
      // [EV-ACT-16 TOCTOU] The document verdict is re-derived UNDER the same
      // User lock document decisions take: an expiry, rejection, or admin
      // revocation committing after the preview above can no longer slip a
      // stale "verified" through to the online write. The legacy flag comes
      // from the LOCKED profile snapshot, not the preview.
      const liveVerified = snapshot.documentsVerified
        || await verification.isRoleVerified(request.user.userId, 'MOVER', tx);
      if (!liveVerified) {
        throw new AppError(403, 'VERIFICATION_REQUIRED', 'Your documents must be verified before you can go online');
      }
      const retiredDriverId = await lockAndRetireDriverSupply(tx, request.user.userId);

      const activated = await tx.rider.update({
        where: { id: rider.id },
        data: {
          isOnline: true,
          isAvailable: !snapshot.currentOrderId,
          currentLat: location.latitude,
          currentLng: location.longitude,
          lastLocationUpdate: new Date(),
          locationSessionId,
        },
      });
      await tx.user.update({
        where: { id: request.user.userId },
        data: { lastMoverRole: 'RIDER' },
      });
      return { updated: activated, retiredDriverId };
    });

    // These Redis keys are observability/debounce aids, not online authority.
    // Never report GO as failed after PostgreSQL has already committed it.
    await app.redis
      .set(`rider:location_db_ts:${rider.id}`, Date.now().toString())
      .catch((error) => request.log.warn({ err: error, riderId: rider.id }, 'rider go-online Redis bookkeeping failed'));

    // Track online session start in Redis for hours tracking.
    await startOnlineSession(app.redis, rider.id)
      .catch((error) => request.log.warn({ err: error, riderId: rider.id }, 'rider online-hours start failed'));

    if (retiredDriverId) {
      await dispatch
        .releaseHeldOffer(retiredDriverId)
        .catch((error) => request.log.warn({ err: error, driverId: retiredDriverId }, 'rider GO sibling driver offer cleanup failed'));
    }

    return { success: true, data: { isOnline: updated.isOnline, isAvailable: updated.isAvailable } };
  });

  /** POST /go-offline — Mark rider as offline. */
  app.post('/go-offline', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);

    if (rider.currentOrderId) {
      throw new ConflictError('You cannot go offline while you have an active delivery. Complete or cancel the current order first.');
    }

    // Database authority goes first. A concurrent offer accept and this CAS
    // cannot both win; if a delivery pointer appears, the 409 keeps native GPS
    // alive for the newly assigned job.
    const updated = await app.prisma.$transaction(async (tx) => {
      const stopped = await tx.rider.updateMany({
        where: { id: rider.id, currentOrderId: null },
        data: { isOnline: false, isAvailable: false, locationSessionId: null },
      });
      if (stopped.count !== 1) {
        throw new ConflictError('You cannot go offline while you have an active delivery. Complete or cancel the current order first.');
      }
      return tx.rider.findUniqueOrThrow({ where: { id: rider.id } });
    });

    await dispatch
      .releaseHeldOffer(rider.id)
      .catch((error) => request.log.warn({ err: error, riderId: rider.id }, 'rider go-offline offer cleanup failed'));

    // Accumulate today's online hours in Redis (SWIFT-143: same helper the
    // force-offline paths use, so a session closes the same way however it ends).
    await closeOnlineSession(app.redis, rider.id)
      .catch((error) => request.log.warn({ err: error, riderId: rider.id }, 'rider online-hours close failed'));

    return { success: true, data: { isOnline: updated.isOnline, isAvailable: updated.isAvailable } };
  });

  // =========================================================================
  // 3. LOCATION
  // =========================================================================

  /** PUT /location — Update lat/lng, persist to DB + Redis, broadcast to active order. */
  app.put('/location', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId); // authz before validation
    const locationSessionId = request.authSessionId;
    if (!locationSessionId) {
      throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
    }
    const { latitude, longitude, heading, speed } = riderLocationSchema.parse(request.body);
    const now = new Date();

    if (!rider.isOnline && !rider.currentOrderId) {
      return { success: true, data: { accepted: false, reason: 'OFFLINE' } };
    }

    // Migration compatibility is first-writer-wins for a legacy null owner;
    // thereafter only the authenticated session that won GO may publish.
    if (!rider.locationSessionId) {
      await app.prisma.$transaction(async (tx) => {
        // Serialize the legacy claim with exact-session revocation. If logout
        // wins, this request cannot install the now-deleted session ID; if the
        // claim wins, logout waits and clears it immediately afterward.
        const users = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "users"
          WHERE "id" = ${request.user.userId}
          FOR SHARE
        `;
        if (!users[0]) return;
        const sessions = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "sessions"
          WHERE "id" = ${locationSessionId}
            AND "userId" = ${request.user.userId}
            AND "expiresAt" > NOW()
          FOR SHARE
        `;
        if (!sessions[0]) return;
        await tx.rider.updateMany({
          where: {
            id: rider.id,
            locationSessionId: null,
            OR: [{ isOnline: true }, { currentOrderId: { not: null } }],
          },
          data: { locationSessionId },
        });
      });
    }
    const authorized = await app.prisma.rider.findFirst({
      where: {
        id: rider.id,
        locationSessionId,
        OR: [{ isOnline: true }, { currentOrderId: { not: null } }],
      },
    });
    if (!authorized) {
      const owner = await app.prisma.rider.findUnique({
        where: { id: rider.id },
        select: { locationSessionId: true, isOnline: true, currentOrderId: true },
      });
      const reason = owner?.isOnline || owner?.currentOrderId ? 'SESSION_REPLACED' : 'OFFLINE';
      return { success: true, data: { accepted: false, reason } };
    }

    // DB update (batched — not every ping needs to hit PG immediately).
    // We update the DB if 10+ seconds have passed since last DB write.
    const lastDbWrite = await app.redis
      .get(`rider:location_db_ts:${rider.id}`)
      .catch((error) => {
        request.log.warn({ err: error, riderId: rider.id }, 'rider location Redis debounce read failed');
        return null;
      });
    const shouldWriteDb = !lastDbWrite || Date.now() - parseInt(lastDbWrite, 10) > 10_000;

    if (shouldWriteDb) {
      const persisted = await app.prisma.rider.updateMany({
        where: {
          id: rider.id,
          locationSessionId,
          OR: [{ isOnline: true }, { currentOrderId: { not: null } }],
        },
        data: { currentLat: latitude, currentLng: longitude, lastLocationUpdate: now },
      });
      if (persisted.count === 0) {
        const owner = await app.prisma.rider.findUnique({
          where: { id: rider.id },
          select: { locationSessionId: true, isOnline: true, currentOrderId: true },
        });
        const reason = owner?.isOnline || owner?.currentOrderId ? 'SESSION_REPLACED' : 'OFFLINE';
        return { success: true, data: { accepted: false, reason } };
      }
      await app.redis
        .set(`rider:location_db_ts:${rider.id}`, Date.now().toString())
        .catch((error) => request.log.warn({ err: error, riderId: rider.id }, 'rider location Redis debounce write failed'));
    }

    // SWIFT-141: the `rider:location:<id>` Redis write was a "fast path for
    // real-time queries" with ZERO readers — every ping serialized + wrote a
    // payload nothing consumed. Deleted (rule 17). The live path is the socket
    // emit below; the persistent path is the throttled DB write above
    // (currentLat/Lng, read by dispatch/presence). There is no third copy.

    // Broadcast to order room if rider has an active order.
    if (authorized.currentOrderId) {
      // Live-leg ETA [SWIFT-UG-RT-01]: recomputed on the same ≥10 s throttle
      // as the DB write, served from cache on the pings in between — the
      // tracking screen gets a moving ETA without a maps call per ping.
      const etaMinutes = shouldWriteDb
        ? await refreshLegEta(app, authorized.currentOrderId, { lat: latitude, lng: longitude })
        : await cachedLegEta(app, authorized.currentOrderId);

      // Authorization above and the live emit cannot be one unguarded read /
      // publish pair: another device may win GO while ETA is being computed.
      // Take a shared lock only for this final synchronous publication
      // checkpoint (never for maps/cache work). Concurrent pings can still
      // publish together, while GO/offline updates wait. GO therefore
      // linearizes either before this check and suppresses the stale sample,
      // or after the emit has already completed.
      const publication = await app.prisma.$transaction(async (tx) => {
        // User -> Session -> profile matches the authority writers' outer lock
        // order. The shared mode keeps concurrent authorized pings concurrent
        // while preventing logout/ban/role-switch deadlocks and stale emits.
        const users = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "users"
          WHERE "id" = ${request.user.userId}
          FOR SHARE
        `;
        const sessions = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "sessions"
          WHERE "id" = ${locationSessionId}
            AND "userId" = ${request.user.userId}
            AND "expiresAt" > NOW()
          FOR SHARE
        `;
        const rows = await tx.$queryRaw<Array<{
          locationSessionId: string | null;
          isOnline: boolean;
          currentOrderId: string | null;
        }>>`
          SELECT "locationSessionId", "isOnline", "currentOrderId"
          FROM "riders"
          WHERE "id" = ${rider.id}
          FOR SHARE
        `;
        const current = rows[0];
        if (
          !users[0]
          || !sessions[0]
          || !current
          || current.locationSessionId !== locationSessionId
          || (!current.isOnline && !current.currentOrderId)
        ) {
          return {
            accepted: false as const,
            reason: current?.isOnline || current?.currentOrderId ? 'SESSION_REPLACED' as const : 'OFFLINE' as const,
          };
        }

        // If completion/reassignment changed the pointer while ETA was in
        // flight, skip this one old-leg sample; the next ping targets the new
        // job. The session itself remains authoritative.
        if (current.currentOrderId === authorized.currentOrderId) {
          app.io.to(`order:${authorized.currentOrderId}`).emit('rider:location', {
            riderId: rider.id,
            lat: latitude,
            lng: longitude,
            heading: heading ?? null,
            speed: speed ?? null,
            etaMinutes,
            ts: now.toISOString(),
          });
        }
        return { accepted: true as const };
      });
      if (!publication.accepted) {
        return { success: true, data: publication };
      }
    }

    return { success: true };
  });

  // =========================================================================
  // 4. AVAILABLE ORDERS
  // =========================================================================

  /** GET /orders/available — Nearby orders needing a rider, sorted by distance. */
  app.get('/orders/available', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await getRider(app, request.user.userId);

    if (!rider.isOnline || !rider.locationSessionId) {
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
        customerId: { not: request.user.userId },
        status: { in: ['READY_FOR_PICKUP', 'ACCEPTED', 'PREPARING'] },
        riderId: null,
        orderType: { in: orderTypes as import('@prisma/client').OrderType[] },
        // [REPORT-006 F-006-03] Rider work is DELIVERY only: a PICKUP or
        // APPOINTMENT order (including one the customer just converted) must
        // never appear on the board — the claim CAS refuses it anyway, but
        // advertising it sends riders to collect work that doesn't exist.
        fulfillment: 'DELIVERY',
        // LIFECYCLE_V2: a held courier job isn't offerable yet.
        ...notHeldFilter(),
        // [F-0026] A self-delivering vendor fulfils this one itself — it is not
        // open work, and advertising it sends riders to collect food that is
        // already out for delivery. In AND because notHeldFilter already spread
        // an OR key above.
        AND: [notSelfDeliveredFilter()],
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
        // WHERE THE PICKUP ACTUALLY IS.
        //
        // A food order is collected from its VENDOR. A parcel has no vendor at
        // all — it is collected from an address the sender typed, which the
        // courier route already stores on the order as pickupLat/pickupLng.
        //
        // This used to read the vendor only, with `?? 0` as the fallback. For
        // every parcel that made the pickup point (0, 0) — null island, in the
        // Atlantic — which is 6,494 km from Georgetown. The radius filter below
        // then removed it from EVERY rider's board, on every request, forever.
        //
        // Parcels were reaching riders solely through the single push offer that
        // dispatch sends. Miss it, decline it, or have the app closed, and the
        // job became invisible to everyone: the sender waits, the board is
        // empty, and nothing about the system says why.
        const pickupLat = order.pickupLat != null ? Number(order.pickupLat) : Number(order.vendor?.latitude ?? NaN);
        const pickupLng = order.pickupLng != null ? Number(order.pickupLng) : Number(order.vendor?.longitude ?? NaN);
        const hasPickup = Number.isFinite(pickupLat) && Number.isFinite(pickupLng);

        // No usable pickup point is NOT a job 6,494 km away — it is a job whose
        // distance we do not know. Infinity keeps it off the radius-filtered
        // board without pretending we measured something.
        const pickupDistance = hasPickup ? haversineDistance(riderLat, riderLng, pickupLat, pickupLng) : Infinity;
        const deliveryDistance = hasPickup
          ? haversineDistance(pickupLat, pickupLng, Number(order.deliveryLat), Number(order.deliveryLng))
          : Infinity;
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
      // [F-0011] The response spreads this row wholesale — omit at the source.
      omit: HANDOVER_SECRETS_OMIT,
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
        // [F-0011] The delivery PIN is deliberately NOT returned: this rider is
        // the party who verifies it at PUT /orders/:id/delivered. They must ask
        // the customer for it.
      },
    };
  });

  // =========================================================================
  // 6. ORDER LIFECYCLE
  // =========================================================================

  /** POST /orders/:id/accept — Claim an available order. */
  app.post('/orders/:id/accept', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    // [REPORT-011 F-04] fare 0 is never a legitimate undercut choice (the floor
    // is 60% of market). A forged/legacy client posting 0 must NOT clamp the
    // rider's own pay to the floor — normalize zero to "no choice" so the
    // market fee applies, at THIS entrance too, not just the offer card.
    const { fare: rawFare } = z.object({ fare: zMoneyMinor.optional() }).parse(request.body ?? {});
    const fare = rawFare && rawFare > 0 ? rawFare : undefined;
    const rider = await getRider(app, request.user.userId);

    // Must be online.
    if (!rider.isOnline || !rider.locationSessionId) {
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

    if (order.customerId === request.user.userId) {
      throw new AppError(409, 'SELF_OWN_ORDER', 'You cannot accept a delivery or courier request created by your own account');
    }

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
    // [REPORT-014 F-014-08] Service authorization, mirroring the candidate SQL
    // filter: a COURIER job needs a courier-serving rider, a food/grocery
    // DELIVERY a delivery rider. A forged/legacy board grab by the wrong
    // service type is refused here (the cascade filter is the offer barrier).
    const needsCourier = order.orderType === 'COURIER';
    const servesCourier = rider.riderType === 'COURIER' || rider.riderType === 'BOTH';
    const servesDelivery = rider.riderType === 'DELIVERY' || rider.riderType === 'BOTH';
    if ((needsCourier && !servesCourier) || (!needsCourier && !servesDelivery)) {
      throw new AppError(400, 'WRONG_SERVICE_TYPE',
        `This ${needsCourier ? 'courier parcel' : 'delivery'} needs a ${needsCourier ? 'courier' : 'delivery'} rider — your account isn't set up for it.`);
    }

    // Rider-set delivery fee, capped at the market rate (deliveryFee) — CASH
    // only [REPORT-005 F-005-01]: on CASH the customer simply pays less at the
    // door; on MMG the checkout total was already paid/instructed to the store,
    // so repricing would rewrite captured money. Early honest 409 here; the
    // persistence seam re-derives the clamp from the LOCKED row either way.
    if (fare != null && order.paymentMethod !== 'CASH'
      && clampDriverFare(fare, Number(order.deliveryFee)) !== Number(order.deliveryFee)) {
      throw new AppError(
        409,
        'MMG_PRICE_LOCKED',
        'The delivery price can’t change on an MMG order — the customer already paid the checkout total to the store.',
      );
    }

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

    // Float, order ownership + RIDER_ASSIGNED status, the one-live-job Rider
    // pointer, and the append-only audit row share one commit boundary. A crash
    // can no longer leave a READY/PREPARING order owned by a permanently-busy
    // rider. Socket/push publication happens only after this transaction lands.
    const updatedOrder = await app.prisma.$transaction(async (tx) => {
      const authority = await lockUserRoleAuthority(tx, request.user.userId);
      assertActiveMoverAccount(authority.status);
      assertMoverRoleAuthority(authority.activeRole, 'RIDER');

      // [REPORT-006 F-006-03] Lock order is User → orders → riders,
      // matching dispatch.claimOrder AND the cancellation paths (orders →
      // riders): the seam takes the orders row lock first, so the float
      // commit below touches the riders row only after the orders lock is
      // held — the old float-first shape inverted against cancellation's
      // orders→riders order and could deadlock. Atomicity is unchanged: a
      // failed float commit still rolls back the whole claim.
      const staged = await orderService.stageDirectRiderAssignment(tx, {
        orderId: id,
        riderId: rider.id,
        changedBy: request.user.userId,
        moverUserId: request.user.userId,
        note: 'Rider accepted the order',
        // The seam clamps against the LOCKED row and applies the total as an
        // atomic delta — no stale absolute totals from this preview [F-005-01].
        ...(fare != null ? { requestedFee: fare } : {}),
      });

      // Float, order, and mover reservation share this transaction. Any failed
      // authority/order/profile predicate rolls the float back automatically;
      // there is no compensating-write window to leak cash headroom. The
      // amount comes from the LOCKED-row snapshot, not the route preview — a
      // picking refund committing between preview and lock shrinks the cash
      // the rider actually fronts [REPORT-006].
      const lockedFloatAmt = staged.paymentMethod === 'CASH' ? Number(staged.subtotalBase) : 0;
      if (lockedFloatAmt > 0) {
        const floatReserved = await floatService.commit(tx, rider.id, lockedFloatAmt);
        if (!floatReserved) {
          throw new AppError(
            400,
            'FLOAT_EXCEEDED',
            `This cash order needs $${lockedFloatAmt.toLocaleString()} float headroom (you front the vendor at pickup); your other live orders have used it up.`,
          );
        }
      }

      return staged;
    });

    // [REPORT-014 F-014-09] Board grab stages its own assignment, so retire the
    // Redis offer pair + finalize the search journal here (claimOrder does this
    // for the offer/direct entrances). Without it a live offer's timeout could
    // later penalize a mover for this already-assigned job, and the SEARCHING
    // journal never closes. Fire-and-caught — the assignment already committed.
    await dispatch.retireAfterAssignment(id, rider.id);
    await orderService.publishCommittedRiderAssignment(updatedOrder, request.user.userId);

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
  for (const [slug, { from, to, note }] of Object.entries(STATUS_TRANSITIONS)) {
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

      // EVIDENCE, NOT A GATE [L3 advisory · L4 shadow-first].
      //
      // `arrived` and `arrived-pickup` are the two rungs where the rider makes
      // a claim about the physical world that pressing a button does not make
      // true — which is why their notes say "reported". Nothing here tests the
      // claim: no radius is enforced, no transition is refused, and the founder
      // has not set one. What it does is WRITE DOWN what the platform already
      // knew at that moment, so the radius can eventually be chosen from a
      // measured distribution instead of guessed.
      //
      // The fix is the one already on the rider row — the same persisted fix
      // dispatch reads — so no client sends anything and no rider is stranded
      // by a phone that cannot get a lock. The handover route may DEMAND GPS
      // in its body because a guarantee claim is impossible without it; an
      // arrival must not be blocked the same way.
      //
      // Degraded data stays degraded [L6]: a missing or stale fix is recorded
      // as exactly that. A distance computed from an hour-old ping would be a
      // fabricated measurement of where someone was standing.
      const evidence = arrivalEvidence(slug, order, rider);

      const updated = await orderService.updateStatus(
        id,
        to,
        request.user.userId,
        evidence ? `${note} — ${evidence}` : note,
      );

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

      // Verify the delivery PIN if one was set on the order.
      // [F-0011] Read the secret ONLY here, where it is compared — the rider is
      // its VERIFIER, so no rider-facing payload may carry it (see getOwnedOrder).
      const secret = await app.prisma.order.findUnique({ where: { id }, select: { ridePin: true } });
      if (secret?.ridePin && secret.ridePin !== ridePin) {
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
    const { payInfo } = await import('../billing/agent-cash.service');
    return {
      success: true,
      data: {
        ...sub,
        // "My Swift Number" + Pay-screen block [san spec 2.4/6.1] — SAN,
        // wallet balance, amount due, channel-honest activation copy.
        ...(await sanDisplay(app.prisma, sub)),
        ...(await payInfo(app.prisma, sub)),
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
