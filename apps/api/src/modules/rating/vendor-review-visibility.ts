import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { assertUsersMayContact, blockedAuthorIds } from '../moderation/user-block.service';
import { processReviewText } from './review-scrub';

type VendorReviewDb = Pick<PrismaClient, 'rating' | 'userBlock'>;

export interface RatingScoreBucket {
  score: number;
  _count: number;
}

/** One groupBy result is the authority for all review-summary fields. */
export function summarizeRatingDistribution(buckets: readonly RatingScoreBucket[]) {
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const bucket of buckets) distribution[bucket.score] = bucket._count;
  const totalReviews = buckets.reduce((sum, bucket) => sum + bucket._count, 0);
  const scoreSum = buckets.reduce(
    (sum, bucket) => sum + bucket.score * bucket._count,
    0,
  );
  return {
    distribution,
    totalReviews,
    averageRating: totalReviews > 0 ? scoreSum / totalReviews : 0,
  };
}

/** Compare-and-set boundary for first replies and concurrent edits. */
export function vendorReviewResponseCasWhere(
  reviewId: string,
  publishedWhere: Prisma.RatingWhereInput,
  observedResponse: string | null,
): Prisma.RatingWhereInput {
  return { id: reviewId, ...publishedWhere, response: observedResponse };
}

/** Notification copy must be the already-scrubbed text that was persisted. */
export function vendorReviewResponseNotificationBody(processedText: string): string {
  return processedText.length > 120
    ? `${processedText.slice(0, 117)}…`
    : processedText;
}

export function vendorReviewResponseDedupeKey(reviewId: string): string {
  return `vendor-review-response:${reviewId}`;
}

interface PersistedNotificationPublisher {
  publishPersisted(notificationId: string): Promise<boolean>;
}

function isSerializableConflict(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'P2034';
}

/**
 * Persist one response against the exact response value the operator read.
 * Two concurrent first replies therefore cannot both win or both proceed to
 * the caller's notification step.
 */
export async function writeVendorReviewResponse(
  db: Pick<PrismaClient, 'rating'>,
  input: {
    reviewId: string;
    publishedWhere: Prisma.RatingWhereInput;
    observedResponse: string | null;
    processedText: string;
    responderId: string;
    respondedAt: Date;
  },
) {
  const changed = await db.rating.updateMany({
    where: vendorReviewResponseCasWhere(
      input.reviewId,
      input.publishedWhere,
      input.observedResponse,
    ),
    data: {
      response: input.processedText,
      respondedAt: input.respondedAt,
      respondedBy: input.responderId,
    },
  });
  if (changed.count !== 1) {
    const stillVisible = await db.rating.findFirst({
      where: { id: input.reviewId, ...input.publishedWhere },
      select: { id: true },
    });
    if (!stillVisible) throw new NotFoundError('Review', input.reviewId);
    throw new AppError(
      409,
      'REVIEW_RESPONSE_CONFLICT',
      'This review response changed. Refresh it before replying again.',
    );
  }
  return db.rating.findUniqueOrThrow({ where: { id: input.reviewId } });
}

/**
 * Own the whole public-reply operation. The live block/publication reads,
 * response CAS and durable notification fact share one SERIALIZABLE commit;
 * only post-commit socket/push fan-out sits outside it. A serialization loser
 * retries from the live block decision instead of publishing stale contact.
 */
