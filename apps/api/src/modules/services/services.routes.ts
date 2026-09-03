import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
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
import { ratingSurfaces, NEW_ACTOR_SURFACE } from '../rating/rating-surface';
import { deactivateRoom } from '../chat/chat-authority';

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

  async function browseTenant(hasSession: boolean): Promise<string> {
    const tenantId = getTenantId();
    // A valid session must always carry its live User tenant; fail closed if
    // that invariant breaks. A true guest gets exactly one public marketplace.
    if (hasSession && !tenantId) {
      throw new AppError(401, 'UNAUTHORIZED', 'No authenticated tenant is bound to this request');
    }
    if (!tenantId) {
      // [F-028-07] The guest fallback chose 'swift-default' without ever
      // asking whether that tenant still EXISTS or remains active — a
      // deactivated operator's service catalog kept serving to the world.
      // One indexed read per guest browse; correctness on a tenant boundary
      // outranks it (same doctrine as public.routes' resolver).
      const t = await app.prisma.tenant.findUnique({ where: { id: 'swift-default' }, select: { isActive: true } });
      if (!t?.isActive) throw new NotFoundError('ServiceCatalog');
    }
    return tenantId ?? 'swift-default';
  }

  /** ONE spelling of a slot time across every service-job notification, so the
   *  provider reads the same "Tue, 9:00 AM, 26 Aug" when a booking is made as
   *  when it is cancelled. */
  function slotLabel(when: Date): string {
    return when.toLocaleString('en-GY', { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' });
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
    const tenantId = await browseTenant(request.authSessionId !== null);
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
    // [ALG-31 / L2] The star line comes from THE ONE MAPPER, never from the raw
    // lifetime mean. `rating-surface.ts` is the single definition of what a
    // rating LOOKS like: `displayRating` is null below RATING_MIN_DISPLAY (5),
    // so a provider with one bad rating reads "New" rather than ★1.0.
    //
    // This endpoint returned `averageRating` and nothing else, so the client had
    // no honest field to render and hand-rolled its own threshold
    // (`totalRatings > 0`) — a THIRD definition of the same rule, and one that
    // let a single 1-star rating brand a provider on the browse page.
    const visible = live.filter(({ verified }) => verified).map(({ provider }) => provider);
    const surfaces = await ratingSurfaces(app.prisma, 'SERVICE_PROVIDER', visible.map((p) => p.id));

    const ranked = visible
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
          // The honest star line (displayRating / ratingBucket / topRated).
          // Kept alongside the raw fields, which the sort still uses as a
          // tie-break — ranking may read the true mean; DISPLAY may not.
          ...(surfaces.get(provider.id) ?? NEW_ACTOR_SURFACE),
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

    // THE FIRST STEP WAS THE ONE THAT DIDN'T RING.
    //
    // Every other transition on a service job notifies the other side —
    // quote, schedule, confirm, decline-slot, complete, cancel. This one, the
    // moment a customer picks a tradesperson and asks them to come, told the
    // provider nothing at all. The job was created, a chat room was opened,
    // 201 was returned, and the person expected to answer it had no idea it
    // existed. It sat in REQUESTED until they happened to open the app and
    // scroll their job list — and since the provider must quote before
    // anything else can happen, the entire flow waited on a signal that was
    // never sent.
    //
    // Sent AFTER the authority transaction, like every sibling above: that
    // transaction holds FOR UPDATE locks on both User rows, and notification
    // fan-out does network I/O. `send` is best-effort by design and never
    // throws into the caller, so a notification hiccup cannot fail a job that
    // is already committed.
    const provider = await app.prisma.serviceProvider.findUnique({
      where: { id: job.providerId },
      select: { userId: true, trade: true },
    });
    if (provider) {
      await notifications.send({
        userId: provider.userId,
        type: 'ORDER_UPDATE',
        title: 'New job request',
        // No customer name and no free text: the description is whatever the
        // customer typed, and the sibling notifications don't quote it either.
        body: `Someone needs a ${serviceTradeLabel(provider.trade)} — open the request to send a quote.`,
        data: { kind: 'booking_requested', jobId: job.id },
      });
    }

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
    // [S0] A provider has ONE body: two customers cannot hold the same slot.
    // The judge is the partial unique index on ("providerId", "scheduledFor")
    // for live jobs (service_job_slot_exclusivity migration) — a read-then-check
    // would still lose a concurrent race, so the database decides and the loser
    // is turned into a real 409 instead of a stood-up customer. The write is a
    // state CAS like the quote (:quote) and confirm (:confirm) paths, so a job
    // that left QUOTED while we were reading fails cleanly rather than being
    // silently overwritten.
    // The provider still ACCEPTS the slot (§4.3) — providerConfirmedAt starts null.
    const updated = await app.prisma.$transaction(async (tx) => {
      const cas = await tx.serviceJob.updateMany({
        where: { id, status: 'QUOTED', customerId: request.user.userId },
        data: { scheduledFor, status: 'SCHEDULED', providerConfirmedAt: null },
      });
      if (cas.count === 0) throw new AppError(400, 'BAD_STATE', 'This job just changed — refresh it');
      return tx.serviceJob.findUniqueOrThrow({ where: { id } });
    }).catch((error: unknown) => {
      // The unique violation IS the double-booking answer — same translation
      // BookingService makes for appointment slots.
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new AppError(409, 'SLOT_TAKEN', 'That time was just booked with this provider — pick another time');
      }
      throw error;
    });
    await notifications.send({
      userId: job.provider.userId,
      type: 'ORDER_UPDATE',
      title: 'Booking to confirm',
      body: `Your quote was accepted for ${slotLabel(scheduledFor)} — confirm or suggest another time.`,
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
    if (job.chatRoomId) await deactivateRoom(app.prisma, job.chatRoomId); // [R048-004] compare-and-set: closed exactly once
    // [S0] Completion used to close the chat room and say nothing to anyone.
    // The two-way rating (§4.6) is the only trust signal this marketplace has,
    // and nobody rates a job they were never told had ended. Both sides get the
    // nudge; the customer's also states the payment reality — cash, direct to
    // the provider, because Swift never holds the money.
    for (const [userId, body] of [
      [job.customerId, 'Your provider marked this job complete. Pay cash directly to them, then rate how it went.'],
      [job.provider.userId, 'You marked this job complete. Rate your customer to close it out.'],
    ] as Array<[string, string]>) {
      await notifications.send({
        userId,
        type: 'ORDER_UPDATE',
        title: 'Job complete — how did it go?',
        body,
        data: { kind: 'booking_completed', jobId: id },
      });
    }
    return { success: true, data: updated };
  });

  app.post('/jobs/:id/cancel', auth, async (request) => {
    const { id } = request.params as { id: string };
    const job = await jobForUser(id, request.user.userId);
    if (['COMPLETED', 'CANCELLED'].includes(job.status)) throw new AppError(400, 'BAD_STATE', 'This job is already closed');
    const updated = await app.prisma.serviceJob.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    if (job.chatRoomId) await deactivateRoom(app.prisma, job.chatRoomId); // [R048-004] compare-and-set: closed exactly once
    // [S0] Cancellation used to be SILENT. A provider who confirmed Tuesday
    // 09:00 and blocked their whole day was never told the customer had gone —
    // they showed up. The other side is always told, and the message states the
    // slot only when one was actually held (a job cancelled at REQUESTED/QUOTED
    // never had a time; inventing one would be the UI lying).
    const cancelledByCustomer = job.customerId === request.user.userId;
    const when = job.scheduledFor ? slotLabel(job.scheduledFor) : null;
    await notifications.send({
      userId: cancelledByCustomer ? job.provider.userId : job.customerId,
      type: 'ORDER_UPDATE',
      title: 'Job cancelled',
      body: cancelledByCustomer
        ? (when
          ? `The customer cancelled the job booked for ${when} — that time is free again.`
          : 'The customer cancelled this job request — no visit is happening.')
        : (when
          ? `Your provider cancelled the job booked for ${when} — choose another provider or time.`
          : 'Your provider cancelled this job request — choose another provider.'),
      data: { kind: 'booking_cancelled', jobId: id },
    });
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
