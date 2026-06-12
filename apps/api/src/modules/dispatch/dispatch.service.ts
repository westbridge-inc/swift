import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService } from '../notification/notification.service';
import { getMapsProvider, type MapsProvider } from '../../providers/maps/maps-provider';
import { rankCandidates, type DispatchCandidate } from './scoring';

declare module 'fastify' {
  interface FastifyInstance {
    /** Decorated in server.ts when background queues are up */
    dispatchQueue?: Queue;
  }
}

// ---------------------------------------------------------------------------
// Dispatch engine (master plan §8) — the most failure-sensitive module.
// Offer -> 20s timeout -> next candidate -> widen radius -> after the last
// round, an HONEST "no movers available" to customer AND vendor. Never a
// silent hang. Acceptance is atomic at the database: ten simultaneous
// accepts resolve to exactly one winner.
// ---------------------------------------------------------------------------

export const OFFER_TIMEOUT_SECONDS = 20;
const BASE_RADIUS_KM = 5;
const RADIUS_STEP_KM = 5;
const MAX_ROUNDS = 3;

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

  async findCandidates(orderId: string, pickup: { lat: number; lng: number }, radiusKm: number): Promise<DispatchCandidate[]> {
    const declined = await this.redis.smembers(declinedKey(orderId));

    const rows = await this.prisma.$queryRaw<GeoCandidateRow[]>`
      SELECT r."id", r."userId", r."currentLat", r."currentLng",
             r."averageRating", r."acceptanceRate", r."currentOrderId"
      FROM "riders" r
      WHERE r."isOnline" = true
        AND r."isAvailable" = true
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
        id: true, status: true, riderId: true, fulfillment: true, orderNumber: true,
        customerId: true, pickupLat: true, pickupLng: true,
        vendor: { select: { name: true, owner: { select: { userId: true } } } },
      },
    });
    if (!order) throw new NotFoundError('Order', orderId);
    if (order.riderId || order.fulfillment !== 'DELIVERY') return {};
    if (!['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status)) return {};
    if (order.pickupLat == null || order.pickupLng == null) return {};

    // One live offer at a time
    const existing = await this.redis.get(offerKey(orderId));
    if (existing) return { offered: existing };

    const round = Number((await this.redis.get(roundKey(orderId))) ?? 0);
    const radius = BASE_RADIUS_KM + round * RADIUS_STEP_KM;
    const candidates = await this.findCandidates(orderId, { lat: order.pickupLat, lng: order.pickupLng }, radius);

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
  async handleOfferTimeout(orderId: string, riderId: string): Promise<void> {
    const current = await this.redis.get(offerKey(orderId));
    if (current !== riderId) return; // answered or superseded — nothing to do

    await this.redis.del(offerKey(orderId));
    await this.redis.sadd(declinedKey(orderId), riderId);
    await this.redis.expire(declinedKey(orderId), 3600);
    await this.recordOfferOutcome(riderId, false);

    await this.dispatchOrder(orderId);
  }

  /** Explicit decline from the rider app. */
  async declineOffer(orderId: string, riderUserId: string): Promise<void> {
    const rider = await this.requireRider(riderUserId);
    const current = await this.redis.get(offerKey(orderId));
    if (current !== rider.id) {
      throw new AppError(409, 'OFFER_EXPIRED', 'This offer is no longer yours to decline');
    }

    await this.redis.del(offerKey(orderId));
    await this.redis.sadd(declinedKey(orderId), rider.id);
    await this.redis.expire(declinedKey(orderId), 3600);
    await this.recordOfferOutcome(rider.id, false);

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
  async acceptOffer(orderId: string, riderUserId: string) {
    const rider = await this.requireRider(riderUserId);

    const current = await this.redis.get(offerKey(orderId));
    if (current !== rider.id) {
      throw new AppError(409, 'OFFER_EXPIRED', 'This offer has expired or went to another mover');
    }

    return this.claimOrder(orderId, rider.id);
  }

  /** The DB-level claim — exposed separately so tests can hammer it raw. */
  async claimOrder(orderId: string, riderId: string) {
    const claimed = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        riderId: null,
        status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
      },
      data: { riderId, status: 'RIDER_ASSIGNED' },
    });

    if (claimed.count === 0) {
      throw new AppError(409, 'ALREADY_TAKEN', 'Another mover already took this job');
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { rider: { include: { user: { select: { firstName: true } } } } },
    });

    await this.prisma.orderStatusLog.create({
      data: { orderId, status: 'RIDER_ASSIGNED', changedBy: riderId, note: 'Mover accepted the job' },
    });

    await this.prisma.rider.update({
      where: { id: riderId },
      data: { isAvailable: false, currentOrderId: orderId },
    });
    await this.recordOfferOutcome(riderId, true);

    await this.redis.del(offerKey(orderId), declinedKey(orderId), roundKey(orderId));

    this.io.to(`order:${orderId}`).emit('order:status_changed', {
      orderId,
      status: 'RIDER_ASSIGNED',
      timestamp: new Date().toISOString(),
    });
    await this.notifications.riderAssigned(
      order.customerId,
      order.orderNumber,
      order.rider?.user?.firstName || 'Your mover',
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

  private async requireRider(userId: string) {
    const rider = await this.prisma.rider.findUnique({ where: { userId }, select: { id: true } });
    if (!rider) throw new NotFoundError('Rider');
    return rider;
  }

  /** Acceptance history feeds future scoring — abandoners drift down the list. */
  private async recordOfferOutcome(riderId: string, accepted: boolean) {
    const rider = await this.prisma.rider.findUnique({
      where: { id: riderId },
      select: { acceptanceRate: true },
    });
    if (!rider) return;
    // Exponential moving average: recent behaviour dominates
    const next = rider.acceptanceRate * 0.8 + (accepted ? 100 : 0) * 0.2;
    await this.prisma.rider.update({
      where: { id: riderId },
      data: { acceptanceRate: next },
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
