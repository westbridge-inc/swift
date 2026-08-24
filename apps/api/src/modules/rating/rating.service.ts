import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError } from '../../utils/errors';
import { RatingStatsService } from './rating-stats.service';
import { RATING_WINDOW_DAYS, SHIELD_PREP_BREACH_MIN } from './rating-math';
import { processReviewText } from './review-scrub';
import { log } from '../../utils/logger';
import { getTenantId } from '../../plugins/tenant-context';
import { blockedAuthorIds } from '../moderation/user-block.service';

// Safety spec ("Rating flags: reuse the ratings/quality engine — safety-tagged
// categories route here automatically"): a rating carrying one of these tags
// auto-opens an incident case via the pre-provisioned RATING_FLAG intake.
// Deterministic vocabulary, most-severe tag decides the category; the rating
// itself NEVER fails on intake trouble (fire-and-forget).
const SAFETY_TAG_CATEGORY: Record<string, string> = {
  different_driver: 'IDENTITY_MISMATCH', // S1
  harassment: 'SAFETY_HARASSMENT', // S2
  felt_unsafe: 'SAFETY_HARASSMENT', // S2
  unsafe_driving: 'DRIVING_DANGEROUS', // S2
  impaired_driving: 'DRIVING_DANGEROUS', // S2
};
// Severity precedence for picking ONE category when several tags land.
const SAFETY_TAG_ORDER = ['different_driver', 'harassment', 'felt_unsafe', 'unsafe_driving', 'impaired_driving'];

type RatingType =
  | 'CUSTOMER_TO_VENDOR'
  | 'CUSTOMER_TO_RIDER'
  | 'CUSTOMER_TO_DRIVER'
  | 'RIDER_TO_CUSTOMER'
  | 'DRIVER_TO_CUSTOMER'
  | 'CUSTOMER_TO_PROVIDER'
  | 'PROVIDER_TO_CUSTOMER';

interface RateInput {
  orderId: string;
  raterId: string;
  rateeId?: string;
  vendorId?: string;
  type: RatingType;
  score: number;
  comment?: string;
  tags?: string[];
}

export class RatingService {
  private stats: RatingStatsService;

  /** `io` is optional so read-only callers (jobs, release paths) need no
   *  socket; rating-CREATING routes pass it so safety flags can page ops. */
  constructor(private prisma: PrismaClient, private io?: Server) {
    this.stats = new RatingStatsService(prisma);
  }

  async rate(input: RateInput) {
    if (input.score < 1 || input.score > 5) {
      throw new AppError(400, 'INVALID_SCORE', 'Rating must be between 1 and 5');
    }

    // Verify the order exists and the rater actually participated in it.
    const order = await this.prisma.order.findUnique({
      where: { id: input.orderId },
      select: {
        customerId: true,
        riderId: true,
        driverId: true,
        vendorId: true,
        status: true,
        acceptedAt: true,
        readyAt: true,
        deliveredAt: true,
        estimatedPrepTime: true,
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { owner: { select: { userId: true } } } },
      },
    });

    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');

    if (!['DELIVERED', 'COMPLETED'].includes(order.status)) {
      throw new AppError(400, 'ORDER_NOT_COMPLETE', 'You can only rate completed orders');
    }

    // Verified-transaction (spec §5.2): only a participant in this order may rate.
    const participantIds = [
      order.customerId,
      order.rider?.userId,
      order.driver?.userId,
      order.vendor?.owner?.userId,
    ].filter((id): id is string => Boolean(id));
    if (!participantIds.includes(input.raterId)) {
      throw new AppError(403, 'NOT_A_PARTICIPANT', 'Only a participant in this transaction can rate it');
    }

    // RAT-A window law: rating opens at completion and closes RATING_WINDOW_DAYS
    // later (legacy rows without deliveredAt stay permissive — never punish old
    // data for a rule born after it).
    if (order.deliveredAt && Date.now() - order.deliveredAt.getTime() > RATING_WINDOW_DAYS * 24 * 3600_000) {
      throw new AppError(400, 'RATING_WINDOW_CLOSED', 'The rating window for this order has closed');
    }

