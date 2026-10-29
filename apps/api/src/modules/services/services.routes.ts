import type { FastifyInstance } from 'fastify';
import { shownRatingTotals, shownRatingsFor, shownSurface } from '../rating/rating-groups';
import type { Prisma } from '@prisma/client';
import { z } from '../../lib/zod';
import { RatingService } from '../rating/rating.service';
import { NotificationService } from '../notification/notification.service';
import { blockedAuthorIds } from '../moderation/user-block.service';
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
  requiredLicenceStatus,
  riskGuidance,
  serviceTradeLabel,
  tradeRiskTier,
} from './services.service';
import { AppError, NotFoundError } from '../../utils/errors';
import { keepPublicPhoto } from '../../utils/owned-photo-upload';
import { retryStorageOrphan } from '../../lib/storage-orphans';
import { queuePortfolioPhotoDeletions, servedPortfolioPhotos } from './portfolio-photos';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { serviceJobCancelVerdict } from '../order/cancel-policy';
import { ReviewDemoRoleRefusedError } from '../review/demo-policy';
import { getTenantId } from '../../plugins/prisma';
import { runAsSystem } from '../../plugins/tenant-context';
import { assertProviderProfileWording, isServiceCategoryOperational } from './service-catalog';
import { formatGuyanaTime } from '../../utils/guyana-day';
import { offersLegalServices } from '../compliance/prohibited-items';
import {
  assertServiceJobStartDue,
  transitionServiceJob,
} from './service-job-transition';
import { executeTenantBoundServiceJobTransaction } from './service-job-transaction';
import { canonicalSlotStart } from '../booking/availability';
import { isServiceJobExclusionViolation } from './provider-time';
import { registerProviderBookableRoutes } from './provider-bookable.routes';
import { proBookableFromListOf, registerProBookingRoutes, serviceAppointmentViewFor } from './pro-booking.routes';
import {
  commandGeneration,
  legacyQuoteSchema,
  legacyScheduleSchema,
  legacyTransitionSchema,
  quoteSchema,
  readServiceJobLifecycleCommand,
  scheduleSchema,
  scheduledTransitionSchema,
  transitionGenerationSchema,
} from './service-job-client-contract';

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
// [ROLE-DOCS · owner 21 Oct 2026] No GEI_LICENCE here: an electrician's GEI licence is a REQUIRED
// checklist document (gei_electrical_licence), reviewed by a person with its January re-check. Asking for it
// again as an optional "qualification" collected the same licence twice. The enum value stays in the
// database type for history; the API no longer accepts it (QUALIFICATION_RETIRED).
const RETIRED_QUALIFICATION_TYPES = new Set(['GEI_LICENCE']);
const qualificationSchema = z.object({
  type: z.enum(['CVQ', 'GTEE', 'CITY_AND_GUILDS', 'OTHER']),
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
// A number format, not a date: the market-zone rule for times does not apply.
const QUOTE_AMOUNT = new Intl.NumberFormat('en-GY', { maximumFractionDigits: 2 });
const rateSchema = z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() });

/** [IMAGES-E2E PR3] How many photos one provider's portfolio holds. */
export const PORTFOLIO_MAX = 12;

/** [IMAGES-E2E PR3] A profile save may keep, reorder or drop portfolio photos, never add
 *  one (an outside address or a path into another folder would skip the scan and the redraw). */
export function assertPortfolioOnlyKeeps(sent: string[], current: string[]): void {
  const allowed = new Set(current);
  if (new Set(sent).size !== sent.length || sent.some((photo) => !allowed.has(photo))) {
    throw new AppError(400, 'PORTFOLIO_UPLOAD_ONLY', 'Add portfolio photos by uploading them');
  }
}

