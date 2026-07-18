import type { PrismaClient, RideClass } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService } from '../notification/notification.service';
import { getMapsProvider, type MapsProvider } from '../../providers/maps/maps-provider';
import { classesAtOrAbove } from '../rides/fare.service';
import { rankCandidates, type DispatchCandidate } from './scoring';
import { customerTrustSummaries } from '../cash/cash-rules.service';
import { estimateLoad } from '../../utils/load';
import { log } from '../../utils/logger';
import { dispatchSearchesCounter, dispatchTimeToAssign } from '../../plugins/observability';
import { getTenantId } from '../../plugins/tenant-context';

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
const BASE_RADIUS_KM = 5;
const RADIUS_STEP_KM = 5;
const MAX_ROUNDS = 3;
/** One automatic re-sweep after exhaustion — supply changes by the minute. */
export const REDISPATCH_DELAY_MS = 90_000;
/** Express orders retry the sweep sooner too. */
export const EXPRESS_REDISPATCH_DELAY_MS = 45_000;
/** GPS silent this long while "online" = the app is gone, not slow. */
export const STALE_LOCATION_MINUTES = 15;

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
const roundKey = (orderId: string) => `dispatch:round:${orderId}`;
const exhaustKey = (orderId: string) => `dispatch:exhausts:${orderId}`;
const reconciledKey = (orderId: string) => `dispatch:reconciled:${orderId}`;

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
  ): Promise<{
    level: 'GOOD' | 'LOW' | 'NONE';
    nearestEtaMinutes?: number;
  }> {
    const candidates = await this.findCandidates(`availability:${pool}`, point, BASE_RADIUS_KM, pool, floatRequired, null);
    const level = candidates.length >= 3 ? 'GOOD' : candidates.length >= 1 ? 'LOW' : 'NONE';
    return {
      level,
      ...(candidates[0] ? { nearestEtaMinutes: Math.max(1, Math.round(candidates[0].etaMinutes)) } : {}),
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
  ): Promise<DispatchCandidate[]> {
    const declined = await this.redis.smembers(declinedKey(orderId));

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

    const rows = pool === 'DRIVER'
      ? await this.prisma.$queryRaw<GeoCandidateRow[]>`
          SELECT d."id", d."userId", d."currentLat", d."currentLng",
                 d."averageRating", d."acceptanceRate", d."currentRideId" AS "currentOrderId"
          FROM "drivers" d
          JOIN "users" u ON u."id" = d."userId"
          WHERE d."isOnline" = true
            AND d."isAvailable" = true
            ${tenantFilter}
            AND d."rideClass"::text = ANY(${eligibleClasses})
            AND d."currentLat" IS NOT NULL
            AND d."currentLng" IS NOT NULL
            AND ST_DWithin(
              geography(ST_MakePoint(d."currentLng", d."currentLat")),
              geography(ST_MakePoint(${pickup.lng}, ${pickup.lat})),
              ${radiusKm * 1000}
            )
          LIMIT 50
        `
      : await this.prisma.$queryRaw<GeoCandidateRow[]>`
          SELECT r."id", r."userId", r."currentLat", r."currentLng",
                 r."averageRating", r."acceptanceRate", r."currentOrderId"
          FROM "riders" r
          JOIN "users" u ON u."id" = r."userId"
          WHERE r."isOnline" = true
            AND r."isAvailable" = true
            ${tenantFilter}
            AND (r."floatLimit" - r."committedFloat") >= ${floatRequired}
            AND r."currentLat" IS NOT NULL
            AND r."currentLng" IS NOT NULL
            AND ST_DWithin(
              geography(ST_MakePoint(r."currentLng", r."currentLat")),
              geography(ST_MakePoint(${pickup.lng}, ${pickup.lat})),
              ${radiusKm * 1000}
            )
          LIMIT 50
        `;

    const eligible = rows.filter((r) => !declined.includes(r.id));
    if (eligible.length === 0) return [];

    const etas = await this.maps.etaMinutes(
      pickup,
      eligible.map((r) => ({ lat: r.currentLat, lng: r.currentLng })),
    );

    const candidates = eligible.map((r, i) => ({
      riderId: r.id,
      userId: r.userId,
      etaMinutes: etas[i] ?? 60,
      averageRating: r.averageRating,
      acceptanceRate: r.acceptanceRate,
      hasActiveJob: r.currentOrderId !== null,
    }));

    return rankCandidates(candidates);
  }

  // -------------------------------------------------------------------------
  // The offer loop
  // -------------------------------------------------------------------------

  /** Start (or continue) dispatching an order. Idempotent per active offer. */
  async dispatchOrder(orderId: string): Promise<{ offered?: string; exhausted?: boolean }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, status: true, riderId: true, driverId: true, orderType: true,
        fulfillment: true, orderNumber: true, rideClass: true, isExpress: true,
        customerId: true, pickupLat: true, pickupLng: true,
        subtotalBase: true, paymentMethod: true, tenantId: true,
        vendor: { select: { name: true, owner: { select: { userId: true } } } },
        items: { select: { quantity: true } },
      },
    });
    if (!order) throw new NotFoundError('Order', orderId);

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
    const candidates = await this.findCandidates(orderId, { lat: order.pickupLat, lng: order.pickupLng }, radius, pool, floatRequired, order.rideClass, order.tenantId);

    if (candidates.length === 0) {
      if (round + 1 < MAX_ROUNDS) {
        // Widen and retry immediately — distance beats waiting
        await this.redis.set(roundKey(orderId), String(round + 1), 'EX', 3600);
        return this.dispatchOrder(orderId);
      }
      log().warn({ orderId, orderNumber: order.orderNumber, pool, rounds: MAX_ROUNDS }, 'dispatch: exhausted — no movers found');
      await this.exhaust(order);
      return { exhausted: true };
    }

    const top = candidates[0]!;
    const timeoutSeconds = order.isExpress ? EXPRESS_OFFER_TIMEOUT_SECONDS : OFFER_TIMEOUT_SECONDS;
    await this.redis.set(offerKey(orderId), top.riderId, 'EX', timeoutSeconds + 10);

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

  /** Timeout: the offer lapsed unanswered — penalise softly and move on. */
  async handleOfferTimeout(orderId: string, moverId: string): Promise<void> {
    const current = await this.redis.get(offerKey(orderId));
    if (current !== moverId) return; // answered or superseded — nothing to do

    const pool = await this.poolOf(orderId);
    await this.redis.del(offerKey(orderId));
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
    const current = await this.redis.get(offerKey(orderId));
    if (current !== mover.id) {
      throw new AppError(409, 'OFFER_EXPIRED', 'This offer is no longer yours to decline');
    }

    await this.redis.del(offerKey(orderId));
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
  async acceptOffer(orderId: string, moverUserId: string) {
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(this.prisma, 'MOVER_OFFER', orderId, moverUserId).catch(() => {});
    const pool = await this.poolOf(orderId);
    const mover = await this.requireMover(moverUserId, pool);

    const current = await this.redis.get(offerKey(orderId));
    if (current !== mover.id) {
      throw new AppError(409, 'OFFER_EXPIRED', 'This offer has expired or went to another mover');
    }

    return this.claimOrder(orderId, mover.id, pool);
  }

  /** The DB-level claim — exposed separately so tests can hammer it raw. */
  async claimOrder(orderId: string, moverId: string, pool: DispatchPool = 'RIDER') {
    const claimed = pool === 'DRIVER'
      ? await this.prisma.order.updateMany({
          where: { id: orderId, driverId: null, status: 'PENDING' },
          data: { driverId: moverId, status: 'DRIVER_ASSIGNED', acceptedAt: new Date() },
        })
      : await this.prisma.order.updateMany({
          where: {
            id: orderId,
            riderId: null,
            status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
          },
          data: { riderId: moverId, status: 'RIDER_ASSIGNED' },
        });

    if (claimed.count === 0) {
      throw new AppError(409, 'ALREADY_TAKEN', 'Another mover already took this job');
    }

    const assignedStatus = pool === 'DRIVER' ? 'DRIVER_ASSIGNED' : 'RIDER_ASSIGNED';
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        rider: { include: { user: { select: { firstName: true } } } },
        driver: { include: { user: { select: { firstName: true } } } },
      },
    });

    await this.prisma.orderStatusLog.create({
      data: { orderId, status: assignedStatus, changedBy: moverId, note: 'Mover accepted the job' },
    });

    if (pool === 'DRIVER') {
      await this.prisma.driver.update({
        where: { id: moverId },
        data: { isAvailable: false, currentRideId: orderId },
      });
    } else {
      // D.3 — commit the rider's float for a CASH order (released on delivery/cancel/fail).
      const floatAmt = order.paymentMethod === 'CASH' ? Number(order.subtotalBase) : 0;
      await this.prisma.rider.update({
        where: { id: moverId },
        data: {
          isAvailable: false,
          currentOrderId: orderId,
          ...(floatAmt > 0 ? { committedFloat: { increment: floatAmt } } : {}),
        },
      });
    }
    await this.recordOfferOutcome(moverId, true, pool);

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
    } catch {
      // Journaling never fails a claim.
    }

    await this.redis.del(offerKey(orderId), declinedKey(orderId), roundKey(orderId), exhaustKey(orderId));

    const assignedEvent = { orderId, status: assignedStatus, timestamp: new Date().toISOString() };
    this.io.to(`order:${orderId}`).emit('order:status_changed', assignedEvent);
    if (order.vendorId) {
      this.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', assignedEvent);
    }
    await this.notifications.riderAssigned(
      order.customerId,
      order.orderNumber,
      (pool === 'DRIVER' ? order.driver?.user?.firstName : order.rider?.user?.firstName) || 'Your mover',
      orderId,
    );

    log().info({ orderId, orderNumber: order.orderNumber, moverId, pool, status: assignedStatus }, 'dispatch: accepted');
    return order;
  }

  // -------------------------------------------------------------------------
  // Honest failure
  // -------------------------------------------------------------------------

  private async exhaust(order: {
    id: string; orderNumber: string; customerId: string; isExpress?: boolean;
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

    // One automatic re-sweep before giving up: movers toggle online by the
    // minute, and a mover who declined two minutes ago may take the re-offer.
    // The declined set is cleared so the retry searches the full pool again.
    if (this.scheduleRedispatch) {
      const attempts = await this.redis.incr(exhaustKey(order.id));
      await this.redis.expire(exhaustKey(order.id), 3600);
      const retryDelay = order.isExpress ? EXPRESS_REDISPATCH_DELAY_MS : REDISPATCH_DELAY_MS;
      if (attempts < 2 && (await this.scheduleRedispatch(order.id, retryDelay))) {
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

    await this.notifications.send({
      userId: order.customerId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'No movers available right now',
      body: `We could not find a mover for order ${order.orderNumber}. ${order.vendor?.name ?? 'The vendor'} can hold it or cancel — we will keep you posted.`,
      audience: 'customer',
      data: { kind: 'dispatch_exhausted', orderId: order.id },
    });
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
          AND: [{ OR: [{ holdExpiresAt: null }, { holdExpiresAt: { lte: new Date() } }] }],
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

export async function sweepStaleMovers(prisma: PrismaClient, staleMinutes = STALE_LOCATION_MINUTES) {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  const [riders, drivers] = await Promise.all([
    prisma.rider.updateMany({
      where: { isOnline: true, lastLocationUpdate: { lt: cutoff } },
      data: { isOnline: false },
    }),
    prisma.driver.updateMany({
      where: { isOnline: true, lastLocationUpdate: { lt: cutoff } },
      data: { isOnline: false },
    }),
  ]);
  return { riders: riders.count, drivers: drivers.count };
}
