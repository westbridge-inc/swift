import type { FastifyInstance } from 'fastify';
import { assessFix, pushTrace, traceKey, recordGpsFlag, flagSentence } from '../dispatch/gps-plausibility';
import { algoValue } from '../algo/algo-config';
import { explainEarning } from '../../utils/explain-earning';
import { z } from 'zod';
import { OrderStatus, EarningType, EarningStatus, RideClass } from '@prisma/client';
import { OrderService } from '../order/order.service';
import { earningsWindow } from '../order/earnings-window';
import { zMoneyWhole } from '../../utils/money-schema';
import { NotificationService } from '../notification/notification.service';
import { VerificationService } from '../verification/verification.service';
import { makeDispatchService } from '../dispatch/dispatch.service';
import { TAXI_DEMAND_WINDOW_MIN } from '../dispatch/demand.service';
import { classesAtOrAbove, classesAtOrBelow } from '../rides/fare.service';
import { freshRidePinReset } from '../rides/ride-pin';
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
import { handoverAttemptState, HANDOVER_SECRETS_OMIT } from '../handover/handover-security';
import { CashRulesService } from '../cash/cash-rules.service';
import { withIdempotency } from '../../utils/idempotency';
import { throwForMissingProfile } from '../../utils/role-gate';
import { ALLOWED_IMAGE_TYPES, looksLikeImage } from '../../utils/images';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { refreshLegEta, cachedLegEta } from '../dispatch/live-eta';
import { startOfDayGY, startOfWeekGY, startOfMonthGY } from '../../utils/time-gy';
import { dailyEarnings } from '../order/daily-earnings';
import {
  assertMoverRoleAuthority,
  assertActiveMoverAccount,
  lockAndRetireRiderSupply,
  lockUserRoleAuthority,
  staleMoverAuthorityError,
} from '../mover-authority';
import { closeOnlineSession } from '../rider/online-hours';
import {
  hasTaxiPassengerCustody,
  lockTaxiOrderForCustodyDecision,
} from '../rides/passenger-custody';
import { mmgPayUrlForWrite, safeMmgPayUrl } from '../../utils/mmg-pay-url';
import { requireStepUp } from '../auth/step-up';
import { stageMmgLinkChange, cancelMmgLinkChange, clearMmgLink } from '../integrity/money-surface';
import { arrivalEvidence } from '../dispatch/arrival-evidence';

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
  // [ALG-15] Reported honestly by the device when it can; older clients omit both.
  accuracy: z.number().min(0).max(100_000).optional(),
  mocked: z.boolean().optional(),
});

const driverGoOnlineSchema = driverLocationSchema.pick({ latitude: true, longitude: true });

