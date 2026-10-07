import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { blockedAuthorIds } from '../moderation/user-block.service';
import { processReviewText } from './review-scrub';
import { guyanaDayKey, startOfGuyanaDay } from '../../utils/guyana-day';
import { createHash } from 'node:crypto';

type VendorReviewDb = Pick<PrismaClient, 'rating' | 'userBlock' | '$queryRaw'>;

/** A stable one-way identifier for old and new reviews. CUIDs carry an exact
 * generation time; their public digest does not expose that timestamp. No
 * migration or new runtime key is required, and cached legacy IDs remain
 * accepted as inputs. Never return a canonical rating ID from these surfaces. */
export function publicVendorReviewId(id: string): string {
  return `rv_${createHash('sha256').update(`swift-review:${id}`).digest('base64url')}`;
}

/** Resolve only at an authenticated mutation door, then re-run its existing
 * publication/tenant/author authority checks. Vendor replies additionally
 * constrain this lookup to the selected store before reading any review. */
export async function resolveVendorReviewId(
  db: Pick<PrismaClient, '$queryRaw'>, suppliedId: string, vendorId?: string,
): Promise<string> {
  if (!suppliedId.startsWith('rv_')) return suppliedId;
  if (!/^rv_[A-Za-z0-9_-]{43}$/.test(suppliedId)) throw new NotFoundError('Review', suppliedId);
  const rows = vendorId === undefined
    ? await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ratings WHERE
        'rv_' || rtrim(translate(encode(sha256(convert_to('swift-review:' || id, 'UTF8')), 'base64'), '+/', '-_'), '=') = ${suppliedId}
      LIMIT 1`
    : await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ratings WHERE "vendorId" = ${vendorId} AND
        'rv_' || rtrim(translate(encode(sha256(convert_to('swift-review:' || id, 'UTF8')), 'base64'), '+/', '-_'), '=') = ${suppliedId}
      LIMIT 1`;
  if (!rows[0]) throw new NotFoundError('Review', suppliedId);
  return rows[0].id;
}

/**
 * The only review fields a store may read about its own reviews: what was
 * said, when, and the store's own reply. Never the reviewer, the reviewer id,
 * the order id or moderation state — the order list already names the
 * customer per order, so any of those would tie a review to a person.
 */
export const STORE_REVIEW_PROJECTION = {
  id: true,
  type: true,
  score: true,
  comment: true,
  tags: true,
  response: true,
  respondedAt: true,
  createdAt: true,
} as const satisfies Prisma.RatingSelect;

/** The reply door answers with the same fields plus which team member replied. */
export const STORE_REVIEW_REPLY_PROJECTION = {
  ...STORE_REVIEW_PROJECTION,
  respondedBy: true,
} as const satisfies Prisma.RatingSelect;

/** Store orders already name customers and carry exact event times. Expose
 * only the review's Guyana calendar day, on both list and reply read-back. */
export function storeVisibleReview<T extends { id: string; createdAt: Date }>(review: T): T {
  return { ...review, id: publicVendorReviewId(review.id), createdAt: startOfGuyanaDay(guyanaDayKey(review.createdAt)) };
}

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
  const review = await db.rating.findUniqueOrThrow({
    where: { id: input.reviewId },
    select: STORE_REVIEW_REPLY_PROJECTION,
  });
  return storeVisibleReview(review);
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
          reviewId: rating.id,
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

/** A deleted account: deactivated by the deletion flow, which also replaces
 *  the phone with a `deleted:` marker. Either signal is enough. A missing
 *  account row counts as deleted too (fail closed). */
export function isDeletedAccount(user: { status: string; phone: string } | null | undefined): boolean {
  if (!user) return true;
  return user.status === 'DEACTIVATED' || user.phone.startsWith('deleted:');
}

/**
 * The store console uses publication alone. An operator controls their own
 * blocks and already knows customers from orders: changing a block must not
 * identify a review's author through either this door or the review list.
 * The author's own block still prevents a reply addressed to that author.
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
  const where = publishedVendorReviewWhere(input.vendorId);
  const canonicalId = await resolveVendorReviewId(db, input.reviewId, input.vendorId);
  const found = await db.rating.findFirst({
    where: { id: canonicalId, ...where },
    include: { rater: { select: { status: true, phone: true } } },
  });
  if (!found) throw new NotFoundError('Review', input.reviewId);
  const { rater, ...rating } = found;
  // Account deletion keeps a review's score and tags but removes its comment
  // and any store reply (owner decision 5 Oct). A store must not add text to
  // that de-identified review afterwards.
  if (isDeletedAccount(rater)) {
    throw new AppError(
      409,
      'REVIEW_AUTHOR_DELETED',
      'The person who wrote this review has deleted their account, so it can’t take a reply.',
    );
  }

  const authorBlock = await db.userBlock.findFirst({
    where: {
      tenantId: input.tenantId,
      blockerId: rating.raterId,
      blockedId: input.responderId,
      unblockedAt: null,
    },
    select: { id: true },
  });
  if (authorBlock) {
    throw new AppError(403, 'USER_BLOCKED', 'Contact is unavailable between these accounts.');
  }
  return { rating, where };
}
