import type { PrismaClient, RideClass, OrderStatus } from '@prisma/client';
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
import { rankCandidates, type DispatchCandidate } from './scoring';
import { customerTrustSummaries } from '../cash/cash-rules.service';
import { estimateLoad } from '../../utils/load';
import { HANDOVER_SECRETS_OMIT } from '../handover/handover-security';
import { notSelfDeliveredFilter } from '../fulfillment/fulfillment-mode';
import { vehicleTypesForPackageSize } from '../../config/vehicle-classes';
import { log } from '../../utils/logger';
import { dispatchSearchesCounter, dispatchTimeToAssign } from '../../plugins/observability';
import { getTenantId } from '../../plugins/tenant-context';
import { clampDriverFare } from '../../utils/markup';
import { assertMmgFulfilmentAllowed } from '../order/order.service';
import { FloatService } from './float.service';
import {
  hasTaxiPassengerCustody,
  lockTaxiOrderForCustodyDecision,
} from '../rides/passenger-custody';

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
const declinedKey = (orderId: string) => `dispatch:declined:${orderId}`;
// Advisory reverse index: which order (if any) a mover currently holds an offer
// for. Set beside offerKey with the same TTL so it self-expires; ALWAYS
// re-validated against the authoritative offerKey before use, so a stale
// pointer is a safe no-op, never a wrong release. Lets go-offline find and
// release a live offer without scanning every open order.
const moverOfferKey = (moverId: string) => `dispatch:mover-offer:${moverId}`;
const roundKey = (orderId: string) => `dispatch:round:${orderId}`;
const exhaustKey = (orderId: string) => `dispatch:exhausts:${orderId}`;
const reconciledKey = (orderId: string) => `dispatch:reconciled:${orderId}`;

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

