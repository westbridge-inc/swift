import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RatingService } from '../rating/rating.service';
import { NotificationService } from '../notification/notification.service';
import {
  canonicalServiceTrade,
  createServiceJobWithLiveAuthority,
  decodeProviderCursor,
  encodeProviderCursor,
  isProviderVerified,
  projectProviderVerificationLocked,
  qualificationTypeMatchesTrade,
  refreshProviderVerification,
  requireCanonicalServiceTrade,
  riskGuidance,
  serviceTradeLabel,
  tradeRiskTier,
} from './services.service';
import { AppError, NotFoundError } from '../../utils/errors';
import { getTenantId } from '../../plugins/prisma';

// ---------------------------------------------------------------------------
// Module S: Services (spec §4.6) — hire verified professionals. A ServiceJob is
// describe -> quote-via-chat -> schedule -> complete -> two-way rating. Trust is
// risk-tiered; providers without a qualification join transparently as
// "self-skilled". Cash on completion (V1). Quote chat reuses the shared Chat.
// ---------------------------------------------------------------------------

const providerProfileSchema = z.object({
  trade: z.string().trim().min(2).max(60),
  bio: z.string().trim().max(2000).optional(),
  portfolioPhotos: z.array(z.string().max(2048)).max(20).optional(),
});
const qualificationSchema = z.object({
  type: z.enum(['GEI_LICENCE', 'CVQ', 'GTEE', 'CITY_AND_GUILDS', 'OTHER']),
  referenceNumber: z.string().trim().max(120).optional(),
});
const browseSchema = z.object({
  trade: z.string().trim().min(2).max(60),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(16).max(2048).optional(),
});
const jobRequestSchema = z.object({
  providerId: z.string().min(1),
  description: z.string().trim().min(10).max(2000),
  photos: z.array(z.string().max(2048)).max(10).optional(),
});
const quoteSchema = z.object({ amount: z.number().positive().max(100_000_000) });
const scheduleSchema = z.object({ scheduledFor: z.coerce.date() });
const rateSchema = z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() });