export async function respondToVendorReview(
  db: Pick<PrismaClient, '$transaction'>,
  publisher: PersistedNotificationPublisher,
  input: {
    tenantId: string;
    responderId: string;
    vendorId: string;
    reviewId: string;
    response: string;
    respondedAt: Date;
  },
) {
  const processed = processReviewText(input.response);
  if (processed.hold) {
    throw new AppError(
      400,
      'KEEP_IT_PROFESSIONAL',
      'That language can’t go on your storefront — rephrase and post again',
    );
  }

  let committed: {
    updated: Awaited<ReturnType<typeof writeVendorReviewResponse>>;
    notificationId: string | null;
  } | undefined;
  let hasObservedResponse = false;
  let operationObservedResponse: string | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      committed = await db.$transaction(async (tx) => {
        const { rating, where } = await requireRespondableVendorReview(tx, {
          tenantId: input.tenantId,
          responderId: input.responderId,
          vendorId: input.vendorId,
          reviewId: input.reviewId,
        });
        // A serialization retry belongs to the same logical request. Preserve
        // what that request first read: a losing first reply must not re-read
        // the winner as an editable value and silently overwrite it.
        if (!hasObservedResponse) {
          operationObservedResponse = rating.response;
          hasObservedResponse = true;
        }
        const isEdit = operationObservedResponse !== null;
        const updated = await writeVendorReviewResponse(tx, {
          reviewId: input.reviewId,
          publishedWhere: where,
          observedResponse: operationObservedResponse,
          processedText: processed.text,
          responderId: input.responderId,
          respondedAt: input.respondedAt,
        });

        let notificationId: string | null = null;
        if (!isEdit) {
          const vendor = await tx.vendor.findUniqueOrThrow({
            where: { id: input.vendorId },
            select: { name: true },
          });
          const notification = await tx.notification.create({
            data: {
              userId: rating.raterId,
              type: 'RATING_RECEIVED',
              title: `${vendor.name} replied to your review`,
              body: vendorReviewResponseNotificationBody(processed.text),
              data: {
                kind: 'review_response',
                ratingId: rating.id,
                vendorId: input.vendorId,
              },
              dedupeKey: vendorReviewResponseDedupeKey(rating.id),
            },
            select: { id: true },
          });
          notificationId = notification.id;
        }

        return { updated, notificationId };
      }, { isolationLevel: 'Serializable' });
      break;
    } catch (error) {
      if (!isSerializableConflict(error) || attempt === 3) throw error;
    }
  }

  if (!committed) throw new Error('Vendor review response transaction did not produce a result');
  if (committed.notificationId) {
    await publisher.publishPersisted(committed.notificationId);
  }
  return committed.updated;
}

/**
 * The single storefront publication boundary for a customer-to-vendor review.
 * Keep list rows, totals, score distributions and the operator reply door on
 * this predicate so none of those secondary surfaces disclose a review the
 * primary list withholds.
 */
export function publishedVendorReviewWhere(
  vendorId: string,
  hiddenAuthorIds: readonly string[] = [],
): Prisma.RatingWhereInput {
  return {
    vendorId,
    type: 'CUSTOMER_TO_VENDOR',
    state: 'ACTIVE',
    isPublic: true,
    visibleAt: { not: null },
    ...(hiddenAuthorIds.length > 0
      ? { raterId: { notIn: [...hiddenAuthorIds] } }
      : {}),
  };
}

/** Directional content rule: only the viewer's own blocks hide authors. */
export async function vendorReviewWhereForViewer(
  db: VendorReviewDb,
  tenantId: string,
  viewerId: string,
  vendorId: string,
): Promise<Prisma.RatingWhereInput> {
  const hiddenAuthorIds = await blockedAuthorIds(db, tenantId, viewerId);
  return publishedVendorReviewWhere(vendorId, hiddenAuthorIds);
}

/**
 * A public operator reply is contact, not just a database edit. The review
 * must first be publishable to this operator (directional visibility), then
 * the two people must be allowed to contact one another in either direction.
 */
export async function requireRespondableVendorReview(
  db: VendorReviewDb,
  input: {
    tenantId: string;
    responderId: string;
    vendorId: string;
    reviewId: string;
  },
) {
  const where = await vendorReviewWhereForViewer(
    db,
    input.tenantId,
    input.responderId,
    input.vendorId,
  );
  const rating = await db.rating.findFirst({
    where: { id: input.reviewId, ...where },
  });
  if (!rating) throw new NotFoundError('Review', input.reviewId);

  await assertUsersMayContact(
    db,
    input.tenantId,
    input.responderId,
    rating.raterId,
  );
  return { rating, where };
}