/** How the production wiring schedules the timeout check (BullMQ delayed job). */
export type TimeoutScheduler = (orderId: string, riderId: string, delayMs: number) => Promise<void>;

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
  private async canReceiveOffer(pool: DispatchPool, moverId: string): Promise<boolean> {
    const count = pool === 'DRIVER'
      ? await this.prisma.driver.count({
          where: {
            id: moverId,
            isOnline: true,
            isAvailable: true,
            currentRideId: null,
            locationSessionId: { not: null },
            user: { status: 'ACTIVE', activeRole: { in: ['MOVER', 'DRIVER'] } },
          },
        })
      : await this.prisma.rider.count({
          where: {
            id: moverId,
            isOnline: true,
            isAvailable: true,
            currentOrderId: null,
            locationSessionId: { not: null },
            user: { status: 'ACTIVE', activeRole: { in: ['MOVER', 'RIDER'] } },
          },
        });
    return count === 1;
  }

  /**
   * Compare-and-delete both Redis offer pointers. A plain GET followed by DEL
   * can erase a newer mover's offer when a role switch and cascade overlap.
   */
  private async removeOfferIfOwned(orderId: string, moverId: string): Promise<boolean> {
    const removed = await this.redis.eval(
      `
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then
          if redis.call('GET', KEYS[2]) == ARGV[2] then
            redis.call('DEL', KEYS[2])
          end
          return 0
        end
        redis.call('DEL', KEYS[1])
        if redis.call('GET', KEYS[2]) == ARGV[2] then
          redis.call('DEL', KEYS[2])
        end
        return 1
      `,
      2,
      offerKey(orderId),
      moverOfferKey(moverId),
      moverId,
      orderId,
    );
    return Number(removed) === 1;
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
    const declined = await this.redis.smembers(declinedKey(orderId));
    const locationFreshSince = new Date(Date.now() - DISPATCH_LOCATION_FRESH_SECONDS * 1000);

    // SWIFT-062: a courier parcel only goes to a vehicle that can carry it.
    const capableVehicles = vehiclesForPackageSize(packageSize);
    const vehicleFilter = packageSize
      ? Prisma.sql`AND r."vehicleType"::text = ANY(${capableVehicles})`
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
            AND d."currentRideId" IS NULL
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
            AND r."currentOrderId" IS NULL
            AND r."locationSessionId" IS NOT NULL
            AND r."lastLocationUpdate" >= ${locationFreshSince}
            AND u."status" = 'ACTIVE'
            AND u."activeRole" IN ('MOVER', 'RIDER')
            ${tenantFilter}
            ${selfFilter}
            ${vehicleFilter}
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

    // Safety exclusions [safety spec §8.5/§8.3]. Keyed on the BOOKING user
    // (excludeUserId at the real dispatch call; null on availability probes,
    // so the hot browse path pays nothing): a mover who shares an incident
    // case with this customer — either direction — is never matched with
    // them again (retaliation guard), and a SHADOW_RESTRICTED mover is
    // excluded from enhanced-monitoring passengers pending review.
    if (excludeUserId && eligible.length > 0) {
      const safetyExcluded = await this.safetyExcludedUserIds(excludeUserId, eligible.map((r) => r.userId), pool);
      if (safetyExcluded.size > 0) {
        eligible = eligible.filter((r) => !safetyExcluded.has(r.userId));
        log().warn({ orderId, customerUserId: excludeUserId, excluded: safetyExcluded.size }, 'dispatch: safety exclusions removed candidates from the pool');
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
    return rankCandidates(candidates, pool === 'DRIVER' ? 'PROXIMITY' : 'BALANCED');
  }

  /** Safety-driven pool exclusions (spec §8.5 retaliation guard + §8.3
   *  SHADOW_RESTRICTED). Two indexed reads, only when a booking user exists
   *  AND candidates survived the geo query — never on availability probes. */
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
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, status: true, riderId: true, driverId: true, orderType: true,
        fulfillment: true, orderNumber: true, rideClass: true, isExpress: true, courierPackageSize: true,
        customerId: true, pickupLat: true, pickupLng: true, taxiPassengerCount: true,
        subtotalBase: true, paymentMethod: true, tenantId: true,
        vendor: { select: { name: true, owner: { select: { userId: true } } } },
        items: { select: { quantity: true } },
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
    } else {
      if (order.driverId) return {};
      if (order.status !== 'PENDING') return {};
    }
    if (order.pickupLat == null || order.pickupLng == null) return {};

    // One live offer at a time
    const existing = await this.redis.get(offerKey(orderId));
    if (existing) return { offered: existing };

    const round = Number((await this.redis.get(roundKey(orderId))) ?? 0);
    const radius = BASE_RADIUS_KM + round * RADIUS_STEP_KM;
    // Search journal (§3): open/refresh the record BESIDE the state machine —
    // fire-and-caught, never load-bearing for the cascade itself.
    await this.journalOpenSearch(order, round, radius);
    // D.3 — a rider must have enough free float to front this order's vendor-cash (CASH deliveries only).
    const floatRequired = pool === 'RIDER' && order.paymentMethod === 'CASH' ? Number(order.subtotalBase) : 0;
    const candidates = await this.findCandidates(orderId, { lat: order.pickupLat, lng: order.pickupLng }, radius, pool, floatRequired, order.rideClass, order.tenantId, order.courierPackageSize, order.customerId, order.taxiPassengerCount);

    if (candidates.length === 0) {
      if (round + 1 < MAX_ROUNDS) {
        // Widen and retry immediately — distance beats waiting
        await this.redis.set(roundKey(orderId), String(round + 1), 'EX', 3600);
        return this.dispatchOrder(orderId, order.tenantId);
      }
      log().warn({ orderId, orderNumber: order.orderNumber, pool, rounds: MAX_ROUNDS }, 'dispatch: exhausted — no movers found');
      await this.exhaust(order);
      return { exhausted: true };
    }

    const top = candidates[0]!;
    const timeoutSeconds = order.isExpress ? EXPRESS_OFFER_TIMEOUT_SECONDS : OFFER_TIMEOUT_SECONDS;
    // [E29 / danger #18] The offer install IS the mutual exclusion: two
    // concurrent triggers (route retry-dispatch + queue job, double webhook,
    // two instances) could both pass the GET above and the old plain SET let
    // the second silently STEAL the first mover's offer — duplicate cards,
    // pushes, journal rows, and a timeout penalty against a mover whose card
    // vanished. NX makes exactly one trigger the owner; losers emit nothing.
    const installed = await this.redis.set(offerKey(orderId), top.riderId, 'EX', timeoutSeconds + 10, 'NX');
    if (installed !== 'OK') {
      const winner = await this.redis.get(offerKey(orderId));
      return winner ? { offered: winner } : {};
    }
    // Reverse pointer so go-offline can find this offer by mover (advisory —
    // re-validated against offerKey on read). Same TTL: it dies with the offer.
    await this.redis.set(moverOfferKey(top.riderId), orderId, 'EX', timeoutSeconds + 10);

    // Candidate discovery and offer installation straddle PostgreSQL + Redis.
    // Revalidate after both pointers exist so either role-switch ordering is
    // safe: switch-before-install is caught here; install-before-switch is
    // removed by the switch's releaseHeldOffer call. Never emit to stale supply.
    if (!(await this.canReceiveOffer(pool, top.riderId))) {
      const removed = await this.removeOfferIfOwned(orderId, top.riderId);
      if (removed) {
        await this.redis.sadd(declinedKey(orderId), top.riderId);
        await this.redis.expire(declinedKey(orderId), 3600);
        log().info({ orderId, moverId: top.riderId, pool }, 'dispatch: withdrew offer after authority changed');
        return this.dispatchOrder(orderId, order.tenantId);
      }
      // Another release already advanced the cascade; do not touch its offer.
      return {};
    }

    // §4d: on a CASH job the mover fronts real money — show them WHO they're
    // fronting it for (trust level, completed orders, strikes) before accept.
    const trust = (await customerTrustSummaries(this.prisma, [order.customerId])).get(order.customerId);

    // §7: a mover judges a big grocery order BEFORE accepting.
    const totalUnits = order.items.reduce((s, i) => s + i.quantity, 0);

    this.io.to(`user:${top.userId}`).emit('dispatch:offer', {
      orderId,
      orderNumber: order.orderNumber,
      vendorName: order.vendor?.name,
      // Express = bigger fee for the mover; badge it so they know why.
      isExpress: order.isExpress,
      expiresInSeconds: timeoutSeconds,
      etaMinutes: Math.round(top.etaMinutes),
      paymentMethod: order.paymentMethod,
      customerTrust: trust ?? null,
      itemCount: order.items.length,
      estLoad: order.items.length > 0 ? estimateLoad(totalUnits) : null,
    });

    // Alert-delivery tracking (§A4): every offer gets a row; the mover's
    // accept/decline stamps acknowledgedAt. Fire-and-caught.
    await this.prisma.alertDelivery
      .create({ data: { kind: 'MOVER_OFFER', subjectId: orderId, recipientId: top.userId } })
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
            expiresAt: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
          },
        })
        .catch(() => {});
    }

    log().info({ orderId, orderNumber: order.orderNumber, moverId: top.riderId, pool, round, etaMinutes: Math.round(top.etaMinutes), candidates: candidates.length }, 'dispatch: offer sent');
    await this.scheduleTimeout(orderId, top.riderId, timeoutSeconds * 1000);
    return { offered: top.riderId };
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
  } | null> {
    const orderId = await this.redis.get(moverOfferKey(moverId));
    if (!orderId) return null;
    const owner = await this.redis.get(offerKey(orderId));
    if (owner !== moverId) return null;
    const ttl = await this.redis.ttl(offerKey(orderId));
    // Keys carry timeout+10s; the last 10s are the timeout worker's grace
    // tail. Under ~3s of card time isn't actionable — report gone.
    if (ttl == null || ttl <= 13) return null;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        orderNumber: true, isExpress: true, paymentMethod: true, customerId: true,
        deliveryFee: true, tipAmount: true, taxiFareTotal: true,
        pickupAddress: true, deliveryAddress: true,
        vendor: { select: { name: true } },
        items: { select: { quantity: true } },
      },
    });
    if (!order) return null;
    const trust = (await customerTrustSummaries(this.prisma, [order.customerId])).get(order.customerId);
    const totalUnits = order.items.reduce((s, i) => s + i.quantity, 0);
    return {
      orderId,
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
    };
  }

  /** §3 journal upkeep: keep ONE open SEARCHING row per subject current
   *  (wave/radius), resolving a prior EXHAUSTED row as RETRIED when a fresh
   *  search begins. Never throws — the journal is beside the machine. */
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
  async markOfferSeen(orderId: string, moverUserId: string): Promise<void> {
    await this.prisma.alertDelivery.updateMany({
      where: { kind: 'MOVER_OFFER', subjectId: orderId, recipientId: moverUserId, seenAt: null },
      data: { seenAt: new Date() },
    });
  }

  /** Timeout: the offer lapsed unanswered — penalise softly and move on. */
  async handleOfferTimeout(orderId: string, moverId: string): Promise<void> {
    const removed = await this.removeOfferIfOwned(orderId, moverId);
    if (!removed) return; // answered or superseded — never delete the new offer

    const pool = await this.poolOf(orderId);
    await this.redis.sadd(declinedKey(orderId), moverId);
    await this.redis.expire(declinedKey(orderId), 3600);
    // [danger #21] Only an offer the mover's client provably RENDERED (or one
    // they acted on) may decay their acceptance rate. A ping the network ate
    // — no socket, push asleep, app killed before the recovery read — is
    // UNDELIVERABLE: the cascade still advances (declined-set above keeps
    // progress honest), but the mover is not punished for a card they never
    // saw. Legacy rows predating seenAt have both stamps null and are spared;
    // that is the fail-fair direction.
    const mover = pool === 'DRIVER'
      ? await this.prisma.driver.findUnique({ where: { id: moverId }, select: { userId: true } })
      : await this.prisma.rider.findUnique({ where: { id: moverId }, select: { userId: true } });
    const ping = mover
      ? await this.prisma.alertDelivery.findFirst({
          where: { kind: 'MOVER_OFFER', subjectId: orderId, recipientId: mover.userId },
          orderBy: { sentAt: 'desc' },
          select: { seenAt: true, acknowledgedAt: true },
        })
      : null;
    const undeliverable = !!ping && ping.seenAt === null && ping.acknowledgedAt === null;
    if (undeliverable) {
      log().info({ orderId, moverId, pool }, 'dispatch: offer timeout UNDELIVERABLE — no render proof, acceptance rate spared');
    } else {
      await this.recordOfferOutcome(moverId, false, pool);
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
    const orderId = await this.redis.get(moverOfferKey(moverId));
    if (!orderId) return;
    const removed = await this.removeOfferIfOwned(orderId, moverId);
    if (!removed) return;
    const pool = await this.poolOf(orderId);
    await this.redis.sadd(declinedKey(orderId), moverId);
    await this.redis.expire(declinedKey(orderId), 3600);
    await this.recordOfferOutcome(moverId, false, pool);
    await this.dispatchOrder(orderId);
  }

  /** Explicit decline from the mover app. */
  async declineOffer(orderId: string, moverUserId: string): Promise<void> {
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(this.prisma, 'MOVER_OFFER', orderId, moverUserId).catch(() => {});
    const pool = await this.poolOf(orderId);
    const mover = await this.requireMover(moverUserId, pool);
    const removed = await this.removeOfferIfOwned(orderId, mover.id);
    if (!removed) {
      throw new AppError(409, 'OFFER_EXPIRED', 'This offer is no longer yours to decline');
    }

    await this.redis.sadd(declinedKey(orderId), mover.id);
    await this.redis.expire(declinedKey(orderId), 3600);
    await this.recordOfferOutcome(mover.id, false, pool);

    await this.dispatchOrder(orderId);
  }

  /** Vendor-initiated "find a mover again" after exhaustion. Wipes the
   *  cascade's memory (declined set, radius, retry counter) and re-runs from
   *  the tightest radius. No-op while an offer is already live — retrying
   *  mid-cascade would yank the countdown out from under a mover. */
  async retryDispatch(orderId: string) {
    const live = await this.redis.get(offerKey(orderId));
    if (live) return { offered: live };
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
  async acceptOffer(orderId: string, moverUserId: string, requestedFare?: number) {
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
    const consumed = await this.removeOfferIfOwned(orderId, mover.id);
    if (!consumed) {
      throw new AppError(409, 'OFFER_EXPIRED', 'This offer has expired or went to another mover');
    }

    try {
      // claimOrder does not throw after its database transaction commits. A
      // rejection here therefore means no durable winner exists and only then
      // is it safe to advance the cascade.
      return await this.claimOrder(orderId, mover.id, pool, { requestedFare: fare });
    } catch (error) {
      await this.redis.sadd(declinedKey(orderId), mover.id).catch(() => {});
      await this.redis.expire(declinedKey(orderId), 3600).catch(() => {});
      await this.dispatchOrder(orderId).catch(() => {});
      throw error;
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
        ? await tx.$queryRaw<Array<{ userId: string; activeRole: string; status: string; vehicleCapacity?: number }>>`
            SELECT u."id" AS "userId", u."activeRole"::text AS "activeRole", u."status"::text AS "status",
                   d."vehicleCapacity" AS "vehicleCapacity"
            FROM "users" u
            JOIN "drivers" d ON d."userId" = u."id"
            WHERE d."id" = ${moverId}
            FOR UPDATE OF u
          `
        : await tx.$queryRaw<Array<{ userId: string; activeRole: string; status: string; vehicleCapacity?: number }>>`
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
      if (pool === 'DRIVER' && lockedOrder.taxiPassengerCount != null
          && (moverAuthority.vehicleCapacity ?? 0) < lockedOrder.taxiPassengerCount) {
        throw new AppError(409, 'CAPACITY_EXCEEDED',
          `This ride needs ${lockedOrder.taxiPassengerCount} seats; your vehicle seats ${moverAuthority.vehicleCapacity ?? 0}.`);
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
            currentRideId: null,
            locationSessionId: { not: null },
            user: { status: 'ACTIVE', activeRole: { in: ['MOVER', 'DRIVER'] } },
          },
          data: { isAvailable: false, currentRideId: orderId },
        });
        if (reserved.count === 0) {
          throw new AppError(409, 'DRIVER_BUSY', 'You already have an active ride — finish it before taking another');
        }
      } else {
        const reserved = await tx.rider.updateMany({
          where: {
            id: moverId,
            isOnline: true,
            isAvailable: true,
            currentOrderId: null,
            locationSessionId: { not: null },
            user: { status: 'ACTIVE', activeRole: { in: ['MOVER', 'RIDER'] } },
          },
          data: {
            isAvailable: false,
            currentOrderId: orderId,
          },
        });
        if (reserved.count === 0) {
          throw new AppError(409, 'DRIVER_BUSY', 'You already have an active job — finish it before taking another');
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
        const floatAmt = lockedOrder.paymentMethod === 'CASH' ? Number(lockedOrder.subtotalBase) : 0;
        if (floatAmt > 0 && !(await new FloatService(tx).commit(tx, moverId, floatAmt))) {
          throw new AppError(
            400,
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
          rider: { include: { user: { select: { firstName: true } } } },
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

    await this.redis
      .del(offerKey(orderId), declinedKey(orderId), roundKey(orderId), exhaustKey(orderId))
      .catch((err) => warnAfterClaimCommit({ err, orderId, moverId, pool }, 'dispatch Redis cleanup failed after claim commit'));

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
    const attempts = await this.redis.incr(exhaustKey(order.id));
    await this.redis.expire(exhaustKey(order.id), EXHAUST_TERMINAL_TTL_SECONDS);
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
    // Exponential moving average: recent behaviour dominates
    if (pool === 'DRIVER') {
      const driver = await this.prisma.driver.findUnique({
        where: { id: moverId },
        select: { acceptanceRate: true },
      });
      if (!driver) return;
      await this.prisma.driver.update({
        where: { id: moverId },
        data: { acceptanceRate: driver.acceptanceRate * 0.8 + (accepted ? 100 : 0) * 0.2 },
      });
      return;
    }
    const rider = await this.prisma.rider.findUnique({
      where: { id: moverId },
      select: { acceptanceRate: true },
    });
    if (!rider) return;
    await this.prisma.rider.update({
      where: { id: moverId },
      data: { acceptanceRate: rider.acceptanceRate * 0.8 + (accepted ? 100 : 0) * 0.2 },
    });
  }
}

/** Route-side construction: timeouts ride the BullMQ queue when it exists. */
export function makeDispatchService(app: FastifyInstance): DispatchService {
  const scheduler: TimeoutScheduler = async (orderId, riderId, delayMs) => {
    if (!app.dispatchQueue) return; // tests drive timeouts manually
    await app.dispatchQueue.add('offer-timeout', { orderId, riderId }, {
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
          status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
          // [F-0026] A self-delivering vendor's order has no rider BY DESIGN —
          // without this the reconciler re-enqueued it every two minutes forever,
          // pushing riders offers for food that already left the store.
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
    await redis.set(reconciledKey(id), '1', 'EX', RECONCILE_COOLDOWN_SECONDS);
    await enqueue(id);
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
    where: { currentRideId: { not: null }, lastLocationUpdate: { lt: cutoff } },
    select: { id: true, currentRideId: true },
  });
  if (stale.length === 0) return { recovered: [], flagged: [] };

  const notifications = new NotificationService(prisma, io);
  const NOT_ABOARD: OrderStatus[] = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];
  const TERMINAL: OrderStatus[] = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
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
        data: { status: 'PENDING', driverId: null, acceptedAt: null },
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
