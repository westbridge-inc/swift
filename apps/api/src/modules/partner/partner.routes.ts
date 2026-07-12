import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PartnerService } from './partner.service';
import { NotificationService } from '../notification/notification.service';

const vehicleSchema = z.object({
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
  year: z.number().int().min(1980).max(new Date().getFullYear() + 1),
  color: z.string().trim().min(1).max(40),
  licensePlate: z.string().trim().min(1).max(20),
});

const businessSchema = z.object({
  name: z.string().trim().min(2).max(120),
  vendorType: z.enum(['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE']),
  phone: z.string().trim().min(5).max(30),
  addressLine1: z.string().trim().min(3).max(200),
  city: z.string().trim().min(2).max(80),
  region: z.string().trim().max(80).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const becomeSchema = z.object({
  role: z.enum(['MOVER', 'VENDOR']),
  vehicleType: z.enum(['BICYCLE', 'MOTORCYCLE', 'CAR']).optional(),
  vehicle: vehicleSchema.optional(),
  business: businessSchema.optional(),
});

export async function partnerRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const service = new PartnerService(app.prisma, new NotificationService(app.prisma, app.io));

  /** POST /become — self-serve provisioning of a Rider/Driver/Vendor entity. */
  app.post('/become', auth, async (request, reply) => {
    const body = becomeSchema.parse(request.body);
    const result = await service.becomePartner(request.user.userId, body);
    reply.code(result.created ? 201 : 200);
    return { success: true, data: result };
  });
}
