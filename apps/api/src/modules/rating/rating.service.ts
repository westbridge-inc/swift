import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError } from '../../utils/errors';
import { RatingStatsService } from './rating-stats.service';
import { RATING_WINDOW_DAYS, SHIELD_PREP_BREACH_MIN } from './rating-math';
import { maskPii, processReviewText } from './review-scrub';
import { SAFETY_TAGS, canonicalTags, mostSevereSafetyTag } from './tag-registry';
import { ratingPipelineCounter } from '../../plugins/observability';
import { log } from '../../utils/logger';

// Safety spec ("Rating flags: reuse the ratings/quality engine — safety-tagged
// categories route here automatically"): a rating carrying one of these tags
// auto-opens an incident case via the pre-provisioned RATING_FLAG intake.
// Deterministic vocabulary, most-severe tag decides the category; the rating
// itself NEVER fails on intake trouble (fire-and-forget).
// [R048-008] the safety vocabulary lives in tag-registry.ts (canonical, typed); nothing here compares a string literal

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
    // [R048-008] ONE canonical vocabulary: what the client sent is canonicalised (an underscore
    // alias is accepted and emitted canonical) before it is stored, compared or matched.
    const tags = canonicalTags(input.tags);
    if (tags.length !== (input.tags ?? []).length || (input.tags ?? []).some((t, i) => t !== tags[i])) ratingPipelineCounter.labels('alias_tag').inc();
    const shielded =
      input.type === 'CUSTOMER_TO_RIDER' && prepBreached &&
      (input.score <= 3 || tags.includes('late'));

    return this.persist({
      orderId: input.orderId, raterId: input.raterId, rateeId: input.rateeId, vendorId: input.vendorId, type: input.type, score: input.score,
      comment: input.comment, tags,
      ...(shielded ? { state: 'EXCLUDED' as const, stateReason: 'SLA_SHIELD' } : {}),
    });
  }

  /** Test seam: a throw here is the process dying at that boundary. */
  failpoint?: (boundary: string, ctx?: Record<string, unknown>) => Promise<void>;

  /**
   * [R048-008] THE ONE PIPELINE every ingress ends in. The comment is scrubbed
   * BEFORE persistence; the rating row and the commands it still owes — the
   * safety intake when a safety tag was chosen, the double-blind release
   * check, the stats recompute — are written in ONE transaction; the commands
   * are then processed after commit, idempotently, or by the sweep when the
   * process died first. A rating that exists always has its commands.
   */
  private async persist(input: {
    orderId: string; raterId: string; rateeId?: string; vendorId?: string; type: RatingType; score: number; comment?: string; tags: string[];
    state?: 'EXCLUDED'; stateReason?: string;
  }) {
    // R7 pipeline: PII masked before storage; profanity auto-HOLDS the text
    // from public view (stars still count) pending the moderation queue.
    const processed = input.comment ? processReviewText(input.comment) : null;
    const safety = mostSevereSafetyTag(input.tags);
    const rating = await this.prisma.$transaction(async (tx) => {
      const row = await tx.rating.create({
        data: {
          orderId: input.orderId,
          raterId: input.raterId,
          rateeId: input.rateeId,
          vendorId: input.vendorId,
          type: input.type,
          score: input.score,
          comment: processed?.text ?? input.comment,
          ...(processed?.hold ? { isPublic: false, flagged: true, flagReason: 'PROFANITY_HOLD' } : {}),
          tags: input.tags,
          editableUntil: new Date(Date.now() + RATING_WINDOW_DAYS * 24 * 3600_000),
          ...(input.state ? { state: input.state, stateReason: input.stateReason } : {}),
        },
      });
      await this.failpoint?.('tx:after-rating');
      const commands: Array<{ command: string; payload?: Record<string, unknown> }> = [{ command: 'RELEASE' }, { command: 'STATS' }];
      if (safety && input.rateeId) {
        // evidence is the SCRUBBED, PII-MASKED text — never the original
        commands.push({ command: 'SAFETY_INTAKE', payload: { tag: safety, category: SAFETY_TAGS[safety].category, tags: input.tags, score: input.score, ...(processed?.text ? { comment: maskPii(processed.text).slice(0, 500) } : {}) } });
      }
      await tx.ratingOutbox.createMany({ data: commands.map((c) => ({ ratingId: row.id, command: c.command, payload: (c.payload ?? undefined) as never })) });
      await this.failpoint?.('tx:after-outbox', { ratingId: row.id });
      return row;
    });
    ratingPipelineCounter.labels('persisted').inc();
    await this.failpoint?.('after-commit');
    // inline, best effort — the sweep finishes whatever this did not
    await this.processRatingOutbox({ ratingId: rating.id }).catch((err) => log().warn({ err, ratingId: rating.id }, '[R048-008] rating outbox inline pass failed — the sweep retries'));
    return rating;
  }

  /**
   * [R048-008] Process the commands a rating owes. Each row is claimed with a
   * compare-and-set, handled by an idempotent handler (the incident intake is
   * one-source-one-case; the release and the stats recompute are pure
   * functions of the rows), and marked processed; a failure records the
   * attempt and leaves the row for the next pass. Exactly-once by
   * construction: one row per (rating, command).
   */
  async processRatingOutbox(opts: { ratingId?: string; limit?: number; now?: Date } = {}): Promise<{ processed: number; failed: number }> {
    const now = opts.now ?? new Date();
    const rows = await this.prisma.ratingOutbox.findMany({
      where: { processedAt: null, availableAt: { lte: now }, attempts: { lt: 25 }, ...(opts.ratingId ? { ratingId: opts.ratingId } : {}) },
      orderBy: { createdAt: 'asc' },
      take: opts.limit ?? 200,
    });
    let processed = 0; let failed = 0;
    for (const row of rows) {
      const claimed = await this.prisma.ratingOutbox.updateMany({
        where: { id: row.id, processedAt: null, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - 60_000) } }] },
        data: { claimedAt: now, attempts: { increment: 1 } },
      });
      if (claimed.count !== 1) continue;
      await this.failpoint?.('outbox:after-claim', { rowId: row.id, command: row.command });
      try {
        const rating = await this.prisma.rating.findUnique({ where: { id: row.ratingId } });
        if (!rating) { await this.prisma.ratingOutbox.update({ where: { id: row.id }, data: { processedAt: now, lastError: 'rating gone' } }); continue; }
        if (row.command === 'SAFETY_INTAKE') await this.flagSafetyTags(rating, (row.payload ?? {}) as { tag: string; category: string; tags: string[]; score: number; comment?: string });
        else if (row.command === 'RELEASE') await this.releaseIfBothSidesRated(rating.orderId);
        else if (row.command === 'STATS') await this.stats.applyRating(rating);
        else throw new Error(`unknown rating command ${row.command}`);
        await this.prisma.ratingOutbox.update({ where: { id: row.id }, data: { processedAt: new Date(), claimedAt: null, lastError: null } });
        ratingPipelineCounter.labels('outbox_processed').inc();
        processed += 1;
      } catch (err) {
        await this.prisma.ratingOutbox.update({ where: { id: row.id }, data: { claimedAt: null, lastError: err instanceof Error ? err.message.slice(0, 500) : String(err), availableAt: new Date(now.getTime() + 30_000) } }).catch(() => undefined);
        ratingPipelineCounter.labels('outbox_retry').inc();
        failed += 1;
      }
    }
    return { processed, failed };
  }

  /** [R048-008] The rating→incident bridge, run from the committed outbox command.
   *  Keyed on the canonical registry; evidence is the scrubbed, PII-masked text
   *  the command carried; the intake is one-source-one-case, so a replay
   *  returns the existing case. A missing `io` no longer drops the signal:
   *  the command stays unprocessed for a process that has one. */
  private async flagSafetyTags(rating: { id: string; orderId: string; raterId: string; rateeId: string | null; score: number }, payload: { tag: string; category: string; tags: string[]; score: number; comment?: string }): Promise<void> {
    if (!rating.rateeId) return;
    if (!this.io) throw new Error('safety-tagged rating with no io wired — left for a process that has one');
    const { IncidentService } = await import('../safety/incident.service');
    await new IncidentService(this.prisma, this.io).intake({
      category: payload.category,
      intake: 'RATING_FLAG',
      source: { type: 'RATING_FLAG', id: `${rating.orderId}:${rating.raterId}` },
      subjectUserId: rating.rateeId,
      reporterUserId: rating.raterId,
      orderId: rating.orderId,
      summary: `Safety-tagged rating (${payload.tag}, score ${payload.score}/5)`,
      details: { ratingId: rating.id, tags: payload.tags, score: payload.score, ...(payload.comment ? { comment: payload.comment } : {}) },
    });
    ratingPipelineCounter.labels('safety_incident').inc();
    log().warn({ ratingId: rating.id, tag: payload.tag, orderId: rating.orderId }, 'safety-tagged rating routed to incident intake');
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

  async getVendorReviews(vendorId: string, limit = 20, offset = 0) {
    const [reviews, total] = await Promise.all([
      this.prisma.rating.findMany({
        where: { vendorId, type: 'CUSTOMER_TO_VENDOR', isPublic: true, visibleAt: { not: null } },
        include: { rater: { select: { firstName: true, avatar: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.rating.count({ where: { vendorId, type: 'CUSTOMER_TO_VENDOR', isPublic: true, visibleAt: { not: null } } }),
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

  // (The per-role legacy-mean updaters are GONE [REPORT-034 S1]: they
  // aggregated every row regardless of RatingState, so a shielded or
  // moderator-excluded rating still moved the vendor/rider/driver mean that
  // dispatch scoring and storefront cards read. RatingStatsService.recompute
  // is the one writer now — same ACTIVE-only rows for both aggregates.)

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

    // [R048-008] the same pipeline as every other rating: scrubbed, transactional, outboxed
    return this.persist({ orderId: jobId, raterId, rateeId, type, score, comment, tags: [] });
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
