import { assertRoadTripInMarket } from './road-trip-market';
import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { RideClass } from '@prisma/client';
import { FareService, type ItineraryEstimate, type TieredEstimate } from './fare.service';
import { newRidePin } from './ride-pin';
import type { TaxiStopPlan } from './taxi-itinerary';
import { stopPreview, type TaxiStopPreview } from './taxi-stops-read';
import type { DispatchService } from '../dispatch/dispatch.service';
import { orderingRestriction } from '../cash/cash-rules.service';
import { persistCheckoutReceiptInTransaction } from '../order/checkout-outbox';
import { generateOrderNumber } from '../../utils/markup';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { lockActiveOrderCustomer } from '../order/order-creation-authority';
import { ReviewDemoOrderRefusedError, REVIEW_DEMO_NO_BOOKINGS_MESSAGE } from '../review/demo-policy';

const ACTIVE_TAXI_STATUSES = [
  'PENDING',
  'DRIVER_ASSIGNED',
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
  'RIDE_IN_PROGRESS',
] as const;

const activeTaxiWhere = (customerId: string, tenantId: string) => ({
  customerId,
  tenantId,
  orderType: 'TAXI' as const,
  status: { in: [...ACTIVE_TAXI_STATUSES] },
});

const rideInProgress = () => new AppError(
  409,
  'RIDE_IN_PROGRESS',
  'You already have an active ride',
);

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
  /** [TAXI multi-stop] The intermediate stops, validated and numbered by
   *  planTaxiStops (the switch, the count, each stop, the market). Absent or
   *  empty: a ride without stops, created exactly as before. */
  stops?: readonly TaxiStopPlan[];
  /** [TAXI multi-stop] The route fare the passenger was quoted for exactly
   *  this itinerary and tier (whole units). Required with stops, compared with
   *  the server's own fare and never used as the price. Ignored without stops. */
  expectedFare?: number;
}

/**
 * [TAXI multi-stop 3/8] The request's command identity, the checkout way
 * (customer.routes /checkout, order/checkout-outbox): the customer's
 * Idempotency-Key and the request's fingerprint. The receipt is written INSIDE
 * the ride's own transaction, and checkout_receipts is unique on (userId,
 * idempotencyKey), so one key can never make two rides, whatever Redis
 * remembers. A ride request's key is stored in its own namespace
 * (rideRequestReceiptKey), never mistaken for a checkout's.
 */
export interface RideRequestCommand {
  idempotency?: { key: string; requestHash: string };
  /** Told the moment the ride's transaction committed: from then on the ride
   *  exists, whatever happens after it. */
  onCommitted?: (committed: { orderId: string; receiptId: string | null }) => void;
}

/** The receipt namespace of a ride request's Idempotency-Key. */
export function rideRequestReceiptKey(idempotencyKey: string): string {
  return `taxi-request:${idempotencyKey}`;
}

/** The Redis key of a ride request's in-flight claim. */
export function rideRequestClaimKey(userId: string, idempotencyKey: string): string {
  return `ride-request:idem:${userId}:${idempotencyKey}`;
}

/** The answer to a ride request. A ride without stops has exactly the keys it
 *  has always had; a ride with stops adds stopCount and stops. */
export interface RideRequestAnswer {
  ride: {
    id: string;
    orderNumber: string;
    status: string;
    fare: number;
    rideClass: RideClass;
    currencyCode: string;
    fareSource: string;
    distanceKm: number;
    durationMin: number;
    ridePin: string | null;
    pickupAddress: string;
    dropoffAddress: string;
    stopCount?: number;
    stops?: TaxiStopPreview[];
  };
  message: string;
}

/** What a receipt keeps of the answer: everything but the PIN, a secret the
 *  order row already holds and a replay reads from there. */
type RideAnswerFacts = Omit<RideRequestAnswer['ride'], 'ridePin' | 'stopCount'>;

/** ONE place shapes the answer, in one key order, for the fresh request and
 *  for every replay of it. */
