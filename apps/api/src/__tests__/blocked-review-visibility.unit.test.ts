import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { RatingService } from '../modules/rating/rating.service';
import { processReviewText } from '../modules/rating/review-scrub';
import {
  requireRespondableVendorReview,
  respondToVendorReview,
  summarizeRatingDistribution,
  vendorReviewResponseCasWhere,
  vendorReviewResponseDedupeKey,
  vendorReviewResponseNotificationBody,
  vendorReviewWhereForViewer,
  writeVendorReviewResponse,
} from '../modules/rating/vendor-review-visibility';

function fakePrisma(
  blockedIds: string[] = [],
  options: {
    review?: { id: string; raterId: string } | null;
    contactBlock?: { id: string; blockerId: string; blockedId: string; blockedAt: Date } | null;
    scoreBuckets?: Array<{ score: number; _count: number }>;
  } = {},
) {
  const userBlockFindMany = vi.fn().mockResolvedValue(
    blockedIds.map((blockedId) => ({ blockedId })),
  );
  const userBlockFindFirst = vi.fn().mockResolvedValue(options.contactBlock ?? null);
  const ratingFindMany = vi.fn().mockResolvedValue([]);
  const ratingFindFirst = vi.fn().mockResolvedValue(options.review ?? null);
  const ratingGroupBy = vi.fn().mockResolvedValue(options.scoreBuckets ?? []);
  const prisma = {
    userBlock: {
      findMany: userBlockFindMany,
      findFirst: userBlockFindFirst,
    },
    rating: {
      findMany: ratingFindMany,
      findFirst: ratingFindFirst,
      groupBy: ratingGroupBy,
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    userBlockFindMany,
    userBlockFindFirst,
    ratingFindMany,
    ratingFindFirst,
    ratingGroupBy,
  };
}

describe('vendor review visibility for a user block', () => {
  it('hides only authors blocked by the signed-in viewer from rows, total and distribution', async () => {
    const db = fakePrisma(['blocked-author']);
    const service = new RatingService(db.prisma);

    await service.getVendorReviews('vendor-1', 20, 40, {
      tenantId: 'tenant-1',
      userId: 'viewer-1',
    });

    expect(db.userBlockFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        blockerId: 'viewer-1',
        unblockedAt: null,
      },
      select: { blockedId: true },
    });
    const where = {
      vendorId: 'vendor-1',
      type: 'CUSTOMER_TO_VENDOR',
      state: 'ACTIVE',
      isPublic: true,
      visibleAt: { not: null },
      raterId: { notIn: ['blocked-author'] },
    };
    expect(db.ratingFindMany).toHaveBeenCalledWith(expect.objectContaining({ where, take: 20, skip: 40 }));
    expect(db.ratingGroupBy).toHaveBeenCalledWith({ by: ['score'], where, _count: true });
  });

  it('keeps guest review browse public while applying the publication predicate everywhere', async () => {
    const db = fakePrisma();
    const service = new RatingService(db.prisma);

    await service.getVendorReviews('vendor-2');

    expect(db.userBlockFindMany).not.toHaveBeenCalled();
    const where = {
      vendorId: 'vendor-2',
      type: 'CUSTOMER_TO_VENDOR',
      state: 'ACTIVE',
      isPublic: true,
      visibleAt: { not: null },
    };
    expect(db.ratingFindMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(db.ratingGroupBy).toHaveBeenCalledWith({ by: ['score'], where, _count: true });
  });

  it('derives total, average and distribution from one score snapshot', async () => {
    const db = fakePrisma([], {
      scoreBuckets: [
        { score: 1, _count: 1 },
        { score: 5, _count: 2 },
      ],
    });
    const service = new RatingService(db.prisma);

    const result = await service.getVendorReviews('vendor-1');

    expect(result.total).toBe(3);
    expect(result.averageRating).toBe(11 / 3);
    expect(result.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 0, 5: 2 });
  });

  it('cannot manufacture an impossible average from a mismatched count query', () => {
    expect(summarizeRatingDistribution([{ score: 5, _count: 2 }])).toEqual({
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2 },
      totalReviews: 2,
      averageRating: 5,
    });
  });

  it('compare-and-sets a first reply against the observed null response', () => {
    const publishedWhere = {
      vendorId: 'vendor-1',
      type: 'CUSTOMER_TO_VENDOR' as const,
      state: 'ACTIVE' as const,
      isPublic: true,
      visibleAt: { not: null },
    };

    expect(vendorReviewResponseCasWhere('review-1', publishedWhere, null)).toEqual({
      id: 'review-1',
      ...publishedWhere,
      response: null,
    });
    expect(vendorReviewResponseDedupeKey('review-1')).toBe('vendor-review-response:review-1');
  });

  it('uses scrubbed persisted reply text for notification copy', () => {
    const processed = processReviewText(
      'Call +592 600 1234 or email owner@example.com and visit https://outside.example/path',
    );

    const body = vendorReviewResponseNotificationBody(processed.text);

    expect(body).toBe(processed.text);
    expect(body).not.toContain('600 1234');
    expect(body).not.toContain('owner@example.com');
    expect(body).not.toContain('outside.example');
  });

  it('allows one concurrent first-reply winner and atomically stages one scrubbed notification', async () => {
    const updateMany = vi.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const rawResponse = 'Call +592 600 1234 or email owner@example.com';
    const scrubbed = processReviewText(rawResponse).text;
    const notificationCreate = vi.fn().mockResolvedValue({ id: 'notification-1' });
    const tx = {
      userBlock: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      rating: {
        updateMany,
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'review-1', response: scrubbed }),
        findFirst: vi.fn().mockResolvedValue({ id: 'review-1', raterId: 'author-1', response: null }),
      },
      vendor: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ name: 'Store One' }),
      },
      notification: { create: notificationCreate },
    };
    const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
    const db = { $transaction: transaction } as unknown as PrismaClient;
    const publishPersisted = vi.fn().mockResolvedValue(true);
    const attempt = () => respondToVendorReview(db, { publishPersisted }, {
      tenantId: 'tenant-1',
      responderId: 'operator-1',
      vendorId: 'vendor-1',
      reviewId: 'review-1',
      response: rawResponse,
      respondedAt: new Date('2026-09-12T00:00:00Z'),
    });

    const outcomes = await Promise.allSettled([attempt(), attempt()]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { statusCode: 409, code: 'REVIEW_RESPONSE_CONFLICT' } });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ response: scrubbed }),
    }));
    expect(notificationCreate).toHaveBeenCalledTimes(1);
    expect(notificationCreate).toHaveBeenCalledWith({
      data: {
        userId: 'author-1',
        type: 'RATING_RECEIVED',
        title: 'Store One replied to your review',
        body: scrubbed,
        data: { kind: 'review_response', ratingId: 'review-1', vendorId: 'vendor-1' },
        dedupeKey: 'vendor-review-response:review-1',
      },
      select: { id: true },
    });
    expect(JSON.stringify(notificationCreate.mock.calls)).not.toContain('600 1234');
    expect(JSON.stringify(notificationCreate.mock.calls)).not.toContain('owner@example.com');
    expect(publishPersisted).toHaveBeenCalledTimes(1);
    expect(publishPersisted).toHaveBeenCalledWith('notification-1');
  });

  it('retries a serialization loser and refuses when a block committed during the reply race', async () => {
    const firstUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const firstNotification = vi.fn().mockResolvedValue({ id: 'rolled-back-notification' });
    const firstTx = {
      userBlock: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      rating: {
        findFirst: vi.fn().mockResolvedValue({ id: 'review-1', raterId: 'author-1', response: null }),
        updateMany: firstUpdate,
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'review-1', response: 'First try' }),
      },
      vendor: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: 'Store One' }) },
      notification: { create: firstNotification },
    };
    const secondUpdate = vi.fn();
    const secondTx = {
      userBlock: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue({
          id: 'block-1',
          blockerId: 'author-1',
          blockedId: 'operator-1',
          blockedAt: new Date('2026-09-12T00:00:01Z'),
        }),
      },
      rating: {
        findFirst: vi.fn().mockResolvedValue({ id: 'review-1', raterId: 'author-1', response: null }),
        updateMany: secondUpdate,
      },
    };
    let attempt = 0;
    const transaction = vi.fn(async (fn: (client: typeof firstTx) => Promise<unknown>) => {
      attempt += 1;
      if (attempt === 1) {
        await fn(firstTx);
        throw Object.assign(new Error('serialization conflict'), { code: 'P2034' });
      }
      return fn(secondTx as unknown as typeof firstTx);
    });
    const db = { $transaction: transaction } as unknown as PrismaClient;
    const publishPersisted = vi.fn().mockResolvedValue(true);

    await expect(respondToVendorReview(db, { publishPersisted }, {
      tenantId: 'tenant-1',
      responderId: 'operator-1',
      vendorId: 'vendor-1',
      reviewId: 'review-1',
      response: 'Thank you',
      respondedAt: new Date('2026-09-12T00:00:00Z'),
    })).rejects.toMatchObject({ statusCode: 403, code: 'USER_BLOCKED' });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(firstUpdate).toHaveBeenCalledTimes(1);
    expect(firstNotification).toHaveBeenCalledTimes(1);
    expect(secondUpdate).not.toHaveBeenCalled();
    expect(publishPersisted).not.toHaveBeenCalled();
  });

  it('keeps a losing first reply a conflict across a serialization retry', async () => {
    const firstTx = {
      userBlock: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      rating: {
        findFirst: vi.fn().mockResolvedValue({ id: 'review-1', raterId: 'author-1', response: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'review-1', response: 'This request' }),
      },
      vendor: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: 'Store One' }) },
      notification: { create: vi.fn().mockResolvedValue({ id: 'rolled-back-notification' }) },
    };
    const secondUpdate = vi.fn().mockImplementation(({ where }) => {
      expect(where.response).toBeNull();
      return Promise.resolve({ count: 0 });
    });
    const secondTx = {
      userBlock: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      rating: {
        findFirst: vi.fn().mockResolvedValue({ id: 'review-1', raterId: 'author-1', response: 'Other winner' }),
        updateMany: secondUpdate,
      },
    };
    let transactionAttempt = 0;
    const transaction = vi.fn(async (fn: (client: typeof firstTx) => Promise<unknown>) => {
      transactionAttempt += 1;
      if (transactionAttempt === 1) {
        await fn(firstTx);
        throw Object.assign(new Error('serialization conflict'), { code: 'P2034' });
      }
      return fn(secondTx as unknown as typeof firstTx);
    });
    const db = { $transaction: transaction } as unknown as PrismaClient;
    const publishPersisted = vi.fn().mockResolvedValue(true);

    await expect(respondToVendorReview(db, { publishPersisted }, {
      tenantId: 'tenant-1',
      responderId: 'operator-1',
      vendorId: 'vendor-1',
      reviewId: 'review-1',
      response: 'This request',
      respondedAt: new Date('2026-09-12T00:00:00Z'),
    })).rejects.toMatchObject({ statusCode: 409, code: 'REVIEW_RESPONSE_CONFLICT' });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(secondUpdate).toHaveBeenCalledTimes(1);
    expect(publishPersisted).not.toHaveBeenCalled();
  });

  it('returns not found when moderation removes publication before the response CAS', async () => {
    const writeDb = {
      rating: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue(null),
        findUniqueOrThrow: vi.fn(),
      },
    } as unknown as PrismaClient;

    await expect(writeVendorReviewResponse(writeDb, {
        reviewId: 'review-1',
        publishedWhere: {
          vendorId: 'vendor-1',
          type: 'CUSTOMER_TO_VENDOR',
          state: 'ACTIVE',
          isPublic: true,
          visibleAt: { not: null },
        },
        observedResponse: null,
        processedText: 'Thanks',
        responderId: 'operator-1',
        respondedAt: new Date('2026-09-12T00:00:00Z'),
      })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('uses the same active, released, public predicate for an operator viewer', async () => {
    const db = fakePrisma(['blocked-author']);

    const where = await vendorReviewWhereForViewer(
      db.prisma,
      'tenant-1',
      'operator-1',
      'vendor-1',
    );

    expect(where).toEqual({
      vendorId: 'vendor-1',
      type: 'CUSTOMER_TO_VENDOR',
      state: 'ACTIVE',
      isPublic: true,
      visibleAt: { not: null },
      raterId: { notIn: ['blocked-author'] },
    });
  });

  it('does not open the reply door for a hidden review', async () => {
    const db = fakePrisma(['blocked-author']);

    await expect(requireRespondableVendorReview(db.prisma, {
      tenantId: 'tenant-1',
      responderId: 'operator-1',
      vendorId: 'vendor-1',
      reviewId: 'review-1',
    })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });

    expect(db.ratingFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'review-1',
        vendorId: 'vendor-1',
        type: 'CUSTOMER_TO_VENDOR',
        state: 'ACTIVE',
        isPublic: true,
        visibleAt: { not: null },
        raterId: { notIn: ['blocked-author'] },
      },
    });
    expect(db.userBlockFindFirst).not.toHaveBeenCalled();
  });

  it('refuses a reply when the author blocked the operator', async () => {
    const contactBlock = {
      id: 'block-1',
      blockerId: 'author-1',
      blockedId: 'operator-1',
      blockedAt: new Date('2026-09-12T00:00:00Z'),
    };
    const db = fakePrisma([], {
      review: { id: 'review-1', raterId: 'author-1' },
      contactBlock,
    });

    await expect(requireRespondableVendorReview(db.prisma, {
      tenantId: 'tenant-1',
      responderId: 'operator-1',
      vendorId: 'vendor-1',
      reviewId: 'review-1',
    })).rejects.toMatchObject({ statusCode: 403, code: 'USER_BLOCKED' });
  });

  it('allows an unaffected operator to reach a published review', async () => {
    const review = { id: 'review-1', raterId: 'author-1' };
    const db = fakePrisma([], { review });

    await expect(requireRespondableVendorReview(db.prisma, {
      tenantId: 'tenant-1',
      responderId: 'operator-1',
      vendorId: 'vendor-1',
      reviewId: 'review-1',
    })).resolves.toMatchObject({ rating: review });
    expect(db.userBlockFindFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        unblockedAt: null,
        OR: [
          { blockerId: 'operator-1', blockedId: 'author-1' },
          { blockerId: 'author-1', blockedId: 'operator-1' },
        ],
      },
      select: { id: true, blockerId: true, blockedId: true, blockedAt: true },
    });
  });
});
