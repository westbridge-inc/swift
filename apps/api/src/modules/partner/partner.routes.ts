import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PartnerService } from './partner.service';

const becomeSchema = z.object({
  role: z.literal('MOVER'),
  vehicleType: z.enum(['BICYCLE', 'MOTORCYCLE', 'CAR']),
  vehicle: z
    .object({
      make: z.string().trim().min(1).max(60),
      model: z.string().trim().min(1).max(60),
      year: z.number().int().min(1980).max(new Date().getFullYear() + 1),
      color: z.string().trim().min(1).max(40),
      licensePlate: z.string().trim().min(1).max(20),
    })
    .optional(),
});

export async function partnerRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const service = new PartnerService(app.prisma);

  /** POST /become — self-serve provisioning of the mover entity (Rider/Driver). */
  app.post('/become', auth, async (request, reply) => {
    const body = becomeSchema.parse(request.body);
    const result = await service.becomePartner(request.user.userId, body);
    reply.code(result.created ? 201 : 200);
    return { success: true, data: result };
  });
}
