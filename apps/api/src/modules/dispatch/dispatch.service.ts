import type { PrismaClient, RideClass } from '@prisma/client';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService } from '../notification/notification.service';
import { getMapsProvider, type MapsProvider } from '../../providers/maps/maps-provider';
import { classesAtOrAbove } from '../rides/fare.service';
import { rankCandidates, type DispatchCandidate } from './scoring';

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
const BASE_RADIUS_KM = 5;
const RADIUS_STEP_KM = 5;
const MAX_ROUNDS = 3;

/** Taxi rides draw from the driver pool; everything else from riders.
 *  Same scoring, same cascade, same atomic claim — shared code, not a copy. */
export type DispatchPool = 'RIDER' | 'DRIVER';

function poolForOrder(order: { orderType: string }): DispatchPool {
  return order.orderType === 'TAXI' ? 'DRIVER' : 'RIDER';
}

const offerKey = (orderId: string) => `dispatch:offer:${orderId}`;
const declinedKey = (orderId: string) => `dispatch:declined:${orderId}`;
const roundKey = (orderId: string) => `dispatch:round:${orderId}`;

/** How the production wiring schedules the timeout check (BullMQ delayed job). */
export type TimeoutScheduler = (orderId: string, riderId: string, delayMs: number) => Promise<void>;

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
  ) {
    this.notifications = new NotificationService(prisma, io);
  }

  // -------------------------------------------------------------------------
  // Candidate discovery — PostGIS over the live rider positions
  // -------------------------------------------------------------------------

  async findCandidates(
    orderId: string,
    pickup: { lat: number; lng: number },
    radiusKm: number,
    pool: DispatchPool = 'RIDER',
    floatRequired = 0,
    rideClass?: RideClass | null,
  ): Promise<DispatchCandidate[]> {
    const declined = await this.redis.smembers(declinedKey(orderId));

    // A driver's rideClass is the TOP tier their vehicle serves, so only drivers
    // at or above the order's tier are eligible (an XL request never offers to a
    // 4-seat Economy car). Legacy/untagged orders fall back to ECONOMY = all.
    const eligibleClasses = classesAtOrAbove(rideClass ?? 'ECONOMY');

    const rows = pool === 'DRIVER'
      ? await this.prisma.$queryRaw<GeoCandidateRow[]>`
          SELECT d."id", d."userId", d."currentLat", d."currentLng",
                 d."averageRating", d."acceptanceRate", d."currentRideId" AS "currentOrderId"
          FROM "drivers" d
          WHERE d."isOnline" = true
            AND d."isAvailable" = true
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
          WHERE r."isOnline" = true
            AND r."isAvailable" = true
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
        fulfillment: true, orderNumber: true, rideClass: true,
        customerId: true, pickupLat: true, pickupLng: true,
        subtotalBase: true, paymentMethod: true,
        vendor: { select: { name: true, owner: { select: { userId: true } } } },
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
    // D.3 — a rider must have enough free float to front this order's vendor-cash (CASH deliveries only).
    const floatRequired = pool === 'RIDER' && order.paymentMethod === 'CASH' ? Number(order.subtotalBase) : 0;
    const candidates = await this.findCandidates(orderId, { lat: order.pickupLat, lng: order.pickupLng }, radius, pool, floatRequired, order.rideClass);

    if (candidates.length === 0) {
      if (round + 1 < MAX_ROUNDS) {
        // Widen and retry immediately — distance beats waiting
        await this.redis.set(roundKey(orderId), String(round + 1), 'EX', 3600);
        return this.dispatchOrder(orderId);
      }
      await this.exhaust(order);
      return { exhausted: true };
    }

    const top = candidates[0]!;
    await this.redis.set(offerKey(orderId), top.riderId, 'EX', OFFER_TIMEOUT_SECONDS + 10);

    this.io.to(`user:${top.userId}`).emit('dispatch:offer', {
      orderId,
      orderNumber: order.orderNumber,
      vendorName: order.vendor?.name,
      expiresInSeconds: OFFER_TIMEOUT_SECONDS,
      etaMinutes: Math.round(top.etaMinutes),
    });

    await this.scheduleTimeout(orderId, top.riderId, OFFER_TIMEOUT_SECONDS * 1000);
    return { offered: top.riderId };
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

  // -------------------------------------------------------------------------
  // Atomic acceptance
  // -------------------------------------------------------------------------

  /**
   * Accept the live offer. The database compare-and-set (riderId IS NULL
   * guarded update) is the real lock — Redis only routes the offer. Even if
   * every rider in town calls this at once, exactly one wins.
   */
  async acceptOffer(orderId: string, moverUserId: string) {
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

    await this.redis.del(offerKey(orderId), declinedKey(orderId), roundKey(orderId));

    this.io.to(`order:${orderId}`).emit('order:status_changed', {
      orderId,
      status: assignedStatus,
      timestamp: new Date().toISOString(),
    });
    await this.notifications.riderAssigned(
      order.customerId,
      order.orderNumber,
      (pool === 'DRIVER' ? order.driver?.user?.firstName : order.rider?.user?.firstName) || 'Your mover',
      orderId,
    );

    return order;
  }

  // -------------------------------------------------------------------------
  // Honest failure
  // -------------------------------------------------------------------------

  private async exhaust(order: {
    id: string; orderNumber: string; customerId: string;
    vendor: { name: string; owner: { userId: string } } | null;
  }) {
    await this.redis.del(offerKey(order.id), roundKey(order.id));

    await this.notifications.send({
      userId: order.customerId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'No movers available right now',
      body: `We could not find a mover for order ${order.orderNumber}. ${order.vendor?.name ?? 'The vendor'} can hold it or cancel — we will keep you posted.`,
      data: { kind: 'dispatch_exhausted', orderId: order.id },
    });
    if (order.vendor) {
      await this.notifications.send({
        userId: order.vendor.owner.userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'No movers available',
        body: `No mover accepted order ${order.orderNumber}. You can hold it and retry, or cancel it.`,
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
  return new DispatchService(app.prisma, app.redis, app.io, getMapsProvider(), scheduler);
}
