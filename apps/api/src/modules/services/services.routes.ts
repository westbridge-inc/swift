import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RatingService } from '../rating/rating.service';
import { tradeRiskTier, riskGuidance, geiRegistryCheck, isProviderVerified } from './services.service';
import { AppError, NotFoundError } from '../../utils/errors';

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
const browseSchema = z.object({ trade: z.string().trim().min(2).max(60) });
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
  const ratingService = new RatingService(app.prisma);

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
    const userId = request.user.userId;
    const isVerified = await isProviderVerified(app.prisma, userId);
    const provider = await app.prisma.serviceProvider.upsert({
      where: { userId },
      create: { userId, trade: body.trade, bio: body.bio, portfolioPhotos: body.portfolioPhotos ?? [], isVerified },
      update: { trade: body.trade, bio: body.bio, ...(body.portfolioPhotos && { portfolioPhotos: body.portfolioPhotos }), isVerified },
    });
    return { success: true, data: provider };
  });

  app.get('/providers/me', auth, async (request) => {
    const provider = await app.prisma.serviceProvider.findUnique({
      where: { userId: request.user.userId },
      include: { qualifications: true },
    });
    if (!provider) throw new NotFoundError('ServiceProvider');
    const certified = provider.qualifications.some((q) => q.status === 'VERIFIED');
    return { success: true, data: { ...provider, certified } };
  });

  /** POST /providers/qualifications — add a trade qualification (earns the badge). */
  app.post('/providers/qualifications', auth, async (request) => {
    const body = qualificationSchema.parse(request.body);
    const provider = await app.prisma.serviceProvider.findUnique({
      where: { userId: request.user.userId },
      select: { id: true },
    });
    if (!provider) throw new NotFoundError('ServiceProvider');

    // An electrician's GEI licence is checkable against the registry → instant badge.
    const verified = body.type === 'GEI_LICENCE' && geiRegistryCheck(body.referenceNumber);
    const qual = await app.prisma.serviceQualification.create({
      data: {
        providerId: provider.id,
        type: body.type,
        referenceNumber: body.referenceNumber,
        status: verified ? 'VERIFIED' : 'PENDING',
        verifiedAt: verified ? new Date() : null,
      },
    });
    // Holding a qualification removes the "self-skilled" transparency label.
    await app.prisma.serviceProvider.update({ where: { id: provider.id }, data: { selfSkilled: false } });
    return { success: true, data: qual };
  });

  // ─── Customer: browse by trade (risk-tiered, certified-first) ──────────

  app.get('/providers', auth, async (request) => {
    const { trade } = browseSchema.parse(request.query);
    const providers = await app.prisma.serviceProvider.findMany({
      where: { trade: { equals: trade, mode: 'insensitive' }, isVerified: true },
      include: { qualifications: { where: { status: 'VERIFIED' }, select: { type: true } } },
    });
    const ranked = providers
      .map((p) => ({
        id: p.id,
        trade: p.trade,
        bio: p.bio,
        portfolioPhotos: p.portfolioPhotos,
        averageRating: p.averageRating,
        totalRatings: p.totalRatings,
        selfSkilled: p.selfSkilled,
        certified: p.qualifications.length > 0,
        badges: p.qualifications.map((q) => q.type),
      }))
      // Surface licensed (certified) providers first — strongest signal for high-risk trades.
      .sort((a, b) => Number(b.certified) - Number(a.certified) || b.averageRating - a.averageRating);

    return {
      success: true,
      data: { riskTier: tradeRiskTier(trade), guidance: riskGuidance(trade), providers: ranked },
    };
  });

  // ─── Jobs: request → quote(-via-chat) → schedule → complete → rate ─────

  app.post('/jobs', auth, async (request, reply) => {
    const body = jobRequestSchema.parse(request.body);
    const customerId = request.user.userId;
    const provider = await app.prisma.serviceProvider.findUnique({
      where: { id: body.providerId },
      select: { id: true, userId: true, isVerified: true },
    });
    if (!provider) throw new NotFoundError('ServiceProvider', body.providerId);
    if (!provider.isVerified) throw new AppError(403, 'PROVIDER_NOT_VERIFIED', 'This provider is not verified to accept jobs yet');
    if (provider.userId === customerId) throw new AppError(400, 'SELF_JOB', 'You cannot hire yourself');

    const job = await app.prisma.serviceJob.create({
      data: { customerId, providerId: provider.id, description: body.description, photos: body.photos ?? [], status: 'REQUESTED' },
    });
    // Quote-via-chat: a transaction-scoped chat for customer + provider.
    const room = await app.prisma.chatRoom.create({
      data: {
        serviceJobId: job.id,
        participants: { create: [{ userId: customerId, role: 'customer' }, { userId: provider.userId, role: 'provider' }] },
      },
    });
    const updated = await app.prisma.serviceJob.update({ where: { id: job.id }, data: { chatRoomId: room.id } });
    reply.code(201);
    return { success: true, data: updated };
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
    const updated = await app.prisma.serviceJob.update({ where: { id }, data: { quoteAmount: amount, status: 'QUOTED' } });
    return { success: true, data: updated };
  });

  app.post('/jobs/:id/schedule', auth, async (request) => {
    const { id } = request.params as { id: string };
    const { scheduledFor } = scheduleSchema.parse(request.body);
    const job = await jobForUser(id, request.user.userId);
    if (job.customerId !== request.user.userId) throw new AppError(403, 'CUSTOMER_ONLY', 'Only the customer can schedule');
    if (job.status !== 'QUOTED') throw new AppError(400, 'BAD_STATE', 'Agree a quote before scheduling');
    const updated = await app.prisma.serviceJob.update({ where: { id }, data: { scheduledFor, status: 'SCHEDULED' } });
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
