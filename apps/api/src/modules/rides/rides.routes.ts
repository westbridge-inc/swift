import type { FastifyInstance } from 'fastify';
import { RideClass } from '@prisma/client';
import { z } from 'zod';
import { FareService } from './fare.service';
import { assertRideGates, assertL2, createRideRequest } from './rides.service';
import { getSupplySnapshot, queueStatusFor, presenceNear, RIDE_QUEUE_TTL_MIN } from './queue.service';
import { OrderService } from '../order/order.service';
import { SosService } from '../safety/sos.service';
import { makeDispatchService } from '../dispatch/dispatch.service';
import { log } from '../../utils/logger';
import { AppError, NotFoundError } from '../../utils/errors';
import { tenantCacheKey } from '../../utils/tenant-cache';
import { safeMmgPayUrl } from '../../utils/mmg-pay-url';
import { enterTenant, getTenantId } from '../../plugins/prisma';

// ---------------------------------------------------------------------------
// Taxi: the fare is computed and SHOWN before any driver
// sees the request, drivers come from the shared dispatch engine, and the
// ride PIN guards pickup. Cash, recorded only.
// ---------------------------------------------------------------------------

const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const estimateSchema = z.object({
  pickup: pointSchema,
  dropoff: pointSchema,
});

const requestRideSchema = z.object({
  pickup: pointSchema,
  dropoff: pointSchema,
  pickupAddress: z.string().trim().min(3).max(200),
  dropoffAddress: z.string().trim().min(3).max(200),
  passengerCount: z.number().int().min(1).max(14).default(1),
  rideClass: z.nativeEnum(RideClass).default(RideClass.ECONOMY),
});

const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

async function authenticatedTenantId(app: FastifyInstance, userId: string): Promise<string> {
  const boundTenantId = getTenantId();
  if (boundTenantId) return boundTenantId;

  // Production auth binds the session's tenant into ALS. Focused/in-process
  // callers may omit the server's onRequest hook, so fail safe by resolving the
  // same authenticated user authority rather than guessing a default tenant.
  const user = await app.prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true },
  });
  if (!user) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authenticated customer no longer exists');
  }
  enterTenant(user.tenantId);
  return user.tenantId;
}