export async function servicesRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const optionalAuth = { preHandler: [app.authenticateOptional] };
  const ratingService = new RatingService(app.prisma, app.io);
  const notifications = new NotificationService(app.prisma, app.io);

  function authenticatedTenant(): string {
    const tenantId = getTenantId();
    if (!tenantId) throw new AppError(401, 'UNAUTHORIZED', 'No authenticated tenant is bound to this request');
    return tenantId;
  }

  function browseTenant(hasSession: boolean): string {
    const tenantId = getTenantId();
    // A valid session must always carry its live User tenant; fail closed if
    // that invariant breaks. A true guest gets exactly one public marketplace.
    if (hasSession && !tenantId) {
      throw new AppError(401, 'UNAUTHORIZED', 'No authenticated tenant is bound to this request');
    }
    return tenantId ?? 'swift-default';
  }

  async function jobForUser(jobId: string, userId: string) {
    const job = await app.prisma.serviceJob.findUnique({
      where: { id: jobId },
      include: { provider: { select: { userId: true } } },
    });
    if (!job) throw new NotFoundError('ServiceJob', jobId);
    if (job.customerId !== userId && job.provider.userId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'You are not part of this job');
    }
    return job;
  }

  // ─── Provider profile + qualifications ─────────────────────────────────

  /** POST /providers — create/update the caller's provider profile. */
  app.post('/providers', auth, async (request) => {
    const body = providerProfileSchema.parse(request.body);
    const trade = requireCanonicalServiceTrade(body.trade);
    const userId = request.user.userId;
    const provider = await app.prisma.$transaction(async (tx) => {
      // One profile per human is the idempotency boundary. Lock the owning user
      // so concurrent first saves cannot race the unique upsert, and persist the
      // trade BEFORE evaluating its legal checklist (electricians must never get
      // a base-doc-only verification window on first save or trade change).
      const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status"::text FROM "users"
        WHERE "id" = ${userId}
        FOR UPDATE /* service-provider-profile-authority */
      `;
      if (!users[0] || users[0].status !== 'ACTIVE') {
        throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'This account cannot publish a provider profile right now.');
      }
      await tx.serviceProvider.upsert({
        where: { userId },
        create: {
          userId,
          trade,
          bio: body.bio,
          portfolioPhotos: body.portfolioPhotos ?? [],
          isVerified: false,
        },
        update: {
          trade,
          bio: body.bio,
          ...(body.portfolioPhotos && { portfolioPhotos: body.portfolioPhotos }),
          // Fail closed until the checklist for the newly persisted trade is
          // evaluated below, within the same uncommitted transaction.
          isVerified: false,
        },
      });
      await projectProviderVerificationLocked(tx, userId);
      return tx.serviceProvider.findUniqueOrThrow({ where: { userId } });
    });
    return { success: true, data: provider };
  });

  app.get('/providers/me', auth, async (request) => {
    await refreshProviderVerification(app.prisma, request.user.userId);
    const provider = await app.prisma.serviceProvider.findUnique({
      where: { userId: request.user.userId },
      include: { qualifications: true },
    });
    if (!provider) throw new NotFoundError('ServiceProvider');
    const trade = canonicalServiceTrade(provider.trade);
    const certified = trade !== null && provider.qualifications.some((q) => (
      q.status === 'VERIFIED'
      && q.verifiedAt !== null
      && q.trade === trade
      && qualificationTypeMatchesTrade(q.type, trade)
    ));
    return {
      success: true,
      data: {
        ...provider,
        tradeLabel: serviceTradeLabel(provider.trade),
        selfSkilled: !certified,
        certified,
      },
    };
  });

  /** Movement R9: the Standing module — daily-folded, subject = the user
   *  (provider ratings key on rateeId). No provider profile = 404, like
   *  providers/me — never an empty standing for the wrong role. */
  app.get('/providers/me/standing', auth, async (request) => {
    const provider = await app.prisma.serviceProvider.findUnique({ where: { userId: request.user.userId }, select: { id: true } });
    if (!provider) throw new NotFoundError('ServiceProvider');
    const { actorStandingView } = await import('../rating/rating-standing');
    return { success: true, data: await actorStandingView(app.prisma, 'SERVICE_PROVIDER', request.user.userId) };
  });

  /** POST /providers/qualifications — add a trade qualification (earns the badge). */
  app.post('/providers/qualifications', auth, async (request) => {
    const body = qualificationSchema.parse(request.body);
    const userId = request.user.userId;
    const qual = await app.prisma.$transaction(async (tx) => {
      // Serialize on the canonical User row, the same authority lock used by a
      // trade change. A timeout/retry of the same
      // qualification returns the existing record instead of minting duplicate
      // badges; no schema-wide role or parallel provider identity is introduced.
      const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status"::text FROM "users"
        WHERE "id" = ${userId}
        FOR UPDATE /* service-provider-qualification-authority */
      `;
      if (!users[0] || users[0].status !== 'ACTIVE') {
        throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'This account cannot submit a qualification right now.');
      }
      const provider = await tx.serviceProvider.findUnique({
        where: { userId },
        select: { id: true, trade: true },
      });
      if (!provider) throw new NotFoundError('ServiceProvider');
      const trade = requireCanonicalServiceTrade(provider.trade);
      if (!qualificationTypeMatchesTrade(body.type, trade)) {
        throw new AppError(400, 'QUALIFICATION_TRADE_MISMATCH', 'That credential does not apply to the selected trade.');
      }

      const referenceNumber = body.referenceNumber ?? null;
      const existing = await tx.serviceQualification.findFirst({
        where: { providerId: provider.id, trade, type: body.type, referenceNumber },
        orderBy: { createdAt: 'asc' },
      });
      if (existing) return existing;

      // A syntactically plausible reference is not verification. Until a real
      // trusted registry adapter or audited admin-review route records the
      // decision, every applicant-supplied credential remains PENDING.
      return tx.serviceQualification.create({
        data: {
          providerId: provider.id,
          trade,
          type: body.type,
          referenceNumber,
          status: 'PENDING',
          verifiedAt: null,
        },
      });
    });
    return { success: true, data: qual };
  });

  // ─── Customer: browse by trade (risk-tiered, certified-first) ──────────

  app.get('/providers', optionalAuth, async (request) => {
    const query = browseSchema.parse(request.query);
    const trade = requireCanonicalServiceTrade(query.trade);
    const tenantId = browseTenant(request.authSessionId !== null);
    const afterId = query.cursor ? decodeProviderCursor(query.cursor, { tenantId, trade }) : undefined;
    const candidates = await app.prisma.serviceProvider.findMany({
      where: {
        trade,
        ...(afterId ? { id: { gt: afterId } } : {}),
        // ServiceProvider is tenant-owned through its canonical User. Keep the
        // relational predicate here until the model itself carries tenantId.
        user: { tenantId, status: 'ACTIVE' },
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      include: {
        qualifications: {
          where: { status: 'VERIFIED', verifiedAt: { not: null }, trade },
          select: { type: true, trade: true },
        },
      },
    });
    const pageCandidates = candidates.slice(0, query.limit);
    const live = await Promise.all(pageCandidates.map(async (provider) => ({
      provider,
      verified: await isProviderVerified(app.prisma, provider.userId),
    })));
    const ranked = live
      .filter(({ verified }) => verified)
      .map(({ provider }) => provider)
      .map((provider) => {
        const qualifications = provider.qualifications.filter((qualification) => (
          qualificationTypeMatchesTrade(qualification.type, trade)
        ));
        return {
          id: provider.id,
          trade: provider.trade,
          tradeLabel: serviceTradeLabel(provider.trade),
          bio: provider.bio,
          portfolioPhotos: provider.portfolioPhotos,
          averageRating: provider.averageRating,
          totalRatings: provider.totalRatings,
          selfSkilled: qualifications.length === 0,
          certified: qualifications.length > 0,
          badges: qualifications.map((qualification) => qualification.type),
        };
      })
      // Surface licensed (certified) providers first — strongest signal for high-risk trades.
      .sort((a, b) => (
        Number(b.certified) - Number(a.certified)
        || b.averageRating - a.averageRating
        || a.id.localeCompare(b.id)
      ));

    const nextCursor = candidates.length > query.limit && pageCandidates.length > 0
      ? encodeProviderCursor({ tenantId, trade, afterId: pageCandidates[pageCandidates.length - 1]!.id })
      : null;

    return {
      success: true,
      data: {
        trade,
        tradeLabel: serviceTradeLabel(trade),
        riskTier: tradeRiskTier(trade),
        guidance: riskGuidance(trade),
        providers: ranked,
        page: { limit: query.limit, nextCursor },
      },
    };
  });

  // ─── Jobs: request → quote(-via-chat) → schedule → complete → rate ─────

  app.post('/jobs', auth, async (request, reply) => {
    const body = jobRequestSchema.parse(request.body);
    const customerId = request.user.userId;
    const tenantId = authenticatedTenant();
    const job = await createServiceJobWithLiveAuthority(app.prisma, {
      customerId,
      tenantId,
      providerId: body.providerId,
      description: body.description,
      photos: body.photos ?? [],
    });
    reply.code(201);
    return { success: true, data: job };
  });

  app.get('/jobs', auth, async (request) => {
    const userId = request.user.userId;
    const jobs = await app.prisma.serviceJob.findMany({
      where: { OR: [{ customerId: userId }, { provider: { userId } }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { success: true, data: jobs };
  });

  app.get('/jobs/:id', auth, async (request) => {
    const { id } = request.params as { id: string };
    return { success: true, data: await jobForUser(id, request.user.userId) };
  });

  app.post('/jobs/:id/quote', auth, async (request) => {
    const { id } = request.params as { id: string };
    const { amount } = quoteSchema.parse(request.body);
    const job = await jobForUser(id, request.user.userId);
    if (job.provider.userId !== request.user.userId) throw new AppError(403, 'PROVIDER_ONLY', 'Only the provider can quote');
    if (!['REQUESTED', 'QUOTED'].includes(job.status)) throw new AppError(400, 'BAD_STATE', `Cannot quote a ${job.status.toLowerCase()} job`);
    // [STRAND-8 / EV-ACT-25] Pricing NEW work re-proves live document
    // authority under the same User lock job creation uses — evidence can
    // expire, be rejected, or be purged between the request and the quote.
    // The write is a state CAS, not a read-then-unconditional update.
    // (Completion/decline of already-contracted work keeps its own policy.)
    const updated = await app.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status" FROM "users" WHERE "id" = ${request.user.userId} FOR UPDATE
      `;
      if (!users[0] || users[0].status !== 'ACTIVE') {
        throw new AppError(409, 'PROVIDER_NOT_VERIFIED', 'Your account is not active — contact support before taking new work.');
      }
      if (!(await isProviderVerified(tx, request.user.userId))) {
        throw new AppError(409, 'PROVIDER_NOT_VERIFIED', 'Your verification has lapsed — renew your documents before taking new work.');
      }
      const cas = await tx.serviceJob.updateMany({
        where: { id, status: { in: ['REQUESTED', 'QUOTED'] }, provider: { userId: request.user.userId } },
        data: { quoteAmount: amount, status: 'QUOTED' },
      });
      if (cas.count === 0) throw new AppError(400, 'BAD_STATE', 'This job just changed — refresh it');
      return tx.serviceJob.findUniqueOrThrow({ where: { id } });
    });
    return { success: true, data: updated };
  });

  app.post('/jobs/:id/schedule', auth, async (request) => {
    const { id } = request.params as { id: string };
    const { scheduledFor } = scheduleSchema.parse(request.body);
    const job = await jobForUser(id, request.user.userId);
    if (job.customerId !== request.user.userId) throw new AppError(403, 'CUSTOMER_ONLY', 'Only the customer can schedule');
    if (job.status !== 'QUOTED') throw new AppError(400, 'BAD_STATE', 'Agree a quote before scheduling');
    // The provider still ACCEPTS the slot (§4.3) — providerConfirmedAt starts null.
    const updated = await app.prisma.serviceJob.update({
      where: { id },
      data: { scheduledFor, status: 'SCHEDULED', providerConfirmedAt: null },
    });
    await notifications.send({
      userId: job.provider.userId,
      type: 'ORDER_UPDATE',
      title: 'Booking to confirm',
      body: `Your quote was accepted for ${scheduledFor.toLocaleString('en-GY', { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })} — confirm or suggest another time.`,
      data: { kind: 'booking_to_confirm', jobId: id },
    });
    return { success: true, data: updated };
  });

  /** POST /jobs/:id/confirm — the provider accepts the customer's slot (§4.3). */
  app.post('/jobs/:id/confirm', auth, async (request) => {
    const { id } = request.params as { id: string };
    const job = await jobForUser(id, request.user.userId);
    if (job.provider.userId !== request.user.userId) throw new AppError(403, 'PROVIDER_ONLY', 'Only the provider can confirm');
    if (job.status !== 'SCHEDULED') throw new AppError(400, 'BAD_STATE', 'There is no scheduled slot to confirm');
    // [STRAND-8 / EV-ACT-25] Affirming the slot is the last acceptance gate
    // for NEW work — re-prove live authority and bind the state in the write.
    const updated = await app.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status" FROM "users" WHERE "id" = ${request.user.userId} FOR UPDATE
      `;
      if (!users[0] || users[0].status !== 'ACTIVE') {
        throw new AppError(409, 'PROVIDER_NOT_VERIFIED', 'Your account is not active — contact support before taking new work.');
      }
      if (!(await isProviderVerified(tx, request.user.userId))) {
        throw new AppError(409, 'PROVIDER_NOT_VERIFIED', 'Your verification has lapsed — renew your documents before confirming new work.');
      }
      const cas = await tx.serviceJob.updateMany({
        where: { id, status: 'SCHEDULED', provider: { userId: request.user.userId } },
        data: { providerConfirmedAt: new Date() },
      });
      if (cas.count === 0) throw new AppError(400, 'BAD_STATE', 'This job just changed — refresh it');
      return tx.serviceJob.findUniqueOrThrow({ where: { id } });
    });
    await notifications.send({
      userId: job.customerId,
      type: 'ORDER_UPDATE',
      title: 'Booking confirmed',
      body: 'Your provider confirmed the time — see you then. Pay cash on completion.',
      data: { kind: 'booking_confirmed', jobId: id },
    });
    return { success: true, data: updated };
  });

  /** POST /jobs/:id/decline-slot — the provider can't make that time; the job
   *  returns to QUOTED so the customer picks another slot (never a dead end). */
  app.post('/jobs/:id/decline-slot', auth, async (request) => {
    const { id } = request.params as { id: string };
    const job = await jobForUser(id, request.user.userId);
    if (job.provider.userId !== request.user.userId) throw new AppError(403, 'PROVIDER_ONLY', 'Only the provider can decline');
    if (job.status !== 'SCHEDULED') throw new AppError(400, 'BAD_STATE', 'There is no scheduled slot to decline');
    const updated = await app.prisma.serviceJob.update({
      where: { id },
      data: { status: 'QUOTED', scheduledFor: null, providerConfirmedAt: null },
    });
    await notifications.send({
      userId: job.customerId,
      type: 'ORDER_UPDATE',
      title: 'Time didn’t work',
      body: 'The provider can’t make that slot — pick another time for your job.',
      data: { kind: 'booking_slot_declined', jobId: id },
    });
    return { success: true, data: updated };
  });

  app.post('/jobs/:id/complete', auth, async (request) => {
    const { id } = request.params as { id: string };
    const job = await jobForUser(id, request.user.userId);
    if (job.provider.userId !== request.user.userId) throw new AppError(403, 'PROVIDER_ONLY', 'Only the provider can complete');
    if (!['SCHEDULED', 'IN_PROGRESS'].includes(job.status)) throw new AppError(400, 'BAD_STATE', `Cannot complete a ${job.status.toLowerCase()} job`);
    const updated = await app.prisma.serviceJob.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    if (job.chatRoomId) await app.prisma.chatRoom.update({ where: { id: job.chatRoomId }, data: { isActive: false } });
    return { success: true, data: updated };
  });

  app.post('/jobs/:id/cancel', auth, async (request) => {
    const { id } = request.params as { id: string };
    const job = await jobForUser(id, request.user.userId);
    if (['COMPLETED', 'CANCELLED'].includes(job.status)) throw new AppError(400, 'BAD_STATE', 'This job is already closed');
    const updated = await app.prisma.serviceJob.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    if (job.chatRoomId) await app.prisma.chatRoom.update({ where: { id: job.chatRoomId }, data: { isActive: false } });
    return { success: true, data: updated };
  });

  /** POST /jobs/:id/rate — two-way rating on a completed job. */
  app.post('/jobs/:id/rate', auth, async (request) => {
    const { id } = request.params as { id: string };
    const { score, comment } = rateSchema.parse(request.body);
    await jobForUser(id, request.user.userId);
    const rating = await ratingService.rateServiceJob(id, request.user.userId, score, comment);
    return { success: true, data: rating };
  });
}