export async function servicesRoutes(app: FastifyInstance) {
  const storage = getStorageProvider();
  /** After the pointer change commits: delete each photo now. A delete that fails stays open
   *  and the standing retry (retryStorageOrphans) finishes it. */
  const deleteQueuedPhotos = async (orphanIds: string[]) => {
    if (orphanIds.length === 0) return;
    // The named system capability: the "does any row still show it" read sees every row.
    await runAsSystem('public-photo-deletion', async () => {
      for (const id of orphanIds) await retryStorageOrphan(app.prisma, storage, app.log, id);
    });
  };
  const auth = { preHandler: [app.authenticate] };
  const optionalAuth = { preHandler: [app.authenticateOptional] };
  const ratingService = new RatingService(app.prisma, app.io);
  const notifications = new NotificationService(app.prisma, app.io);

  async function publishPersisted(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => notifications.publishPersisted(id)));
  }

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
    return formatGuyanaTime(when, { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short', hour12: true }, 'en-US');
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

  /** A scheduled-slot command needs the slot it acts on; a job with none has nothing to act on. */
  function scheduledGeneration(
    command: Parameters<typeof commandGeneration>[0],
    job: Parameters<typeof commandGeneration>[1],
  ): { expectedUpdatedAt: Date; expectedScheduledFor: Date } {
    const { expectedUpdatedAt, expectedScheduledFor } = commandGeneration(command, job);
    if (!expectedScheduledFor) throw new AppError(400, 'BAD_STATE', 'There is no scheduled slot for this job');
    return { expectedUpdatedAt, expectedScheduledFor };
  }

  // [BOOK-P1] A provider's bookable services, weekly hours and time off (behind INSTANT_BOOKING).
  registerProviderBookableRoutes(app);
  // [BOOK-P2] A customer books a time from a pro's menu, and either side moves it (behind INSTANT_BOOKING).
  registerProBookingRoutes(app);

  // ─── Provider profile + qualifications ─────────────────────────────────

  /** POST /providers — create/update the caller's provider profile. */
  app.post('/providers', auth, async (request) => {
    const body = providerProfileSchema.parse(request.body);
    const trade = requireCanonicalServiceTrade(body.trade);
    // [R4 · research A8] Swift never lists legal services: a profile whose own words offer them is refused, whatever
    // trade it names (the lawyer trade itself stays held in the catalogue).
    if (offersLegalServices(body.bio)) {
      throw new AppError(409, 'SERVICE_NOT_ALLOWED', 'Swift doesn\'t list legal services. Remove them from your profile to continue.');
    }
    // [TRADES · GUARDRAILS §8] Refused before anything is written: no gas or fuel supply,
    // no protected title the trade's checklist does not prove.
    assertProviderProfileWording(trade, body.bio);
    const userId = request.user.userId;
    let droppedPhotoDeletions: string[] = [];
    const provider = await app.prisma.$transaction(async (tx) => {
      // One profile per human is the idempotency boundary. Lock the owning user
      // so concurrent first saves cannot race the unique upsert, and persist the
      // trade BEFORE evaluating its legal checklist (electricians must never get
      // a base-doc-only verification window on first save or trade change).
      const users = await tx.$queryRaw<Array<{ id: string; status: string; tenantKind: string; tenantId: string }>>`
        SELECT u."id", u."status"::text, t."kind"::text AS "tenantKind", u."tenantId" FROM "users" u JOIN "tenants" t ON t."id" = u."tenantId"
        WHERE u."id" = ${userId}
        FOR UPDATE OF u /* service-provider-profile-authority */
      `;
      if (!users[0] || users[0].status !== 'ACTIVE') {
        throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'This account cannot publish a provider profile right now.');
      }
      // [REVIEW-PARTNER] A demo account never becomes a service provider.
      if (users[0].tenantKind === 'REVIEW') throw new ReviewDemoRoleRefusedError();
      // [IMAGES-E2E PR3] Portfolio photos are UPLOADED (POST /providers/me/portfolio: scanned,
      // redrawn without camera data). A profile save may keep, reorder or drop them, never add one.
      if (body.portfolioPhotos !== undefined) {
        // [REVIEW-G S4-2] Read under the provider row's lock: a photo taken down meanwhile is not written back.
        const locked = await tx.$queryRaw<Array<{ id: string; portfolioPhotos: string[] }>>`
          SELECT "id", "portfolioPhotos" FROM "service_providers" WHERE "userId" = ${userId}
          FOR UPDATE /* service-provider-portfolio-authority */
        `;
        const current = locked[0]?.portfolioPhotos ?? [];
        assertPortfolioOnlyKeeps(body.portfolioPhotos, current);
        // [REVIEW-F S2-1] A photo the save drops is deleted, not just unlinked.
        const kept = new Set(body.portfolioPhotos);
        if (locked[0]) {
          droppedPhotoDeletions = await queuePortfolioPhotoDeletions(
            tx, { id: locked[0].id, userId }, users[0].tenantId, current.filter((photo) => !kept.has(photo)),
          );
        }
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
    await deleteQueuedPhotos(droppedPhotoDeletions);
    // [COORD 18 Oct, option S] The row's live averageRating/totalRatings never reach the person: whole groups only.
    return { success: true, data: { ...provider, ...(await shownRatingTotals(app.prisma, 'SERVICE_PROVIDER', request.user.userId)) } };
  });

  /** [IMAGES-E2E PR3] POST /providers/me/portfolio — add one photo of the provider's own work. */
  app.post('/providers/me/portfolio', auth, async (request) => {
    const userId = request.user.userId;
    const provider = await app.prisma.serviceProvider.findUnique({
      where: { userId },
      select: { id: true, portfolioPhotos: true, user: { select: { status: true } } },
    });
    if (!provider) throw new NotFoundError('ServiceProvider');
    if (provider.user.status !== 'ACTIVE') {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'This account cannot publish a provider profile right now.');
    }
    if (provider.portfolioPhotos.length >= PORTFOLIO_MAX) {
      throw new AppError(409, 'PORTFOLIO_FULL', `A portfolio holds ${PORTFOLIO_MAX} photos. Remove one to add another.`);
    }
    const url = await keepPublicPhoto(request, storage, `portfolio/${provider.id}`, 'provider-portfolio');
    // [REVIEW-G S4-1 · REVIEW-F S2-1] Added under the account's and the row's locks (the order the
    // profile save and account erasure use): a closed account or a full portfolio does not take
    // the photo, and the bytes just kept are deleted rather than left behind.
    // [REVIEW-G/F S4-1 on #1918] The bytes are kept before this transaction: if it fails (a DB
    // error, a lost connection) they get their durable deletion row in a fresh transaction and are
    // deleted, never left behind with no pointer and no row.
    const discardKept = async (): Promise<void> => {
      const orphanIds = await app.prisma.$transaction(async (tx) => {
        const owner = await tx.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
        return owner ? queuePortfolioPhotoDeletions(tx, { id: provider.id, userId }, owner.tenantId, [url]) : [];
      }).catch((err: unknown) => {
        app.log.error({ err, providerId: provider.id }, 'portfolio upload: deletion row for unkept photo failed');
        return [] as string[];
      });
      await deleteQueuedPhotos(orphanIds).catch(() => undefined);
    };
    const added = await app.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ status: string; tenantId: string }>>`
        SELECT "status"::text, "tenantId" FROM "users" WHERE "id" = ${userId}
        FOR UPDATE /* service-provider-portfolio-upload-authority */
      `;
      const rows = await tx.$queryRaw<Array<{ portfolioPhotos: string[] }>>`
        SELECT "portfolioPhotos" FROM "service_providers" WHERE "id" = ${provider.id}
        FOR UPDATE /* service-provider-portfolio-authority */
      `;
      const tenantId = users[0]?.tenantId;
      const refusal = users[0]?.status !== 'ACTIVE'
        ? new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'This account cannot publish a provider profile right now.')
        : !rows[0]
          ? new NotFoundError('ServiceProvider')
          : rows[0].portfolioPhotos.length >= PORTFOLIO_MAX
            ? new AppError(409, 'PORTFOLIO_FULL', `A portfolio holds ${PORTFOLIO_MAX} photos. Remove one to add another.`)
            : null;
      if (refusal) {
        const orphanIds = tenantId ? await queuePortfolioPhotoDeletions(tx, { id: provider.id, userId }, tenantId, [url]) : [];
        return { refusal, orphanIds };
      }
      const updated = await tx.serviceProvider.update({
        where: { id: provider.id },
        data: { portfolioPhotos: { push: url } },
        select: { id: true, portfolioPhotos: true },
      });
      return { updated };
    }).catch(async (error: unknown) => {
      await discardKept();
      throw error;
    });
    if ('refusal' in added) {
      await deleteQueuedPhotos(added.orphanIds ?? []);
      throw added.refusal;
    }
    return { success: true, data: added.updated };
  });

  /** [IMAGES-E2E PR3] DELETE /providers/me/portfolio/:file — take one photo down (the public door stops serving it). */
  app.delete<{ Params: { file: string } }>('/providers/me/portfolio/:file', auth, async (request) => {
    const userId = request.user.userId;
    const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
    if (!user) throw new NotFoundError('ServiceProvider');
    // [REVIEW-F S2-1] The photo's bytes are deleted, not just unlinked: the deletion row is
    // written with the pointer change, under the row's lock, and the object deleted after.
    const { portfolio, orphanIds } = await app.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; portfolioPhotos: string[] }>>`
        SELECT "id", "portfolioPhotos" FROM "service_providers" WHERE "userId" = ${userId}
        FOR UPDATE /* service-provider-portfolio-authority */
      `;
      const provider = rows[0];
      if (!provider) throw new NotFoundError('ServiceProvider');
      const removed = provider.portfolioPhotos.filter((photo) => photo.split('/').pop() === request.params.file);
      if (removed.length === 0) throw new NotFoundError('PortfolioPhoto', request.params.file);
      const queued = await queuePortfolioPhotoDeletions(tx, { id: provider.id, userId }, user.tenantId, removed);
      const row = await tx.serviceProvider.update({
        where: { id: provider.id },
        data: { portfolioPhotos: { set: provider.portfolioPhotos.filter((photo) => !removed.includes(photo)) } },
        select: { id: true, portfolioPhotos: true },
      });
      return { portfolio: row, orphanIds: queued };
    });
    await deleteQueuedPhotos(orphanIds);
    // Only the photo list goes back (id + portfolioPhotos), never the provider's whole row.
    return { success: true, data: portfolio };
  });

  app.get('/providers/me', auth, async (request) => {
    await refreshProviderVerification(app.prisma, request.user.userId);
    const provider = await app.prisma.serviceProvider.findUnique({
      where: { userId: request.user.userId },
      include: { qualifications: true },
    });
    if (!provider) throw new NotFoundError('ServiceProvider');
    const trade = canonicalServiceTrade(provider.trade);
    const matching = trade === null ? [] : provider.qualifications.filter((q) => (
      q.status === 'VERIFIED'
      && q.verifiedAt !== null
      && q.trade === trade
      && qualificationTypeMatchesTrade(q.type, trade)
    ));
    // [ROLE-DOCS · PR 3] the licence the trade REQUIRES, approved by a person, counts too (and carries its date)
    const licence = trade === null ? { required: false, checkedOn: null } : await requiredLicenceStatus(app.prisma, request.user.userId);
    const licenceOn = licence.checkedOn;
    const certified = matching.length > 0 || licenceOn !== null;
    const licenceCheckedOn = [licenceOn, ...matching.map((q) => q.verifiedAt)].reduce<Date | null>(
      (latest, at) => (at && (!latest || at > latest) ? at : latest), null,
    )?.toISOString() ?? null;
    return {
      success: true,
      data: {
        ...provider,
        // [COORD 18 Oct, option S] The row's live averageRating/totalRatings never reach the person: whole groups only.
        ...(await shownRatingTotals(app.prisma, 'SERVICE_PROVIDER', request.user.userId)),
        tradeLabel: serviceTradeLabel(provider.trade),
        categoryUnavailable: trade === null || !isServiceCategoryOperational(trade),
        // [REVIEW-F #2053 S4-2] a trade that requires a licence is never "self-skilled"
        selfSkilled: !certified && !licence.required,
        certified,
        // [R7 · ROLE-DOCS PR 3] "Licence on file, checked on [date]": the latest day a person checked one (null = none).
        licenceCheckedOn,
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
    const asked = (request.body as { type?: unknown } | null | undefined)?.type;
    if (typeof asked === 'string' && RETIRED_QUALIFICATION_TYPES.has(asked)) {
      throw new AppError(400, 'QUALIFICATION_RETIRED', 'Your GEI electrical licence goes in your Documents checklist, where a person checks it. It is not added as a qualification.');
    }
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
    // [SEC-TRUST F2] A signed-in customer never sees the providers they blocked.
    const viewerId = request.authSessionId !== null ? request.user?.userId : undefined;
    const blocked = viewerId ? await blockedAuthorIds(app.prisma, tenantId, viewerId) : [];
    const candidates = await app.prisma.serviceProvider.findMany({
      where: {
        trade,
        ...(afterId ? { id: { gt: afterId } } : {}),
        ...(blocked.length ? { userId: { notIn: blocked } } : {}),
        // ServiceProvider is tenant-owned through its canonical User. Keep the
        // relational predicate here until the model itself carries tenantId.
        user: { tenantId, status: 'ACTIVE' },
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      include: {
        qualifications: {
          where: { status: 'VERIFIED', verifiedAt: { not: null }, trade },
          select: { type: true, trade: true, verifiedAt: true },
        },
      },
    });
    const pageCandidates = candidates.slice(0, query.limit);
    const live = await Promise.all(pageCandidates.map(async (provider) => {
      const verified = await isProviderVerified(app.prisma, provider.userId);
      // [ROLE-DOCS · PR 3] the licence the trade REQUIRES, approved by a person (read only for a listed provider)
      const licence = verified ? await requiredLicenceStatus(app.prisma, provider.userId) : { required: false, checkedOn: null };
      return { provider, verified, licenceOn: licence.checkedOn, licenceRequired: licence.required };
    }));
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
    const licenceOnOf = new Map(live.map(({ provider, licenceOn }) => [provider.id, licenceOn]));
    const licenceRequiredOf = new Map(live.map(({ provider, licenceRequired }) => [provider.id, licenceRequired]));
    // [COORD 18 Oct, option S] The star a customer (or the provider) sees is from whole groups of 5 only; the
    // ranking below still reads the true mean (display only).
    const shown = await shownRatingsFor(app.prisma, 'SERVICE_PROVIDER', visible.map((p) => p.userId));
    // [BOOK-P3] Which of these pros a customer can book from their list right now (the phone shows Book
    // for them, a quote request for everyone): the switch on, a trade with a bookable menu, weekly hours,
    // at least one active service, and the agreement with the advance-acceptance clause accepted. The
    // booking routes re-check all of it (pro-booking.routes.ts); this only decides the button.
    const bookableFromList = await proBookableFromListOf(app.prisma, visible, trade);
    const rankMean = new Map(visible.map((p) => [p.id, p.averageRating]));

    const ranked = visible
      .map((provider) => {
        const qualifications = provider.qualifications.filter((qualification) => (
          qualificationTypeMatchesTrade(qualification.type, trade)
        ));
        // [ROLE-DOCS · PR 3] a required trade licence a person approved is a licence on file too
        const licenceOn = licenceOnOf.get(provider.id) ?? null;
        return {
          id: provider.id,
          trade: provider.trade,
          tradeLabel: serviceTradeLabel(provider.trade),
          bio: provider.bio,
          portfolioPhotos: servedPortfolioPhotos(provider),
          // The honest star line (displayRating / ratingBucket / topRated).
          // Kept alongside the raw fields, which the sort still uses as a
          // tie-break — ranking may read the true mean; DISPLAY may not.
          ...shownSurface(shown.get(provider.userId)!),
          averageRating: shown.get(provider.userId)!.average,
          totalRatings: shown.get(provider.userId)!.ratingCount,
          // [REVIEW-F #2053 S4-2] a trade that requires a licence is never "self-skilled"
          selfSkilled: qualifications.length === 0 && licenceOn === null && !licenceRequiredOf.get(provider.id),
          certified: qualifications.length > 0 || licenceOn !== null,
          badges: qualifications.map((qualification) => qualification.type),
          bookableFromList: bookableFromList.has(provider.id),
          // [R7] "Licence on file, checked on [date]": the latest day a person checked one of these (null = none).
          licenceCheckedOn: qualifications.reduce<Date | null>(
            (latest, q) => (q.verifiedAt && (!latest || q.verifiedAt > latest) ? q.verifiedAt : latest), licenceOn,
          )?.toISOString() ?? null,
        };
      })
      // Surface licensed (certified) providers first — strongest signal for high-risk trades.
      .sort((a, b) => (
        Number(b.certified) - Number(a.certified)
        || rankMean.get(b.id)! - rankMean.get(a.id)!
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
    const { job, created } = await createServiceJobWithLiveAuthority(app.prisma, {
      customerId,
      tenantId,
      providerId: body.providerId,
      description: body.description,
      photos: body.photos ?? [],
    });
    // A retry of a request that already landed gets the first job back with
    // the same answer, and the provider is not told twice.
    if (!created) {
      reply.code(201);
      return { success: true, data: job };
    }

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
    // [BOOK-P2] A job booked from a pro's menu carries the customer's appointment rules (cancel,
    // move) while INSTANT_BOOKING is on; every other job is exactly as before (no field added).
    const now = new Date();
    return {
      success: true,
      data: jobs.map((job) => {
        const appointment = serviceAppointmentViewFor(job, userId, now);
        return appointment ? { ...job, appointment } : job;
      }),
    };
  });

  app.get('/jobs/:id', auth, async (request) => {
    const { id } = request.params as { id: string };
    const job = await jobForUser(id, request.user.userId);
    const appointment = serviceAppointmentViewFor(job, request.user.userId);
    return { success: true, data: appointment ? { ...job, appointment } : job };
  });

  app.post('/jobs/:id/quote', auth, async (request) => {
    const { id } = request.params as { id: string };
    const command = readServiceJobLifecycleCommand(request, quoteSchema, legacyQuoteSchema);
    const { amount } = command.body;
    const job = await jobForUser(id, request.user.userId);
    const { expectedUpdatedAt } = commandGeneration(command, job);
    if (job.provider.userId !== request.user.userId) throw new AppError(403, 'PROVIDER_ONLY', 'Only the provider can quote');
    if (!['REQUESTED', 'QUOTED'].includes(job.status)) throw new AppError(400, 'BAD_STATE', `Cannot quote a ${job.status.toLowerCase()} job`);
    // [STRAND-8 / EV-ACT-25] Pricing NEW work re-proves live document
    // authority under the same User lock job creation uses — evidence can
    // expire, be rejected, or be purged between the request and the quote.
    // The write is a state CAS, not a read-then-unconditional update.
    // (Completion/decline of already-contracted work keeps its own policy.)
    const transitioned = await executeTenantBoundServiceJobTransaction(app.prisma, async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status" FROM "users" WHERE "id" = ${request.user.userId} FOR UPDATE
      `;
      if (!users[0] || users[0].status !== 'ACTIVE') {
        throw new AppError(409, 'PROVIDER_NOT_VERIFIED', 'Your account is not active — contact support before taking new work.');
      }
      if (!(await isProviderVerified(tx, request.user.userId))) {
        throw new AppError(409, 'PROVIDER_NOT_VERIFIED', 'Your verification has lapsed — renew your documents before taking new work.');
      }
      return transitionServiceJob(tx, {
        jobId: id,
        actorUserId: request.user.userId,
        expectedUpdatedAt,
        from: job.status,
        to: 'QUOTED',
        guard: { provider: { userId: request.user.userId } },
        // The boundary above proves two-decimal precision. Persist the
        // canonical decimal string so Prisma never has to infer money from a
        // binary floating-point value.
        data: { quoteAmount: amount.toFixed(2) },
        action: 'SERVICE_JOB_QUOTED',
        audit: { amount },
        notices: [{
          userId: job.customerId,
          type: 'ORDER_UPDATE',
          title: 'Quote received',
          body: `Your provider quoted GYD ${QUOTE_AMOUNT.format(amount)} — review it before choosing a time.`,
          data: { kind: 'booking_quoted', jobId: id },
        }],
      });
    });
    await publishPersisted(transitioned.notificationIds);
    return { success: true, data: transitioned.job };
  });

  app.post('/jobs/:id/schedule', auth, async (request) => {
    const { id } = request.params as { id: string };
    const command = readServiceJobLifecycleCommand(request, scheduleSchema, legacyScheduleSchema);
    // [BOOK-P1] A slot is minute-grained, as an appointment's is (canonicalSlotStart):
    // 09:00:00 and 09:00:01 are one time, checked, stored and held as 09:00.
    const scheduledFor = canonicalSlotStart(command.body.scheduledFor);
    const job = await jobForUser(id, request.user.userId);
    const { expectedUpdatedAt, expectedQuoteAmount } = commandGeneration(command, job);
    if (job.customerId !== request.user.userId) throw new AppError(403, 'CUSTOMER_ONLY', 'Only the customer can schedule');
    if (job.status !== 'QUOTED' || expectedQuoteAmount === null) throw new AppError(400, 'BAD_STATE', 'Agree a quote before scheduling');
    // A slot that has already started cannot be kept: the provider would be
    // asked to confirm the impossible and the reminder sweep (which looks
    // forward only) would never fire. Same rule and code as appointments
    // (BookingService.validateSlot).
    if (scheduledFor.getTime() <= Date.now()) throw new AppError(400, 'SLOT_IN_PAST', 'Pick a time in the future');
    // [S0] A provider has ONE body: two customers cannot hold the same slot.
    // The judge is the partial unique index on ("providerId", "scheduledFor")
    // for live jobs (service_job_slot_exclusivity migration), and [BOOK-P1] the
    // exclusion over the time each live job holds (provider-time.ts) — a
    // read-then-check would still lose a concurrent race, so the database decides and the loser
    // is turned into a real 409 instead of a stood-up customer. The write is a
    // state CAS like the quote (:quote) and confirm (:confirm) paths, so a job
    // that left QUOTED while we were reading fails cleanly rather than being
    // silently overwritten.
    // The provider still ACCEPTS the slot (§4.3) — providerConfirmedAt starts null.
    const transitioned = await executeTenantBoundServiceJobTransaction(app.prisma, async (boundTx) => {
      return transitionServiceJob(boundTx, {
        jobId: id,
        actorUserId: request.user.userId,
        expectedUpdatedAt,
        from: 'QUOTED',
        to: 'SCHEDULED',
        guard: { customerId: request.user.userId, quoteAmount: expectedQuoteAmount },
        data: { scheduledFor, providerConfirmedAt: null },
        action: 'SERVICE_JOB_SCHEDULED',
        audit: { scheduledFor: scheduledFor.toISOString(), acceptedQuoteAmount: expectedQuoteAmount },
        notices: [{
          userId: job.provider.userId,
          type: 'ORDER_UPDATE',
          title: 'Booking to confirm',
          body: `Your quote was accepted for ${slotLabel(scheduledFor)} — confirm or suggest another time.`,
          data: { kind: 'booking_to_confirm', jobId: id },
        }],
      });
    }).catch((error: unknown) => {
      // The unique violation IS the double-booking answer — same translation
      // BookingService makes for appointment slots. [BOOK-P1] So is the
      // one-pro-one-time exclusion: another live job of this provider holds
      // that time (a booked service runs to its end, provider-time.ts).
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002' || isServiceJobExclusionViolation(error)) {
        throw new AppError(409, 'SLOT_TAKEN', 'That time was just booked with this provider — pick another time');
      }
      throw error;
    });
    await publishPersisted(transitioned.notificationIds);
    return { success: true, data: transitioned.job };
  });

  /** POST /jobs/:id/confirm — the provider accepts the customer's slot (§4.3). */
  app.post('/jobs/:id/confirm', auth, async (request) => {
    const { id } = request.params as { id: string };
    const command = readServiceJobLifecycleCommand(request, scheduledTransitionSchema, legacyTransitionSchema);
    const job = await jobForUser(id, request.user.userId);
    const { expectedUpdatedAt, expectedScheduledFor } = scheduledGeneration(command, job);
    if (job.provider.userId !== request.user.userId) throw new AppError(403, 'PROVIDER_ONLY', 'Only the provider can confirm');
    if (job.status !== 'SCHEDULED') throw new AppError(400, 'BAD_STATE', 'There is no scheduled slot to confirm');
    // [STRAND-8 / EV-ACT-25] Affirming the slot is the last acceptance gate
    // for NEW work — re-prove live authority and bind the state in the write.
    const transitioned = await executeTenantBoundServiceJobTransaction(app.prisma, async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status" FROM "users" WHERE "id" = ${request.user.userId} FOR UPDATE
      `;
      if (!users[0] || users[0].status !== 'ACTIVE') {
        throw new AppError(409, 'PROVIDER_NOT_VERIFIED', 'Your account is not active — contact support before taking new work.');
      }
      if (!(await isProviderVerified(tx, request.user.userId))) {
        throw new AppError(409, 'PROVIDER_NOT_VERIFIED', 'Your verification has lapsed — renew your documents before confirming new work.');
      }
      const confirmedAt = new Date();
      return transitionServiceJob(tx, {
        jobId: id,
        actorUserId: request.user.userId,
        expectedUpdatedAt,
        from: 'SCHEDULED',
        to: 'SCHEDULED',
        guard: {
          provider: { userId: request.user.userId },
          scheduledFor: expectedScheduledFor,
          providerConfirmedAt: null,
        },
        data: { providerConfirmedAt: confirmedAt },
        action: 'SERVICE_JOB_SLOT_CONFIRMED',
        audit: { scheduledFor: expectedScheduledFor.toISOString(), confirmedAt: confirmedAt.toISOString() },
        notices: [{
          userId: job.customerId,
          type: 'ORDER_UPDATE',
          title: 'Booking confirmed',
          body: 'Your provider confirmed the time — see you then. Pay cash on completion.',
          data: { kind: 'booking_confirmed', jobId: id },
        }],
      });
    });
    await publishPersisted(transitioned.notificationIds);
    return { success: true, data: transitioned.job };
  });

  /** POST /jobs/:id/decline-slot — the provider can't make that time; the job
   *  returns to QUOTED so the customer picks another slot (never a dead end). */
  app.post('/jobs/:id/decline-slot', auth, async (request) => {
    const { id } = request.params as { id: string };
    const command = readServiceJobLifecycleCommand(request, scheduledTransitionSchema, legacyTransitionSchema);
    const job = await jobForUser(id, request.user.userId);
    const { expectedUpdatedAt, expectedScheduledFor } = scheduledGeneration(command, job);
    if (job.provider.userId !== request.user.userId) throw new AppError(403, 'PROVIDER_ONLY', 'Only the provider can decline');
    if (job.status !== 'SCHEDULED') throw new AppError(400, 'BAD_STATE', 'There is no scheduled slot to decline');
    const transitioned = await executeTenantBoundServiceJobTransaction(
      app.prisma,
      (boundTx) => transitionServiceJob(boundTx, {
        jobId: id,
        actorUserId: request.user.userId,
        expectedUpdatedAt,
        from: 'SCHEDULED',
        to: 'QUOTED',
        guard: {
          provider: { userId: request.user.userId },
          scheduledFor: expectedScheduledFor,
          providerConfirmedAt: null,
        },
        // [BOOK-P1] A job with no time holds none: its end goes with its start.
        data: { scheduledFor: null, endsAt: null, providerConfirmedAt: null },
        action: 'SERVICE_JOB_SLOT_DECLINED',
        audit: { scheduledFor: expectedScheduledFor.toISOString() },
        notices: [{
          userId: job.customerId,
          type: 'ORDER_UPDATE',
          title: 'Time didn’t work',
          body: 'The provider can’t make that slot — pick another time for your job.',
          data: { kind: 'booking_slot_declined', jobId: id },
        }],
      }),
    );
    await publishPersisted(transitioned.notificationIds);
    return { success: true, data: transitioned.job };
  });

  /** The provider explicitly starts confirmed work at or after the agreed time. */
  app.post('/jobs/:id/start', auth, async (request) => {
    const { id } = request.params as { id: string };
    const command = readServiceJobLifecycleCommand(request, scheduledTransitionSchema, legacyTransitionSchema);
    const job = await jobForUser(id, request.user.userId);
    const { expectedUpdatedAt, expectedScheduledFor } = scheduledGeneration(command, job);
    if (job.provider.userId !== request.user.userId) throw new AppError(403, 'PROVIDER_ONLY', 'Only the provider can start');
    const startedAt = new Date();
    assertServiceJobStartDue(expectedScheduledFor, startedAt);
    const transitioned = await executeTenantBoundServiceJobTransaction(
      app.prisma,
      (boundTx) => transitionServiceJob(boundTx, {
        jobId: id,
        actorUserId: request.user.userId,
        expectedUpdatedAt,
        from: 'SCHEDULED',
        to: 'IN_PROGRESS',
        guard: {
          provider: { userId: request.user.userId },
          providerConfirmedAt: { not: null },
          AND: [
            { scheduledFor: expectedScheduledFor },
            { scheduledFor: { lte: startedAt } },
          ],
        },
        action: 'SERVICE_JOB_STARTED',
        audit: { scheduledFor: expectedScheduledFor.toISOString(), startedAt: startedAt.toISOString() },
        notices: [{
          userId: job.customerId,
          type: 'ORDER_UPDATE',
          title: 'Job started',
          body: 'Your provider marked the agreed job as started.',
          data: { kind: 'booking_started', jobId: id },
        }],
        now: startedAt,
      }),
    );
    await publishPersisted(transitioned.notificationIds);
    return { success: true, data: transitioned.job };
  });

  app.post('/jobs/:id/complete', auth, async (request) => {
    const { id } = request.params as { id: string };
    const command = readServiceJobLifecycleCommand(request, transitionGenerationSchema, legacyTransitionSchema);
    const job = await jobForUser(id, request.user.userId);
    const { expectedUpdatedAt } = commandGeneration(command, job);
    if (job.provider.userId !== request.user.userId) throw new AppError(403, 'PROVIDER_ONLY', 'Only the provider can complete');
    // [build-9 compatibility] The installed app has no Start button: its
    // provider completes a confirmed job straight from SCHEDULED. That single
    // tap is served as start-then-complete in ONE transaction, under every
    // start rule (confirmed slot, agreed time reached) and both CAS writes.
    const legacyFromScheduled = command.legacy && job.status === 'SCHEDULED';
    if (job.status !== 'IN_PROGRESS' && !legacyFromScheduled) throw new AppError(400, 'BAD_STATE', `Cannot complete a ${job.status.toLowerCase()} job`);
    const completedAt = new Date();
    const scheduledFor = job.scheduledFor;
    if (legacyFromScheduled) {
      if (!scheduledFor) throw new AppError(400, 'BAD_STATE', 'There is no scheduled slot for this job');
      assertServiceJobStartDue(scheduledFor, completedAt);
    }
    const transitioned = await executeTenantBoundServiceJobTransaction(
      app.prisma,
      async (boundTx) => {
      let generation = expectedUpdatedAt;
      if (legacyFromScheduled && scheduledFor) {
        const started = await transitionServiceJob(boundTx, {
          jobId: id,
          actorUserId: request.user.userId,
          expectedUpdatedAt,
          from: 'SCHEDULED',
          to: 'IN_PROGRESS',
          guard: {
            provider: { userId: request.user.userId },
            providerConfirmedAt: { not: null },
            AND: [{ scheduledFor }, { scheduledFor: { lte: completedAt } }],
          },
          action: 'SERVICE_JOB_STARTED',
          audit: { scheduledFor: scheduledFor.toISOString(), startedAt: completedAt.toISOString(), completedInOneStep: true },
          notices: [],
          now: completedAt,
        });
        generation = started.job.updatedAt;
      }
      return transitionServiceJob(boundTx, {
        jobId: id,
        actorUserId: request.user.userId,
        expectedUpdatedAt: generation,
        from: 'IN_PROGRESS',
        to: 'COMPLETED',
        guard: { provider: { userId: request.user.userId } },
        data: { completedAt },
        action: 'SERVICE_JOB_COMPLETED',
        audit: { completedAt: completedAt.toISOString() },
        closeChatRoomId: job.chatRoomId,
        notices: [
          {
            userId: job.customerId,
            type: 'ORDER_UPDATE',
            title: 'Job complete — how did it go?',
            body: 'Your provider marked this job complete. Pay cash directly to them, then rate how it went.',
            data: { kind: 'booking_completed', jobId: id },
          },
          {
            userId: job.provider.userId,
            type: 'ORDER_UPDATE',
            title: 'Job complete — how did it go?',
            body: 'You marked this job complete. Rate your customer to close it out.',
            data: { kind: 'booking_completed', jobId: id },
          },
        ],
        now: completedAt,
      });
      },
    );
    await publishPersisted(transitioned.notificationIds);
    return { success: true, data: transitioned.job };
  });

  app.post('/jobs/:id/cancel', auth, async (request) => {
    const { id } = request.params as { id: string };
    const command = readServiceJobLifecycleCommand(request, transitionGenerationSchema, legacyTransitionSchema);
    const job = await jobForUser(id, request.user.userId);
    const { expectedUpdatedAt } = commandGeneration(command, job);
    if (['COMPLETED', 'CANCELLED'].includes(job.status)) throw new AppError(400, 'BAD_STATE', 'This job is already closed');
    const cancelledByCustomer = job.customerId === request.user.userId;
    // [owner #50 · coordinator rulings 14 Oct] The one cancellation rule decides
    // the customer's cancel, as the Terms (§7) say: free while the job is a
    // request, refused once it is booked or in progress (contact the provider).
    // [BOOK-P2 · owner B1] A time booked from a pro's menu, while INSTANT_BOOKING
    // is on: free until two hours before it starts (cancel-policy.ts).
    // The provider may still cancel a booked or started job. Never a fee.
    if (cancelledByCustomer) {
      const verdict = serviceJobCancelVerdict(job, new Date());
      if (!verdict.allowed) throw new AppError(409, verdict.code, verdict.message);
    }
    const when = job.scheduledFor ? slotLabel(job.scheduledFor) : null;
    const cancelledAt = new Date();
    const transitioned = await executeTenantBoundServiceJobTransaction(
      app.prisma,
      (boundTx) => transitionServiceJob(boundTx, {
        jobId: id,
        actorUserId: request.user.userId,
        expectedUpdatedAt,
        from: job.status,
        to: 'CANCELLED',
        guard: { OR: [{ customerId: request.user.userId }, { provider: { userId: request.user.userId } }] },
        data: { cancelledAt },
        action: 'SERVICE_JOB_CANCELLED',
        audit: { cancelledAt: cancelledAt.toISOString(), cancelledBy: cancelledByCustomer ? 'CUSTOMER' : 'PROVIDER' },
        closeChatRoomId: job.chatRoomId,
        notices: [{
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
        }],
        now: cancelledAt,
      }),
    );
    await publishPersisted(transitioned.notificationIds);
    return { success: true, data: transitioned.job };
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