    // RAT-A party-to-type matrix: each direction may only be filed by the party
    // it belongs to, about the party it names — a vendor owner can never
    // CUSTOMER_TO_VENDOR their own store, a customer can never rate themselves.
    const providerUserId = order.vendor?.owner?.userId;
    const expectedRater: Record<string, string | null | undefined> = {
      CUSTOMER_TO_VENDOR: order.customerId,
      CUSTOMER_TO_RIDER: order.customerId,
      CUSTOMER_TO_DRIVER: order.customerId,
      CUSTOMER_TO_PROVIDER: order.customerId,
      RIDER_TO_CUSTOMER: order.rider?.userId,
      DRIVER_TO_CUSTOMER: order.driver?.userId,
      PROVIDER_TO_CUSTOMER: providerUserId,
    };
    if (expectedRater[input.type] !== input.raterId) {
      throw new AppError(403, 'WRONG_PARTY', 'This rating direction belongs to a different party on the order');
    }
    const expectedSubject: Record<string, { vendorId?: string | null; rateeId?: string | null }> = {
      CUSTOMER_TO_VENDOR: { vendorId: order.vendorId },
      CUSTOMER_TO_RIDER: { rateeId: order.rider?.userId },
      CUSTOMER_TO_DRIVER: { rateeId: order.driver?.userId },
      CUSTOMER_TO_PROVIDER: { rateeId: providerUserId },
      RIDER_TO_CUSTOMER: { rateeId: order.customerId },
      DRIVER_TO_CUSTOMER: { rateeId: order.customerId },
      PROVIDER_TO_CUSTOMER: { rateeId: order.customerId },
    };
    const subject = expectedSubject[input.type] ?? {};
    if (subject.vendorId !== undefined && input.vendorId !== subject.vendorId) {
      throw new AppError(400, 'WRONG_SUBJECT', 'The rating names a party that was not on this order');
    }
    if (subject.rateeId !== undefined && (subject.rateeId == null || input.rateeId !== subject.rateeId)) {
      throw new AppError(400, 'WRONG_SUBJECT', 'The rating names a party that was not on this order');
    }

    // Prevent duplicate ratings
    const existing = await this.prisma.rating.findFirst({
      where: { orderId: input.orderId, raterId: input.raterId, type: input.type },
    });
    if (existing) {
      throw new AppError(409, 'ALREADY_RATED', 'You have already submitted a rating for this');
    }

    // S1 SLA shield [Movement R6]: a low/late rider rating on a delivery
    // whose kitchen blew its own quoted prep by ≥ SHIELD_PREP_BREACH_MIN is
    // born EXCLUDED — kept and auditable, never counted. The blame lands
    // where the delay happened; the customer's vendor rating stands.
    const prepBreached =
      order.acceptedAt != null && order.readyAt != null &&
      order.readyAt.getTime() - order.acceptedAt.getTime() >
        ((order.estimatedPrepTime ?? 30) + SHIELD_PREP_BREACH_MIN) * 60_000;
    const shielded =
      input.type === 'CUSTOMER_TO_RIDER' && prepBreached &&
      (input.score <= 3 || (input.tags ?? []).includes('late'));

    // R7 pipeline: PII masked before storage; profanity auto-HOLDS the text
    // from public view (stars still count) pending the moderation queue.
    const processed = input.comment ? processReviewText(input.comment) : null;

    const rating = await this.prisma.rating.create({
      data: {
        orderId: input.orderId,
        raterId: input.raterId,
        rateeId: input.rateeId,
        vendorId: input.vendorId,
        type: input.type,
        score: input.score,
        comment: processed?.text ?? input.comment,
        ...(processed?.hold ? { isPublic: false, flagged: true, flagReason: 'PROFANITY_HOLD' } : {}),
        tags: input.tags || [],
        editableUntil: new Date(Date.now() + RATING_WINDOW_DAYS * 24 * 3600_000),
        ...(shielded ? { state: 'EXCLUDED' as const, stateReason: 'SLA_SHIELD' } : {}),
      },
    });

    // Safety spec: a safety-tagged rating auto-opens an incident case
    // (RATING_FLAG intake). Fire-and-forget — a rating never fails on it.
    void this.flagSafetyTags(rating.id, input).catch(() => {});

