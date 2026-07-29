import type { FastifyInstance } from 'fastify';
import { RideClass } from '@prisma/client';
import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { FareService } from './fare.service';
import { OrderService } from '../order/order.service';
import { SosService } from '../safety/sos.service';
import { makeDispatchService } from '../dispatch/dispatch.service';
import { log } from '../../utils/logger';
import { orderingRestriction } from '../cash/cash-rules.service';
import { generateOrderNumber } from '../../utils/markup';
import { AppError, NotFoundError } from '../../utils/errors';
import { tenantCacheKey } from '../../utils/tenant-cache';

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
    const cacheKey = tenantCacheKey(`avail:DRIVER:${lat.toFixed(2)}:${lng.toFixed(2)}`);
    const cached = await app.redis.get(cacheKey);
    // gate mirrors DISPATCH_AVAILABILITY: with the flag off, clients read the
    // truth but change NOTHING — byte-identical UX until the launch decision.
    const gate = process.env['DISPATCH_AVAILABILITY'] === '1';
    if (cached) return { success: true, data: { ...JSON.parse(cached), gate } };
    const data = await dispatch.getAvailability('DRIVER', { lat, lng });
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

  /** POST /request — create the ride at the quoted fare and start dispatch. */
  app.post('/request', auth, async (request, reply) => {
    const body = requestRideSchema.parse(request.body);
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
      select: { id: true, countryCode: true, trustLevel: true, selfieCapturedAt: true },
    });

    const active = await app.prisma.order.findFirst({
      where: {
        customerId: user.id,
        orderType: 'TAXI',
        status: { in: ['PENDING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'] },
      },
      select: { id: true },
    });
    if (active) {
      throw new AppError(409, 'RIDE_IN_PROGRESS', 'You already have an active ride');
    }

    // Strike consequences apply to rides exactly as to deliveries
    const restriction = await orderingRestriction(app.prisma, user.id);
    if (restriction === 'banned') {
      throw new AppError(403, 'ACCOUNT_RESTRICTED', 'Rides are disabled on this account after repeated failed payments. Contact support.');
    }

    // Hard pre-check (availability spec §2.1, flag-gated): when the same query
    // dispatch would ping finds NOBODY, say so before taking the request. The
    // client shows Notify-me; "Try anyway" stays honored unless the market
    // config forbids it (TAXI_ALLOW_REQUEST_ON_NONE, spec default TRUE — some
    // drivers come online mid-search).
    if (process.env['DISPATCH_AVAILABILITY'] === '1' && process.env['TAXI_ALLOW_REQUEST_ON_NONE'] === '0') {
      const supply = await dispatch.getAvailability('DRIVER', body.pickup);
      if (supply.level === 'NONE') {
        throw new AppError(
          409,
          'NO_DRIVERS_NEARBY',
          "No drivers are available near you right now — we're sorry. We'll ping you the moment one comes online.",
        );
      }
    }
    if (restriction === 'restricted') {
      throw new AppError(403, 'STRIKE_RESTRICTED', 'After repeated failed payments, rides require ID verification. Verify your identity to continue.');
    }

    // Universal signup selfie (master plan §3): the driver sees who they are
    // picking up, so a live profile photo is required before booking rides.
    if (!user.selfieCapturedAt) {
      throw new AppError(403, 'SELFIE_REQUIRED', 'Add your profile photo before booking rides — your driver sees it when they accept.');
    }

    const tiered = await fareService.estimateTiers(body.pickup, body.dropoff, user.countryCode);
    const tier = tiered.tiers.find((t) => t.rideClass === body.rideClass);
    if (!tier) {
      throw new AppError(400, 'INVALID_RIDE_CLASS', 'That ride tier is not available.');
    }

    // A tier can't seat more passengers than its vehicles hold (XL = 6, others = 4)
    if (body.passengerCount > tier.capacity) {
      throw new AppError(400, 'TOO_MANY_PASSENGERS',
        `${body.rideClass} seats up to ${tier.capacity}. Choose a larger ride for ${body.passengerCount}.`,
        { capacity: tier.capacity, passengerCount: body.passengerCount });
    }

    const estimate = {
      fare: tier.fare,
      currencyCode: tiered.currencyCode,
      distanceKm: tiered.distanceKm,
      durationMin: tiered.durationMin,
      source: tier.source,
    };

    // Master plan §5: a rider reaches Level 2 BEFORE their first taxi ride —
    // getting into a stranger's car is the highest-trust action on Swift.
    // This supersedes the old fare-threshold gate (every ride now needs L2).
    if (user.trustLevel === 'L1') {
      throw new AppError(403, 'ID_VERIFICATION_REQUIRED',
        'Rides need a one-time ID verification first — it takes a minute in the app and covers every future ride.',
        { reason: 'first_ride_l2' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = await app.prisma.order.count({ where: { placedAt: { gte: today } } });

    // PIN is verified by the driver at pickup (mandatory for taxi)
    // 6-digit identity PIN from a CSPRNG (not Math.random) — verified by the
    // driver and attempt-capped (driver.routes MAX_PIN_ATTEMPTS).
    const ridePin = String(randomInt(100000, 1000000));

    const order = await app.prisma.order.create({
      data: {
        orderNumber: generateOrderNumber(todayCount + 1),
        orderType: 'TAXI',
        customerId: user.id,
        status: 'PENDING',
        pickupAddress: body.pickupAddress,
        pickupLat: body.pickup.lat,
        pickupLng: body.pickup.lng,
        deliveryAddress: body.dropoffAddress,
        deliveryLat: body.dropoff.lat,
        deliveryLng: body.dropoff.lng,
        taxiPickupAddress: body.pickupAddress,
        taxiDropoffAddress: body.dropoffAddress,
        taxiPassengerCount: body.passengerCount,
        rideClass: body.rideClass,
        taxiDistance: estimate.distanceKm,
        taxiDuration: estimate.durationMin,
        taxiFareTotal: estimate.fare,
        subtotalBase: estimate.fare,
        subtotalMarkup: 0,
        subtotalCustomer: estimate.fare,
        deliveryFee: 0,
        totalAmount: estimate.fare,
        paymentMethod: 'CASH',
        ridePin,
        statusHistory: {
          create: { status: 'PENDING', changedBy: user.id, note: `Ride requested — fixed fare $${estimate.fare}` },
        },
      },
    });

    // The customer re-entered the funnel and got a ride — any pending "notify me
    // when drivers are back" watch is now obsolete. Clear it so the 2-min supply
    // scan can't push "Drivers are back!" while they're already in a ride.
    // Best-effort: a watch-clear hiccup must never fail the ride request.
    await app.prisma.supplyWatch
      .deleteMany({ where: { customerId: user.id, pool: 'DRIVER', notifiedAt: null } })
      .catch(() => {});

    // Shared dispatch engine, driver pool — same cascade, same atomicity.
    // SWIFT-AUD-D6-08: enqueue the first-pass dispatch instead of running it
    // inline. It does external ETA round-trips that would otherwise pin this
    // request handler (and a DB connection) open under a hail storm; the client
    // listens for the dispatch:offer socket event either way. Fall back to inline
    // when no queue is up (tests / degraded boot) so behaviour is unchanged there.
    if (app.dispatchQueue) {
      await app.dispatchQueue.add('dispatch-order', { orderId: order.id }, {
        priority: 5,
        removeOnComplete: 100,
        removeOnFail: 50,
      });
    } else {
      await dispatch.dispatchOrder(order.id);
    }

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
            id: true, vehicleMake: true, vehicleModel: true, vehicleColor: true,
            licensePlate: true, vehiclePhotoUrl: true, averageRating: true,
            currentLat: true, currentLng: true,
            user: { select: { firstName: true, avatar: true, phone: true } },
          },
        },
      },
      orderBy: { placedAt: 'desc' },
    });
    return { success: true, data: ride };
  });

  /** GET /:id — one owned ride. */
  app.get<{ Params: { id: string } }>('/:id', auth, async (request) => {
    const ride = await app.prisma.order.findFirst({
      where: { id: request.params.id, customerId: request.user.userId, orderType: 'TAXI' },
      include: {
        driver: {
          select: {
            vehicleMake: true, vehicleModel: true, vehicleColor: true, licensePlate: true,
            vehiclePhotoUrl: true, averageRating: true,
            user: { select: { firstName: true, avatar: true } },
          },
        },
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ride) throw new NotFoundError('Ride', request.params.id);
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
