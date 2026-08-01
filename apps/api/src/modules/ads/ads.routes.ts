import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AdvertiserService } from './advertiser.service';

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
}