    // Double-blind (marketplace §1): written ratings stay hidden until the
    // other side has rated too (aggregates still update immediately below).
    await this.releaseIfBothSidesRated(input.orderId);

    // Update aggregate ratings
    if (input.type === 'CUSTOMER_TO_VENDOR' && input.vendorId) {
      await this.updateVendorRating(input.vendorId);
    }
    if (input.type === 'CUSTOMER_TO_RIDER' && order.riderId) {
      await this.updateRiderRating(order.riderId);
    }
    if (input.type === 'CUSTOMER_TO_DRIVER' && order.driverId) {
      await this.updateDriverRating(order.driverId);
    }

    // Movement R: the materialized stat (the only thing new UIs read) moves
    // in the same breath — EXCLUDED rows never count, so a shielded rating
    // leaves the rider's aggregate untouched by construction.
    await this.stats.applyRating(rating);

    return rating;
  }

  /** The rating→incident bridge. Most-severe safety tag decides the category;
   *  one case per rating (ratings are unique per order+rater+type). */
  private async flagSafetyTags(ratingId: string, input: RateInput): Promise<void> {
    const tags = (input.tags ?? []).map((t) => t.trim().toLowerCase());
    const hit = SAFETY_TAG_ORDER.find((t) => tags.includes(t));
    if (!hit || !input.rateeId) return;
    if (!this.io) {
      // A creating path without io would silently drop safety signal — loud log
      // so it can never rot unnoticed.
      log().error({ ratingId, tag: hit }, 'safety-tagged rating with no io wired — incident intake skipped');
      return;
    }
    const { IncidentService } = await import('../safety/incident.service');
    await new IncidentService(this.prisma, this.io).intake({
      category: SAFETY_TAG_CATEGORY[hit]!,
      intake: 'RATING_FLAG',
      subjectUserId: input.rateeId,
      reporterUserId: input.raterId,
      orderId: input.orderId,
      summary: `Safety-tagged rating (${hit}, score ${input.score}/5)`,
      details: { ratingId, tags, score: input.score, ...(input.comment ? { comment: input.comment } : {}) },
    });
    log().warn({ ratingId, tag: hit, orderId: input.orderId }, 'safety-tagged rating routed to incident intake');
  }

  async rateOrder(userId: string, orderId: string, input: {
    vendorScore?: number;
    vendorComment?: string;
    vendorTags?: string[];
    riderScore?: number;
    riderComment?: string;
    riderTags?: string[];
    driverScore?: number;
    driverComment?: string;
    driverTags?: string[];
  }) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: userId },
      include: {
        vendor: { select: { id: true } },
        rider: { select: { id: true, userId: true } },
        driver: { select: { id: true, userId: true } },
      },
    });

    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    if (!['DELIVERED', 'COMPLETED'].includes(order.status)) {
      throw new AppError(400, 'ORDER_NOT_COMPLETE', 'You can only rate completed orders');
    }

    const ratings: Array<{ type: string; score: number }> = [];

    // Rate vendor
    if (input.vendorScore && order.vendorId) {
      await this.rate({
        orderId,
        raterId: userId,
        vendorId: order.vendorId,
        type: 'CUSTOMER_TO_VENDOR',
        score: input.vendorScore,
        comment: input.vendorComment,
        tags: input.vendorTags,
      });
      ratings.push({ type: 'vendor', score: input.vendorScore });
    }

    // Rate rider
    if (input.riderScore && order.rider) {
      await this.rate({
        orderId,
        raterId: userId,
        rateeId: order.rider.userId,
        type: 'CUSTOMER_TO_RIDER',
        score: input.riderScore,
        comment: input.riderComment,
        tags: input.riderTags,
      });
      ratings.push({ type: 'rider', score: input.riderScore });
    }

    // Rate driver
    if (input.driverScore && order.driver) {
      await this.rate({
        orderId,
        raterId: userId,
        rateeId: order.driver.userId,
        type: 'CUSTOMER_TO_DRIVER',
        score: input.driverScore,
        comment: input.driverComment,
        tags: input.driverTags,
      });
      ratings.push({ type: 'driver', score: input.driverScore });
    }

    return { ratings, message: 'Thank you for your feedback!' };
  }

  async getVendorReviews(vendorId: string, limit = 20, offset = 0, viewerId?: string) {
    const tenantId = getTenantId();
    const [hiddenAuthorIds, vendor] = await Promise.all([
      viewerId && tenantId
        ? blockedAuthorIds(this.prisma, tenantId, viewerId)
        : Promise.resolve([]),
      viewerId && tenantId
        ? this.prisma.vendor.findFirst({
            where: { id: vendorId, tenantId },
            select: { owner: { select: { userId: true } } },
          })
        : Promise.resolve(null),
    ]);
    const visibleAuthors = hiddenAuthorIds.length > 0
      ? { raterId: { notIn: hiddenAuthorIds } }
      : {};
    const [reviews, total] = await Promise.all([
      this.prisma.rating.findMany({
        where: { vendorId, type: 'CUSTOMER_TO_VENDOR', isPublic: true, visibleAt: { not: null }, ...visibleAuthors },
        include: { rater: { select: { id: true, firstName: true, avatar: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.rating.count({
        where: { vendorId, type: 'CUSTOMER_TO_VENDOR', isPublic: true, visibleAt: { not: null }, ...visibleAuthors },
      }),
    ]);

    // Rating distribution
    const distribution = await this.prisma.rating.groupBy({
      by: ['score'],
      where: { vendorId, type: 'CUSTOMER_TO_VENDOR', ...visibleAuthors },
      _count: true,
    });

    const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const d of distribution) dist[d.score] = d._count;

    const hidden = new Set(hiddenAuthorIds);
    const visibleReviews = reviews.map((review) => {
      const responseAuthorId = review.respondedBy ?? vendor?.owner.userId;
      if (!responseAuthorId || !hidden.has(responseAuthorId)) return review;
      return { ...review, response: null, respondedAt: null, respondedBy: null };
    });

    return { reviews: visibleReviews, total, distribution: dist };
  }

  /**
   * Double-blind release: once the order has ratings from BOTH directions
   * (a customer-authored one and a counterpart-authored one), every rating on
   * the order becomes visible. Until then — or the sweep window — the written
   * rating stays hidden from the ratee, so nobody retaliates.
   */
  async releaseIfBothSidesRated(orderId: string) {
    const sides = await this.prisma.rating.findMany({
      where: { orderId },
      select: { type: true },
    });
    const customerSide = sides.some((r) => r.type.startsWith('CUSTOMER_TO'));
    const counterpartSide = sides.some((r) => !r.type.startsWith('CUSTOMER_TO'));
    if (customerSide && counterpartSide) {
      await this.prisma.rating.updateMany({
        where: { orderId, visibleAt: null },
        data: { visibleAt: new Date() },
      });
    }
  }

  /** Sweep half of double-blind: release anything older than the window —
   *  a no-show counterpart must not hide feedback forever. */
  async releaseDoubleBlind(windowHours = 72): Promise<number> {
    const res = await this.prisma.rating.updateMany({
      where: { visibleAt: null, createdAt: { lt: new Date(Date.now() - windowHours * 3600_000) } },
      data: { visibleAt: new Date() },
    });
    return res.count;
  }

  private async updateVendorRating(vendorId: string) {
    const agg = await this.prisma.rating.aggregate({
      where: { vendorId, type: 'CUSTOMER_TO_VENDOR' },
      _avg: { score: true },
      _count: true,
    });
    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        averageRating: Math.round((agg._avg.score || 5) * 10) / 10,
        totalRatings: agg._count,
      },
    });
  }

  private async updateRiderRating(riderId: string) {
    const rider = await this.prisma.rider.findUnique({ where: { id: riderId }, select: { userId: true } });
    if (!rider) return;
    const agg = await this.prisma.rating.aggregate({
      where: { rateeId: rider.userId, type: 'CUSTOMER_TO_RIDER' },
      _avg: { score: true },
      _count: true,
    });
    await this.prisma.rider.update({
      where: { id: riderId },
      data: {
        averageRating: Math.round((agg._avg.score || 5) * 10) / 10,
        totalRatings: agg._count,
      },
    });
  }

  private async updateDriverRating(driverId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { id: driverId }, select: { userId: true } });
    if (!driver) return;
    const agg = await this.prisma.rating.aggregate({
      where: { rateeId: driver.userId, type: 'CUSTOMER_TO_DRIVER' },
      _avg: { score: true },
      _count: true,
    });
    await this.prisma.driver.update({
      where: { id: driverId },
      data: {
        averageRating: Math.round((agg._avg.score || 5) * 10) / 10,
        totalRatings: agg._count,
      },
    });
  }

  /** Two-way service rating on a completed ServiceJob (verified participant). */
  async rateServiceJob(jobId: string, raterId: string, score: number, comment?: string) {
    if (score < 1 || score > 5) {
      throw new AppError(400, 'INVALID_SCORE', 'Rating must be between 1 and 5');
    }
    const job = await this.prisma.serviceJob.findUnique({
      where: { id: jobId },
      select: { status: true, customerId: true, provider: { select: { id: true, userId: true } } },
    });
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Service job not found');
    if (job.status !== 'COMPLETED') {
      throw new AppError(400, 'JOB_NOT_COMPLETE', 'You can only rate completed jobs');
    }

    const isCustomer = raterId === job.customerId;
    const isProvider = raterId === job.provider.userId;
    if (!isCustomer && !isProvider) {
      throw new AppError(403, 'NOT_A_PARTICIPANT', 'Only a participant in this job can rate it');
    }
    const type: RatingType = isCustomer ? 'CUSTOMER_TO_PROVIDER' : 'PROVIDER_TO_CUSTOMER';
    const rateeId = isCustomer ? job.provider.userId : job.customerId;

    const existing = await this.prisma.rating.findFirst({ where: { orderId: jobId, raterId, type } });
    if (existing) throw new AppError(409, 'ALREADY_RATED', 'You have already rated this job');

    const processed = comment ? processReviewText(comment) : null;

    const rating = await this.prisma.rating.create({
      data: {
        orderId: jobId,
        raterId,
        rateeId,
        type,
        score,
        comment: processed?.text ?? comment,
        ...(processed?.hold ? { isPublic: false, flagged: true, flagReason: 'PROFANITY_HOLD' } : {}),
      },
    });
    if (isCustomer) await this.updateProviderRating(job.provider.id, job.provider.userId);
    return rating;
  }

  private async updateProviderRating(providerId: string, providerUserId: string) {
    const agg = await this.prisma.rating.aggregate({
      where: { rateeId: providerUserId, type: 'CUSTOMER_TO_PROVIDER' },
      _avg: { score: true },
      _count: true,
    });
    await this.prisma.serviceProvider.update({
      where: { id: providerId },
      data: {
        averageRating: Math.round((agg._avg.score || 5) * 10) / 10,
        totalRatings: agg._count,
      },
    });
  }

  /**
   * Anti-manipulation sweep (spec §5.2): flag rating-bombing — the same rater
   * leaving 3+ low scores (<=2) against the same target within 24h. Verified-
   * transaction already blocks non-buyers; this catches sabotage patterns for
   * human review. Returns the number of ratings flagged.
   */
  async flagSuspiciousRatings(now = new Date()): Promise<number> {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const recent = await this.prisma.rating.findMany({
      where: { createdAt: { gte: since }, score: { lte: 2 }, flagged: false },
      select: { id: true, raterId: true, vendorId: true, rateeId: true },
    });

    const groups = new Map<string, string[]>();
    for (const r of recent) {
      const target = r.vendorId ?? r.rateeId ?? 'none';
      const key = `${r.raterId}:${target}`;
      const ids = groups.get(key) ?? [];
      ids.push(r.id);
      groups.set(key, ids);
    }

    const toFlag: string[] = [];
    for (const ids of groups.values()) {
      if (ids.length >= 3) toFlag.push(...ids);
    }
    if (toFlag.length === 0) return 0;

    await this.prisma.rating.updateMany({
      where: { id: { in: toFlag } },
      data: { flagged: true, flagReason: 'rating_bombing_suspected' },
    });
    return toFlag.length;
  }
}