export async function ridesRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const fareService = new FareService(app.prisma);
  const orderService = new OrderService(app.prisma, app.io);
  const dispatch = makeDispatchService(app);

  /** POST /estimate — exact per-tier fares (Economy/Comfort/XL), before anything
   *  is requested. */
  /**
   * GET /availability — the honest supply read (availability spec §1/§2.1):
   * derived from the EXACT candidate query dispatch pings with. Buckets only,
   * never counts or positions. 10s cache per ~1km cell.
   */
  app.get('/availability', auth, async (request) => {
    const { lat, lng } = z
      .object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) })
      .parse(request.query);
    const tenantId = await authenticatedTenantId(app, request.user.userId);
    const cacheKey = tenantCacheKey(`avail:DRIVER:${lat.toFixed(2)}:${lng.toFixed(2)}`);
    const cached = await app.redis.get(cacheKey);
    // gate mirrors DISPATCH_AVAILABILITY: with the flag off, clients read the
    // truth but change NOTHING — byte-identical UX until the launch decision.
    const gate = process.env['DISPATCH_AVAILABILITY'] === '1';
    if (cached) {
      const data = JSON.parse(cached) as { level: 'GOOD' | 'LOW' | 'NONE'; nearestEtaMinutes?: number | null };
      // A rolling deploy may briefly read a cache entry written by the older
      // optional-field contract. Normalize it at the boundary so TaxiScreen
      // always receives the same shape.
      return { success: true, data: { ...data, nearestEtaMinutes: data.nearestEtaMinutes ?? null, gate } };
    }
    const data = await dispatch.getAvailability('DRIVER', { lat, lng }, 0, tenantId);
    await app.redis.set(cacheKey, JSON.stringify(data), 'EX', 10).catch(() => {});
    return { success: true, data: { ...data, gate } };
  });

  /** POST /availability/watch — "tell me when drivers are back" (spec §5).
   *  One active watch per customer; the 2-min scan notifies once. */
  app.post('/availability/watch', auth, async (request) => {
    const { lat, lng } = z
      .object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) })
      .parse(request.body);
    // Replace any previous active watch — the newest location wins.
    await app.prisma.supplyWatch.deleteMany({
      where: { customerId: request.user.userId, notifiedAt: null },
    });
    const watch = await app.prisma.supplyWatch.create({
      data: {
        customerId: request.user.userId,
        pool: 'DRIVER',
        lat, lng,
        expiresAt: new Date(Date.now() + 2 * 3600 * 1000),
      },
    });
    return { success: true, data: { id: watch.id, expiresAt: watch.expiresAt } };
  });

  app.post('/estimate', auth, async (request) => {
    const body = estimateSchema.parse(request.body);
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
      select: { countryCode: true },
    });
    const estimate = await fareService.estimateTiers(body.pickup, body.dropoff, user.countryCode);
    return { success: true, data: estimate };
  });

  /** POST /request — create the ride at the quoted fare and start dispatch.
   *  The core lives in rides.service createRideRequest (one source of truth
   *  with the 5.5B queue's auto-request); this handler is HTTP only. */
  app.post('/request', auth, async (request, reply) => {
    const body = requestRideSchema.parse(request.body);
    const { order, estimate, ridePin } = await createRideRequest(app, fareService, dispatch, request.user.userId, body);

    reply.code(201);
    return {
      success: true,
      data: {
        ride: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          fare: estimate.fare,
          rideClass: body.rideClass,
          currencyCode: estimate.currencyCode,
          fareSource: estimate.source,
          distanceKm: estimate.distanceKm,
          durationMin: estimate.durationMin,
          ridePin,
          pickupAddress: body.pickupAddress,
          dropoffAddress: body.dropoffAddress,
        },
        message: 'Looking for a driver near you…',
      },
    };
  });

  // -------------------------------------------------------------------------
  // The 5.5B queue (rides spec): a supply gap is a service, not an apology.
  // Join stores the trip; the 2-min scan auto-requests the head when a driver
  // frees up; TTL expiry pushes a re-request deep link. Additive-only.
  // -------------------------------------------------------------------------

  /** POST /queue/join — enter the waitlist with the full trip, gates mirrored
   *  from the request path (no availability pre-check: the queue exists FOR
   *  the no-supply case). Replaces any prior WAITING entry (newest trip wins,
   *  same semantic as the supply watch). */
  app.post('/queue/join', auth, async (request, reply) => {
    const body = requestRideSchema.parse(request.body);
    const user = await assertRideGates(app, request.user.userId);
    assertL2(user);

    const ttlMin = RIDE_QUEUE_TTL_MIN();
    await app.prisma.rideQueueEntry.updateMany({
      where: { customerId: user.id, tenantId: user.tenantId, status: 'WAITING' },
      data: { status: 'LEFT' },
    });
    const entry = await app.prisma.rideQueueEntry.create({
      data: {
        customerId: user.id,
        tenantId: user.tenantId,
        pickupLat: body.pickup.lat,
        pickupLng: body.pickup.lng,
        pickupAddress: body.pickupAddress,
        dropoffLat: body.dropoff.lat,
        dropoffLng: body.dropoff.lng,
        dropoffAddress: body.dropoffAddress,
        rideClass: body.rideClass,
        passengerCount: body.passengerCount,
        expiresAt: new Date(Date.now() + ttlMin * 60_000),
      },
    });

    // Joining the queue supersedes a bare notify-me watch (the queue IS the
    // richer version of it). Best-effort, mirrors the request path's cleanup.
    await app.prisma.supplyWatch
      .deleteMany({ where: { customerId: user.id, pool: 'DRIVER', notifiedAt: null } })
      .catch(() => {});

    reply.code(201);
    return { success: true, data: await queueStatusFor(app.prisma, dispatch, entry) };
  });

  /** POST /queue/leave — one tap out; idempotent. */
  app.post('/queue/leave', auth, async (request) => {
    const tenantId = await authenticatedTenantId(app, request.user.userId);
    await app.prisma.rideQueueEntry.updateMany({
      where: { customerId: request.user.userId, tenantId, status: 'WAITING' },
      data: { status: 'LEFT' },
    });
    return { success: true, data: { left: true } };
  });

  /** GET /queue — my live queue state (position derived, never stored), or
   *  null when I'm not in line. The client polls this alongside the socket. */
  app.get('/queue', auth, async (request) => {
    const tenantId = await authenticatedTenantId(app, request.user.userId);
    const entry = await app.prisma.rideQueueEntry.findFirst({
      where: {
        customerId: request.user.userId,
        tenantId,
        status: 'WAITING',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!entry) return { success: true, data: null };
    return { success: true, data: await queueStatusFor(app.prisma, dispatch, entry) };
  });

  /** GET /supply — the honest counts for the 5.5A card (S-41: "{online}
   *  drivers online — {busy} on trips"). Coarse counts only, no positions. */
  app.get('/supply', auth, async (request) => {
    const q = estimateSchema.pick({ pickup: true }).extend({}).safeParse({
      pickup: {
        lat: Number((request.query as Record<string, unknown>)['lat']),
        lng: Number((request.query as Record<string, unknown>)['lng']),
      },
    });
    if (!q.success) {
      throw new AppError(400, 'INVALID_POINT', 'lat and lng are required.');
    }
    const tenantId = await authenticatedTenantId(app, request.user.userId);
    const snapshot = await getSupplySnapshot(app.prisma, q.data.pickup, tenantId);
    const availability = await dispatch.getAvailability('DRIVER', q.data.pickup, 0, tenantId);
    return { success: true, data: { ...snapshot, level: availability.level, nearestEtaMinutes: availability.nearestEtaMinutes ?? null } };
  });

  /** GET /presence — the "map is alive" read (rides spec 5.1/6.2): up to 12
   *  COARSE positions of free online drivers near a point. Privacy is the
   *  design: server-side ~100m deterministic jitter (stable per driver per
   *  5-min bucket so cars don't dance between refetches), no identities, no
   *  bearings, hailable (online + available) cars only. Zero rows ⇒ empty
   *  array — the client renders nothing rather than faking supply (0.8). */
  app.get('/presence', auth, async (request) => {
    const qq = request.query as Record<string, unknown>;
    const lat = Number(qq['lat']);
    const lng = Number(qq['lng']);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new AppError(400, 'INVALID_POINT', 'lat and lng are required.');
    }
    const tenantId = await authenticatedTenantId(app, request.user.userId);
    const cars = await presenceNear(app.prisma, { lat, lng }, tenantId);
    return { success: true, data: { cars } };
  });

  /** GET /active — the customer's current ride, with driver identity. */
  app.get('/active', auth, async (request) => {
    const ride = await app.prisma.order.findFirst({
      where: {
        customerId: request.user.userId,
        orderType: 'TAXI',
        status: { in: ['PENDING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'] },
      },
      include: {
        driver: {
          select: {
            id: true, userId: true, vehicleMake: true, vehicleModel: true, vehicleColor: true,
            licensePlate: true, vehiclePhotoUrl: true, averageRating: true,
            currentLat: true, currentLng: true, bodyType: true, colorHex: true,
            mmgPayUrl: true,
            user: { select: { firstName: true, avatar: true, phone: true } },
          },
        },
      },
      orderBy: { placedAt: 'desc' },
    });
    if (!ride?.driver) return { success: true, data: ride };
    // Vehicle visual identity [rides spec 6B]: shape + tint the client renders
    // on the card, the map marker, and the arrival screen. Classify-on-read
    // heals rows born before the assignment hook/backfill.
    const { vehicleIdentityFor } = await import('./vehicle-identity');
    // R8.4: the ride card shows "{Driver} · {display}★" from the ONE mapper.
    const { ratingSurfaces } = await import('../rating/rating-surface');
    const surface = (await ratingSurfaces(app.prisma, 'DRIVER', [ride.driver.userId])).get(ride.driver.userId);
    // MMG is a trip-END surface (rides spec 5.9/Part 7): the driver's own pay
    // link rides along only once the trip is underway, so the post-trip sheet
    // holds it — never shown while they're still deciding on a driver.
    const driver = { ...ride.driver, ...vehicleIdentityFor(ride.driver), displayRating: surface?.displayRating ?? null };
    (driver as { mmgPayUrl?: string | null }).mmgPayUrl = ride.status === 'RIDE_IN_PROGRESS'
      ? safeMmgPayUrl(ride.driver.mmgPayUrl)
      : null;
    return { success: true, data: { ...ride, driver } };
  });

  /** GET /:id — one owned ride. */
  app.get<{ Params: { id: string } }>('/:id', auth, async (request) => {
    const ride = await app.prisma.order.findFirst({
      where: { id: request.params.id, customerId: request.user.userId, orderType: 'TAXI' },
      include: {
        driver: {
          select: {
            userId: true, vehicleMake: true, vehicleModel: true, vehicleColor: true, licensePlate: true,
            vehiclePhotoUrl: true, averageRating: true, mmgPayUrl: true,
            user: { select: { firstName: true, avatar: true } },
          },
        },
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ride) throw new NotFoundError('Ride', request.params.id);
    if (ride.driver) {
      const { ratingSurfaces } = await import('../rating/rating-surface');
      const surface = (await ratingSurfaces(app.prisma, 'DRIVER', [ride.driver.userId])).get(ride.driver.userId);
      (ride.driver as { displayRating?: number | null }).displayRating = surface?.displayRating ?? null;
    }
    // Same trip-end rule as /active: the pay link only for a ride that is
    // underway or done (receipt / pay-later), never during matching.
    if (ride.driver) {
      (ride.driver as { mmgPayUrl?: string | null }).mmgPayUrl = ['RIDE_IN_PROGRESS', 'DELIVERED', 'COMPLETED'].includes(ride.status)
        ? safeMmgPayUrl(ride.driver.mmgPayUrl)
        : null;
    }
    return { success: true, data: ride };
  });

  /** POST /:id/cancel — rides ride the same state machine as everything else. */
  app.post<{ Params: { id: string } }>('/:id/cancel', auth, async (request) => {
    const body = cancelSchema.parse(request.body ?? {});
    const result = await orderService.cancelOrder(request.params.id, request.user.userId, body.reason);
    return { success: true, data: result };
  });

  /** POST /:id/sos — passenger or driver raises an emergency on an active ride.
   *  The app also dials the local emergency number; this raises a first-class
   *  alert in the ONE SOS engine (safety §4) so ops get paged, the war-room
   *  lights up, and the incident carries a full ack/resolve lifecycle + evidence
   *  trail — which ride-hailing safety requires (pre-launch audit: no SOS was a
   *  rides blocker). */
  app.post<{ Params: { id: string } }>('/:id/sos', auth, async (request) => {
    const { id } = request.params;
    const body = z.object({
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      note: z.string().max(500).optional(),
    }).parse(request.body ?? {});

    // Only a participant in THIS ride may raise its SOS.
    const ride = await app.prisma.order.findFirst({
      where: {
        id,
        orderType: 'TAXI',
        OR: [{ customerId: request.user.userId }, { driver: { userId: request.user.userId } }],
      },
      select: { id: true, orderNumber: true, status: true, customerId: true, driver: { select: { userId: true } } },
    });
    if (!ride) throw new NotFoundError('Ride', id);

    const raisedBy = ride.customerId === request.user.userId ? 'passenger' : 'driver';
    const counterpartyUserId = raisedBy === 'passenger' ? ride.driver?.userId ?? null : ride.customerId;

    // Loud, correlated trace for ops.
    log().error({ orderId: ride.id, orderNumber: ride.orderNumber, raisedBy, lat: body.lat, lng: body.lng }, 'SOS raised on active ride');

    // ONE SOS engine (safety §4, standing order #17): a ride panic is a
    // first-class SosAlert, never a parallel notify. It goes straight to ACTIVE
    // — this button has no countdown affordance and the rider is dialling
    // emergency services in parallel, so the slide-to-cancel grace (which guards
    // an accidental app tap) would only delay the ops page. The engine owns the
    // fan-out: ops page + war-room socket + the ack/resolve lifecycle.
    const alert = await new SosService(app.prisma, app.io).create({
      actorUserId: request.user.userId,
      actorRole: raisedBy === 'passenger' ? 'CUSTOMER' : 'MOVER',
      orderId: ride.id,
      orderType: 'TAXI',
      counterpartyUserId,
      triggerSource: 'BUTTON',
      immediate: true,
      lat: body.lat ?? null,
      lng: body.lng ?? null,
    });

    // Keep the free-text reason + coords on the order's immutable timeline (the
    // SosAlert carries no free-text trigger field; ops correlate via orderId).
    await app.prisma.orderStatusLog.create({
      data: { orderId: ride.id, status: ride.status, changedBy: request.user.userId, note: `SOS raised by ${raisedBy}${body.note ? `: ${body.note}` : ''} ${body.lat != null ? `@${body.lat},${body.lng}` : ''}`.trim() },
    });

    return { success: true, data: { acknowledged: true, orderId: ride.id, sosAlertId: alert.id, status: alert.status } };
  });
}
