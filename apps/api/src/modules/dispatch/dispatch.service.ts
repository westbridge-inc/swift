import { randomUUID } from 'node:crypto';
import type { PrismaClient, RideClass, VehicleType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { getMapsProvider, type MapsProvider } from '../../providers/maps/maps-provider';
import { classesAtOrAbove } from '../rides/fare.service';
import { closeOnlineSession } from '../rider/online-hours';
import { rankCandidates, applyFairnessBand, type DispatchCandidate } from './scoring';
import { algoConfig } from '../algo/algo-config';
import { foodAgeLimitMinutes, foodAge, retireTooOldOrder, rescueIncentiveGyd, grantRescueIncentive, incentiveKey } from './rescue';
import { recordDecision } from '../algo/decisions';
import { TERMINAL_ORDER_STATUSES, DRIVER_PRE_CUSTODY_STATUSES } from '../order/order-status';
import { customerTrustSummaries } from '../cash/cash-rules.service';
import { estimateLoad, requiredPackageSizeForOrder, totalBulkUnits, DEFAULT_LOAD_BANDS } from '../../utils/load';
import { HANDOVER_SECRETS_OMIT } from '../handover/handover-security';
import { notSelfDeliveredFilter } from '../fulfillment/fulfillment-mode';
import { vehicleTypesForPackageSize, VEHICLE_CLASSES } from '../../config/vehicle-classes';
import { freshRidePinReset } from '../rides/ride-pin';
import { log } from '../../utils/logger';
import { dispatchSearchesCounter, dispatchTimeToAssign } from '../../plugins/observability';
import { getTenantId } from '../../plugins/tenant-context';
import { clampDriverFare } from '../../utils/markup';
import { assertMmgFulfilmentAllowed } from '../order/order.service';
import { FloatService, riderFloatForOrder } from './float.service';
import {
  hasTaxiPassengerCustody,
  lockTaxiOrderForCustodyDecision,
} from '../rides/passenger-custody';
import { riderCounterpartySelect } from '../../utils/counterparty';
import { capacityPredicateSql, capacityWhere, riderStackingCapacity, riderLiveLegCount, reserveRiderLeg } from './concurrency-policy';
import { stackVerdict } from './stack-eligibility';

declare module 'fastify' {
  interface FastifyInstance {
    /** Decorated in server.ts when background queues are up */
    dispatchQueue?: Queue;
  }
}

// ---------------------------------------------------------------------------
// Dispatch engine — the most failure-sensitive module.
// Offer -> 20s timeout -> next candidate -> widen radius -> after the last
// round, an HONEST "no movers available" to customer AND vendor. Never a
// silent hang. Acceptance is atomic at the database: ten simultaneous
// accepts resolve to exactly one winner.
// ---------------------------------------------------------------------------

export const OFFER_TIMEOUT_SECONDS = 20;
/** Express really IS faster at the dispatch layer, not just a badge: each
 *  offer expires sooner, so the cascade burns through non-responders and
 *  reaches a willing mover earlier. (The bigger fee is the accept incentive;
 *  this is the mechanical speed-up.) */
export const EXPRESS_OFFER_TIMEOUT_SECONDS = 12;

// SWIFT-062: a courier parcel must only ever reach a mover whose vehicle can
// actually carry it — a bicycle can't take a wardrobe box. Capacity is derived
// from the vehicle-class taxonomy (config/vehicle-classes) — the single source
// of truth — so adding a box truck or canter automatically extends dispatch.
/** Vehicle types that can carry a package of this size (any vehicle if unknown). */
export function vehiclesForPackageSize(size: string | null | undefined): string[] {
  return vehicleTypesForPackageSize(size);
}
/** Can this vehicle carry a parcel of this size? */
export function vehicleCanCarry(vehicleType: string, size: string | null | undefined): boolean {
  return vehiclesForPackageSize(size).includes(vehicleType);
}

const BASE_RADIUS_KM = 5;
const RADIUS_STEP_KM = 5;
const MAX_ROUNDS = 3;
/** One automatic re-sweep after exhaustion — supply changes by the minute. */
export const REDISPATCH_DELAY_MS = 90_000;
/** Express orders retry the sweep sooner too. */
export const EXPRESS_REDISPATCH_DELAY_MS = 45_000;
/** How many exhaustion cycles before dispatch gives up for good [SWIFT-065].
 *  Attempts 1..CAP-1 schedule one more re-sweep; the CAP-th is TERMINAL — no
 *  further cascade, admins paged exactly once. Env-tunable so a too-eager cap
 *  can be relaxed without a deploy. */
export const EXHAUST_CAP = Math.max(1, Number(process.env['DISPATCH_EXHAUST_CAP'] ?? 3));
/** Once exhausted, the attempt counter (and the reconciler's "leave it alone"
 *  signal) persists this long, so a permanently stranded order can't reset the
 *  counter every hour and re-cascade + re-page admins forever [SWIFT-065]. */
export const EXHAUST_TERMINAL_TTL_SECONDS = Math.max(3600, Number(process.env['DISPATCH_EXHAUST_TERMINAL_TTL'] ?? 6 * 3600));
/** GPS silent this long while "online" = the app is gone, not slow. */
export const STALE_LOCATION_MINUTES = 15;
/**
 * Candidate supply is a short renewable lease, not the much longer stranded-
 * trip recovery window above. The mobile foreground heartbeat renews every
 * 30s and native background location renews while the app is suspended.
 */
export function normalizeDispatchLocationFreshSeconds(value: unknown): number {
  const configured = Number(value);
  // Mobile renews every 30s. Three heartbeat windows absorb timer, radio,
  // request, and DB jitter; accepting 30 here would make healthy supply flap.
  return Number.isFinite(configured) ? Math.max(90, configured) : 90;
}
export const DISPATCH_LOCATION_FRESH_SECONDS = normalizeDispatchLocationFreshSeconds(
  process.env['DISPATCH_LOCATION_FRESH_SECONDS'] ?? 90,
);
/** [R-05] TAXI slow lane past the fast cap: re-sweep cadence — the rider's
 *  card says "every minute", so it IS every minute. */
export const TAXI_RESCAN_MS = Math.max(15_000, Number(process.env['TAXI_RESCAN_MS'] ?? 60_000));
/** How long a waiting taxi request keeps re-sweeping before the honest
 *  release (mirrors the ride-queue TTL semantics). */
export const TAXI_WAIT_LIMIT_MIN = Math.max(5, Number(process.env['TAXI_WAIT_LIMIT_MIN'] ?? 30));

/** Straight-line candidate cap. The geo query keeps the N movers with the
 *  smallest great-circle distance; rankCandidates then re-sorts THOSE by real
 *  road ETA and the offer goes to the ETA-best. Great-circle nearest is not
 *  road-ETA nearest across a real network (rivers, one-ways, the single Demerara
 *  bridge), so a mover who is ETA-closest but straight-line #(N+1) is truncated
 *  before scoring ever sees them — but ONLY when more than N movers sit in the
 *  radius, which at launch fleet density effectively never happens. Env-tunable
 *  per market: a dense city raises it to shrink that truncation window, at a
 *  bounded maps-provider cost (the ETA batch already handles N destinations). We
 *  do NOT default it high — the provider bills per element in prod. Read
 *  per-call so ops can size it and the behaviour is testable. */
export function nearestCandidateCap(): number {
  const n = Number(process.env['DISPATCH_NEAREST_CANDIDATE_CAP']);
  return Number.isInteger(n) && n > 0 ? n : 50;
}

/** Taxi rides draw from the driver pool; everything else from riders.
 *  Same scoring, same cascade, same atomic claim — shared code, not a copy. */
export type DispatchPool = 'RIDER' | 'DRIVER';

function poolForOrder(order: { orderType: string }): DispatchPool {
  return order.orderType === 'TAXI' ? 'DRIVER' : 'RIDER';
}

/** Journal vertical (availability spec §3): TAXI | COURIER | DELIVERY. */
function verticalForOrder(order: { orderType: string }): string {
  if (order.orderType === 'TAXI') return 'TAXI';
  if (String(order.orderType).startsWith('COURIER')) return 'COURIER';
  return 'DELIVERY';
}

const offerKey = (orderId: string) => `dispatch:offer:${orderId}`;
/** [ALG-01] Per-rider offer log (sorted set by ms): offers received; declines and expiries apart. */
export const offersSentKey = (riderId: string) => `dispatch:offers-sent:${riderId}`;
export const offerOutcomeKey = (riderId: string, outcomeLog: 'declines' | 'expiries') => `dispatch:offer-${outcomeLog}:${riderId}`;
const OFFER_LOG_TTL_S = 24 * 3600;

/** What a mover collects, hands over, and keeps on a CASH job — or null. */
export type OfferCashMath = {
  collectFromCustomer: number;
  payToVendor: number;
  youKeep: number;
};

/**
 * [WS-6.0] The cash-math triple for the offer card.
 *
 * A mover accepting a CASH job is committing their own float: they collect the
 * whole order total at the door and hand the store its share. The card showed
 * only what they EARN, so the decision was made without the exposure beside it.
 *
 * Every number here is a stored column, never derived arithmetic:
 *
 *   collectFromCustomer  order.totalAmount     — what the customer owes at the door
 *   payToVendor          riderFloatForOrder(order) — `subtotalBase`, the goods
 *                        at the STORE's price, read through THE SAME function
 *                        the float gate commits [G4]. The card can no longer
 *                        name one number while the gate holds another: if
 *                        markup ever made them differ, the reconciliation
 *                        below fails and the card refuses instead.
 *   youKeep              deliveryFee + tipAmount — the SAME expression
 *                        `createEarnings` uses for the earnings rows and for the
 *                        MMG settlement debt. Not a second definition of pay.
 *
 * AND IT REFUSES RATHER THAN GUESSES. The three only describe the money if they
 * reconcile against the order's own totals. `serviceFee`, `taxAmount` and
 * `discount` sit between the subtotal and the total; they are zero today and
 * there is no defined recipient for them in a zero-commission, cash-direct
 * model. If one ever becomes non-zero the split stops being true, so this
 * returns null and the card shows nothing rather than a breakdown that does not
 * add up. A wrong money split on a mover's screen is worse than no split.
 */
export function cashMathForOffer(order: {
  paymentMethod: string;
  totalAmount: unknown;
  subtotalBase: unknown;
  deliveryFee: unknown;
  serviceFee: unknown;
  taxAmount: unknown;
  tipAmount: unknown;
  discount: unknown;
}): OfferCashMath | null {
  if (order.paymentMethod !== 'CASH') return null;

  const n = (v: unknown) => Number(v);
  const total = n(order.totalAmount);
  const vendorShare = riderFloatForOrder(order as { paymentMethod: string; subtotalBase: number });
  const fee = n(order.deliveryFee);
  const tip = n(order.tipAmount);
  const service = n(order.serviceFee);
  const tax = n(order.taxAmount);
  const discount = n(order.discount);

  if (![total, vendorShare, fee, tip, service, tax, discount].every(Number.isFinite)) return null;

  // Reconciliation, in minor units so decimal representation cannot decide it.
  const cents = (v: number) => Math.round(v * 100);
  const keep = fee + tip;
  if (cents(vendorShare) + cents(keep) + cents(service) + cents(tax) - cents(discount) !== cents(total)) {
    return null;
  }
  // With the above satisfied and the extras zero, collect - pay === keep. State
  // it directly rather than trusting the reader to re-derive it.
  if (cents(total) - cents(vendorShare) !== cents(keep)) return null;

  return { collectFromCustomer: total, payToVendor: vendorShare, youKeep: keep };
}
const declinedKey = (orderId: string) => `dispatch:declined:${orderId}`;
/**
 * [REPORT-014 F-014-04] Offer ATTEMPT identity. Both Redis pointers store a
 * composite `<id>:<attemptId>` value (ids are cuids/uuids — no ':' inside), so
 * a re-offer of the same order to the same mover is a DIFFERENT value. Every
 * destructive consumer (timeout job, go-offline release, withdraw) compares
 * the attempt it was armed for; a stale generation-1 job firing while
 * generation 2 is live matches nothing and is a no-op. Values written by
 * pre-attempt deploys are bare ids; wildcard-mode compares accept them so
 * in-flight offers survive the cutover.
 */
function parseOfferValue(value: string): { id: string; attemptId?: string } {
  const i = value.indexOf(':');
  return i === -1 ? { id: value } : { id: value.slice(0, i), attemptId: value.slice(i + 1) };
}
const offerValue = (id: string, attemptId: string) => `${id}:${attemptId}`;
// Advisory reverse index: which order (if any) a mover currently holds an offer
// for. Set beside offerKey with the same TTL so it self-expires; ALWAYS
// re-validated against the authoritative offerKey before use, so a stale
// pointer is a safe no-op, never a wrong release. Lets go-offline find and
// release a live offer without scanning every open order.
const moverOfferKey = (moverId: string) => `dispatch:mover-offer:${moverId}`;
const roundKey = (orderId: string) => `dispatch:round:${orderId}`;
const exhaustKey = (orderId: string) => `dispatch:exhausts:${orderId}`;
const reconciledKey = (orderId: string) => `dispatch:reconciled:${orderId}`;
/** [F-014-06] Short single-flight lock around exhaust() side effects. */
const exhaustLockKey = (orderId: string) => `dispatch:exhaust-lock:${orderId}`;

/** A committed claim must never be surfaced as failed, even if the logger's
 * destination is itself unhealthy while reporting a best-effort side effect. */
function warnAfterClaimCommit(bindings: Record<string, unknown>, message: string): void {
  try {
    log().warn(bindings, message);
  } catch {
    // Canonical database state is already durable.
  }
}

/** An order should have been in the cascade this long before we treat a
 *  missing offer key as LOST STATE rather than an in-flight gap. */
export const RECONCILE_STUCK_MINUTES = 3;
/** Don't reconcile the same order more than once per this window (anti-spam). */
const RECONCILE_COOLDOWN_SECONDS = 600;

/** How the production wiring schedules the timeout check (BullMQ delayed job).
 *  [F-014-04] attemptId rides the job so the timeout can only consume the
 *  exact offer generation it was armed for. */
export type TimeoutScheduler = (orderId: string, riderId: string, delayMs: number, attemptId?: string) => Promise<void>;

/** Schedules a delayed full re-dispatch. Returns false when no queue is up
 *  (tests, degraded boot) so exhaustion falls through to the honest "no
 *  movers" notices instead of promising a retry that will never run. */
export type RedispatchScheduler = (orderId: string, delayMs: number) => Promise<boolean>;

interface GeoCandidateRow {
  id: string;
  userId: string;
  currentLat: number;
  currentLng: number;
  averageRating: number;
  acceptanceRate: number;
  currentOrderId: string | null;
}

export class DispatchService {
  private notifications: NotificationService;

  constructor(
    private prisma: PrismaClient,
    private redis: Redis,
    private io: Server,
    private maps: MapsProvider,
    private scheduleTimeout: TimeoutScheduler = async () => {},
    private scheduleRedispatch?: RedispatchScheduler,
  ) {
    this.notifications = new NotificationService(prisma, io);
  }

  /** Re-read database authority after installing the advisory Redis offer. */
  private async canReceiveOffer(pool: DispatchPool, moverId: string, riderCap = 1): Promise<boolean> {
    const count = pool === 'DRIVER'
      ? await this.prisma.driver.count({
          where: {
            id: moverId,
            isOnline: true,
            isAvailable: true,
            ...capacityWhere('DRIVER'),
            locationSessionId: { not: null },
            user: { status: 'ACTIVE', activeRole: { in: ['MOVER', 'DRIVER'] } },
          },
        })
      : await this.prisma.rider.count({
          where: {
            id: moverId,
            isOnline: true,
            isAvailable: true,
            // capacity checked below against the live leg COUNT — the null
            // pointer stops being the capacity answer under stacking.
            locationSessionId: { not: null },
            user: { status: 'ACTIVE', activeRole: { in: ['MOVER', 'RIDER'] } },
          },
        });
    if (count !== 1) return false;
    if (pool === 'RIDER') {
      // The capacity half of the re-check, from the orders table — the same
      // truth the candidate SQL counted, so the two gates cannot disagree.
      const legs = await riderLiveLegCount(this.prisma, moverId);
      if (legs >= riderCap) return false;
    }
    return true;
  }

  /**
   * Compare-and-delete both Redis offer pointers. A plain GET followed by DEL
   * can erase a newer mover's offer when a role switch and cascade overlap.
   */
  /** [REPORT-014 F-014-09] Post-commit retirement for the RIDER BOARD-GRAB
   *  entrance, which stages its own assignment (stageDirectRiderAssignment)
   *  instead of going through claimOrder — and therefore never finalized the
   *  DispatchSearch journal or retired the Redis offer pair. A live offer left
   *  behind lets a scheduled timeout later decline/penalize a mover for a job
   *  already assigned, and a recoverable ghost offer survives. This mirrors
   *  claimOrder's post-commit cleanup exactly; all steps fire-and-caught (the
   *  assignment already committed). */
  async retireAfterAssignment(orderId: string, moverId: string): Promise<void> {
    try {
      const open = await this.prisma.dispatchSearch.findFirst({
        where: { subjectId: orderId, status: 'SEARCHING' },
        select: { id: true, startedAt: true },
      });
      if (open) {
        const assignedAt = new Date();
        await this.prisma.dispatchSearch.update({
          where: { id: open.id },
          data: { status: 'ASSIGNED', assignedTo: moverId, assignedAt },
        });
        dispatchSearchesCounter.inc({ status: 'assigned' });
        dispatchTimeToAssign.observe((assignedAt.getTime() - open.startedAt.getTime()) / 1000);
      }
    } catch (err) {
      warnAfterClaimCommit({ err, orderId, moverId, pool: 'RIDER' }, 'board-grab journal finalization failed');
    }
    // [REPORT-019 F-019-01] Retire whatever offer generation is still LIVE
    // for this order — which may belong to a DIFFERENT mover than the board
    // winner (the grab bypasses the offer). The old delete keyed on the
    // winner erased THEIR reverse pointer (possibly naming an unrelated live
    // offer, breaking its prompt release) while leaving the actually-offered
    // mover's pointer dangling. Parse the live owner from the forward value
    // and strict-remove exactly that generation pair. A fresh install can't
    // race in behind us: dispatchOrder re-reads the assigned order first.
    await this.retireLiveOfferPair(orderId, moverId, 'RIDER');
  }

  /** Owner-aware post-assignment Redis retirement, shared by the board grab
   *  and claimOrder's own cleanup. Best-effort (assignment already durable). */
  private async retireLiveOfferPair(orderId: string, assignedMoverId: string, pool: DispatchPool): Promise<void> {
    try {
      const live = await this.redis.get(offerKey(orderId));
      if (live) {
        const { id: ownerMoverId, attemptId } = parseOfferValue(live);
        await this.removeOfferIfOwned(orderId, ownerMoverId, attemptId);
      }
      await this.redis.del(declinedKey(orderId), roundKey(orderId), exhaustKey(orderId));
    } catch (err) {
      warnAfterClaimCommit({ err, orderId, moverId: assignedMoverId, pool }, 'post-assignment Redis retirement failed');
    }
  }

  /** [F-014-04] Two compare modes. STRICT (attemptId given — timeout jobs,
   *  go-offline release, install-withdraw): only the exact
   *  `mover:attempt` / `order:attempt` generation is consumed; a stale job
   *  can never delete (or stale-clean the reverse pointer of) a later
   *  generation. WILDCARD (no attemptId — client accept/decline, legacy
   *  in-flight jobs): any generation OWNED BY THIS MOVER matches, including
   *  pre-attempt bare values; safe because the caller is bound to the
   *  authenticated mover, who can only ever consume their own offer. */
  private async removeOfferIfOwned(orderId: string, moverId: string, attemptId?: string): Promise<boolean> {
    const removed = await this.redis.eval(
      `
        local offer = redis.call('GET', KEYS[1])
        local reverse = redis.call('GET', KEYS[2])
        local mine, reverseMine
        if ARGV[3] ~= '' then
          mine = offer == (ARGV[1] .. ':' .. ARGV[3])
          reverseMine = reverse == (ARGV[2] .. ':' .. ARGV[3])
        else
          mine = (offer == ARGV[1])
            or (offer and string.sub(offer, 1, string.len(ARGV[1]) + 1) == (ARGV[1] .. ':'))
          reverseMine = (reverse == ARGV[2])
            or (reverse and string.sub(reverse, 1, string.len(ARGV[2]) + 1) == (ARGV[2] .. ':'))
        end
        if not mine then
          if reverseMine then
            redis.call('DEL', KEYS[2])
          end
          return 0
        end
        redis.call('DEL', KEYS[1])
        if reverseMine then
          redis.call('DEL', KEYS[2])
        end
        return 1
      `,
      2,
      offerKey(orderId),
      moverOfferKey(moverId),
      moverId,
      orderId,
      attemptId ?? '',
    );
    return Number(removed) === 1;
  }

  /** [REPORT-014 F-014-06] Exhaustion is single-flight. The lock is
   *  deliberately SHORT (10s): it dedups a concurrent burst without ever
   *  eating a legitimate later cycle (taxi re-sweeps are >=15s apart,
   *  redispatch delays >=45s — a suppressed cycle there would break the
   *  re-arm chain and strand the order). [REPORT-021 F-021-03] The lock is
   *  OWNER-TOKENED and released on exhaust FAILURE: BullMQ retries a failed
   *  dispatch job in ~5s, inside the lock window — a surviving lock made the
   *  retry a silent no-op and the reconciler then skipped the order for the
   *  whole terminal window. Compare-delete: only the failing owner's own
   *  token is ever released, never a concurrent invocation's lock. */
  private async acquireExhaustLock(orderId: string): Promise<string | null> {
    const token = randomUUID();
    const ok = (await this.redis.set(exhaustLockKey(orderId), token, 'EX', 10, 'NX')) === 'OK';
    return ok ? token : null;
  }

  private async releaseExhaustLock(orderId: string, token: string): Promise<void> {
    await this.redis.eval(
      `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          redis.call('DEL', KEYS[1])
        end
        return 1
      `,
      1,
      exhaustLockKey(orderId),
      token,
    ).catch(() => {});
  }

  /** [REPORT-014 F-014-05] Offer installation is ONE atomic dual-key
   *  reservation: the per-order key (exactly one live offer per order — the
   *  E29 mutual exclusion) AND the per-mover reverse key (exactly one live
   *  offer per mover) are checked and written inside a single Lua script.
   *  The old plain reverse SET let one mover own several order keys while
   *  the singular reverse pointer named only the last — the first card was
   *  unrecoverable by release/recovery yet its timeout still decayed the
   *  mover. No partial state: a taken order or a busy mover leaves both
   *  keys untouched. */
  private async installOfferPair(
    orderId: string,
    moverId: string,
    attemptId: string,
    ttlSeconds: number,
  ): Promise<'OK' | 'ORDER_TAKEN' | 'MOVER_BUSY'> {
    const res = await this.redis.eval(
      `
        if redis.call('EXISTS', KEYS[1]) == 1 then
          return 'ORDER_TAKEN'
        end
        if redis.call('EXISTS', KEYS[2]) == 1 then
          return 'MOVER_BUSY'
        end
        redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
        redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
        return 'OK'
      `,
      2,
      offerKey(orderId),
      moverOfferKey(moverId),
      offerValue(moverId, attemptId),
      offerValue(orderId, attemptId),
      String(ttlSeconds),
    );
    return res as 'OK' | 'ORDER_TAKEN' | 'MOVER_BUSY';
  }

  // -------------------------------------------------------------------------
  // Candidate discovery — PostGIS over the live rider positions
  // -------------------------------------------------------------------------

  /**
   * Availability read (availability spec §1): derived from findCandidates —
   * the EXACT query dispatch pings with, at the base radius. Customers get a
   * bucket and a nearest ETA, never counts or positions. A probe orderId has
   * no declined-set, so nothing is excluded that dispatch wouldn't exclude.
   */
  async getAvailability(
    pool: DispatchPool,
    point: { lat: number; lng: number },
    /** Cash a rider must be able to front (RIDER pool). Match dispatch's float
     *  gate so a checkout probe doesn't count riders dispatch would skip — a
     *  high-value CASH order needs a rider with the headroom to front it. 0
     *  (the browsing default) counts everyone, exactly as before. */
    floatRequired = 0,
    /** Authenticated requests inherit their bound tenant. Background workers
     *  must pass the queue/order tenant explicitly because they intentionally
     *  run without request-local tenant context. */
    tenantId: string | null = getTenantId(),
  ): Promise<{
    level: 'GOOD' | 'LOW' | 'NONE';
    /** Stable client contract: null when no eligible fresh mover exists. */
    nearestEtaMinutes: number | null;
  }> {
    const candidates = await this.findCandidates(
      `availability:${pool}`,
      point,
      BASE_RADIUS_KM,
      pool,
      floatRequired,
      null,
      tenantId,
    );
    const level = candidates.length >= 3 ? 'GOOD' : candidates.length >= 1 ? 'LOW' : 'NONE';
    return {
      level,
      nearestEtaMinutes: candidates[0]
        ? Math.max(1, Math.round(candidates[0].etaMinutes))
        : null,
    };
  }

  async findCandidates(
    orderId: string,
    pickup: { lat: number; lng: number },
    radiusKm: number,
    pool: DispatchPool = 'RIDER',
    floatRequired = 0,
    rideClass?: RideClass | null,
    tenantId: string | null = getTenantId(),
    packageSize?: string | null,
    /** The booking user — never offer a taxi to the person who hailed it (a
     *  dual-role user online as a driver could otherwise be dispatched their own
     *  ride). Omitted on the availability probe, which has no booker. */
    excludeUserId?: string | null,
    /** [REPORT-014 F-014-01] Taxi passenger count: DRIVER candidates must
     *  physically seat the party — rideClass alone maps BUS_9 (9 seats) into
     *  the same GROUP tier as BUS_15 (15 seats). */
    passengerCount?: number | null,
  ): Promise<DispatchCandidate[]> {
    // Stacking: the RIDER pool's live capacity (AlgoConfig, cached ~30s;
    // clamped 1..3; 1 = historical behaviour and the kill switch).
    const riderCap = await riderStackingCapacity(this.prisma);
    const declined = await this.redis.smembers(declinedKey(orderId));
    const locationFreshSince = new Date(Date.now() - DISPATCH_LOCATION_FRESH_SECONDS * 1000);

    // SWIFT-062: a courier parcel only goes to a vehicle that can carry it.
    const capableVehicles = vehiclesForPackageSize(packageSize);
    const vehicleFilter = packageSize
      ? Prisma.sql`AND r."vehicleType"::text = ANY(${capableVehicles})`
      : Prisma.empty;
    // [REPORT-014 F-014-08] Service authorization, not just vehicle capability:
    // a COURIER order (packageSize set) may only go to a rider whose riderType
    // serves courier work, and a food/grocery DELIVERY only to a delivery
    // rider — a DELIVERY-only rider must never be offered/claim a parcel and
    // vice versa. BOTH serves either. (Drivers are the taxi pool — N/A here.)
    const riderTypeFilter = pool === 'RIDER'
      ? (packageSize
          ? Prisma.sql`AND r."riderType"::text = ANY(ARRAY['COURIER','BOTH'])`
          : Prisma.sql`AND r."riderType"::text = ANY(ARRAY['DELIVERY','BOTH'])`)
      : Prisma.empty;

    // A driver's rideClass is the TOP tier their vehicle serves, so only drivers
    // at or above the order's tier are eligible (an XL request never offers to a
    // 4-seat Economy car). Legacy/untagged orders fall back to ECONOMY = all.
    const eligibleClasses = classesAtOrAbove(rideClass ?? 'ECONOMY');

    // Multi-tenancy: these are raw geo queries, so the Prisma tenantScope
    // extension does NOT reach them — an order must only ever be offered to a
    // mover in its OWN tenant. We JOIN the mover's user and filter on its
    // tenantId (the order's tenant when dispatching; the caller's tenant for an
    // availability probe). A null tenant (untagged system/test call) skips the
    // filter and behaves exactly as before.
    const tenantFilter = tenantId ? Prisma.sql`AND u."tenantId" = ${tenantId}` : Prisma.empty;
    // Self-exclusion: a mover never gets offered their own order — a dual-role
    // user hailing a taxi (or ordering a delivery) while online as a mover must
    // not be dispatched their own request. Filters on the joined users row, so
    // the one clause works for both the driver (d) and rider (r) branches.
    const selfFilter = excludeUserId ? Prisma.sql`AND u."id" <> ${excludeUserId}` : Prisma.empty;

    // Straight-line cap (tunable per market). rankCandidates re-ranks the
    // survivors by real road ETA below — see nearestCandidateCap() for why the
    // cap is straight-line and when that matters.
    const cap = nearestCandidateCap();

    const rows = pool === 'DRIVER'
      ? await this.prisma.$queryRaw<GeoCandidateRow[]>`
          SELECT d."id", d."userId", d."currentLat", d."currentLng",
                 d."averageRating", d."acceptanceRate", d."currentRideId" AS "currentOrderId"
          FROM "drivers" d
          JOIN "users" u ON u."id" = d."userId"
          WHERE d."isOnline" = true
            AND d."isAvailable" = true
            ${capacityPredicateSql('DRIVER')}
            AND d."locationSessionId" IS NOT NULL
            AND d."lastLocationUpdate" >= ${locationFreshSince}
            AND u."status" = 'ACTIVE'
            AND u."activeRole" IN ('MOVER', 'DRIVER')
            ${tenantFilter}
            ${selfFilter}
            AND d."rideClass"::text = ANY(${eligibleClasses})
            ${passengerCount != null ? Prisma.sql`AND d."vehicleCapacity" >= ${passengerCount}` : Prisma.empty}
            AND d."currentLat" IS NOT NULL
            AND d."currentLng" IS NOT NULL
            AND ST_DWithin(
              geography(ST_MakePoint(d."currentLng", d."currentLat")),
              geography(ST_MakePoint(${pickup.lng}, ${pickup.lat})),
              ${radiusKm * 1000}
            )
          -- SWIFT-142: nearest-first BEFORE the cap, so with more movers than the
          -- cap in range the pool is the CLOSEST ones, not an arbitrary set the
          -- index happened to return (which could drop the mover at the door).
          -- Cap is straight-line + tunable (nearestCandidateCap); ETA re-rank below.
          ORDER BY ST_Distance(
            geography(ST_MakePoint(d."currentLng", d."currentLat")),
            geography(ST_MakePoint(${pickup.lng}, ${pickup.lat}))
          ) ASC
          LIMIT ${cap}
        `
      : await this.prisma.$queryRaw<GeoCandidateRow[]>`
          SELECT r."id", r."userId", r."currentLat", r."currentLng",
                 r."averageRating", r."acceptanceRate", r."currentOrderId"
          FROM "riders" r
          JOIN "users" u ON u."id" = r."userId"
          WHERE r."isOnline" = true
            AND r."isAvailable" = true
            ${capacityPredicateSql('RIDER', riderCap)}
            AND r."locationSessionId" IS NOT NULL
            AND r."lastLocationUpdate" >= ${locationFreshSince}
            AND u."status" = 'ACTIVE'
            AND u."activeRole" IN ('MOVER', 'RIDER')
            ${tenantFilter}
            ${selfFilter}
            ${vehicleFilter}
            ${riderTypeFilter}
            AND (r."floatLimit" - r."committedFloat") >= ${floatRequired}
            AND r."currentLat" IS NOT NULL
            AND r."currentLng" IS NOT NULL
            AND ST_DWithin(
              geography(ST_MakePoint(r."currentLng", r."currentLat")),
              geography(ST_MakePoint(${pickup.lng}, ${pickup.lat})),
              ${radiusKm * 1000}
            )
          -- SWIFT-142: nearest-first BEFORE the cap (see the driver branch).
          ORDER BY ST_Distance(
            geography(ST_MakePoint(r."currentLng", r."currentLat")),
            geography(ST_MakePoint(${pickup.lng}, ${pickup.lat}))
          ) ASC
          LIMIT ${cap}
        `;

    let eligible = rows.filter((r) => !declined.includes(r.id));
    if (eligible.length === 0) return [];

    // Safety exclusions [safety spec §8.5/§8.3] and user blocks [STORE-002].
    // Keyed on the BOOKING user (excludeUserId at the real dispatch call; null
    // on availability probes, so the hot browse path pays nothing): a mover who
    // shares an incident case with this customer — either direction — is never
    // matched with them again (retaliation guard), a SHADOW_RESTRICTED mover is
    // excluded from enhanced-monitoring passengers pending review, and either
    // party having blocked the other keeps them apart.
    if (excludeUserId && eligible.length > 0) {
      const safetyExcluded = await this.safetyExcludedUserIds(excludeUserId, eligible.map((r) => r.userId), pool);
      if (safetyExcluded.size > 0) {
        eligible = eligible.filter((r) => !safetyExcluded.has(r.userId));
        log().warn({ orderId, customerUserId: excludeUserId, excluded: safetyExcluded.size }, 'dispatch: safety or block exclusions removed candidates from the pool');
        if (eligible.length === 0) return [];
      }
    }

    // [E5 / danger #13] The journey being ranked is MOVER → PICKUP; the old
    // call routed pickup→mover, which directed roads (one-way systems) can
    // rank differently. Haversine masked it; routed providers no longer do.
    const etas = await this.maps.etaMinutesFrom(
      eligible.map((r) => ({ lat: r.currentLat, lng: r.currentLng })),
      pickup,
    );

    const candidates = eligible.map((r, i) => ({
      riderId: r.id,
      userId: r.userId,
      etaMinutes: etas[i] ?? 60,
      averageRating: r.averageRating,
      acceptanceRate: r.acceptanceRate,
      hasActiveJob: r.currentOrderId !== null,
    }));

    // Taxi (DRIVER pool) ranks proximity near-absolute — the rider watches the
    // car on the map; a farther-but-better car offered first reads as broken.
    const profile = pool === 'DRIVER' ? 'PROXIMITY' : 'BALANCED';
    const ranked = rankCandidates(candidates, profile);
    return this.fairnessBand(orderId, ranked, profile);
  }

  /**
   * [ALG-01] The fairness band on top of the pure ranking: effectively-equal
   * candidates are reordered by fewest offers received in the window, then
   * longest since their last offer. SHADOW until `fairness.enabled`: the
   * reorder is recorded as evidence and the ranking is returned unchanged.
   * Live, a reorder that changed the order is recorded too. Never throws
   * into dispatch — a failed read means the pure ranking, as today.
   */
  private async fairnessBand<T extends DispatchCandidate>(orderId: string, ranked: T[], profile: 'BALANCED' | 'PROXIMITY'): Promise<T[]> {
    if (ranked.length < 2) return ranked;
    try {
      const [enabled, band, windowMin] = await Promise.all([
        algoConfig(this.prisma, 'fairness.enabled'),
        algoConfig(this.prisma, 'fairness.band'),
        algoConfig(this.prisma, 'fairness.windowMinutes'),
      ]);
      const windowMs = Math.min(24 * 60, Math.max(5, Number(windowMin.value) || 60)) * 60_000;
      const since = Date.now() - windowMs;
      const offersInWindow = new Map<string, number>();
      const lastOfferAt = new Map<string, number>();
      for (const c of ranked) {
        const [count, last] = await Promise.all([
          this.redis.zcount(offersSentKey(c.riderId), since, '+inf'),
          this.redis.zrevrange(offersSentKey(c.riderId), 0, 0, 'WITHSCORES'),
        ]);
        offersInWindow.set(c.riderId, count);
        if (last[1]) lastOfferAt.set(c.riderId, Number(last[1]));
      }
      const r = applyFairnessBand(ranked, profile, { band: Math.min(0.5, Math.max(0, Number(band.value) || 0)), offersInWindow, lastOfferAt });
      const live = Boolean(enabled.value);
      if (r.changed) {
        await recordDecision(this.prisma, {
          algo: 'ALG-01', subjectType: 'ORDER', subjectId: orderId, outcome: live ? 'REORDERED' : 'WOULD_REORDER', shadow: !live,
          sentence: `${live ? 'The' : 'Shadow: the'} fairness band moved ${r.order[0]!.riderId === ranked[0]!.riderId ? 'a lower position' : 'the first offer'} to the rider with fewer offers this hour (${r.groups.length} tied group${r.groups.length === 1 ? '' : 's'}).`,
          inputs: {
            profile, band: Number(band.value), windowMinutes: Number(windowMin.value),
            before: ranked.slice(0, 5).map((c) => c.riderId), after: r.order.slice(0, 5).map((c) => c.riderId),
            offersInWindow: Object.fromEntries([...offersInWindow].filter(([id]) => ranked.slice(0, 5).some((c) => c.riderId === id))),
            groups: r.groups,
          },
          configVersion: Math.max(enabled.version, band.version, windowMin.version),
        });
      }
      return live ? r.order : ranked;
    } catch (err) {
      log().warn({ err, orderId }, 'dispatch: fairness band skipped — pure ranking used');
      return ranked;
    }
  }

  /** Safety-driven pool exclusions (spec §8.5 retaliation guard + §8.3
   *  SHADOW_RESTRICTED) plus the customer's own blocks [STORE-002]. Three
   *  indexed reads, only when a booking user exists AND candidates survived
   *  the geo query — never on availability probes. */
  private async safetyExcludedUserIds(customerUserId: string, candidateUserIds: string[], pool: DispatchPool): Promise<Set<string>> {
    const excluded = new Set<string>();
    // §8.5: subject and reporter on ANY shared case (365d, either direction)
    // are never matched by dispatch again. Retaliation risk doesn't care who
    // reported whom.
    const pairs = await this.prisma.incidentCase.findMany({
      where: {
        createdAt: { gte: new Date(Date.now() - 365 * 86_400_000) },
        OR: [
          { reporterUserId: customerUserId, subjectUserId: { in: candidateUserIds } },
          { subjectUserId: customerUserId, reporterUserId: { in: candidateUserIds } },
        ],
      },
      select: { subjectUserId: true, reporterUserId: true },
      take: 100,
    });
    for (const p of pairs) {
      if (p.subjectUserId !== customerUserId) excluded.add(p.subjectUserId);
      if (p.reporterUserId && p.reporterUserId !== customerUserId) excluded.add(p.reporterUserId);
    }
    // §8.3: SHADOW_RESTRICTED movers stay online for the general public but
    // are kept away from enhanced-monitoring passengers pending review.
    const passenger = await this.prisma.user.findUnique({
      where: { id: customerUserId },
      select: { enhancedSafetyMonitoring: true },
    });
    if (passenger?.enhancedSafetyMonitoring) {
      const restricted =
        pool === 'DRIVER'
          ? await this.prisma.driver.findMany({ where: { userId: { in: candidateUserIds }, safetyShadowRestrictedAt: { not: null } }, select: { userId: true } })
          : await this.prisma.rider.findMany({ where: { userId: { in: candidateUserIds }, safetyShadowRestrictedAt: { not: null } }, select: { userId: true } });
      for (const r of restricted) excluded.add(r.userId);
    }
    // [STORE-002] A block the customer placed themselves. This belongs in the
    // same set as §8.5 rather than in a filter of its own: the retaliation
    // guard above already says "these two are never matched again", and a
    // block is that same policy stated by the person instead of by an incident
    // case. Symmetric, so a mover who blocked this customer is also kept away
    // — the mover's refusal is as real as the customer's.
    //
    // Bounded to the candidates actually in front of us, so the cost is one
    // indexed read over a short id list and does not grow with how many people
    // the customer has ever blocked.
    //
    // Deliberately keyed on ids and not on tenantId, unlike the rest of the
    // moderation module. A user id belongs to exactly one tenant, so an
    // id-bounded read cannot cross the wall — while THREADING tenantId here
    // would fail OPEN: dispatch also runs from sockets and workers where
    // getTenantId() is null, and `where: { tenantId: null }` matches no rows,
    // which would silently stop excluding anybody. Fail-closed by construction
    // beats a scope that is only correct on the HTTP path.
    const blocked = await this.prisma.userBlock.findMany({
      where: {
        unblockedAt: null,
        OR: [
          { blockerId: customerUserId, blockedId: { in: candidateUserIds } },
          { blockedId: customerUserId, blockerId: { in: candidateUserIds } },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
    for (const b of blocked) {
      excluded.add(b.blockerId === customerUserId ? b.blockedId : b.blockerId);
    }
    return excluded;
  }

  // -------------------------------------------------------------------------
  // The offer loop
  // -------------------------------------------------------------------------

  /** Start (or continue) dispatching an order. Idempotent per active offer. */
  async dispatchOrder(
    orderId: string,
    /** Optional worker provenance. The order remains authoritative, but a
     *  stale/malformed job cannot dispatch an ID from a different tenant. */
    expectedTenantId?: string,
  ): Promise<{ offered?: string; exhausted?: boolean }> {
    // Stacking: live RIDER capacity for this cascade round (cached ~30s; 1 =
    // historical behaviour and the kill switch).
    const riderCap = await riderStackingCapacity(this.prisma);
    // [F-014-06] The old widen/withdraw recursion is one flat loop: every
    // pass re-reads order authority (status can change mid-cascade), and the
    // terminal exhaust below is SINGLE-FLIGHT so concurrent triggers of one
    // logical search can't burn several lifecycle attempts or double-notify.
    dispatchRound: for (;;) {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true, status: true, riderId: true, driverId: true, orderType: true,
          fulfillment: true, orderNumber: true, rideClass: true, isExpress: true, courierPackageSize: true,
          customerId: true, pickupLat: true, pickupLng: true, taxiPassengerCount: true,
          subtotalBase: true, paymentMethod: true, paymentStatus: true, tenantId: true, readyAt: true, foodAgeHeldAt: true, foodAgeWaivedAt: true,
          // [WS-6.0] The cash-math triple. A mover deciding on a CASH job is
          // deciding how much of their OWN float to commit, and the card used
          // to show only what they earn. Every number is a stored column, not
          // an arithmetic guess — see `cashMathForOffer`.
          totalAmount: true, subtotalCustomer: true, deliveryFee: true,
          serviceFee: true, taxAmount: true, tipAmount: true, discount: true,
          vendor: { select: { name: true, owner: { select: { userId: true } } } },
          items: { select: { quantity: true, bulkUnits: true } },
        },
      });
      if (!order) throw new NotFoundError('Order', orderId);
      if (expectedTenantId && order.tenantId !== expectedTenantId) {
        throw new AppError(409, 'DISPATCH_TENANT_MISMATCH', 'Dispatch job tenant does not own this order');
      }

      const pool = poolForOrder(order);
      if (pool === 'RIDER') {
        if (order.riderId || order.fulfillment !== 'DELIVERY') return {};
        if (!['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status)) return {};
        // [TA-S0-001 hold] Held for a person: too old to deliver and already
        // paid by MMG. Not ours to offer until an operator decides.
        if (order.foodAgeHeldAt) return {};
      } else {
        if (order.driverId) return {};
        if (order.status !== 'PENDING') return {};
      }
      if (order.pickupLat == null || order.pickupLng == null) return {};

      // [ALG-06 ②] Food-age cutoff: an order nobody could deliver in time is
      // too old to deliver — a person, not another cascade. Marks nobody.
      if (pool === 'RIDER' && order.readyAt) {
        // [hold v3] An operator's "deliver anyway" is durable: the cutoff no
        // longer applies to this order, so it is dispatched like any other.
        const limit = order.foodAgeWaivedAt ? null : await foodAgeLimitMinutes(this.prisma, order.orderType, order.tenantId);
        const age = foodAge({ readyAt: order.readyAt }, limit);
        if (age.tooOld && age.ageMinutes != null && limit != null) {
          await retireTooOldOrder({ prisma: this.prisma, redis: this.redis, io: this.io, notifications: this.notifications }, order, age.ageMinutes, limit);
          return { exhausted: true };
        }
      }

      // One live offer at a time
      const existing = await this.redis.get(offerKey(orderId));
      if (existing) return { offered: parseOfferValue(existing).id };

      const round = Number((await this.redis.get(roundKey(orderId))) ?? 0);
      // [ALG-06 ①] The cascade this search is on (exhausted attempts + 1). From
      // `rescue.incentiveFromCascade` the offer carries Swift's OWN money as an
      // incentive (ALG-INV-19) — 0 until the founder sets an amount.
      const cascade = Number((await this.redis.get(exhaustKey(orderId))) ?? 0) + 1;
      const rescueGyd = pool === 'RIDER' ? await rescueIncentiveGyd(this.prisma, cascade, order.tenantId) : 0;
      if (rescueGyd > 0) await this.redis.set(incentiveKey(orderId), JSON.stringify({ amountGyd: rescueGyd, cascade }), 'EX', 3600).catch(() => {});
      const radius = BASE_RADIUS_KM + round * RADIUS_STEP_KM;
      // Search journal (§3): open/refresh the record BESIDE the state machine —
      // fire-and-caught, never load-bearing for the cascade itself.
      await this.journalOpenSearch(order, round, radius);
      // D.3 — a rider must have enough free float to front this order's vendor-cash (CASH deliveries only).
      const floatRequired = pool === 'RIDER' ? riderFloatForOrder(order) : 0;
      const candidates = await this.findCandidates(orderId, { lat: order.pickupLat, lng: order.pickupLng }, radius, pool, floatRequired, order.rideClass, order.tenantId, order.courierPackageSize, order.customerId, order.taxiPassengerCount);

      // [G1 SHADOW] What a load gate WOULD demand, and what it WOULD cost.
      //
      // Changes nothing. It exists to answer the one question that decides
      // whether this may ever be enforced: how much of the rider pool would the
      // gate remove, and would it have removed riders from jobs that completed
      // perfectly well? Turning the filter on without that evidence trades a
      // visible failure (a rider who cannot carry it) for an invisible one
      // (nothing dispatches, and nobody is paged) — which is worse.
      //
      // Wrapped, and deliberately so: a classification bug must never stop a
      // dispatch. A shadow that can take the cascade down is not a shadow, it
      // is an outage.
      this.logLoadGateShadow(order, candidates.length);

      const timeoutSeconds = order.isExpress ? EXPRESS_OFFER_TIMEOUT_SECONDS : OFFER_TIMEOUT_SECONDS;
      // [F-014-05] Walk the ranked candidates: the FIRST who can atomically
      // reserve BOTH the order and themselves gets the card. A mover already
      // holding a live offer elsewhere is skipped, not declined — they did
      // nothing wrong; they simply are not free this instant.
      for (const top of candidates) {
        // [F-014-04] Mint this attempt's identity. It lives in both Redis values,
        // the timeout job, the socket/push/recovery payloads, and the evidence row.
        const attemptId = randomUUID();
        // [E29 / danger #18 + F-014-05] The offer install IS the mutual
        // exclusion — now for BOTH parties. Concurrent triggers for one order
        // (route retry + queue job, double webhook, two instances) resolve to
        // exactly one owner and losers emit nothing; and one mover can never
        // hold two live offers at once. One Lua script; no partial writes.
        const installed = await this.installOfferPair(orderId, top.riderId, attemptId, timeoutSeconds + 10);
        if (installed === 'ORDER_TAKEN') {
          const winner = await this.redis.get(offerKey(orderId));
          return winner ? { offered: parseOfferValue(winner).id } : {};
        }
        if (installed === 'MOVER_BUSY') continue;

        // Candidate discovery and offer installation straddle PostgreSQL + Redis.
        // Revalidate after both pointers exist so either role-switch ordering is
        // safe: switch-before-install is caught here; install-before-switch is
        // removed by the switch's releaseHeldOffer call. Never emit to stale supply.
        const stackedOfferBlocked = pool === 'RIDER' && riderCap > 1
          ? await (async () => {
              const legs = await riderLiveLegCount(this.prisma, top.riderId);
              if (legs === 0) return false;
              const v = await stackVerdict(this.prisma, top.riderId, orderId);
              return !v.eligible; // refused pairs are logged inside, rule-named
            })()
          : false;
        if (stackedOfferBlocked || !(await this.canReceiveOffer(pool, top.riderId, riderCap))) {
          const removed = await this.removeOfferIfOwned(orderId, top.riderId, attemptId);
          if (removed) {
            await this.redis.sadd(declinedKey(orderId), top.riderId);
            await this.redis.expire(declinedKey(orderId), 3600);
            log().info({ orderId, moverId: top.riderId, pool }, 'dispatch: withdrew offer after authority changed');
            continue dispatchRound; // fresh ring — the declined set now excludes them
          }
          // Another release already advanced the cascade; do not touch its offer.
          return {};
        }

        // §4d: on a CASH job the mover fronts real money — show them WHO they're
        // fronting it for (trust level, completed orders, strikes) before accept.
        const trust = (await customerTrustSummaries(this.prisma, [order.customerId])).get(order.customerId);

        // §7: a mover judges a big grocery order BEFORE accepting.
        const totalUnits = order.items.reduce((s, i) => s + i.quantity, 0);

        // [F-014-10] FINAL conditional publish proof: the awaited trust/load
        // reads above leave a window where a go-offline release or a role
        // switch retires this exact attempt. Publishing anyway would render a
        // ghost card, write false evidence, and arm a stale timeout. One last
        // ownership read closes the window to ~zero — and the attempt token
        // [F-014-04] makes anything that still slips through a no-op.
        if ((await this.redis.get(offerKey(orderId))) !== offerValue(top.riderId, attemptId)) {
          return {}; // whoever retired it already owns the cascade
        }

        // [ALG-01] The fairness window's source of truth: every offer this
        // rider RECEIVED, by time. Declines and expiries are logged apart
        // (Kerb D5: acceptance rate is information, never a gate).
        await this.redis.zadd(offersSentKey(top.riderId), Date.now(), `${orderId}:${attemptId}`).catch(() => {});
        await this.redis.expire(offersSentKey(top.riderId), OFFER_LOG_TTL_S).catch(() => {});
        try {
          this.io.to(`user:${top.userId}`).emit('dispatch:offer', {
            orderId,
            // [F-014-04] The client echoes this back on accept/decline/seen so
            // those actions bind to exactly this generation (optional — older
            // clients omit it).
            offerAttemptId: attemptId,
            orderNumber: order.orderNumber,
            vendorName: order.vendor?.name,
            // Express = bigger fee for the mover; badge it so they know why.
            isExpress: order.isExpress,
            expiresInSeconds: timeoutSeconds,
            etaMinutes: Math.round(top.etaMinutes),
            // [ALG-06 ①] Swift's own money on top of the fee, or absent.
            rescueIncentiveGyd: rescueGyd > 0 ? rescueGyd : null,
            paymentMethod: order.paymentMethod,
            customerTrust: trust ?? null,
            itemCount: order.items.length,
            estLoad: order.items.length > 0 ? estimateLoad(totalUnits) : null,
            // [WS-6.0] Server-computed, or absent. Null on MMG (the customer
            // already paid the store) and null whenever the numbers do not
            // reconcile — see `cashMathForOffer`.
            cashMath: cashMathForOffer(order),
          });
        } catch (err) {
          // [F-014-10] A socket-layer throw must not strand the installed
          // pair half-published: evidence + timeout below still run, the
          // flag-gated push still fires, and the mover can recover the card
          // via /offers/current.
          log().warn({ err, orderId, moverId: top.riderId }, 'dispatch: offer socket emit failed — evidence/timeout continue');
        }

        // Alert-delivery tracking (§A4): every offer gets a row; the mover's
        // accept/decline stamps acknowledgedAt. Fire-and-caught. The attempt id
        // makes the row evidence about THIS generation only [F-014-04].
        await this.prisma.alertDelivery
          .create({ data: { kind: 'MOVER_OFFER', subjectId: orderId, recipientId: top.userId, offerAttemptId: attemptId } })
          .catch(() => {});

        // Journal (§3): who this wave actually tried — cooldown + "everyone
        // declined" proof for Live Ops.
        await this.prisma.dispatchSearch
          .updateMany({
            where: { subjectId: orderId, status: 'SEARCHING' },
            data: { candidatesTried: { push: top.riderId } },
          })
          .catch(() => {});

        // Loud alerts (alerts spec §A2/§A3, flag-gated): the socket only reaches a
        // FOREGROUNDED app — a mover with the phone in their pocket would sleep
        // through a 30s offer. notifications.send fans out to Expo push (and the
        // notification row survives the offer). Never let alert plumbing fail the
        // offer itself. expiresAt rides along so a late-opening client can drop
        // stale offers instead of showing ghosts.
        if (process.env['ALERTS_LOUD'] === '1') {
          const isTaxi = pool === 'DRIVER';
          await this.notifications
            .send({
              userId: top.userId,
              type: 'ORDER_UPDATE',
              title: isTaxi ? '\u{1F695} Someone nearby needs a pickup' : '\u{1F6F5} Order available nearby',
              body: isTaxi
                ? `~${Math.round(top.etaMinutes)} min away · ${timeoutSeconds}s to accept`
                : `${order.vendor?.name ?? 'A store'} · ~${Math.round(top.etaMinutes)} min away · ${timeoutSeconds}s to accept`,
              audience: 'earner',
              data: {
                kind: 'dispatch_offer',
                orderId,
                offerAttemptId: attemptId,
                expiresAt: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
              },
            })
            .catch(() => {});
        }

        log().info({ orderId, orderNumber: order.orderNumber, moverId: top.riderId, pool, round, attemptId, etaMinutes: Math.round(top.etaMinutes), candidates: candidates.length }, 'dispatch: offer sent');
        try {
          await this.scheduleTimeout(orderId, top.riderId, timeoutSeconds * 1000, attemptId);
        } catch (err) {
          // [F-014-10] No timeout job = a card whose cascade would silently
          // hang until TTL + reconciler while the customer waits on a mover
          // who may never answer. Retire OUR OWN attempt (strict token) and
          // report no offer — the reconciler re-drives the order. The mover
          // is neither declined nor decayed: they did nothing.
          log().error({ err, orderId, moverId: top.riderId, attemptId }, 'dispatch: timeout scheduling failed — offer rolled back');
          await this.removeOfferIfOwned(orderId, top.riderId, attemptId).catch(() => {});
          return {};
        }
        return { offered: top.riderId };
      }

      // Empty ring, or every candidate holds a live offer elsewhere [F-014-05]:
      // widen and retry immediately — distance beats waiting, and reserved
      // movers' offers resolve in seconds.
      if (round + 1 < MAX_ROUNDS) {
        await this.redis.set(roundKey(orderId), String(round + 1), 'EX', 3600);
        continue;
      }
      log().warn({ orderId, orderNumber: order.orderNumber, pool, rounds: MAX_ROUNDS, candidatesInRange: candidates.length }, 'dispatch: exhausted — no offerable movers');
      // [F-014-06] Exhaustion side effects run once per logical search: the
      // NX lock collapses a concurrent burst (route retry + queue job + two
      // instances) to ONE attempt-counter tick, notice set, and re-sweep
      // schedule. Losers still answer exhausted=true honestly.
      const exhaustToken = await this.acquireExhaustLock(orderId);
      if (exhaustToken) {
        try {
          await this.exhaust(order);
        } catch (err) {
          // [F-021-03] A failed exhaust (queue add threw) must not leave the
          // lock standing — the job retry needs to run the real thing.
          await this.releaseExhaustLock(orderId, exhaustToken);
          throw err;
        }
      }
      return { exhausted: true };
    }
  }

  /**
   * [E27 / danger #37] Current-offer recovery: a mover whose socket dropped
   * (network blip, app restart, background kill) could previously NEVER see
   * their live exclusive offer again — the job silently timed out and the
   * miss still counted against their acceptance ranking. This read lets the
   * client rebuild the offer card. The reverse mover pointer is advisory
   * only; ownership is re-proven against the authoritative offerKey, and an
   * offer inside its post-timeout grace tail reports null rather than a card
   * the accept path would refuse.
   */
  async currentOfferFor(moverId: string): Promise<{
    orderId: string;
    /** [F-014-04] The live generation's identity — echoed on accept/decline/seen. */
    offerAttemptId: string | null;
    orderNumber: string;
    vendorName: string | null;
    isExpress: boolean;
    paymentMethod: string | null;
    expiresInSeconds: number;
    itemCount: number;
    estLoad: string | null;
    customerTrust: unknown;
    /** [REPORT-010 F-07] Authoritative money/route facts ride the recovery
     *  payload so the rebuilt card never depends on a separately-fetched
     *  board row for its price (the missing row made Accept submit fare 0). */
    deliveryFee: number;
    tipAmount: number;
    taxiFareTotal: number | null;
    pickupAddress: string | null;
    deliveryAddress: string | null;
    /** [G5] The live card shows "N min away" and the cash box. A card rebuilt
     *  after an app death must show the SAME things, or it is a different card:
     *  a rider who force-quit and reopened would otherwise accept a CASH job
     *  without the exposure the live card had put beside the button. */
    etaMinutes: number | null;
    cashMath: OfferCashMath | null;
    /** [ALG-06 ①] The incentive the live card carried, or null — a rebuilt
     *  card that dropped Swift's bonus would show less money than the live one. */
    rescueIncentiveGyd: number | null;
  } | null> {
    const reverse = await this.redis.get(moverOfferKey(moverId));
    if (!reverse) return null;
    const { id: orderId, attemptId } = parseOfferValue(reverse);
    const owner = await this.redis.get(offerKey(orderId));
    // [F-014-04] The pair must agree on the GENERATION, not just the ids: a
    // stale reverse pointer naming attempt 1 while attempt 2 is live (or a
    // legacy/composite mismatch) is not this mover's recoverable card.
    const expectedOwner = attemptId ? offerValue(moverId, attemptId) : moverId;
    if (owner !== expectedOwner) return null;
    const ttl = await this.redis.ttl(offerKey(orderId));
    // Keys carry timeout+10s; the last 10s are the timeout worker's grace
    // tail. Under ~3s of card time isn't actionable — report gone.
    if (ttl == null || ttl <= 13) return null;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        orderNumber: true, isExpress: true, paymentMethod: true, customerId: true,
        deliveryFee: true, tipAmount: true, taxiFareTotal: true,
        pickupAddress: true, deliveryAddress: true, pickupLat: true, pickupLng: true,
        totalAmount: true, subtotalBase: true, serviceFee: true, taxAmount: true, discount: true,
        status: true, riderId: true, driverId: true, fulfillment: true, orderType: true,
        vendor: { select: { name: true } },
        items: { select: { quantity: true } },
      },
    });
    if (!order) return null;
    // [REPORT-014 F-014-09] The Redis pair is a routing cache; PostgreSQL is
    // the assignment authority. A board/direct grab can commit a winner while
    // this pair lingers — resurrecting the card then invites an accept that
    // can only end ALREADY_TAKEN (and a stale countdown on a dead job). An
    // order that is no longer offerable recovers NOTHING.
    if (order.orderType === 'TAXI') {
      if (order.driverId || order.status !== 'PENDING') return null;
    } else {
      if (
        order.riderId
        || order.fulfillment !== 'DELIVERY'
        || !['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status)
      ) return null;
    }
    const trust = (await customerTrustSummaries(this.prisma, [order.customerId])).get(order.customerId);
    const totalUnits = order.items.reduce((s, i) => s + i.quantity, 0);
    // [G5] The same journey the ranking priced — MOVER → PICKUP — from wherever
    // the mover is NOW. A mover whose position is unknown gets null, never a
    // stale number; the card hides the line rather than guess.
    const mover = (await this.prisma.rider.findUnique({ where: { id: moverId }, select: { currentLat: true, currentLng: true } }))
      ?? (await this.prisma.driver.findUnique({ where: { id: moverId }, select: { currentLat: true, currentLng: true } }));
    let etaMinutes: number | null = null;
    if (mover?.currentLat != null && mover.currentLng != null && order.pickupLat != null && order.pickupLng != null) {
      const [eta] = await this.maps.etaMinutesFrom(
        [{ lat: mover.currentLat, lng: mover.currentLng }],
        { lat: order.pickupLat, lng: order.pickupLng },
      );
      etaMinutes = eta != null && Number.isFinite(eta) ? Math.round(eta) : null;
    }
    return {
      orderId,
      offerAttemptId: attemptId ?? null,
      orderNumber: order.orderNumber,
      vendorName: order.vendor?.name ?? null,
      isExpress: order.isExpress,
      paymentMethod: order.paymentMethod,
      expiresInSeconds: Math.max(0, ttl - 10),
      itemCount: order.items.length,
      estLoad: order.items.length > 0 ? estimateLoad(totalUnits) : null,
      customerTrust: trust ?? null,
      deliveryFee: Number(order.deliveryFee),
      tipAmount: Number(order.tipAmount),
      taxiFareTotal: order.taxiFareTotal != null ? Number(order.taxiFareTotal) : null,
      pickupAddress: order.pickupAddress ?? null,
      deliveryAddress: order.deliveryAddress ?? null,
      etaMinutes,
      rescueIncentiveGyd: await this.rescueIncentiveOn(orderId),
      // The SAME function the live emit calls — one definition of the triple.
      cashMath: cashMathForOffer(order),
    };
  }

  /** §3 journal upkeep: keep ONE open SEARCHING row per subject current
   *  (wave/radius), resolving a prior EXHAUSTED row as RETRIED when a fresh
   *  search begins. Never throws — the journal is beside the machine. */
  /**
   * [G1 SHADOW] Record what a vehicle-capacity gate would have demanded of this
   * order, and how much of the candidate pool it would have cost.
   *
   * READ BY NOBODY IN DISPATCH. The only consumer is the rollout decision.
   *
   * `wouldHaveExcluded: true` on a job that then completes fine is the signal
   * that the bands are too tight — that single field is what says whether this
   * may ever be enforced. `poolAfter` against `poolBefore` is the other half:
   * a gate that removes most of the pool is a misconfiguration wearing the
   * costume of a safety feature.
   *
   * Synchronous and total: it awaits nothing, so it cannot add latency to a
   * dispatch round, and it swallows everything, so it cannot end one. If this
   * ever throws into the cascade it has become the outage it was meant to
   * prevent.
   */
  private logLoadGateShadow(
    order: { id: string; orderType: string; courierPackageSize: string | null; items: { quantity: number; bulkUnits: number | null }[] },
    poolBefore: number,
  ): void {
    try {
      const requiredSize = requiredPackageSizeForOrder(order, DEFAULT_LOAD_BANDS);
      // No requirement means nothing to shadow — a taxi, or a goods order with
      // no lines. Logging those would bury the rows that carry a decision.
      if (!requiredSize) return;
      // COURIER is already gated in production; it is here only as the control
      // that shows the derivation agrees with the declaration it cannot see.
      const alreadyGated = order.orderType === 'COURIER';
      log().info({
        orderId: order.id,
        orderType: order.orderType,
        requiredSize,
        bulkUnits: totalBulkUnits(order.items),
        bands: DEFAULT_LOAD_BANDS,
        alreadyGated,
        poolBefore,
      }, 'loadgate:shadow');
    } catch {
      // Deliberately silent. A shadow that reports its own failure into the
      // dispatch path is still in the dispatch path.
    }
  }

  private async journalOpenSearch(order: { id: string; orderType: string }, round: number, radius: number) {
    try {
      const open = await this.prisma.dispatchSearch.findFirst({
        where: { subjectId: order.id, status: 'SEARCHING' },
        select: { id: true },
      });
      if (open) {
        await this.prisma.dispatchSearch.update({
          where: { id: open.id },
          data: { wave: round + 1, radiusKm: radius },
        });
        return;
      }
      await this.prisma.dispatchSearch.updateMany({
        where: { subjectId: order.id, status: 'EXHAUSTED', resolution: null },
        data: { resolution: 'RETRIED' },
      });
      await this.prisma.dispatchSearch.create({
        data: {
          vertical: verticalForOrder(order),
          subjectId: order.id,
          status: 'SEARCHING',
          wave: round + 1,
          radiusKm: radius,
        },
      });
      dispatchSearchesCounter.inc({ status: 'started' });
    } catch {
      // Journaling never fails dispatch.
    }
  }

  /** The mover's client rendered the offer card — stamp the delivery proof.
   *  [danger #21] `seenAt` (rendered) is distinct from `acknowledgedAt`
   *  (acted); the timeout below uses it to tell an IGNORED offer apart from
   *  one the network ate. Scoped to the caller's own row — no cross-user
   *  effect — and idempotent (first render wins). */
  async markOfferSeen(orderId: string, moverUserId: string, offerAttemptId?: string): Promise<void> {
    // [F-014-04] Render proof is evidence about ONE generation. Prefer the
    // client's echoed attempt id; otherwise resolve the live attempt from the
    // authoritative offer key so a late render of an old card can't stamp a
    // newer attempt it never showed. The recipientId scope means a forged or
    // foreign attempt id can only ever match the caller's own row.
    let attemptId = offerAttemptId;
    if (!attemptId) {
      const live = await this.redis.get(offerKey(orderId));
      attemptId = live ? parseOfferValue(live).attemptId : undefined;
    }
    await this.prisma.alertDelivery.updateMany({
      where: {
        kind: 'MOVER_OFFER',
        subjectId: orderId,
        recipientId: moverUserId,
        seenAt: null,
        // Legacy shape (pre-attempt row + pre-attempt client + no live
        // composite offer): fall back to the old unscoped stamp.
        ...(attemptId ? { offerAttemptId: attemptId } : {}),
      },
      data: { seenAt: new Date() },
    });
  }

  /** [danger #21 + REPORT-014 F-014-10] Render-proof lookup for ONE offer
   *  generation. True only when the mover provably SAW (seenAt) or ACTED ON
   *  (acknowledgedAt) the card, read from the attempt's own evidence row. A
   *  MISSING row — the fire-and-caught insert failed, or the attempt never
   *  reached publication — is NOT proof of delivery: absence spares the
   *  rate. That is the fail-fair direction; the declined-set keeps cascade
   *  progress honest either way. */
  private async offerWasDeliverable(orderId: string, moverId: string, pool: DispatchPool, attemptId?: string): Promise<boolean> {
    const mover = pool === 'DRIVER'
      ? await this.prisma.driver.findUnique({ where: { id: moverId }, select: { userId: true } })
      : await this.prisma.rider.findUnique({ where: { id: moverId }, select: { userId: true } });
    if (!mover) return false;
    const ping = await this.prisma.alertDelivery.findFirst({
      where: {
        kind: 'MOVER_OFFER',
        subjectId: orderId,
        recipientId: mover.userId,
        ...(attemptId ? { offerAttemptId: attemptId } : {}),
      },
      orderBy: { sentAt: 'desc' },
      select: { seenAt: true, acknowledgedAt: true },
    });
    return !!ping && (ping.seenAt !== null || ping.acknowledgedAt !== null);
  }

  /** Timeout: the offer lapsed unanswered — penalise softly and move on.
   *  [F-014-04] attemptId (present on every job armed after the cutover)
   *  binds the whole consequence chain — removal, decline mark, decay,
   *  redispatch — to the exact generation this job was scheduled for. A
   *  stale generation-1 job firing while generation 2 is live is a no-op. */
  async handleOfferTimeout(orderId: string, moverId: string, attemptId?: string): Promise<void> {
    const removed = await this.removeOfferIfOwned(orderId, moverId, attemptId);
    if (!removed) return; // answered or superseded — never delete the new offer
    // [ALG-01] An expiry is not a decline: logged apart, counted by nobody as a gate.
    await this.redis.zadd(offerOutcomeKey(moverId, 'expiries'), Date.now(), `${orderId}:${attemptId ?? ''}`).catch(() => {});
    await this.redis.expire(offerOutcomeKey(moverId, 'expiries'), OFFER_LOG_TTL_S).catch(() => {});

    const pool = await this.poolOf(orderId);
    await this.redis.sadd(declinedKey(orderId), moverId);
    await this.redis.expire(declinedKey(orderId), 3600);
    // [danger #21] Only an offer the mover's client provably RENDERED (or one
    // they acted on) may decay their acceptance rate — the cascade still
    // advances (declined-set above), but the mover is not punished for a card
    // they never saw. [F-014-04] The evidence read is scoped to THIS
    // generation's row; [F-014-10] a MISSING row (the fire-and-caught insert
    // failed) is absence of proof, not proof of delivery — spared too.
    if (await this.offerWasDeliverable(orderId, moverId, pool, attemptId)) {
      await this.recordOfferOutcome(moverId, false, pool);
    } else {
      log().info({ orderId, moverId, pool, attemptId }, 'dispatch: offer timeout UNDELIVERABLE — no render proof, acceptance rate spared');
    }

    await this.dispatchOrder(orderId);
  }

  /** A mover going offline abandons any live offer they still hold. Without
   *  this, the offer key survives untouched until the 20s BullMQ timeout: the
   *  reconciler treats a live offer as "in cascade" and skips the order, and
   *  the customer's countdown burns on a mover who has explicitly quit. We turn
   *  it into an immediate cascade advance (same release the timeout would do)
   *  and score the miss against acceptanceRate. The reverse index is advisory:
   *  we re-validate against the authoritative offer key, so a stale pointer
   *  (offer already moved on) is a no-op — we never yank an offer that is now
   *  someone else's. Safe to call unconditionally on every go-offline. */
  async releaseHeldOffer(moverId: string): Promise<void> {
    const reverse = await this.redis.get(moverOfferKey(moverId));
    if (!reverse) return;
    const { id: orderId, attemptId } = parseOfferValue(reverse);
    // [F-014-04] Strict-generation release: if a NEWER attempt installed
    // between the read above and this consume, the compare misses and we
    // touch nothing — the newer offer's own lifecycle owns it.
    const removed = await this.removeOfferIfOwned(orderId, moverId, attemptId);
    if (!removed) return;
    const pool = await this.poolOf(orderId);
    await this.redis.sadd(declinedKey(orderId), moverId);
    await this.redis.expire(declinedKey(orderId), 3600);
    // [F-014-10] Same fail-fair law as the timeout: a release racing the
    // publish tail — before the socket emit ever ran — must not charge the
    // mover a miss for a card that never reached a screen.
    if (await this.offerWasDeliverable(orderId, moverId, pool, attemptId)) {
      await this.recordOfferOutcome(moverId, false, pool);
    } else {
      log().info({ orderId, moverId, pool, attemptId }, 'dispatch: released offer had no render proof — acceptance rate spared');
    }
    await this.dispatchOrder(orderId);
  }

  /** Explicit decline from the mover app. [F-014-04] The echoed attempt id
   *  (when the client sends one) pins the decline to the card generation the
   *  mover actually saw; without it, wildcard mode still only ever consumes
   *  this authenticated mover's own live offer. */
  async declineOffer(orderId: string, moverUserId: string, offerAttemptId?: string): Promise<void> {
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(this.prisma, 'MOVER_OFFER', orderId, moverUserId).catch(() => {});
    const pool = await this.poolOf(orderId);
    const mover = await this.requireMover(moverUserId, pool);
    const removed = await this.removeOfferIfOwned(orderId, mover.id, offerAttemptId);
    if (!removed) {
      throw new AppError(409, 'OFFER_EXPIRED', 'This offer is no longer yours to decline');
    }

    await this.redis.sadd(declinedKey(orderId), mover.id);
    await this.redis.expire(declinedKey(orderId), 3600);
    await this.recordOfferOutcome(mover.id, false, pool);
    // [ALG-01] An explicit decline is not an expiry: logged apart, counted by nobody as a gate.
    await this.redis.zadd(offerOutcomeKey(mover.id, 'declines'), Date.now(), `${orderId}:${offerAttemptId ?? ''}`).catch(() => {});
    await this.redis.expire(offerOutcomeKey(mover.id, 'declines'), OFFER_LOG_TTL_S).catch(() => {});

    await this.dispatchOrder(orderId);
  }

  /** Vendor-initiated "find a mover again" after exhaustion. Wipes the
   *  cascade's memory (declined set, radius, retry counter) and re-runs from
   *  the tightest radius. No-op while an offer is already live — retrying
   *  mid-cascade would yank the countdown out from under a mover. */
  async retryDispatch(orderId: string) {
    const live = await this.redis.get(offerKey(orderId));
    if (live) return { offered: parseOfferValue(live).id };
    // [F-021-03] The exhaust LOCK is deliberately NOT cleared here: it is
    // owner-tokened, ~10s, and deleting it could erase a concurrent
    // invocation's single-flight guard (double notices, double attempt
    // burn). A manual retry that re-exhausts inside that window simply
    // skips a duplicate of the notices that just went out.
    await this.redis.del(declinedKey(orderId), roundKey(orderId), exhaustKey(orderId));
    return this.dispatchOrder(orderId);
  }

  // -------------------------------------------------------------------------
  // Atomic acceptance
  // -------------------------------------------------------------------------

  /**
   * Accept the live offer. The database compare-and-set (riderId IS NULL
   * guarded update) is the real lock — Redis only routes the offer. Even if
   * every rider in town calls this at once, exactly one wins.
   */
  async acceptOffer(orderId: string, moverUserId: string, requestedFare?: number, offerAttemptId?: string) {
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(this.prisma, 'MOVER_OFFER', orderId, moverUserId).catch(() => {});
    const pool = await this.poolOf(orderId);
    const mover = await this.requireMover(moverUserId, pool);

    // [REPORT-012 F-012-02] Prove the rail BEFORE consuming the exclusive
    // offer. A positive fare on a non-CASH order used to ride into claimOrder,
    // which rejected it MMG_PRICE_LOCKED — but only AFTER removeOfferIfOwned
    // had destroyed the mover's offer, and the catch below then marked that
    // mover declined and advanced the cascade: a stale/forged client burned
    // its own valid offer. The price on a non-CASH rail is locked and the
    // current card sends no fare there, so a submitted fare is NEUTRALIZED —
    // the accept proceeds at the locked market price, the offer is never
    // consumed-then-rejected. The in-claim MMG_PRICE_LOCKED gate stays as the
    // locked-row belt (board/direct entrances, and any future caller).
    let fare = requestedFare;
    if (fare !== undefined) {
      const rail = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { paymentMethod: true },
      });
      if (rail && rail.paymentMethod !== 'CASH') fare = undefined;
    }

    // Consume the offer atomically before claiming. A late accept can no longer
    // pass GET and then claim after timeout/offline has offered the job to the
    // next mover. If the DB claim loses, advance the cascade below.
    // [F-014-04] With a client-echoed attempt id this binds to the exact card
    // generation; wildcard is still mover-safe (own offer only).
    const consumed = await this.removeOfferIfOwned(orderId, mover.id, offerAttemptId);
    if (!consumed) {
      throw new AppError(409, 'OFFER_EXPIRED', 'This offer has expired or went to another mover');
    }

    try {
      // claimOrder does not throw after its database transaction commits. A
      // rejection here therefore means no durable winner exists and only then
      // is it safe to advance the cascade.
      const claimed = await this.claimOrder(orderId, mover.id, pool, { requestedFare: fare });
      // [ALG-06 ①] The offer carried an incentive and this rider took it: the
      // payable exists now — after the durable claim, never before.
      if (pool === 'RIDER') await this.settleRescueIncentive(orderId, mover.id);
      return claimed;
    } catch (error) {
      await this.redis.sadd(declinedKey(orderId), mover.id).catch(() => {});
      await this.redis.expire(declinedKey(orderId), 3600).catch(() => {});
      await this.dispatchOrder(orderId).catch(() => {});
      throw error;
    }
  }

  /** [ALG-06 ①] The incentive attached to this order's current search, or null. Never throws. */
  private async rescueIncentiveOn(orderId: string): Promise<number | null> {
    try {
      const raw = await this.redis.get(incentiveKey(orderId));
      if (!raw) return null;
      const amountGyd = Number((JSON.parse(raw) as { amountGyd?: number }).amountGyd) || 0;
      return amountGyd > 0 ? amountGyd : null;
    } catch {
      return null;
    }
  }

  /**
   * [ALG-06 ①] Grant the rescue incentive the accepted offer carried, if any.
   * Swift's own money (ALG-INV-19): an earning of its own type, PENDING like
   * every payable, idempotent per order. Never load-bearing for the claim.
   */
  private async settleRescueIncentive(orderId: string, riderId: string): Promise<void> {
    try {
      const raw = await this.redis.get(incentiveKey(orderId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as { amountGyd?: number; cascade?: number };
      const amountGyd = Number(parsed.amountGyd) || 0;
      if (amountGyd > 0) {
        const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { tenantId: true } });
        await grantRescueIncentive(this.prisma, { orderId, riderId, amountGyd, cascade: Number(parsed.cascade) || 1, ...(order?.tenantId ? { tenantId: order.tenantId } : {}) });
      }
      await this.redis.del(incentiveKey(orderId)).catch(() => {});
    } catch (err) {
      log().warn({ err, orderId, riderId }, 'dispatch: rescue incentive not granted');
    }
  }

  /** The DB-level claim — exposed separately so tests can hammer it raw. */
  async claimOrder(
    orderId: string,
    moverId: string,
    pool: DispatchPool = 'RIDER',
    options: { requestedFare?: number } = {},
  ) {
    const assignedStatus = pool === 'DRIVER' ? 'DRIVER_ASSIGNED' : 'RIDER_ASSIGNED';
    // Atomic double compare-and-set: claim the ORDER (exactly-one-winner-per-order)
    // AND reserve the MOVER (exactly-one-active-job-per-mover) in ONE transaction.
    // The mover CAS is the REAL exclusivity lock — a mover already on a job (or won
    // by a concurrent accept of a DIFFERENT order) fails it, the whole tx rolls back,
    // and this order stays open for the next candidate. Without it, two orders offered
    // to the same free driver in one window both claim and double-book the driver
    // (the founder's one-ride-per-driver invariant). [SWIFT taxi-exclusivity]
    const order = await this.prisma.$transaction(async (tx) => {
      // Canonical lock order is User → Order → selected mover profile. Admin
      // suspension/ban and role switching take the same User lock first, so an
      // accept and a revocation have one legal database order rather than a
      // mover becoming assigned after authority was removed.
      const authority = pool === 'DRIVER'
        ? await tx.$queryRaw<Array<{ userId: string; activeRole: string; status: string; vehicleType?: string }>>`
            SELECT u."id" AS "userId", u."activeRole"::text AS "activeRole", u."status"::text AS "status",
                   d."vehicleType"::text AS "vehicleType"
            FROM "users" u
            JOIN "drivers" d ON d."userId" = u."id"
            WHERE d."id" = ${moverId}
            FOR UPDATE OF u
          `
        : await tx.$queryRaw<Array<{ userId: string; activeRole: string; status: string; vehicleType?: string }>>`
            SELECT u."id" AS "userId", u."activeRole"::text AS "activeRole", u."status"::text AS "status"
            FROM "users" u
            JOIN "riders" r ON r."userId" = u."id"
            WHERE r."id" = ${moverId}
            FOR UPDATE OF u
          `;
      const moverAuthority = authority[0];
      const allowedRole = pool === 'DRIVER'
        ? moverAuthority?.activeRole === 'MOVER' || moverAuthority?.activeRole === 'DRIVER'
        : moverAuthority?.activeRole === 'MOVER' || moverAuthority?.activeRole === 'RIDER';
      if (!moverAuthority || moverAuthority.status !== 'ACTIVE' || !allowedRole) {
        throw new AppError(409, 'MOVER_INACTIVE', 'This mover is no longer available to accept work');
      }

      // Lock the order after the User (the platform-wide lock order) and make
      // self-ownership/fare decisions from this exact source generation. A
      // dual-role account can never claim the request it created, even through
      // a forged board/offer request that bypassed discovery filtering.
      const lockedOrders = await tx.$queryRaw<Array<{
        customerId: string;
        taxiFareTotal: Prisma.Decimal | null;
        paymentMethod: string;
        paymentStatus: string;
        orderType: string;
        subtotalBase: Prisma.Decimal;
        deliveryFee: Prisma.Decimal;
        taxiPassengerCount: number | null;
      }>>`
        SELECT "customerId", "taxiFareTotal",
               "paymentMethod"::text AS "paymentMethod",
               "paymentStatus"::text AS "paymentStatus",
               "orderType"::text AS "orderType",
               "subtotalBase",
               "deliveryFee",
               "taxiPassengerCount"
        FROM "orders"
        WHERE "id" = ${orderId}
        FOR UPDATE
      `;
      const lockedOrder = lockedOrders[0];
      if (!lockedOrder) throw new NotFoundError('Order', orderId);
      if (lockedOrder.customerId === moverAuthority.userId) {
        throw new AppError(409, 'SELF_OWN_ORDER', 'You cannot accept a request created by your own account');
      }
      // [REPORT-014 F-014-01] PHYSICAL capacity is authoritative at the claim:
      // discovery/board filters are conveniences — a 14-passenger GROUP ride
      // must never commit to a 9-seat bus (or a default 4-seat profile that
      // self-tagged GROUP). Locked driver seats vs the locked order's count.
      // [REPORT-016 F-016-03] Physical seats come from the vehicle TAXONOMY
      // keyed on the immutable vehicleType, never the mutable vehicleCapacity
      // column — a historically self-forged/stale column can't buy a seat at
      // the money-moving claim. (The column is separately healed + set from
      // taxonomy at provisioning; this makes it non-authoritative here.)
      if (pool === 'DRIVER' && lockedOrder.taxiPassengerCount != null) {
        const seats = VEHICLE_CLASSES[moverAuthority.vehicleType as VehicleType]?.seats ?? 0;
        if (seats < lockedOrder.taxiPassengerCount) {
          throw new AppError(409, 'CAPACITY_EXCEEDED',
            `This ride needs ${lockedOrder.taxiPassengerCount} seats; your vehicle seats ${seats}.`);
        }
      }
      // [SPS-F-0016 / REPORT-004 F-004-01] Offer-card claims are the third
      // assignment writer beside the canonical seam and the board grab — the
      // payment-first law holds here too, on the same row lock, AFTER the
      // self-order check so payment state is never disclosed to an
      // unauthorized mover. Covers legacy in-flight rows that predate the gate.
      assertMmgFulfilmentAllowed(lockedOrder, assignedStatus);

      const chosenTaxiFare = pool === 'DRIVER' && options.requestedFare !== undefined
        ? clampDriverFare(options.requestedFare, Number(lockedOrder.taxiFareTotal))
        : undefined;

      // [REPORT-005 F-005-01] Rider fee choice for the offer card is applied
      // HERE, inside the locked claim — never as a post-assignment second
      // commit. CASH only: an MMG total was already paid/instructed to the
      // store; a differing fare on MMG refuses before any assignment write.
      let riderRepricing: { deliveryFee: number; totalAmount: { decrement: number } } | undefined;
      if (pool === 'RIDER' && options.requestedFare !== undefined) {
        const marketFee = Number(lockedOrder.deliveryFee);
        const chosenFee = clampDriverFare(options.requestedFare, marketFee);
        if (chosenFee !== marketFee) {
          if (lockedOrder.paymentMethod !== 'CASH') {
            throw new AppError(
              409,
              'MMG_PRICE_LOCKED',
              'The delivery price can’t change on an MMG order — the customer already paid the checkout total to the store.',
            );
          }
          riderRepricing = { deliveryFee: chosenFee, totalAmount: { decrement: marketFee - chosenFee } };
        }
      }

      const claimed = pool === 'DRIVER'
        ? await tx.order.updateMany({
            where: {
              id: orderId,
              customerId: { not: moverAuthority.userId },
              driverId: null,
              status: 'PENDING',
            },
            data: {
              driverId: moverId,
              status: 'DRIVER_ASSIGNED',
              acceptedAt: new Date(),
              ...(chosenTaxiFare !== undefined
                ? { taxiFareTotal: chosenTaxiFare, totalAmount: chosenTaxiFare }
                : {}),
            },
          })
        : await tx.order.updateMany({
            where: {
              id: orderId,
              customerId: { not: moverAuthority.userId },
              riderId: null,
              status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
              // [REPORT-006 F-006-03] A Redis offer consumed after the
              // customer converted to pickup must not assign a rider to the
              // converted row — the CAS binds DELIVERY like the board seam.
              fulfillment: 'DELIVERY',
              // [TA-S0-001 hold] Nor to a row held for a person.
              foodAgeHeldAt: null,
            },
            data: { riderId: moverId, status: 'RIDER_ASSIGNED', ...(riderRepricing ?? {}) },
          });
      if (claimed.count === 0) {
        throw new AppError(409, 'ALREADY_TAKEN', 'Another mover already took this job');
      }

      if (pool === 'DRIVER') {
        const reserved = await tx.driver.updateMany({
          where: {
            id: moverId,
            isOnline: true,
            isAvailable: true,
            ...capacityWhere('DRIVER'),
            locationSessionId: { not: null },
            user: { status: 'ACTIVE', activeRole: { in: ['MOVER', 'DRIVER'] } },
          },
          data: { isAvailable: false, currentRideId: orderId },
        });
        if (reserved.count === 0) {
          throw new AppError(409, 'DRIVER_BUSY', 'You already have an active ride — finish it before taking another');
        }
      } else {
        // Stacking [B5]: BOTH claim doors (offer accept and board grab) come
        // through this one reservation. The guarded raw update is the
        // FloatService.commit idiom — the count condition and the write are one
        // statement, so two concurrent claims cannot both slip under the cap.
        const claimCap = await riderStackingCapacity(this.prisma);
        if (claimCap > 1) {
          // Between legs, the pairing must satisfy the batching rulebook — a
          // refusal names its rule and rolls the claim CAS back with it.
          const v = await stackVerdict(tx, moverId, orderId);
          if (!v.eligible && v.legs > 0) {
            throw new AppError(
              409,
              'STACK_INELIGIBLE',
              `This job can't be stacked with your current delivery (${v.rule}: ${v.detail})`,
            );
          }
        }
        const reserved = await reserveRiderLeg(tx, moverId, orderId, claimCap);
        if (!reserved) {
          throw new AppError(409, 'DRIVER_BUSY', claimCap > 1
            ? 'You are at your delivery limit — finish one before taking another'
            : 'You already have an active job — finish it before taking another');
        }
        // D.3 — commit the rider's float for a CASH order (released on
        // delivery/cancel/fail) through the GUARDED atomic writer, from the
        // LOCKED live subtotal. [REPORT-007-v4 F-01] The old inline increment
        // was blind: candidate discovery checked headroom at OFFER time, but a
        // substitution approved while the Redis offer sat live could raise the
        // unassigned subtotal — acceptance then re-read the dearer amount and
        // pushed committedFloat past the rider's hard cap. A failed guard rolls
        // the whole claim back (order CAS, reservation, log) — same one-winner
        // semantics as the board entrance.
        const floatAmt = riderFloatForOrder(lockedOrder);
        if (floatAmt > 0 && !(await new FloatService(tx).commit(tx, moverId, floatAmt))) {
          throw new AppError(
            409,
            'FLOAT_EXCEEDED',
            `This cash order now needs $${floatAmt.toLocaleString()} float headroom (the basket changed while the offer was out) — it exceeds your available float.`,
          );
        }
      }

      // This append-only evidence is part of the assignment fact, not
      // best-effort telemetry. If it cannot be written, the order claim, mover
      // reservation, and cash-float commitment must all roll back with it.
      await tx.orderStatusLog.create({
        data: { orderId, status: assignedStatus, changedBy: moverId, note: 'Mover accepted the job' },
      });

      // Capture the committed response in the same boundary. A second DB read
      // after commit could fail and falsely tell the mover they lost a claim
      // that is already durable.
      return tx.order.findUniqueOrThrow({
        where: { id: orderId },
        // [F-0011] This row is returned straight to the accepting mover by the
        // taxi accept route. The mover VERIFIES the ride PIN — they must not read it.
        omit: HANDOVER_SECRETS_OMIT,
        include: {
          // [F-027-07] allow-list, not `include` — see utils/counterparty.
          rider: { select: riderCounterpartySelect({ withPhone: false }) },
          driver: { include: { user: { select: { firstName: true } } } },
        },
      });
    });

    // Everything below is publication/telemetry/cache cleanup after the
    // authoritative DB commit. None may convert a winner into an HTTP failure
    // that acceptOffer interprets as permission to re-dispatch the same job.
    await this.recordOfferOutcome(moverId, true, pool)
      .catch((err) => warnAfterClaimCommit({ err, orderId, moverId, pool }, 'dispatch acceptance-rate update failed after claim commit'));

    // Journal (§3): the search resolved — somebody took the job. The duration
    // read rides the same fire-and-caught boat as the journal itself.
    try {
      const assignedAt = new Date();
      const open = await this.prisma.dispatchSearch.findFirst({
        where: { subjectId: orderId, status: 'SEARCHING' },
        select: { id: true, startedAt: true },
      });
      if (open) {
        await this.prisma.dispatchSearch.update({
          where: { id: open.id },
          data: { status: 'ASSIGNED', assignedTo: moverId, assignedAt },
        });
        dispatchSearchesCounter.inc({ status: 'assigned' });
        dispatchTimeToAssign.observe((assignedAt.getTime() - open.startedAt.getTime()) / 1000);
      }
    } catch (err) {
      warnAfterClaimCommit({ err, orderId, moverId, pool }, 'dispatch journal finalization failed after claim commit');
    }

    // [REPORT-019 F-019-01 / F-014-09] Owner-aware retirement: entrances that
    // do not pre-consume (taxi direct accept, any future direct claim) leave
    // the OFFERED mover's pair live here — possibly a different mover than
    // the winner. Remove exactly that generation, never a bystander pointer.
    await this.retireLiveOfferPair(orderId, moverId, pool);

    const assignedEvent = { orderId, status: assignedStatus, timestamp: new Date().toISOString() };
    try {
      this.io.to(`order:${orderId}`).emit('order:status_changed', assignedEvent);
      if (order.vendorId) {
        this.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', assignedEvent);
      }
    } catch (err) {
      warnAfterClaimCommit({ err, orderId, moverId, pool }, 'dispatch socket publication failed after claim commit');
    }
    await this.notifications
      .riderAssigned(
        order.customerId,
        order.orderNumber,
        (pool === 'DRIVER' ? order.driver?.user?.firstName : order.rider?.user?.firstName) || 'Your mover',
        orderId,
      )
      .catch((err) => warnAfterClaimCommit({ err, orderId, moverId, pool }, 'dispatch assignment notification failed after claim commit'));

    try {
      log().info({ orderId, orderNumber: order.orderNumber, moverId, pool, status: assignedStatus }, 'dispatch: accepted');
    } catch {
      // Logging is not part of the durable assignment contract.
    }
    return order;
  }

  // -------------------------------------------------------------------------
  // Honest failure
  // -------------------------------------------------------------------------

  private async exhaust(order: {
    id: string; orderNumber: string; customerId: string; isExpress?: boolean;
    tenantId: string;
    vendor: { name: string; owner: { userId: string } } | null;
  }) {
    await this.redis.del(offerKey(order.id), roundKey(order.id));

    // Journal (§3): the honest outcome. A later retry opens a FRESH record
    // and stamps this one RETRIED (journalOpenSearch).
    await this.prisma.dispatchSearch
      .updateMany({
        where: { subjectId: order.id, status: 'SEARCHING' },
        data: { status: 'EXHAUSTED', exhaustedAt: new Date() },
      })
      .then((r) => {
        if (r.count > 0) dispatchSearchesCounter.inc({ status: 'exhausted' });
      })
      .catch(() => {});

    // Automatic re-sweeps before giving up: movers toggle online by the minute,
    // and a mover who declined two minutes ago may take the re-offer. The
    // counter persists for the terminal window [SWIFT-065] — the 1h TTL used to
    // expire and let a permanently-stranded order re-cascade + re-page admins
    // every hour, forever. Now attempts accumulate up to EXHAUST_CAP and the
    // reconciler (which skips any order with a live exhaustKey) leaves it alone.
    // [F-021-03] One script: the attempt counter can never exist WITHOUT its
    // terminal TTL (a naked INCR whose EXPIRE failed would make the
    // reconciler skip this order until a manual retry, forever).
    const attempts = Number(await this.redis.eval(
      `
        local n = redis.call('INCR', KEYS[1])
        redis.call('EXPIRE', KEYS[1], ARGV[1])
        return n
      `,
      1,
      exhaustKey(order.id),
      String(EXHAUST_TERMINAL_TTL_SECONDS),
    ));
    if (attempts < EXHAUST_CAP && this.scheduleRedispatch) {
      const retryDelay = order.isExpress ? EXPRESS_REDISPATCH_DELAY_MS : REDISPATCH_DELAY_MS;
      if (await this.scheduleRedispatch(order.id, retryDelay)) {
        await this.redis.del(declinedKey(order.id));
        await this.notifications.send({
          userId: order.customerId,
          type: 'SYSTEM_ANNOUNCEMENT',
          title: 'Still looking for a mover',
          body: `All nearby movers are busy right now — we are automatically retrying for order ${order.orderNumber}.`,
          audience: 'customer',
          data: { kind: 'dispatch_retrying', orderId: order.id },
        });
        return;
      }
    }

    // [R-05 certification catch] TAXI slow lane. The rider's exhausted card
    // promises "trying every minute as drivers come online" — past the fast
    // cap that used to be silently false: the search went TERMINAL for six
    // hours while the customer sat on an honest-looking waiting screen and a
    // driver who came online minutes later was never asked. A waiting taxi
    // request now keeps re-sweeping every TAXI_RESCAN_MS (quiet: no repeat
    // pushes, the admin page fires once below) until TAXI_WAIT_LIMIT_MIN from
    // placement, then the ride is RELEASED honestly — cancelled, told, done —
    // instead of stranded. Food/grocery keep the vendor-hold terminal flow.
    if (this.scheduleRedispatch) {
      const row = await this.prisma.order.findUnique({
        where: { id: order.id },
        select: { orderType: true, status: true, driverId: true, placedAt: true },
      });
      if (row?.orderType === 'TAXI' && row.status === 'PENDING' && !row.driverId) {
        const ageMs = Date.now() - row.placedAt.getTime();
        if (ageMs < TAXI_WAIT_LIMIT_MIN * 60_000) {
          if (await this.scheduleRedispatch(order.id, TAXI_RESCAN_MS)) {
            await this.redis.del(declinedKey(order.id));
            // The open screen still needs its honest dead-state card.
            this.io.to(`order:${order.id}`).emit('dispatch:exhausted', { orderId: order.id, orderNumber: order.orderNumber });
            // Supply drought is still an ops fact — page once per terminal window.
            const { opsPageOnce } = await import('../../jobs/queue');
            await opsPageOnce({ redis: this.redis }, `dispatch_exhausted:${order.id}`, EXHAUST_TERMINAL_TTL_SECONDS, () =>
              notifyAdmins(this.prisma, this.notifications, {
                title: 'Dispatch exhausted — no mover found',
                body: `Order ${order.orderNumber} found no mover after all retries. Check mover supply and dispatch health.`,
                data: { kind: 'ops_dispatch_exhausted', orderId: order.id },
                tenantId: order.tenantId,
              }),
            ).catch(() => {});
            return;
          }
        } else {
          // The wait limit is up — release the ride, honestly and exactly once
          // (conditional update: a driver matched in the same instant wins).
          const released = await this.prisma.order.updateMany({
            where: { id: order.id, status: 'PENDING', driverId: null },
            data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'NO_DRIVERS_AVAILABLE' },
          });
          if (released.count > 0) {
            await this.prisma.orderStatusLog
              .create({ data: { orderId: order.id, status: 'CANCELLED', changedBy: 'system', note: `Released after ${TAXI_WAIT_LIMIT_MIN} min — no drivers available` } })
              .catch(() => {});
            this.io.to(`order:${order.id}`).emit('order:status_changed', { orderId: order.id, status: 'CANCELLED', timestamp: new Date().toISOString() });
            await this.notifications.send({
              userId: order.customerId,
              type: 'SYSTEM_ANNOUNCEMENT',
              title: "We couldn't find you a driver",
              body: 'No drivers came online in time, so your request was released — nothing to pay. Try again anytime.',
              audience: 'customer',
              data: { kind: 'ride_released_no_drivers', orderId: order.id },
            });
          }
          await this.redis.del(declinedKey(order.id), exhaustKey(order.id));
          return;
        }
      }
    }

    await this.notifications.send({
      userId: order.customerId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'No movers available right now',
      body: `We could not find a mover for order ${order.orderNumber}. ${order.vendor?.name ?? 'The vendor'} can hold it or cancel — we will keep you posted.`,
      audience: 'customer',
      data: { kind: 'dispatch_exhausted', orderId: order.id },
    });
    // Terminal socket signal to the rider's LIVE screen (mirrors the assigned
    // emit) — so a taxi rider's ActiveRide can flip from "contacting drivers…"
    // to a real dead state (search again / cancel) instead of spinning forever.
    // The push above reaches a backgrounded app; this reaches the open screen. [taxi #8]
    this.io.to(`order:${order.id}`).emit('dispatch:exhausted', { orderId: order.id, orderNumber: order.orderNumber });
    if (order.vendor) {
      await this.notifications.send({
        userId: order.vendor.owner.userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'No movers available',
        body: `No mover accepted order ${order.orderNumber}. You can hold it and retry, or cancel it.`,
        audience: 'business',
        data: { kind: 'dispatch_exhausted', orderId: order.id },
      });
    }

    // Ops visibility (SWIFT-AUD-D7-02): a fully-exhausted dispatch = a customer's
    // order stranded with no mover, one of the fatal five. Customer + vendor are
    // told; admins must be too, so a dead/absent mover pool at launch is caught
    // before it becomes a wave of stranded orders. Fire-and-caught — never let an
    // alert failure change the dispatch outcome. opsPageOnce dedups [SWIFT-065]:
    // one page per order per terminal window, so a stranded order can't spam the
    // admins on every re-exhaust.
    const { opsPageOnce } = await import('../../jobs/queue');
    await opsPageOnce({ redis: this.redis }, `dispatch_exhausted:${order.id}`, EXHAUST_TERMINAL_TTL_SECONDS, () =>
      notifyAdmins(this.prisma, this.notifications, {
        title: 'Dispatch exhausted — no mover found',
        body: `Order ${order.orderNumber} found no mover after all retries. Check mover supply and dispatch health.`,
        data: { kind: 'ops_dispatch_exhausted', orderId: order.id },
        tenantId: order.tenantId,
      }),
    ).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async poolOf(orderId: string): Promise<DispatchPool> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { orderType: true },
    });
    if (!order) throw new NotFoundError('Order', orderId);
    return poolForOrder(order);
  }

  private async requireMover(userId: string, pool: DispatchPool) {
    const mover = pool === 'DRIVER'
      ? await this.prisma.driver.findUnique({ where: { userId }, select: { id: true } })
      : await this.prisma.rider.findUnique({ where: { userId }, select: { id: true } });
    if (!mover) throw new NotFoundError(pool === 'DRIVER' ? 'Driver' : 'Rider');
    return mover;
  }

  /** Acceptance history feeds future scoring — abandoners drift down the list. */
  private async recordOfferOutcome(moverId: string, accepted: boolean, pool: DispatchPool = 'RIDER') {
    // [REPORT-014 F-014-14] Exponential moving average as ONE atomic write —
    // recent behaviour dominates. The old read-then-write lost concurrent
    // outcomes: two misses from 100 both read 100 and both wrote 80 (should
    // serialize to 64). Raw SQL applies the EMA against the row's CURRENT
    // value under Postgres's row lock, exactly like the cancellationRate EMA.
    const target = accepted ? 100 : 0;
    if (pool === 'DRIVER') {
      await this.prisma.$executeRaw`
        UPDATE "drivers" SET "acceptanceRate" = "acceptanceRate" * 0.8 + ${target} * 0.2
        WHERE "id" = ${moverId}`;
      return;
    }
    await this.prisma.$executeRaw`
      UPDATE "riders" SET "acceptanceRate" = "acceptanceRate" * 0.8 + ${target} * 0.2
      WHERE "id" = ${moverId}`;
  }
}