export function shapeRideRequestAnswer(facts: RideAnswerFacts, ridePin: string | null): RideRequestAnswer {
  const stops = facts.stops ?? [];
  return {
    ride: {
      id: facts.id,
      orderNumber: facts.orderNumber,
      status: facts.status,
      fare: facts.fare,
      rideClass: facts.rideClass,
      currencyCode: facts.currencyCode,
      fareSource: facts.fareSource,
      distanceKm: facts.distanceKm,
      durationMin: facts.durationMin,
      ridePin,
      pickupAddress: facts.pickupAddress,
      dropoffAddress: facts.dropoffAddress,
      ...(stops.length > 0 ? { stopCount: stops.length, stops: stopPreview(stops) } : {}),
    },
    message: 'Looking for a driver near you…',
  };
}

/** A stored receipt's answer, shaped again with the ride's current PIN. */
export function replayRideRequestAnswer(result: Prisma.JsonValue, ridePin: string | null): RideRequestAnswer {
  const ride = (result as { ride?: RideAnswerFacts } | null)?.ride;
  if (!ride || typeof ride.id !== 'string') {
    throw new Error('ride request receipt holds no ride answer');
  }
  return shapeRideRequestAnswer(ride, ridePin);
}

/** [CHECKOUT-IDEM, the ride's twin] The database could not confirm whether
 *  the ride committed (its transaction failed after its work was done, and no
 *  receipt proves it). Not a refusal: the ride may exist. The claim on the key
 *  is kept for a short settle window, and the passenger checks the active ride
 *  instead of booking again. */
export class RideRequestOutcomeUnknownError extends AppError {
  constructor() {
    super(503, 'RIDE_REQUEST_OUTCOME_UNKNOWN', 'We could not confirm your ride yet. Check your active ride before you book again.');
  }
}

/** The server's fare for this itinerary and tier is not the one the passenger
 *  was shown: nothing is booked, and the answer names the fare now. */
