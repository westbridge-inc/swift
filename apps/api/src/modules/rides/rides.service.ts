import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { RideClass } from '@prisma/client';
import { FareService } from './fare.service';
import { newRidePin } from './ride-pin';
import type { DispatchService } from '../dispatch/dispatch.service';
import { orderingRestriction } from '../cash/cash-rules.service';
import { generateOrderNumber } from '../../utils/markup';
import { AppError } from '../../utils/errors';
import { lockActiveOrderCustomer } from '../order/order-creation-authority';

// ---------------------------------------------------------------------------
// The ride-request core, extracted from the POST /request handler (rides spec
// 5.5B needed a second caller: the queue's auto-request). One source of truth
// for the gates and the creation path — the route and the 2-min queue scan
// both call this. Error PRECEDENCE is preserved exactly as the route has
// always thrown it (active → banned → availability(flag) → restricted →
// selfie → fare → capacity → L2) and is pinned by
// taxi-characterization.test.ts.
// ---------------------------------------------------------------------------

/** The slice of the app the request core needs — the route passes the real
 *  Fastify instance; the queue-scan worker passes { prisma } (no dispatch
 *  queue in a worker ⇒ the inline dispatch fallback runs, as in tests). */
export interface RideRequestApp {
  prisma: PrismaClient;
  dispatchQueue?: FastifyInstance['dispatchQueue'];
}

export interface RideRequestBody {
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  pickupAddress: string;
  dropoffAddress: string;
  passengerCount: number;
  rideClass: RideClass;
}

type GatedUser = {
  id: string;
  tenantId: string;
  countryCode: string;
  trustLevel: string;
  selfieCapturedAt: Date | null;
};

/**
 * The pre-flight gates in the request route's exact order. `dispatch` present
 * ⇒ the flag-gated availability pre-check runs in its historical slot
 * (between the two strike outcomes). Join-the-queue passes no dispatch — a
 * queue exists precisely FOR the no-supply case.
 */
export async function assertRideGates(
  app: RideRequestApp,
  userId: string,
  opts: { dispatch?: DispatchService; pickup?: { lat: number; lng: number } } = {},
): Promise<GatedUser> {
  const user = await app.prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, tenantId: true, countryCode: true, trustLevel: true, selfieCapturedAt: true },
  });

  const active = await app.prisma.order.findFirst({
    where: {
      customerId: user.id,
      tenantId: user.tenantId,
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
  if (opts.dispatch && opts.pickup
    && process.env['DISPATCH_AVAILABILITY'] === '1' && process.env['TAXI_ALLOW_REQUEST_ON_NONE'] === '0') {
    const supply = await opts.dispatch.getAvailability('DRIVER', opts.pickup, 0, user.tenantId);
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

  return user;
}

/**
 * Master plan §5: a rider reaches Level 2 BEFORE their first taxi ride —
 * getting into a stranger's car is the highest-trust action on Swift.
 * This supersedes the old fare-threshold gate (every ride now needs L2).
 * (Kept separate because the route has always thrown it AFTER fare/capacity.)
 */
export function assertL2(user: GatedUser): void {
  if (user.trustLevel === 'L1') {
    throw new AppError(403, 'ID_VERIFICATION_REQUIRED',
      'Rides need a one-time ID verification first — it takes a minute in the app and covers every future ride.',
      { reason: 'first_ride_l2' });
  }
}

/**
 * Create the ride at the quoted fare and start dispatch — the whole request
 * path minus HTTP: gates, tier fare, capacity, L2, order row + PENDING
 * history, watch cleanup, dispatch enqueue (queue when up, inline otherwise).
 */
export async function createRideRequest(
  app: RideRequestApp,
  fareService: FareService,
  dispatch: DispatchService,
  userId: string,
  body: RideRequestBody,
  /** false ⇒ skip the flag-gated availability pre-check (queue auto-request:
   *  the scan just saw supply; re-refusing on a flap only adds a race). */
  availabilityPreCheck = true,
  /** Queue workers carry the tenant captured from the authenticated customer
   *  at join time. If account tenancy changed meanwhile, fail closed instead
   *  of creating an order in a different operator from the scanned supply. */
  expectedTenantId?: string,
): Promise<{
  order: { id: string; orderNumber: string; status: string };
  estimate: { fare: number; currencyCode: string; distanceKm: number; durationMin: number; source: string };
  ridePin: string;
}> {
  const user = await assertRideGates(app, userId,
    availabilityPreCheck ? { dispatch, pickup: body.pickup } : {});
  if (expectedTenantId && user.tenantId !== expectedTenantId) {
    throw new AppError(
      409,
      'RIDE_QUEUE_TENANT_CHANGED',
      'Your operator changed while this queued ride was waiting. Join the queue again.',
    );
  }
  const orderTenantId = expectedTenantId ?? user.tenantId;

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
    billableKm: tiered.billableKm,
    routeSource: tiered.routeSource,
    source: tier.source,
  };

  assertL2(user);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCount = await app.prisma.order.count({ where: { placedAt: { gte: today } } });

  // PIN is verified by the driver at pickup (mandatory for taxi)
  // 6-digit identity PIN from a CSPRNG (not Math.random) — verified by the
  // driver and attempt-capped (driver.routes MAX_PIN_ATTEMPTS).
  const ridePin = newRidePin();

  const order = await app.prisma.$transaction(async (tx) => {
    await lockActiveOrderCustomer(tx, user.id, orderTenantId);
    return tx.order.create({
      data: {
        tenantId: orderTenantId,
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
        // [ALG-18] One reader for every rail: the taxi's frozen distance, with its engine.
        billableKm: estimate.billableKm,
        billableKmSource: estimate.routeSource,
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
    await app.dispatchQueue.add('dispatch-order', { orderId: order.id, tenantId: orderTenantId }, {
      priority: 5,
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  } else {
    await dispatch.dispatchOrder(order.id, orderTenantId);
  }

  return { order: { id: order.id, orderNumber: order.orderNumber, status: order.status }, estimate, ridePin };
}