/** Route-side construction: timeouts ride the BullMQ queue when it exists. */
export function makeDispatchService(app: FastifyInstance): DispatchService {
  const scheduler: TimeoutScheduler = async (orderId, riderId, delayMs, attemptId) => {
    if (!app.dispatchQueue) return; // tests drive timeouts manually
    await app.dispatchQueue.add('offer-timeout', { orderId, riderId, attemptId }, {
      delay: delayMs,
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  };
  const redispatch: RedispatchScheduler = async (orderId, delayMs) => {
    if (!app.dispatchQueue) return false; // no queue -> exhaustion stays final
    await app.dispatchQueue.add('dispatch-order', { orderId }, {
      delay: delayMs,
      removeOnComplete: 100,
      removeOnFail: 50,
    });
    return true;
  };
  return new DispatchService(app.prisma, app.redis, app.io, getMapsProvider(), scheduler, redispatch);
}

/** Force-offline movers whose GPS went silent while flagged online. A phone
 *  that died mid-shift otherwise keeps swallowing offers (one 20s timeout
 *  each) forever. The app pings location every 8–25s while online, so
 *  STALE_LOCATION_MINUTES of silence means the app is gone, not slow.
 *  Movers with no location at all are already invisible to findCandidates. */
/**
 * Recover orders that fell OUT of the dispatch lifecycle — the load-bearing
 * failure this whole design has to survive. The offer key and the delayed
 * BullMQ timeout job both live only in Redis; a Redis restart (or a lost
 * failover) erases them, and nothing else re-drives the order. A customer's
 * accepted food order or a hailed taxi then silently never gets a mover.
 *
 * This sweep finds any order still in a dispatchable state with no mover, that
 * has sat past RECONCILE_STUCK_MINUTES with NO live offer key (so it isn't
 * mid-cascade), is NOT deliberately exhausted (exhaustKey — awaiting the
 * vendor's manual/auto retry), and hasn't been reconciled in the cooldown
 * window, and re-enqueues the normal `dispatch-order` job. dispatchOrder is
 * idempotent on the offer key, so re-enqueuing an order that turns out to be
 * fine is a no-op. Returns the orders it re-drove (loud for ops).
 */
export async function reconcileStuckDispatch(
  prisma: PrismaClient,
  redis: Redis,
  enqueue: (orderId: string) => Promise<void>,
  stuckMinutes = RECONCILE_STUCK_MINUTES,
): Promise<{ recovered: string[] }> {
  const cutoff = new Date(Date.now() - stuckMinutes * 60_000);
  const candidates = await prisma.order.findMany({
    where: {
      updatedAt: { lt: cutoff },
      OR: [
        // Food / grocery / courier: waiting on a rider. A held order
        // (LIFECYCLE_V2 free-cancel window still open) is NOT stuck —
        // reconciling it would dispatch inside the customer's window.
        {
          orderType: { not: 'TAXI' },
          fulfillment: 'DELIVERY',
          riderId: null,
          // [hold v3 · N-03] A held row is not stuck; it is waiting for a person.
          foodAgeHeldAt: null,
          // [F-0026] A self-delivering vendor's order has no rider BY DESIGN —
          // without this the reconciler re-enqueued it every two minutes forever,
          // pushing riders offers for food that already left the store.
          status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
          AND: [
            { OR: [{ holdExpiresAt: null }, { holdExpiresAt: { lte: new Date() } }] },
            notSelfDeliveredFilter(),
          ],
        },
        // Taxi: waiting on a driver.
        { orderType: 'TAXI', driverId: null, status: 'PENDING' },
      ],
    },
    select: { id: true },
    take: 500,
  });

  const recovered: string[] = [];
  for (const { id } of candidates) {
    // In cascade, deliberately exhausted, or just reconciled — leave alone.
    const [offer, exhausted, already] = await Promise.all([
      redis.get(offerKey(id)),
      redis.get(exhaustKey(id)),
      redis.get(reconciledKey(id)),
    ]);
    if (offer || exhausted || already) continue;
    // [F-014-06] The cooldown claim is NX: two overlapping sweeps can both
    // pass the read above, but exactly one owns the repair. Claimed BEFORE
    // enqueue; released on enqueue failure so a broken queue suppresses
    // nothing — the next sweep simply tries again.
    const claimed = await redis.set(reconciledKey(id), '1', 'EX', RECONCILE_COOLDOWN_SECONDS, 'NX');
    if (claimed !== 'OK') continue;
    try {
      await enqueue(id);
    } catch (err) {
      await redis.del(reconciledKey(id)).catch(() => {});
      log().warn({ err, orderId: id }, 'dispatch reconcile: enqueue failed — claim released for the next sweep');
      continue;
    }
    recovered.push(id);
  }
  return { recovered };
}

export async function sweepStaleMovers(prisma: PrismaClient, staleMinutes = STALE_LOCATION_MINUTES, redis?: Redis) {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  // [E23 / danger #20] Two holes closed: (1) a NULL lastLocationUpdate row
  // (online but never sent a fix) evaded the `lt` predicate FOREVER; (2) the
  // sweep flipped only isOnline, leaving isAvailable + locationSessionId
  // behind — half-cleared supply state that later paths had to distrust.
  // IDLE stale movers get the full clear; a mover with an ACTIVE job keeps
  // its location session (the trip-recovery watchdogs own that custody —
  // clearing it would break trip tracking the moment their signal returns).
  const staleWhere = { OR: [{ lastLocationUpdate: { lt: cutoff } }, { lastLocationUpdate: null }] };
  // SWIFT-143: a bulk updateMany returns no ids, so capture the riders we're about
  // to force offline FIRST — otherwise their online-hours session (`online_since`)
  // is never closed and the stats endpoint counts a phantom open session forever.
  const staleRiderIds = redis
    ? (await prisma.rider.findMany({ where: { isOnline: true, ...staleWhere }, select: { id: true } })).map((r) => r.id)
    : [];
  const [idleRiders, busyRiders, idleDrivers, busyDrivers] = await Promise.all([
    prisma.rider.updateMany({
      where: { isOnline: true, currentOrderId: null, ...staleWhere },
      data: { isOnline: false, isAvailable: false, locationSessionId: null },
    }),
    prisma.rider.updateMany({
      where: { isOnline: true, currentOrderId: { not: null }, ...staleWhere },
      data: { isOnline: false },
    }),
    prisma.driver.updateMany({
      where: { isOnline: true, currentRideId: null, ...staleWhere },
      data: { isOnline: false, isAvailable: false, locationSessionId: null },
    }),
    prisma.driver.updateMany({
      where: { isOnline: true, currentRideId: { not: null }, ...staleWhere },
      data: { isOnline: false },
    }),
  ]);
  if (redis) {
    for (const id of staleRiderIds) await closeOnlineSession(redis, id);
  }
  return { riders: idleRiders.count + busyRiders.count, drivers: idleDrivers.count + busyDrivers.count };
}

/** Watchdog for a taxi whose driver went dark (GPS silent past the stale window)
 *  AFTER accepting. Such a ride is invisible to every other sweep:
 *  reconcileStuckDispatch only re-drives driverId-null PENDING taxis, and
 *  sweepStaleMovers forces isOnline=false but never clears currentRideId or
 *  touches the ride. So the ride hangs — the customer's map freezes on the last
 *  fix, the ride never completes, and the customer can't even book again (the
 *  /request active-guard 409s on these statuses). We resolve each stranded ride
 *  by its stage:
 *    • passenger NOT yet aboard (DRIVER_ASSIGNED / _EN_ROUTE / _ARRIVED): CAS the
 *      ride back to PENDING, free the driver, tell the customer, and re-dispatch
 *      — the same controlled release a driver-cancel does, triggered by the drop.
 *    • passenger ABOARD (RIDE_IN_PROGRESS): NEVER auto-cancel (they are physically
 *      in the car). Page ops once and tell the customer their driver lost signal,
 *      so a frozen map is not the only cue. currentRideId stays set.
 *  currentRideId is the signal, not isOnline (the sweep may already have flipped
 *  it). Idempotent: a re-run finds the ride already PENDING / already paged. */
export async function recoverStrandedTaxiRides(
  prisma: PrismaClient,
  redis: Redis,
  io: Server,
  enqueue: (orderId: string) => Promise<void>,
  staleMinutes = STALE_LOCATION_MINUTES,
): Promise<{ recovered: string[]; flagged: string[] }> {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  const stale = await prisma.driver.findMany({
    // [REPORT-014 F-014-11] Include the NULL-timestamp shape, exactly as
    // sweepStaleMovers and the delivery watchdog do. A busy driver who never
    // sent a fix (or whose timestamp was cleared) is forced offline by the
    // sweep but their in-custody ride was never released/flagged — the ride
    // hung forever because this recovery query only matched `lt cutoff`.
    where: {
      currentRideId: { not: null },
      OR: [{ lastLocationUpdate: { lt: cutoff } }, { lastLocationUpdate: null }],
    },
    select: { id: true, currentRideId: true },
  });
  if (stale.length === 0) return { recovered: [], flagged: [] };

  const notifications = new NotificationService(prisma, io);
  const NOT_ABOARD = DRIVER_PRE_CUSTODY_STATUSES;
  const TERMINAL = TERMINAL_ORDER_STATUSES; // ONE definition [order/order-status.ts]
  const recovered: string[] = [];
  const flagged: string[] = [];

  for (const d of stale) {
    const orderId = d.currentRideId!;
    const decision = await prisma.$transaction(async (tx) => {
      await lockTaxiOrderForCustodyDecision(tx, orderId);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          orderType: true,
          customerId: true,
          orderNumber: true,
          driverId: true,
          ridePinVerified: true,
          ridePinVerifiedAt: true,
          tenantId: true, // the ops page follows the ride's tenant [NOC-A F45]
        },
      });

      const assignedLiveTaxi = order
        && order.orderType === 'TAXI'
        && order.driverId === d.id
        && !TERMINAL.includes(order.status);
      // Evaluate durable handoff evidence before trusting the lifecycle status.
      // This fails safe for a legacy row left PENDING by the old verify/release
      // race while retaining terminal-pointer healing after a completed trip.
      if (assignedLiveTaxi && hasTaxiPassengerCustody(order)) {
        return { kind: 'FLAGGED' as const, order };
      }

      // A completed/cancelled/non-taxi/non-live pointer is damage, not active
      // custody. Heal it while holding the same order lock used above.
      if (!assignedLiveTaxi || !NOT_ABOARD.includes(order.status)) {
        await tx.driver.updateMany({
          where: { id: d.id, currentRideId: orderId },
          data: { currentRideId: null },
        });
        return { kind: 'IGNORED' as const };
      }

      // Passenger not aboard: controlled release + re-dispatch. PIN verify,
      // start, logout, customer cancel, and this watchdog all take this lock,
      // so no custody marker can appear between this decision and release.
      await tx.order.update({
        where: { id: orderId },
        // [REPORT-014 F-014-12] Fresh PIN + zeroed attempt budget on release —
        // the next driver's window is untouched and the old PIN is dead.
        data: { status: 'PENDING', driverId: null, acceptedAt: null, ...freshRidePinReset() },
      });
      await tx.driver.updateMany({
        where: { id: d.id, currentRideId: orderId },
        data: { isAvailable: false, currentRideId: null }, // gone dark → not free supply
      });
      await tx.orderStatusLog.create({
        data: { orderId, status: 'PENDING', changedBy: 'system:ride-watchdog', note: 'Driver went GPS-dark before pickup — auto-released and re-dispatched' },
      });
      return { kind: 'RELEASED' as const, order };
    });

    if (decision.kind === 'IGNORED') continue;
    const order = decision.order;
    if (decision.kind === 'FLAGGED') {
      // Passenger aboard: do NOT auto-cancel. Page ops once + tell the customer.
      const { opsPageOnce } = await import('../../jobs/queue');
      await opsPageOnce({ redis }, `taxi_driver_dropped:${orderId}`, 1800, () =>
        notifyAdmins(prisma, notifications, {
          // Scoped to the ride [NOC-A F45].
          tenantId: order.tenantId ?? null,
          title: 'Taxi driver lost signal mid-trip',
          body: `Order ${order.orderNumber}: the driver's GPS went dark with a passenger aboard. Contact both parties — do NOT auto-cancel.`,
          data: { kind: 'ops_taxi_driver_dropped', orderId },
        }),
      ).catch(() => {});
      await notifications.send({
        userId: order.customerId,
        type: 'ORDER_UPDATE',
        title: 'Your driver lost signal',
        body: 'We’ve lost your driver’s live location. Stay where you are — we’re reaching out to them. If you’re not moving, contact support.',
        data: { orderId, status: order.status },
      }).catch(() => {});
      flagged.push(orderId);
      continue;
    }

    io.to(`order:${orderId}`).emit('order:status_changed', { orderId, status: 'PENDING', reason: 'driver_dropped' });
    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Finding you another driver',
      body: 'Your driver dropped off the map before pickup — we’re matching you with the nearest available driver now.',
      data: { orderId, status: 'PENDING' },
    }).catch(() => {});
    await enqueue(orderId).catch(() => {});
    recovered.push(orderId);
  }

  return { recovered, flagged };
}