function fareChanged(expectedFare: number | undefined, fare: number, rideClass: RideClass, currencyCode: string): AppError {
  return new AppError(409, 'FARE_CHANGED',
    'The fare for this trip has changed. Check the new fare, then book again.',
    { expectedFare: expectedFare ?? null, fare, rideClass, currencyCode });
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
    select: { id: true, tenantId: true, countryCode: true, trustLevel: true, selfieCapturedAt: true, tenant: { select: { kind: true } } },
  });

  // [REVIEW-PARTNER · DL-5] The store-review fiction books no rides: its taxi
  // driver's board stays honestly empty, and nothing — no order, no queue
  // entry, no dispatch, no SMS — is written. First, so no other gate (a
  // selfie, an ID check through a provider) is ever asked of a reviewer.
  if (user.tenant.kind === 'REVIEW') throw new ReviewDemoOrderRefusedError(REVIEW_DEMO_NO_BOOKINGS_MESSAGE);

  const active = await app.prisma.order.findFirst({
    where: activeTaxiWhere(user.id, user.tenantId),
    select: { id: true },
  });
  if (active) {
    throw rideInProgress();
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
  /** [TAXI multi-stop 3/8] The command's identity (Idempotency-Key) and its
   *  commit listener; the route passes them, the queue scan does not. */
  command: RideRequestCommand = {},
): Promise<{
  order: { id: string; orderNumber: string; status: string };
  estimate: { fare: number; currencyCode: string; distanceKm: number; durationMin: number; source: string };
  ridePin: string;
  answer: RideRequestAnswer;
}> {
  // [TAXI multi-stop] Validated and numbered by the caller (planTaxiStops);
  // none for a ride without stops, which takes exactly the path it always has.
  const stops = body.stops ?? [];
  if (stops.length === 0) assertRoadTripInMarket(body);
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

  // [M-34] Zone pricing is the order's tenant's, in the rider's country.
  // [TAXI multi-stop] A ride with stops is priced as ONE trip over its whole
  // road (fare.service estimateItineraryTiers: base and minimum once, no fee
  // per stop); it refuses a zone-priced route (409) and a route the engine
  // cannot drive (503) rather than guess.
  const itineraryEstimate: ItineraryEstimate | null = stops.length === 0
    ? null
    : await fareService.estimateItineraryTiers(body.pickup, stops, body.dropoff, user.countryCode, orderTenantId);
  const tiered: TieredEstimate = itineraryEstimate
    ?? await fareService.estimateTiers(body.pickup, body.dropoff, user.countryCode, orderTenantId);
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

  // [TAXI multi-stop] The passenger books the route fare they were shown, or
  // nothing: a fare that moved since the quote (rates, the road, the tier) is
  // shown to them again before anything is written. The order always stores
  // the SERVER's fare; the passenger's number is only ever compared. A caller
  // that sent no quoted fare at all (the route refuses that first, 400
  // EXPECTED_FARE_REQUIRED) is refused here too: nothing is booked unseen.
  if (stops.length > 0 && body.expectedFare !== tier.fare) {
    throw fareChanged(body.expectedFare, tier.fare, body.rideClass, tiered.currencyCode);
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
  // The leg that ENDS at each stop, as priced: frozen on the stop row.
  const legs = itineraryEstimate?.legs ?? [];

  assertL2(user);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCount = await app.prisma.order.count({ where: { placedAt: { gte: today } } });

  // PIN is verified by the driver at pickup (mandatory for taxi)
  // 6-digit identity PIN from a CSPRNG (not Math.random) — verified by the
  // driver and attempt-capped (driver.routes MAX_PIN_ATTEMPTS).
  const ridePin = newRidePin();

  // [TAXI multi-stop] Set once the transaction's work is done: a failure after
  // this point came from the commit itself, and its outcome is unknown.
  let staged = null as { order: { id: string; orderNumber: string; status: string }; facts: RideAnswerFacts; receiptId: string | null } | null;
  const committed = await app.prisma.$transaction(async (tx) => {
    await lockActiveOrderCustomer(tx, user.id, orderTenantId);

    // The pre-flight check above preserves the request's historical error
    // precedence, but it cannot serialize two overlapping hails. The customer
    // row lock does: after a competing creation commits, this transaction sees
    // its active TAXI row before it is allowed to insert another. Both the HTTP
    // route and queue auto-hail share this exact authority boundary.
    const active = await tx.order.findFirst({
      where: activeTaxiWhere(user.id, orderTenantId),
      select: { id: true },
    });
    if (active) {
      throw rideInProgress();
    }

    const created = await tx.order.create({
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
        // [M-36] The ride's money is in the estimate's currency — stamped on the order.
        currencyCode: estimate.currencyCode,
        subtotalBase: estimate.fare,
        subtotalMarkup: 0,
        subtotalCustomer: estimate.fare,
        deliveryFee: 0,
        totalAmount: estimate.fare,
        paymentMethod: 'CASH',
        ridePin,
        // [TAXI multi-stop] The itinerary, frozen with the ride in the same
        // commit: the stop count on the order, one row per intermediate stop in
        // the passenger's order, each with the priced leg that ends at it. The
        // pickup and the FINAL destination stay in pickup* / delivery*, and the
        // distance, minutes and fare above are the whole route's. A stop row
        // carries its ride's tenant (the lineage trigger proves it).
        ...(stops.length > 0 ? {
          taxiStopCount: stops.length,
          taxiStops: {
            create: stops.map((stop, i) => ({
              tenantId: orderTenantId,
              sequence: stop.sequence,
              lat: stop.lat,
              lng: stop.lng,
              address: stop.address,
              legMeters: legs[i]?.meters ?? null,
              legSeconds: legs[i]?.seconds ?? null,
            })),
          },
        } : {}),
        statusHistory: {
          create: {
            status: 'PENDING',
            changedBy: user.id,
            note: stops.length === 0
              ? `Ride requested — fixed fare $${estimate.fare}`
              : `Ride requested — fixed fare $${estimate.fare}, ${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}`,
          },
        },
      },
    });

    const facts: RideAnswerFacts = {
      id: created.id,
      orderNumber: created.orderNumber,
      status: created.status,
      fare: estimate.fare,
      rideClass: body.rideClass,
      currencyCode: estimate.currencyCode,
      fareSource: estimate.source,
      distanceKm: estimate.distanceKm,
      durationMin: estimate.durationMin,
      pickupAddress: body.pickupAddress,
      dropoffAddress: body.dropoffAddress,
      ...(stops.length > 0 ? { stops: stopPreview(stops) } : {}),
    };
    // [TAXI multi-stop · CHECKOUT-IDEM] The command's one answer commits WITH
    // the ride: a same-key retry is answered from here even if Redis forgot,
    // and a second insert under the same key rolls its whole ride back.
    const receiptId = command.idempotency
      ? await persistCheckoutReceiptInTransaction(tx, {
        userId: user.id,
        tenantId: orderTenantId,
        idempotencyKey: command.idempotency.key,
        requestHash: command.idempotency.requestHash,
        orderIds: [created.id],
        result: { ride: facts },
      })
      : null;
    staged = { order: { id: created.id, orderNumber: created.orderNumber, status: created.status }, facts, receiptId };
    return staged;
  }).catch(async (error: unknown) => {
    // The transaction's work never finished: COMMIT was never sent, so it rolled back.
    if (!staged) {
      // [DISPATCH 1/3] orders_one_live_taxi_per_customer_key: the database itself
      // refuses a second live taxi for one customer. The lock and check above make
      // this a belt (a live ride under another tenant is the one shape they miss);
      // it answers exactly as the check does, never with a raw constraint error.
      const e = error as { code?: unknown; meta?: { target?: unknown } } | null;
      if (e?.code === 'P2002' && String(e.meta?.target ?? '').includes('customerId')) throw rideInProgress();
      // The same key's receipt is already there: another request under this key committed first.
      if (command.idempotency && e?.code === 'P2002' && String(e.meta?.target ?? '').includes('idempotencyKey')) {
        throw new AppError(409, 'DUPLICATE_REQUEST', 'This ride is already being requested — hold on.');
      }
      throw error;
    }
    // The work was done and the commit failed or lost its answer. Without a
    // key the error stands as it always has; with one, only the durable receipt
    // can say whether the ride exists.
    if (!command.idempotency) throw error;
    return settleRideRequestCommit(app.prisma, staged, error);
  });
  const order = committed.order;
  try {
    command.onCommitted?.({ orderId: order.id, receiptId: committed.receiptId });
  } catch (err) {
    log().error({ err, orderId: order.id }, '[TAXI multi-stop] a ride commit listener threw; ignored, the ride is committed');
  }

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

  return {
    order: { id: order.id, orderNumber: order.orderNumber, status: order.status },
    estimate,
    ridePin,
    answer: shapeRideRequestAnswer(committed.facts, ridePin),
  };
}

