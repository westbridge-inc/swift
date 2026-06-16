import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';

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
  constructor(private prisma: PrismaClient) {}

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

    // Prevent duplicate ratings
    const existing = await this.prisma.rating.findFirst({
      where: { orderId: input.orderId, raterId: input.raterId, type: input.type },
    });
    if (existing) {
      throw new AppError(409, 'ALREADY_RATED', 'You have already submitted a rating for this');
    }

    const rating = await this.prisma.rating.create({
      data: {
        orderId: input.orderId,
        raterId: input.raterId,
        rateeId: input.rateeId,
        vendorId: input.vendorId,
        type: input.type,
        score: input.score,
        comment: input.comment,
        tags: input.tags || [],
      },
    });

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

    return rating;
  }

  async rateOrder(userId: string, orderId: string, input: {
    vendorScore?: number;
    vendorComment?: string;
    vendorTags?: string[];
    riderScore?: number;
    riderComment?: string;
    driverScore?: number;
    driverComment?: string;
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
      });
      ratings.push({ type: 'driver', score: input.driverScore });
    }

    return { ratings, message: 'Thank you for your feedback!' };
  }

  async getVendorReviews(vendorId: string, limit = 20, offset = 0) {
    const [reviews, total] = await Promise.all([
      this.prisma.rating.findMany({
        where: { vendorId, type: 'CUSTOMER_TO_VENDOR', isPublic: true },
        include: { rater: { select: { firstName: true, avatar: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.rating.count({ where: { vendorId, type: 'CUSTOMER_TO_VENDOR', isPublic: true } }),
    ]);

    // Rating distribution
    const distribution = await this.prisma.rating.groupBy({
      by: ['score'],
      where: { vendorId, type: 'CUSTOMER_TO_VENDOR' },
      _count: true,
    });

    const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const d of distribution) dist[d.score] = d._count;

    return { reviews, total, distribution: dist };
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

    const rating = await this.prisma.rating.create({
      data: { orderId: jobId, raterId, rateeId, type, score, comment },
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
