import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';

type RatingType =
  | 'CUSTOMER_TO_VENDOR'
  | 'CUSTOMER_TO_RIDER'
  | 'CUSTOMER_TO_DRIVER'
  | 'RIDER_TO_CUSTOMER'
  | 'DRIVER_TO_CUSTOMER';

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

    // Verify order exists and rater is a participant
    const order = await this.prisma.order.findUnique({
      where: { id: input.orderId },
      select: { customerId: true, riderId: true, driverId: true, vendorId: true, status: true },
    });

    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');

    if (!['DELIVERED', 'COMPLETED'].includes(order.status)) {
      throw new AppError(400, 'ORDER_NOT_COMPLETE', 'You can only rate completed orders');
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
}