/**
 * [TAXI multi-stop · CHECKOUT-IDEM, the ride's twin] Settle a ride request
 * whose transaction rejected AFTER its work was done: the rejection came from
 * the commit (an error, or an answer lost after the database committed), so
 * the outcome is unknown and only the durable receipt can settle it. Present:
 * the ride committed, carry on. Absent or unreadable: the outcome stays
 * unknown, and the caller keeps its claim on the key for the settle window.
 */
async function settleRideRequestCommit<T extends { order: { id: string }; receiptId: string | null }>(
  prisma: PrismaClient,
  staged: T,
  err: unknown,
): Promise<T> {
  let landed = false;
  try {
    landed = staged.receiptId !== null
      && (await prisma.checkoutReceipt.count({ where: { id: staged.receiptId } })) === 1;
  } catch (readErr) {
    log().error({ err: readErr, orderId: staged.order.id }, '[TAXI multi-stop] the ride receipt could not be read to settle an unknown commit');
  }
  if (landed) {
    log().warn({ err, orderId: staged.order.id }, '[TAXI multi-stop] ride commit answer lost; the durable receipt proves the ride committed');
    return staged;
  }
  log().error({ err, orderId: staged.order.id }, '[TAXI multi-stop] ride commit outcome unknown and no receipt yet; the claim is kept');
  throw new RideRequestOutcomeUnknownError();
}