const verifyPinSchema = z.object({
  // [REPORT-021 F-021-01] Every handover PIN is exactly 6 digits — a
  // malformed submission is rejected at the SHAPE, before the custody
  // decision, so it can never burn one of the five verification attempts.
  pin: z.string().regex(/^\d{6}$/, 'The pickup code is 6 digits'),
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
  // [M-29] The cash rail — the same one the rider's handover at the door uses.
  const cashRules = new CashRulesService(app.prisma, notifications, orderService);
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
      // [F-0011] The driver VERIFIES the ride PIN — never let them read it.
      omit: HANDOVER_SECRETS_OMIT,
      include: { customer: { select: { id: true, firstName: true, lastName: true, phone: true, avatar: true } } },
    });
    if (!order) throw new NotFoundError('Ride', orderId);
    return order;
  }

  // ─── Profile ───────────────────────────────────────────────────────────

  /** Movement R9: the Standing module — daily-folded, subject = the user
   *  (driver ratings key on rateeId). Role-gated like every driver route. */
  app.get('/standing', { preHandler: [app.authenticate] }, async (request) => {
    await getDriver(request.user.userId);
    const { actorStandingView } = await import('../rating/rating-standing');
    return { success: true, data: await actorStandingView(app.prisma, 'DRIVER', request.user.userId) };
  });

  app.get('/profile', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await app.prisma.driver.findUnique({
      where: { userId: request.user.userId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            avatar: true,
            activeRole: true,
            lastMoverRole: true,
          },
        },
        subscription: true,
      },
    });
    if (!driver) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Driver');
    return {
      success: true,
      data: driver ? { ...driver, mmgPayUrl: safeMmgPayUrl(driver.mmgPayUrl), mmgPayUrlPending: safeMmgPayUrl(driver.mmgPayUrlPending) } : driver,
    };
  });

  app.put('/profile', { preHandler: [app.authenticate] }, async (request) => {
    const me = await getDriver(request.user.userId); // authz before validation
    const body = updateDriverProfileSchema.parse(request.body);
    const mmgPayUrl = body.mmgPayUrl === undefined
      ? undefined
      : mmgPayUrlForWrite(body.mmgPayUrl);
    // [ALG-34 / ALG-INV-14] The MMG pay link is where the driver's money goes:
    // step-up first; a new link is STAGED behind a cool-off with the old one
    // still live and the driver told. Clearing it is immediate.
    if (mmgPayUrl !== undefined) await requireStepUp(app, request);

    const driver = await app.prisma.driver.update({
      where: { userId: request.user.userId },
      data: {
        ...(body.vehicleMake !== undefined && { vehicleMake: body.vehicleMake }),
        ...(body.vehicleModel !== undefined && { vehicleModel: body.vehicleModel }),
        ...(body.vehicleYear !== undefined && { vehicleYear: body.vehicleYear }),
        ...(body.vehicleColor !== undefined && { vehicleColor: body.vehicleColor }),
        ...(body.licensePlate !== undefined && { licensePlate: body.licensePlate }),
        // [REPORT-014 F-014-01] rideClass and vehicleCapacity are TAXONOMY
        // authority (derived from the verified vehicle type at provisioning/
        // admin verification), never self-serve: an online driver could
        // otherwise tag a 4-seat car GROUP and receive 14-passenger work.
        // The fields remain accepted-and-ignored so legacy clients don't 400.
        ...(body.profilePhotoUrl !== undefined && { profilePhotoUrl: body.profilePhotoUrl }),
        ...(body.nationalIdUrl !== undefined && { nationalIdUrl: body.nationalIdUrl }),
        ...(body.driverLicenseUrl !== undefined && { driverLicenseUrl: body.driverLicenseUrl }),
        ...(body.vehicleInsuranceUrl !== undefined && { vehicleInsuranceUrl: body.vehicleInsuranceUrl }),
        ...(body.vehicleInspectionUrl !== undefined && { vehicleInspectionUrl: body.vehicleInspectionUrl }),
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            avatar: true,
            activeRole: true,
            lastMoverRole: true,
          },
        },
      },
    });
    if (mmgPayUrl === null) {
      await clearMmgLink({ prisma: app.prisma, io: app.io }, { actor: 'DRIVER', entityId: me.id });
    } else if (mmgPayUrl !== undefined) {
      await stageMmgLinkChange({ prisma: app.prisma, io: app.io }, {
        actor: 'DRIVER', entityId: me.id, userId: request.user.userId, sessionId: request.authSessionId, newUrl: mmgPayUrl,
      });
    }
    const link = mmgPayUrl === undefined
      ? { mmgPayUrl: driver.mmgPayUrl, mmgPayUrlPending: driver.mmgPayUrlPending, mmgPayUrlApplyAt: driver.mmgPayUrlApplyAt }
      : await app.prisma.driver.findUniqueOrThrow({ where: { id: me.id }, select: { mmgPayUrl: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true } });
    return {
      success: true,
      data: { ...driver, ...link, mmgPayUrl: safeMmgPayUrl(link.mmgPayUrl), mmgPayUrlPending: safeMmgPayUrl(link.mmgPayUrlPending) },
    };
  });

  /** DELETE /profile/mmg-pay-url/pending — "this wasn't me": drop a staged
   *  link change and sign out every other device. No step-up — cancelling
   *  is always the safe direction. */
  app.delete('/profile/mmg-pay-url/pending', { preHandler: [app.authenticate] }, async (request) => {
    const me = await getDriver(request.user.userId);
    const data = await cancelMmgLinkChange({ prisma: app.prisma, io: app.io }, {
      actor: 'DRIVER', entityId: me.id, userId: request.user.userId, keepSessionId: request.authSessionId,
    });
    return { success: true, data };
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
    const locationSessionId = request.authSessionId;
    if (!locationSessionId) {
      throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
    }

    // Universal signup selfie (master plan §3): riders see the driver's photo
    // on acceptance, so a live profile photo is required before going online.
    if (!driver.user.selfieCapturedAt) {
      throw new AppError(403, 'SELFIE_REQUIRED', 'Add your profile photo before going online — riders see it when you accept.');
    }

    // Live-operation gate (spec §3.4): the taxi checklist must be approved AND a
    // current, hire-class motor insurance confirmed before carrying passengers.
    // The legacy documentsVerified flag only grandfathers the base documents.
    // [STRAND-3 / EV-ACT-17] The checklist is the PERSISTED vehicle class's,
    // not a hard-coded CAR: a BUS must present its commercial documents
    // (road_service_licence) at GO, exactly as status/expiry evaluate it.
    const live = await verification.getLiveOperationStatus(request.user.userId, {
      vehicleType: driver.vehicleType,
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
    const location = driverGoOnlineSchema.parse(request.body ?? {});

    // Serialize GO against role switching and compare the profile generation
    // captured before the slower verification gates. If an accept/offline/
    // switch wins meanwhile, this request must not resurrect stale supply.
    const { updated, retiredRiderId } = await app.prisma.$transaction(async (tx) => {
      const authority = await lockUserRoleAuthority(tx, request.user.userId);
      assertActiveMoverAccount(authority.status);
      assertMoverRoleAuthority(authority.activeRole, 'DRIVER');

      // Revalidate the exact authenticated session under the User lock. A
      // logout/reuse-revocation that completed during the slower gates must
      // prevent this stale request from becoming the new GPS owner.
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
      const retiredRiderId = await lockAndRetireRiderSupply(tx, request.user.userId);

      // Lock and re-read the profile after the User lock. This makes the active
      // pointer/availability decision atomic even if a claimant does not rely on
      // Prisma's @updatedAt behavior.
      const snapshots = await tx.$queryRaw<Array<{ currentRideId: string | null; documentsVerified: boolean; updatedAt: Date }>>`
        SELECT "currentRideId", "documentsVerified", "updatedAt"
        FROM "drivers"
        WHERE "id" = ${driver.id}
        FOR UPDATE
      `;
      const snapshot = snapshots[0];
      if (!snapshot || snapshot.updatedAt.getTime() !== driver.updatedAt.getTime()) {
        throw staleMoverAuthorityError();
      }

      // [EV-ACT-17 TOCTOU] Re-derive the live-operation verdict UNDER the same
      // User lock document decisions take — an expiry/rejection committing
      // after the route's preview can no longer write stale supply online.
      // Persisted vehicle class; legacy flag from the LOCKED snapshot.
      const liveGate = await verification.getLiveOperationStatus(request.user.userId, {
        vehicleType: driver.vehicleType,
        legacyVerified: snapshot.documentsVerified,
      }, tx);
      if (!liveGate.allowed) {
        throw liveGate.reason === 'insurance'
          ? new AppError(403, 'INSURANCE_HIRE_CLASS_REQUIRED', 'A current hire-class motor insurance must be verified before you can carry passengers')
          : new AppError(403, 'VERIFICATION_REQUIRED', 'Your documents must be verified before going online');
      }

      const activated = await tx.driver.update({
        where: { id: driver.id },
        data: {
          isOnline: true,
          isAvailable: !snapshot.currentRideId,
          currentLat: location.latitude,
          currentLng: location.longitude,
          lastLocationUpdate: new Date(),
          locationSessionId,
        },
      });
      await tx.user.update({
        where: { id: request.user.userId },
        data: { lastMoverRole: 'DRIVER' },
      });
      return { updated: activated, retiredRiderId };
    });

    // PostgreSQL is authoritative. Redis only debounces later GPS writes; a
    // cache outage must not turn a committed GO into a client-visible failure
    // that prevents the phone from starting its location stream.
    await app.redis
      .set(`driver:location_db_ts:${driver.id}`, Date.now().toString())
      .catch((error) => request.log.warn({ err: error, driverId: driver.id }, 'driver go-online Redis bookkeeping failed'));

    if (retiredRiderId) {
      await dispatch
        .releaseHeldOffer(retiredRiderId)
        .catch((error) => request.log.warn({ err: error, riderId: retiredRiderId }, 'driver GO sibling rider offer cleanup failed'));
      await closeOnlineSession(app.redis, retiredRiderId)
        .catch((error) => request.log.warn({ err: error, riderId: retiredRiderId }, 'driver GO sibling online-hours close failed'));
    }

    return { success: true, data: updated };
  });

  app.post('/go-offline', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await getDriver(request.user.userId);

    if (driver.currentRideId) {
      throw new AppError(400, 'ACTIVE_RIDE', 'You cannot go offline while you have an active ride');
    }

    // Database authority goes first. A concurrent accept and this CAS cannot
    // both win: if the ride pointer appears, GO OFFLINE conflicts and the phone
    // keeps tracking the newly assigned job.
    const updated = await app.prisma.$transaction(async (tx) => {
      const stopped = await tx.driver.updateMany({
        where: { id: driver.id, currentRideId: null },
        data: { isOnline: false, isAvailable: false, locationSessionId: null },
      });
      if (stopped.count !== 1) {
        throw new AppError(400, 'ACTIVE_RIDE', 'You cannot go offline while you have an active ride');
      }
      return tx.driver.findUniqueOrThrow({ where: { id: driver.id } });
    });

    // Once DB authority is offline, an offer can no longer be accepted because
    // claimOrder CASes isAvailable=true. Redis cleanup is immediate when healthy
    // and safely degrades to the short offer TTL during an outage.
    await dispatch
      .releaseHeldOffer(driver.id)
      .catch((error) => request.log.warn({ err: error, driverId: driver.id }, 'driver go-offline offer cleanup failed'));

    return { success: true, data: updated };
  });

  // ─── Location ──────────────────────────────────────────────────────────

  app.put('/location', { preHandler: [app.authenticate] }, async (request) => {
    const found = await app.prisma.driver.findUnique({ where: { userId: request.user.userId } });
    if (!found) await throwForMissingProfile(app, request.user.userId, 'MOVER', 'Driver');
    const driver = found!;
    const locationSessionId = request.authSessionId;
    if (!locationSessionId) {
      throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
    }

    const { latitude, longitude, heading, accuracy, mocked } = driverLocationSchema.parse(request.body);

    // A queued native callback after GO OFFLINE is a normal race. Treat it as
    // an accepted no-op so clients do not retry; active rides remain authorized
    // even if safety/recovery has force-offlined their driver.
    if (!driver.isOnline && !driver.currentRideId) {
      return { success: true, data: { accepted: false, reason: 'OFFLINE' } };
    }

    // Existing online rows from the additive migration have no owner. Exactly
    // one authenticated device may claim that null generation; every explicit
    // GO above rotates ownership to the device that performed it.
    if (!driver.locationSessionId) {
      await app.prisma.$transaction(async (tx) => {
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
        await tx.driver.updateMany({
          where: {
            id: driver.id,
            locationSessionId: null,
            OR: [{ isOnline: true }, { currentRideId: { not: null } }],
          },
          data: { locationSessionId },
        });
      });
    }
    const authorized = await app.prisma.driver.findFirst({
      where: {
        id: driver.id,
        locationSessionId,
        OR: [{ isOnline: true }, { currentRideId: { not: null } }],
      },
    });
    // [ALG-15] Physics before persistence — a flag, never a refusal. Off switch: 'ALG-15.enabled'.
    if (authorized && (await algoValue(app.prisma, 'ALG-15.enabled'))) {
      const now = new Date();
      const prev = authorized.currentLat != null && authorized.currentLng != null && authorized.lastLocationUpdate
        ? { lat: authorized.currentLat, lng: authorized.currentLng, at: authorized.lastLocationUpdate }
        : null;
      const fix = { lat: latitude, lng: longitude, at: now, accuracyM: accuracy ?? null, mocked: mocked ?? null };
      const maxKmh = Math.min(300, Math.max(60, await algoValue(app.prisma, 'gps.maxPlausibleKmh')));
      const assessment = assessFix(prev, fix, { maxPlausibleKmh: maxKmh });
      void pushTrace(app.redis, traceKey('DRIVER', driver.id), fix);
      if (assessment.signals.length > 0) {
        void recordGpsFlag({ prisma: app.prisma, redis: app.redis }, {
          pool: 'DRIVER', moverId: driver.id, outcome: 'FLAGGED', signals: assessment.signals,
          inputs: { prev, fix: { lat: latitude, lng: longitude, accuracyM: accuracy ?? null, mocked: mocked ?? null }, speedKmh: assessment.speedKmh, distanceM: assessment.distanceM, elapsedS: assessment.elapsedS, maxKmh },
          sentence: flagSentence(assessment.signals, assessment),
        });
      }
    }
    if (!authorized) {
      const owner = await app.prisma.driver.findUnique({
        where: { id: driver.id },
        select: { locationSessionId: true, isOnline: true, currentRideId: true },
      });
      const reason = owner?.isOnline || owner?.currentRideId ? 'SESSION_REPLACED' : 'OFFLINE';
      return { success: true, data: { accepted: false, reason } };
    }

    // DB write debounced to ≥10 s (same policy as the rider route): dispatch
    // reads the persisted fix, and a <10 s-stale point is noise at ride speeds —
    // this keeps a busy fleet from hitting PG on every ping.
    const lastDbWrite = await app.redis
      .get(`driver:location_db_ts:${driver.id}`)
      .catch((error) => {
        request.log.warn({ err: error, driverId: driver.id }, 'driver location Redis debounce read failed');
        return null;
      });
    const shouldWriteDb = !lastDbWrite || Date.now() - parseInt(lastDbWrite, 10) > 10_000;
    if (shouldWriteDb) {
      const persisted = await app.prisma.driver.updateMany({
        where: {
          id: driver.id,
          locationSessionId,
          OR: [{ isOnline: true }, { currentRideId: { not: null } }],
        },
        data: {
          currentLat: latitude,
          currentLng: longitude,
          lastLocationUpdate: new Date(),
        },
      });
      if (persisted.count === 0) {
        const owner = await app.prisma.driver.findUnique({
          where: { id: driver.id },
          select: { locationSessionId: true, isOnline: true, currentRideId: true },
        });
        const reason = owner?.isOnline || owner?.currentRideId ? 'SESSION_REPLACED' : 'OFFLINE';
        return { success: true, data: { accepted: false, reason } };
      }
      await app.redis
        .set(`driver:location_db_ts:${driver.id}`, Date.now().toString())
        .catch((error) => request.log.warn({ err: error, driverId: driver.id }, 'driver location Redis debounce write failed'));
    }

    // (No Redis geo set here — dispatch queries the persisted PostGIS point;
    // a parallel geo index nobody reads is a bug waiting to disagree.)

    // Broadcast location to anyone tracking this ride
    if (authorized.currentRideId) {
      // Live-leg ETA [SWIFT-UG-RT-01]: pickup ETA while en route to the
      // passenger, dropoff ETA once the ride is in progress — refreshed on
      // the throttled branch, cached in between (same policy as the rider).
      const etaMinutes = shouldWriteDb
        ? await refreshLegEta(app, authorized.currentRideId, { lat: latitude, lng: longitude })
        : await cachedLegEta(app, authorized.currentRideId);

      // ETA work yields long enough for a second device to rotate GO. Take a
      // short shared row lock only around the final authority check +
      // synchronous socket publication. Concurrent pings do not block one
      // another, but no old-generation sample can emit after a GO commits.
      const publication = await app.prisma.$transaction(async (tx) => {
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
          currentRideId: string | null;
        }>>`
          SELECT "locationSessionId", "isOnline", "currentRideId"
          FROM "drivers"
          WHERE "id" = ${driver.id}
          FOR SHARE
        `;
        const current = rows[0];
        if (
          !users[0]
          || !sessions[0]
          || !current
          || current.locationSessionId !== locationSessionId
          || (!current.isOnline && !current.currentRideId)
        ) {
          return {
            accepted: false as const,
            reason: current?.isOnline || current?.currentRideId ? 'SESSION_REPLACED' as const : 'OFFLINE' as const,
          };
        }

        if (current.currentRideId === authorized.currentRideId) {
          app.io.to(`order:${authorized.currentRideId}`).emit('driver:location', {
            driverId: driver.id,
            orderId: authorized.currentRideId,
            latitude,
            longitude,
            heading: heading || null,
            etaMinutes,
            timestamp: new Date().toISOString(),
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

  // ─── Available Rides ───────────────────────────────────────────────────

  app.get('/rides/available', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await getDriver(request.user.userId);

    if (!driver.isOnline || !driver.isAvailable || !driver.locationSessionId) {
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
        customerId: { not: request.user.userId },
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
        // [REPORT-014 F-014-01] Physical seats too: a 14-passenger GROUP
        // request never surfaces to a 9-seat bus (class alone can't tell).
        AND: [{
          OR: [
            { taxiPassengerCount: null },
            { taxiPassengerCount: { lte: driver.vehicleCapacity ?? 4 } },
          ],
        }],
      },
      include: {
        customer: { select: { id: true, firstName: true, avatar: true } },
      },
      orderBy: { placedAt: 'asc' },
      take: 20,
    });

    // R8.4: the incoming request shows "{Passenger} · {rating}★" (or New) —
    // one batched read from the ONE mapper.
    const { ratingSurfaces } = await import('../rating/rating-surface');
    const passengerSurfaces = await ratingSurfaces(app.prisma, 'CUSTOMER', orders.map((o) => o.customer?.id).filter((x): x is string => !!x));

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
        // [S1] `taxiFareTotal` is Decimal(10,2) — this is the number the driver
        // agrees to drive for, and it left as a STRING. Null (no quote yet)
        // stays null so the offer card shows an em-dash, never a fabricated 0.
        fareTotal: order.taxiFareTotal === null ? null : Number(order.taxiFareTotal),
        fareSurge: order.taxiFareSurge, // Float in the schema — already a number
        distanceToPickup: distanceToPickup !== null ? Math.round(distanceToPickup * 10) / 10 : null,
        etaToPickup: etaMinutes,
        customer: order.customer
          ? { ...order.customer, displayRating: passengerSurfaces.get(order.customer.id)?.displayRating ?? null }
          : order.customer,
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
      // [F-0011] Polled continuously by the driver app — the PIN must never ride along.
      omit: HANDOVER_SECRETS_OMIT,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true, avatar: true } },
        statusHistory: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });

    if (order?.customer) {
      const { ratingSurfaces } = await import('../rating/rating-surface');
      const surface = (await ratingSurfaces(app.prisma, 'CUSTOMER', [order.customer.id])).get(order.customer.id);
      (order.customer as { displayRating?: number | null }).displayRating = surface?.displayRating ?? null;
    }
    return { success: true, data: order };
  });

  // ─── Ride Lifecycle ────────────────────────────────────────────────────

  // 1. Accept ride
  app.post('/rides/:id/accept', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    // [REPORT-011 F-04] fare 0 = "no choice", never the 60% floor (a
    // forged/legacy client must not clamp the driver's own fare down).
    const { fare: rawFare } = z.object({ fare: zMoneyWhole.optional() }).parse(request.body ?? {});
    const fare = rawFare && rawFare > 0 ? rawFare : undefined;
    const driver = await getDriver(request.user.userId);

    if (!driver.isOnline || !driver.locationSessionId) {
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
    if (order.customerId === request.user.userId) {
      throw new AppError(409, 'SELF_OWN_ORDER', 'You cannot accept a taxi request created by your own account');
    }

    // SWIFT-063: the accept path enforces ride class too — the board filter is a
    // convenience, this is the barrier. An Economy driver cannot claim an XL ride
    // (mirrors the cascade's classesAtOrAbove eligibility).
    const rideClass = order.rideClass ?? 'ECONOMY';
    if (!classesAtOrAbove(rideClass).includes(driver.rideClass ?? 'ECONOMY')) {
      throw new AppError(400, 'WRONG_RIDE_CLASS', `This is a ${rideClass} ride; your ${driver.rideClass ?? 'ECONOMY'} vehicle can't serve it.`);
    }
    // [REPORT-014 F-014-01] Friendly pre-check; the locked claim re-proves it.
    if (order.taxiPassengerCount != null && (driver.vehicleCapacity ?? 0) < order.taxiPassengerCount) {
      throw new AppError(400, 'CAPACITY_EXCEEDED',
        `This ride needs ${order.taxiPassengerCount} seats; your vehicle seats ${driver.vehicleCapacity ?? 0}.`);
    }

    // Shared claim: the DB compare-and-set means two drivers tapping
    // accept at the same instant resolve to exactly one winner — the old
    // check-then-update here could double-assign.
    // Assignment, mover reservation, immutable evidence, and the driver's
    // server-clamped fare share one commit. A crash cannot leave a durable
    // winner carrying the old fare (or a fare write on an unassigned ride).
    const responseOrder = await dispatch.claimOrder(id, driver.id, 'DRIVER', { requestedFare: fare });

    // Customer-facing publication is after the canonical claim and therefore
    // best-effort. A socket/push outage cannot tell the driver a durable winner
    // failed (a retry would only meet their already-owned ride).
    try {
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
    } catch (error) {
      request.log.warn({ err: error, orderId: id }, 'direct taxi assignment socket publication failed after commit');
    }

    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Driver Found!',
      body: `${driver.user.firstName} is heading to pick you up in a ${driver.vehicleColor} ${driver.vehicleMake} ${driver.vehicleModel} (${driver.licensePlate}).`,
      data: { orderId: id, status: 'DRIVER_ASSIGNED' },
    }).catch((error) => request.log.warn({ err: error, orderId: id }, 'direct taxi assignment notification failed after commit'));

    return { success: true, data: responseOrder };
  });

  /** POST /offers/decline — pass on a live dispatch offer. The cascade moves
   *  to the next driver immediately instead of waiting out the 20s timeout.
   *  (Parity with the rider route — this side simply didn't exist before, so
   *  a driver tapping Decline only dismissed the card locally.) */
  app.post('/offers/decline', { preHandler: [app.authenticate] }, async (request) => {
    await getDriver(request.user.userId); // authz before validation
    const { orderId, offerAttemptId } = z.object({
      orderId: z.string().min(1).max(64),
      offerAttemptId: z.string().min(1).max(64).optional(), // [F-014-04]
    }).parse(request.body);
    await dispatch.declineOffer(orderId, request.user.userId, offerAttemptId);
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
    const { orderId, fare, offerAttemptId } = z.object({
      orderId: z.string().min(1).max(64),
      fare: zMoneyWhole.optional(),
      offerAttemptId: z.string().min(1).max(64).optional(), // [F-014-04]
    }).parse(request.body);
    // [REPORT-010 F-07] fare 0 is never a legitimate choice — a recovered
    // card missing its board row must not silently clamp pay to the 60%
    // floor. Zero means "no choice"; the market fare applies.
    const order = await dispatch.acceptOffer(orderId, request.user.userId, fare && fare > 0 ? fare : undefined, offerAttemptId);
    return { success: true, data: { orderId: order.id, status: order.status, orderNumber: order.orderNumber } };
  });

  /** GET /offers/current — [E27 / danger #37] recover the live exclusive
   *  offer after a socket drop/app restart (parity with the rider route). */
  app.get('/offers/current', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await getDriver(request.user.userId);
    const offer = await dispatch.currentOfferFor(driver.id);
    return { success: true, data: { offer } };
  });

  /** POST /offers/seen — [danger #21] render proof for honest timeout
   *  accounting (parity with the rider route). */
  app.post('/offers/seen', { preHandler: [app.authenticate] }, async (request) => {
    await getDriver(request.user.userId); // authz before validation
    const { orderId, offerAttemptId } = z.object({
      orderId: z.string().min(1).max(64),
      offerAttemptId: z.string().min(1).max(64).optional(), // [F-014-04]
    }).parse(request.body);
    await dispatch.markOfferSeen(orderId, request.user.userId, offerAttemptId);
    return { success: true, data: { seen: true } };
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
    if (!cancellable.includes(order.status) || hasTaxiPassengerCustody(order)) {
      throw new AppError(400, 'INVALID_STATUS',
        hasTaxiPassengerCustody(order)
          ? 'You cannot cancel once the trip has started — end the trip instead.'
          : `Cannot cancel a ride in ${order.status} status`);
    }

    // Controlled release, atomic: CAS the ride back to PENDING (unassigned) and
    // free the driver together. The order becomes re-dispatchable; the driver is
    // un-trapped. A concurrent transition (customer cancel, complete) makes the
    // CAS miss and we 409 cleanly.
    const release = await app.prisma.$transaction(async (tx) => {
      await lockTaxiOrderForCustodyDecision(tx, id);
      const current = await tx.order.findFirst({
        where: { id, driverId: driver.id, orderType: 'TAXI' },
        select: {
          status: true,
          ridePinVerified: true,
          ridePinVerifiedAt: true,
        },
      });
      if (!current) return { released: false, custody: false };
      if (hasTaxiPassengerCustody(current)) return { released: false, custody: true };
      if (!cancellable.includes(current.status)) return { released: false, custody: false };
      await tx.order.update({
        where: { id },
        // [REPORT-014 F-014-12] Fresh PIN + zeroed attempt budget: a driver
        // who burned all 5 attempts before cancelling cannot leave the next
        // driver locked out or brute-force the (now-rotated) PIN.
        data: { status: 'PENDING', driverId: null, acceptedAt: null, ...freshRidePinReset() },
      });
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
      return { released: true, custody: false };
    });
    if (release.custody) {
      throw new AppError(400, 'INVALID_STATUS', 'You cannot cancel once the trip has started — end the trip instead.');
    }
    if (!release.released) throw new AppError(409, 'INVALID_STATUS', 'This ride can no longer be cancelled');

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
    // Named in the trail, like every vendor- and dispatch-driven transition
    // already is. This row was 8/8 null on the database.
    await app.prisma.orderStatusLog.create({
      data: { orderId: id, status: 'DRIVER_EN_ROUTE', changedBy: request.user.userId, note: 'Driver started the run to the passenger' },
    });
    const updatedOrder = await app.prisma.order.findUniqueOrThrow({ where: { id }, omit: HANDOVER_SECRETS_OMIT });

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

    const arrivedAt = new Date();
    const claimed = await app.prisma.order.updateMany({
      where: { id, status: 'DRIVER_EN_ROUTE' },
      data: { status: 'DRIVER_ARRIVED', driverArrivedAt: arrivedAt },
    });
    if (claimed.count === 0) throw new AppError(409, 'INVALID_STATUS', `Cannot mark arrived from status ${order.status}`);

    // [Band F] Still "reported", not "arrived" — pressing the button remains
    // the driver's claim. What changed is that the claim is now WRITTEN DOWN
    // beside the position the platform already had, so an appeal can read what
    // was true at the moment the customer's clock started.
    //
    // The position comes from the driver's own location stream, NOT from a
    // request body. That is the point: a body would let the client state where
    // it is, which is the one thing a spoofed arrival needs. This is the same
    // stream the customer's map reads, so a driver who fakes it has to fake it
    // to the customer too.
    //
    // It does NOT refuse. `SWIFT_BUILD_NOW.md` Band F and cash-rules' own
    // philosophy agree: flag into human review, never refuse a money outcome
    // outright. A refusal here would strand a driver who is genuinely at the
    // door under a tin roof with no fix.
    const evidence = arrivalEvidence(
      { lat: driver.currentLat, lng: driver.currentLng, at: driver.lastLocationUpdate },
      { lat: order.pickupLat, lng: order.pickupLng },
      arrivedAt,
    );
    await app.prisma.orderStatusLog.create({
      data: { orderId: id, status: 'DRIVER_ARRIVED', changedBy: request.user.userId, note: evidence.note },
    });
    const updatedOrder = await app.prisma.order.findUniqueOrThrow({ where: { id }, omit: HANDOVER_SECRETS_OMIT });

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
    await getDriverRide(driver.id, id); // fast ownership check; lock below is authoritative

    // The attempt, secret comparison, and custody marker share the order lock.
    // A watchdog/logout/cancel can therefore only release the ride before this
    // commit, or observe custody afterwards — never between PIN success and the
    // durable handoff evidence.
    const verification = await app.prisma.$transaction(async (tx) => {
      await lockTaxiOrderForCustodyDecision(tx, id);
      const current = await tx.order.findFirst({
        where: { id, driverId: driver.id, orderType: 'TAXI' },
        select: {
          status: true,
          ridePin: true,
          ridePinAttempts: true,
          ridePinVerified: true,
          ridePinVerifiedAt: true,
        },
      });
      if (!current) throw new NotFoundError('Ride', id);
      if (current.status !== 'DRIVER_ARRIVED') {
        throw new AppError(400, 'INVALID_STATUS', 'Driver must be at pickup location to verify PIN');
      }
      if (hasTaxiPassengerCustody(current)) {
        throw new AppError(400, 'ALREADY_VERIFIED', 'Ride PIN has already been verified');
      }

      // HND-004: the SAME lockout rule the pickup code uses (one handover engine).
      const { locked, remaining } = handoverAttemptState(current.ridePinAttempts);
      if (locked) {
        throw new AppError(400, 'MAX_ATTEMPTS', 'Maximum PIN verification attempts exceeded. Please contact support.');
      }
      if (current.ridePin !== pin) {
        await tx.order.update({
          where: { id },
          data: { ridePinAttempts: { increment: 1 } },
        });
        return { kind: 'INVALID_PIN' as const, remaining };
      }

      const updatedOrder = await tx.order.update({
        where: { id },
        data: {
          ridePinAttempts: { increment: 1 },
          ridePinVerified: true,
          ridePinVerifiedAt: new Date(),
        },
        // [F-0011] Confirm the PIN matched without ever echoing it.
        omit: HANDOVER_SECRETS_OMIT,
      });
      return { kind: 'VERIFIED' as const, order: updatedOrder };
    });
    if (verification.kind === 'INVALID_PIN') {
      throw new AppError(400, 'INVALID_PIN', `Incorrect PIN. ${verification.remaining} attempt(s) remaining.`);
    }
    const updatedOrder = verification.order;

    app.io.to(`order:${id}`).emit('ride:pin_verified', { orderId: id });

    return { success: true, data: updatedOrder, message: 'PIN verified successfully. You may now start the ride.' };
  });

  // 5. Start ride
  app.put('/rides/:id/start', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await getDriver(request.user.userId);
    await getDriverRide(driver.id, id); // fast ownership check; lock below is authoritative

    const { order, previous } = await app.prisma.$transaction(async (tx) => {
      await lockTaxiOrderForCustodyDecision(tx, id);
      const current = await tx.order.findFirst({
        where: { id, driverId: driver.id, orderType: 'TAXI' },
        omit: HANDOVER_SECRETS_OMIT,
      });
      if (!current) throw new NotFoundError('Ride', id);
      if (current.status !== 'DRIVER_ARRIVED') {
        throw new AppError(400, 'INVALID_STATUS', `Cannot start ride from status ${current.status}`);
      }
      if (!hasTaxiPassengerCustody(current)) {
        throw new AppError(400, 'PIN_REQUIRED', 'Ride PIN must be verified before starting the ride');
      }
      const updated = await tx.order.update({
        where: { id },
        data: { status: 'RIDE_IN_PROGRESS', pickedUpAt: new Date() },
        omit: HANDOVER_SECRETS_OMIT,
      });
      await tx.orderStatusLog.create({
        data: { orderId: id, status: 'RIDE_IN_PROGRESS', changedBy: request.user.userId, note: 'Ride started' },
      });
      return { order: updated, previous: current };
    });
    const updatedOrder = order;

    app.io.to(`order:${id}`).emit('order:status_changed', {
      orderId: id,
      status: 'RIDE_IN_PROGRESS',
      estimatedDuration: previous.taxiDuration,
    });

    await notifications.send({
      userId: previous.customerId,
      type: 'ORDER_UPDATE',
      title: 'Ride Started',
      body: previous.taxiDuration
        ? `Your ride has started. Estimated arrival in ~${previous.taxiDuration} minutes.`
        : 'Your ride has started. Enjoy the trip!',
      data: { orderId: id, status: 'RIDE_IN_PROGRESS' },
    });

    return { success: true, data: updatedOrder };
  });

  // 6. The fare outcome at the destination — the golden rule for rides [M-29].
  //    'paid' completes the ride with the fare captured and the driver's fare
  //    earned, in one commit; 'refused' / 'no_show' (the passenger left without
  //    paying) fail it with GPS evidence, strike the passenger and open the
  //    driver's guarantee claim. The same rail as the rider's handover at the
  //    door — never a second one.
  const fareOutcomeSchema = z.object({
    outcome: z.enum(['paid', 'no_show', 'refused']),
    gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
    photoUrl: z.string().max(2048).optional(),
  });
  app.post('/rides/:id/handover', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await getDriver(request.user.userId);
    const order = await getDriverRide(driver.id, id); // ownership before validation
    const body = fareOutcomeSchema.parse(request.body);
    // Idempotent on Idempotency-Key: a network-retried outcome returns the
    // original result instead of failing the (now-terminal) transition.
    const { data, replayed } = await withIdempotency(app, request, 'handover', id, async () => {
      const result = await cashRules.handover(id, request.user.userId, body);
      return {
        orderId: id,
        status: result.order.status,
        actualDuration: result.order.actualDeliveryTime ?? null,
        claim: result.claim
          ? { id: result.claim.id, status: result.claim.status, amount: Number(result.claim.amount), flags: result.claim.flags }
          : null,
      };
    });
    if (!replayed) {
      try {
        app.io.to(`order:${id}`).emit('order:status_changed', {
          orderId: id,
          status: data.status,
          fare: {
            base: order.taxiFareBase,
            perKm: order.taxiFarePerKm,
            perMin: order.taxiFarePerMin,
            surge: order.taxiFareSurge,
            total: order.taxiFareTotal,
          },
          actualDuration: data.actualDuration,
        });
      } catch (error) {
        request.log.warn({ err: error, orderId: id }, 'taxi fare outcome socket publication failed after commit');
      }
      if (data.status === 'DELIVERED') {
        await notifications.send({
          userId: order.customerId,
          type: 'ORDER_UPDATE',
          title: 'Ride Complete',
          body: `You have arrived at your destination. Total fare: $${Number(order.taxiFareTotal || order.totalAmount).toLocaleString()} GYD.`,
          data: { orderId: id, status: 'DELIVERED' },
        }).catch((error) => request.log.warn({ err: error, orderId: id }, 'taxi completion notification failed after commit'));
      }
    }
    return { success: true, data, replayed };
  });

  // 7. Complete ride
  app.put('/rides/:id/complete', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await getDriver(request.user.userId);
    const order = await getDriverRide(driver.id, id);

    if (order.status !== 'RIDE_IN_PROGRESS') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot complete ride from status ${order.status}`);
    }
    // [M-29] A cash fare is earned when the money is recorded, never on this
    // tap: the fare outcome (paid / refused / left without paying) is the step
    // that completes a cash ride. The terminal authority refuses the bare
    // transition too; this answer just says so before it is attempted.
    if (order.paymentMethod === 'CASH' && order.paymentStatus !== 'CAPTURED') {
      throw new AppError(409, 'PAYMENT_NOT_CAPTURED', 'Record the fare first — “Fare collected” completes the trip; “Refused” or “Left without paying” records the outcome.');
    }

    // Calculate actual duration
    const actualDuration = order.pickedUpAt
      ? Math.round((Date.now() - order.pickedUpAt.getTime()) / 60000)
      : order.taxiDuration;

    // The terminal fact is one PostgreSQL commit: status/timestamp + actual
    // duration + driver release/count/rate rehabilitation + earnings + log.
    // Injected failures in any staged write roll the entire ride back to
    // RIDE_IN_PROGRESS, so a retry is safe and cannot double-pay/count.
    const { order: updatedOrder } = await orderService.transitionOrderAtomically({
      orderId: id,
      target: 'DELIVERED',
      allowedFrom: ['RIDE_IN_PROGRESS'],
      changedBy: request.user.userId,
      note: 'Ride completed',
      terminalMetadata: { actualDeliveryTime: actualDuration },
      decayDriverCancellationRate: true,
      invalidStatus: (current) => new AppError(409, 'INVALID_STATUS', `Cannot complete ride from status ${current}`),
    });

    try {
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
    } catch (error) {
      request.log.warn({ err: error, orderId: id }, 'taxi completion socket publication failed after commit');
    }

    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Ride Complete',
      body: `You have arrived at your destination. Total fare: $${Number(order.taxiFareTotal || order.totalAmount).toLocaleString()} GYD.`,
      data: { orderId: id, status: 'DELIVERED' },
    }).catch((error) => request.log.warn({ err: error, orderId: id }, 'taxi completion notification failed after commit'));

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

    // [S1] taxiFareTotal / tipAmount / totalAmount are Prisma `Decimal`s — raw
    // rows put them on the wire as STRINGS ("1500.00"), so a ride history that
    // sums or formats them breaks per-client instead of per-row. Coerced at the
    // seam, before the shared paginator (rider /earnings is the reference).
    // A null fare stays null — LAW 1: never invent a zero.
    const data = rides.map((ride) => ({
      ...ride,
      taxiFareTotal: ride.taxiFareTotal === null ? null : Number(ride.taxiFareTotal),
      tipAmount: Number(ride.tipAmount),
      totalAmount: Number(ride.totalAmount),
    }));

    return { success: true, ...paginatedResponse(data, total, { page, limit, skip }) };
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

    // [S1] The aggregate below was coerced; the ROWS were not. `Earning.amount`
    // is Decimal(10,2), so each row's amount reached the app as a STRING while
    // the total beside it was a number — the same list, two types. Map the rows
    // before the shared paginator, exactly as rider /earnings does.
    // [ALG-21] One sentence per row, from the stored fields that produced the number.
    const orderIds = [...new Set(earnings.map((e) => e.orderId))];
    const relatedOrders = orderIds.length > 0
      ? await app.prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, orderType: true, paymentMethod: true, isExpress: true, billableKm: true, billableKmSource: true, taxiDistance: true },
        })
      : [];
    const orderMap = new Map(relatedOrders.map((o) => [o.id, o]));
    const data = earnings.map((earning) => ({ ...earning, amount: Number(earning.amount), sentence: explainEarning(earning, orderMap.get(earning.orderId) ?? null) }));

    return {
      success: true,
      ...paginatedResponse(data, total, { page, limit, skip }),
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
        // [S1] Same defect as /earnings above: the total was coerced, the rows
        // it is the sum of were not. Decimal(10,2) → number at the seam.
        earnings: earnings.map((earning) => ({ ...earning, amount: Number(earning.amount) })),
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
