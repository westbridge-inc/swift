import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AdvertiserService } from './advertiser.service';
import { BookingService } from './booking.service';
import { AdCheckoutService } from './checkout.service';
import { CreativeService } from './creative.service';
import { AdsLifecycleService } from './lifecycle.service';
import { AdStatsService } from './stats.service';
import { mondayOfDate, isMonday } from './ads-weeks';
import { AppError, NotFoundError } from '../../utils/errors';

// Advertiser-facing ads routes (ads-platform spec §4.2/§4.3). Registration and
// the "under review" dashboard read. Ops/admin queue actions live in the admin
// module behind the admin guard. Ad-management access is AdvertiserMember-based.

const registerSchema = z.object({
  companyName: z.string().trim().min(2).max(80),
  legalName: z.string().trim().max(120).optional(),
  registrationNo: z.string().trim().max(40).optional(),
  industry: z.enum(AdvertiserService.INDUSTRIES),
  website: z.string().trim().url().max(200).optional().or(z.literal('')),
  contactName: z.string().trim().min(1).max(120),
  contactEmail: z.string().trim().email(),
  contactPhone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +5926001234.'),
  city: z.string().trim().max(80).optional(),
});

export async function adsRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const advertisers = new AdvertiserService(app.prisma, app.io);

  /** POST /advertiser/register — a logged-in user registers a company; it
   *  lands PENDING_REVIEW in the founder queue and they become OWNER. */
  app.post('/advertiser/register', auth, async (request) => {
    const body = registerSchema.parse(request.body ?? {});
    const advertiser = await advertisers.register(request.user.userId, {
      ...body,
      website: body.website || null,
    });
    return { success: true, data: { id: advertiser.id, status: advertiser.status, companyName: advertiser.companyName } };
  });

  /** GET /advertiser/me — the caller's advertiser(s) + status, for the
   *  "under review" / approved dashboard gating. */
  app.get('/advertiser/me', auth, async (request) => {
    return { success: true, data: await advertisers.listForUser(request.user.userId) };
  });

  // ── Placements, availability, campaigns, reservation (spec §2/§7) ─────────
  const booking = new BookingService(app.prisma);

  /** GET /placements — the sellable home-screen placements (wizard step ①). */
  app.get('/placements', auth, async () => {
    const rows = await app.prisma.adPlacement.findMany({ where: { active: true }, orderBy: { tier: 'asc' } });
    return { success: true, data: rows.map((p) => ({ id: p.id, key: p.key, name: p.name, tier: p.tier, mediaKind: p.mediaKind, slotsPerWeek: p.slotsPerWeek, rotationSeconds: p.rotationSeconds, weeklyPrice: Number(p.weeklyPrice), currency: p.currency })) };
  });

  /** GET /placements/:id/availability — per-week availability for a city over a
   *  range; lazily materialises inventory rows (spec §7.2). */
  app.get<{ Params: { id: string } }>('/placements/:id/availability', auth, async (request) => {
    const q = z.object({
      city: z.string().trim().min(1).default('*'),
      from: z.string().date(),
      to: z.string().date(),
    }).parse(request.query ?? {});
    const from = new Date(`${q.from}T00:00:00Z`);
    const to = new Date(`${q.to}T00:00:00Z`);
    if (to < from) throw new AppError(400, 'BAD_RANGE', 'to must be on or after from.');
    return { success: true, data: await booking.availability(request.params.id, q.city, from, to) };
  });

  /** POST /campaigns — create a DRAFT campaign (any member; weeks snapped to
   *  Mondays). Reserving inventory + paying is gated on an APPROVED advertiser. */
  app.post('/campaigns', auth, async (request) => {
    const body = z.object({
      advertiserId: z.string().min(1),
      placementId: z.string().min(1),
      name: z.string().trim().min(2).max(80),
      objective: z.enum(['AWARENESS', 'TRAFFIC', 'PROMOTION']).optional(),
      cities: z.array(z.string().trim().min(1)).min(1).max(50).default(['*']),
      startWeek: z.string().date(),
      endWeek: z.string().date(),
      destinationType: z.enum(['NONE', 'URL', 'DEEPLINK']).optional(),
      destinationValue: z.string().trim().max(500).optional(),
    }).parse(request.body ?? {});
    await advertisers.assertMember(body.advertiserId, request.user.userId);
    const placement = await app.prisma.adPlacement.findUnique({ where: { id: body.placementId } });
    if (!placement || !placement.active) throw new NotFoundError('AdPlacement', body.placementId);

    const startWeek = mondayOfDate(new Date(`${body.startWeek}T00:00:00Z`));
    const endWeek = mondayOfDate(new Date(`${body.endWeek}T00:00:00Z`));
    if (endWeek < startWeek) throw new AppError(400, 'BAD_RANGE', 'endWeek must be on or after startWeek.');
    if (!isMonday(startWeek) || !isMonday(endWeek)) throw new AppError(500, 'WEEK_SNAP_FAILED', 'Internal week normalization error.');

    const campaign = await app.prisma.adCampaign.create({
      data: {
        advertiserId: body.advertiserId, placementId: body.placementId, name: body.name,
        objective: body.objective ?? null, cities: body.cities, startWeek, endWeek,
        destinationType: body.destinationType ?? 'NONE', destinationValue: body.destinationValue ?? null,
      },
    });
    return { success: true, data: { id: campaign.id, status: campaign.status, startWeek: campaign.startWeek, endWeek: campaign.endWeek } };
  });

  /** POST /campaigns/:id/reserve — hold the inventory (spec §7.3). Race-safe;
   *  APPROVED advertiser only (a pending applicant can draft, not commit). */
  app.post<{ Params: { id: string } }>('/campaigns/:id/reserve', auth, async (request) => {
    const campaign = await app.prisma.adCampaign.findUnique({
      where: { id: request.params.id },
      include: { advertiser: { select: { id: true, status: true } } },
    });
    if (!campaign) throw new NotFoundError('AdCampaign', request.params.id);
    await advertisers.assertMember(campaign.advertiserId, request.user.userId);
    if (campaign.advertiser.status !== 'APPROVED') {
      throw new AppError(403, 'ADVERTISER_NOT_APPROVED', 'Your advertiser account must be approved before you can book inventory.');
    }
    const settings = await app.prisma.adsSettings.findUnique({ where: { tenantId: campaign.tenantId } });
    // [R045-ADS-06] The reservation and the campaign's status commit together
    // under the campaign lock — never RESERVED inventory on a DRAFT campaign.
    const result = await booking.reserveAndHold(campaign.id, { reservationMinutes: settings?.reservationMinutes ?? 20 });
    return { success: true, data: result };
  });

  /** POST /campaigns/:id/checkout — issue the invoice for the held slots
   *  (spec §8.1). Reserves first if still DRAFT. Provider MMG/POWERTRANZ hosted
   *  URLs need live acquirer creds (founder-gated); MOCK works in dev. The
   *  audited mark-paid path settles it either way. */
  const checkout = new AdCheckoutService(app.prisma, app.io);
  app.post<{ Params: { id: string } }>('/campaigns/:id/checkout', auth, async (request) => {
    const { provider } = z.object({ provider: z.enum(['MOCK', 'MMG', 'POWERTRANZ', 'MANUAL']).default('MANUAL') }).parse(request.body ?? {});
    const campaign = await app.prisma.adCampaign.findUnique({ where: { id: request.params.id }, select: { advertiserId: true, tenantId: true } });
    if (!campaign) throw new NotFoundError('AdCampaign', request.params.id);
    await advertisers.assertMember(campaign.advertiserId, request.user.userId);
    const settings = await app.prisma.adsSettings.findUnique({ where: { tenantId: campaign.tenantId } });
    const { invoice, reservedUntil } = await checkout.checkout(request.params.id, provider, settings?.reservationMinutes ?? 20);
    return {
      success: true,
      data: { invoiceId: invoice.id, number: invoice.number, amount: Number(invoice.amount), currency: invoice.currency, status: invoice.status, paymentUrl: invoice.paymentUrl, reservedUntil },
    };
  });

  // ── Creatives (spec §9) — direct multipart upload, member-gated ───────────
  const creatives = new CreativeService(app.prisma, app.io);

  /** POST /campaigns/:id/creatives — upload a creative (image or MP4). Text
   *  fields ride multipart form fields alongside the file. */
  app.post<{ Params: { id: string } }>('/campaigns/:id/creatives', auth, async (request) => {
    const campaign = await app.prisma.adCampaign.findUnique({ where: { id: request.params.id }, select: { advertiserId: true } });
    if (!campaign) throw new NotFoundError('AdCampaign', request.params.id);
    await advertisers.assertMember(campaign.advertiserId, request.user.userId);

    // Per-call transport cap: §9.1 allows 25 MB videos, but the GLOBAL
    // multipart limit is 5 MB (KYC/selfie/proof photos) — without this
    // override every ad video over 5 MB dies at the transport layer. The
    // service still enforces the real per-kind caps (500 KB image / 25 MB mp4).
    const file = await request.file({ limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach a creative file.');
    const buffer = await file.toBuffer();
    const fields = file.fields as Record<string, { value?: string } | undefined>;
    const kind = (fields['kind']?.value === 'VIDEO' ? 'VIDEO' : 'IMAGE') as 'IMAGE' | 'VIDEO';
    const text = {
      headline: fields['headline']?.value,
      body: fields['body']?.value,
      ctaLabel: fields['ctaLabel']?.value,
    };
    const creative = await creatives.upload({ campaignId: request.params.id, kind, buffer, mime: file.mimetype, filename: file.filename, text });
    return { success: true, data: { id: creative.id, status: creative.status, transcodeStatus: creative.transcodeStatus, fileUrl: creative.fileUrl } };
  });

  // ── Campaign lifecycle (spec §6.1) — advertiser-side events ───────────────
  const lifecycle = new AdsLifecycleService(app.prisma, app.io);
  const memberEvent = (event: 'pause' | 'resume') =>
    async (request: { user: { userId: string }; params: { id: string } }) => {
      const campaign = await app.prisma.adCampaign.findUnique({ where: { id: request.params.id }, select: { advertiserId: true } });
      if (!campaign) throw new NotFoundError('AdCampaign', request.params.id);
      await advertisers.assertMember(campaign.advertiserId, request.user.userId);
      const updated = await lifecycle.transition(request.params.id, event, request.user.userId);
      return { success: true, data: { id: updated.id, status: updated.status } };
    };
  // ── Serving + events (spec §11/§12) — PUBLIC by design (anonymous allowed);
  //    server derives userHash when signed in. ────────────────────────────────
  const { AdServingService } = await import('./serving.service');
  const { AdEventService } = await import('./event.service');
  const serving = new AdServingService(app.prisma);
  const events = new AdEventService(app.prisma);
  const optionalAuth = { preHandler: [app.authenticateOptional] };

  const deriveUserId = (request: { user?: { userId?: string } }): string | null => request.user?.userId ?? null;
  const deriveEventPrincipal = (request: { user?: { userId?: string }; headers: { authorization?: unknown } }) => ({
    userId: deriveUserId(request),
    authPresented: typeof request.headers.authorization === 'string' && request.headers.authorization.trim().length > 0,
  });

  /** GET /serve — build the home-screen ad slots. Never errors the home screen;
   *  empty inventory → house ads → collapsed slot. */
  app.get('/serve', optionalAuth, async (request) => {
    const q = z.object({
      placements: z.string().min(1),
      city: z.string().trim().min(1).default('*'),
      sessionId: z.string().trim().min(1).max(128),
    }).parse(request.query ?? {});
    const keys = q.placements.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 5);
    try {
      const { getTenantId } = await import('../../plugins/tenant-context');
      const data = await serving.serve({ tenantId: getTenantId() ?? 'swift-default', city: q.city, sessionId: q.sessionId, userId: deriveUserId(request), keys });
      return { success: true, data };
    } catch {
      // Ads must NEVER break the home screen — degrade to empty on any failure.
      return { success: true, data: { placements: {}, _house: {} } };
    }
  });

  /** POST /events — batch (≤50) ad event ingestion. Per-item verdict. */
  app.post('/events', optionalAuth, async (request) => {
    const body = z.object({
      events: z.array(z.object({
        token: z.string().min(8),
        eventType: z.enum(['IMPRESSION', 'VIEWABLE_IMPRESSION', 'CLICK', 'VIDEO_START', 'VIDEO_Q25', 'VIDEO_Q50', 'VIDEO_Q75', 'VIDEO_COMPLETE']),
        occurredAt: z.string(),
        meta: z.record(z.string(), z.unknown()).optional(),
      })).min(1).max(50),
    }).parse(request.body ?? {});
    const verdicts = await events.ingest(body.events, deriveEventPrincipal(request));
    return { success: true, data: { results: verdicts } };
  });

  app.post<{ Params: { id: string } }>('/campaigns/:id/pause', auth, memberEvent('pause'));
  app.post<{ Params: { id: string } }>('/campaigns/:id/resume', auth, memberEvent('resume'));

  /** GET /campaigns/:id/stats — the advertiser dashboard numbers (spec §12.3).
   *  Reads the nightly AdStatsDaily rollups ONLY; the reconciliation merge-gate
   *  proves these totals exactly equal the raw AdEvent counts. */
  const statsService = new AdStatsService(app.prisma);
  app.get<{ Params: { id: string } }>('/campaigns/:id/stats', auth, async (request) => {
    z.object({ granularity: z.enum(['day']).default('day') }).parse(request.query ?? {});
    const campaign = await app.prisma.adCampaign.findUnique({ where: { id: request.params.id }, select: { advertiserId: true } });
    if (!campaign) throw new NotFoundError('AdCampaign', request.params.id);
    await advertisers.assertMember(campaign.advertiserId, request.user.userId);
    return { success: true, data: await statsService.campaignStats(request.params.id) };
  });

  // ── Advertiser dashboard reads (spec §14) — all member-gated ─────────────

  /** §14.2 home — the advertiser's campaigns with placement + invoice status. */
  app.get<{ Params: { id: string } }>('/advertiser/:id/campaigns', auth, async (request) => {
    await advertisers.assertMember(request.params.id, request.user.userId);
    const campaigns = await app.prisma.adCampaign.findMany({
      where: { advertiserId: request.params.id },
      include: {
        placement: { select: { key: true, name: true, tier: true, mediaKind: true } },
        invoices: { select: { id: true, number: true, status: true, amount: true, paymentUrl: true } },
        creatives: { select: { id: true, status: true, transcodeStatus: true } },
        bookings: { select: { weekStart: true, city: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      success: true,
      data: campaigns.map((c) => ({
        id: c.id, name: c.name, status: c.status, statusReason: c.statusReason,
        placement: { key: c.placement.key, name: c.placement.name, tier: c.placement.tier, mediaKind: c.placement.mediaKind },
        cities: c.cities, startWeek: c.startWeek, endWeek: c.endWeek,
        totalAmount: c.totalAmount ? Number(c.totalAmount) : null, currency: c.currency,
        invoices: c.invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, amount: Number(i.amount), paymentUrl: i.paymentUrl })),
        creatives: c.creatives,
        bookings: c.bookings,
        createdAt: c.createdAt,
      })),
    };
  });

  /** §14.5 billing — the advertiser's invoices. */
  app.get<{ Params: { id: string } }>('/advertiser/:id/invoices', auth, async (request) => {
    await advertisers.assertMember(request.params.id, request.user.userId);
    const invoices = await app.prisma.adInvoice.findMany({
      where: { advertiserId: request.params.id },
      include: { campaign: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      success: true,
      data: invoices.map((i) => ({
        id: i.id, number: i.number, campaign: i.campaign.name, amount: Number(i.amount),
        currency: i.currency, status: i.status, provider: i.provider, paymentUrl: i.paymentUrl,
        paidAt: i.paidAt, refundedAmount: Number(i.refundedAmount), createdAt: i.createdAt,
      })),
    };
  });

  /** §14.6 team — list members; OWNER adds MANAGER/ANALYST by phone (the
   *  invited person must already have a Swift account). */
  app.get<{ Params: { id: string } }>('/advertiser/:id/members', auth, async (request) => {
    await advertisers.assertMember(request.params.id, request.user.userId);
    const members = await app.prisma.advertiserMember.findMany({ where: { advertiserId: request.params.id } });
    const users = await app.prisma.user.findMany({
      where: { id: { in: members.map((m) => m.userId) } },
      select: { id: true, firstName: true, lastName: true, phone: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    return {
      success: true,
      data: members.map((m) => {
        const u = userById.get(m.userId);
        return { userId: m.userId, role: m.role, name: u ? `${u.firstName} ${u.lastName}`.trim() : null, phone: u?.phone ?? null };
      }),
    };
  });

  app.post<{ Params: { id: string } }>('/advertiser/:id/members', auth, async (request) => {
    const body = z.object({
      phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +5926001234.'),
      role: z.enum(['MANAGER', 'ANALYST']),
    }).parse(request.body ?? {});
    await advertisers.assertMember(request.params.id, request.user.userId, true); // OWNER only
    const invited = await app.prisma.user.findUnique({ where: { phone: body.phone }, select: { id: true } });
    if (!invited) throw new NotFoundError('User', body.phone);
    const member = await app.prisma.advertiserMember.upsert({
      where: { advertiserId_userId: { advertiserId: request.params.id, userId: invited.id } },
      create: { advertiserId: request.params.id, userId: invited.id, role: body.role },
      update: { role: body.role },
    });
    return { success: true, data: { userId: member.userId, role: member.role } };
  });

  /** §14.4 — the EXACT refund the advertiser will get if they cancel now,
   *  shown BEFORE confirming. Same pure calculator the cancel executes. */
  app.get<{ Params: { id: string } }>('/campaigns/:id/refund-preview', auth, async (request) => {
    const campaign = await app.prisma.adCampaign.findUnique({ where: { id: request.params.id }, select: { advertiserId: true, tenantId: true } });
    if (!campaign) throw new NotFoundError('AdCampaign', request.params.id);
    await advertisers.assertMember(campaign.advertiserId, request.user.userId);
    const { AdsRefundService } = await import('./refund.service');
    const settings = await app.prisma.adsSettings.findUnique({ where: { tenantId: campaign.tenantId }, select: { cancelFullRefundDays: true } });
    const plan = await new AdsRefundService(app.prisma, app.io).preview(request.params.id, 'ADVERTISER_CANCEL', { cancelFullRefundDays: settings?.cancelFullRefundDays ?? 7 });
    return { success: true, data: plan };
  });

  /** §6.1 cancel — the advertiser cancels; the §8.4 refund plan executes
   *  (future weeks per the day thresholds, current week 0%). */
  app.post<{ Params: { id: string } }>('/campaigns/:id/cancel', auth, async (request) => {
    const campaign = await app.prisma.adCampaign.findUnique({ where: { id: request.params.id }, select: { advertiserId: true, tenantId: true } });
    if (!campaign) throw new NotFoundError('AdCampaign', request.params.id);
    await advertisers.assertMember(campaign.advertiserId, request.user.userId);
    const { AdsRefundService } = await import('./refund.service');
    const settings = await app.prisma.adsSettings.findUnique({ where: { tenantId: campaign.tenantId }, select: { cancelFullRefundDays: true } });
    const refunds = new AdsRefundService(app.prisma, app.io);
    // [R045-ADS-01] The obligation is staged in the SAME transaction as the
    // cancel; execution follows, and the worker retries it if that fails.
    let staged: { intentId: string } | null = null;
    const updated = await lifecycle.transition(request.params.id, 'cancel', request.user.userId, undefined, {
      within: async (tx) => { staged = await refunds.stage(tx, request.params.id, 'ADVERTISER_CANCEL', request.user.userId, { cancelFullRefundDays: settings?.cancelFullRefundDays ?? 7 }); },
    });
    const refund = staged
      ? await refunds.executeNow((staged as { intentId: string }).intentId).catch(() => ({ planTotal: 0, refundedTotal: 0, creditedTotal: 0, releasedSlots: 0, intentId: (staged as { intentId: string }).intentId }))
      : { planTotal: 0, refundedTotal: 0, creditedTotal: 0, releasedSlots: 0, intentId: null };
    return { success: true, data: { id: updated.id, status: updated.status, refund } };
  });
}
