import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { VehicleType } from '@prisma/client';
import { PartnerService } from './partner.service';
import { NotificationService } from '../notification/notification.service';
import {
  completeUserRoleAuthorityTransition,
  transitionUserRoleAuthorityInTransaction,
} from '../mover-authority';

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
  vehicleType: z.nativeEnum(VehicleType).optional(),
  vehicle: vehicleSchema.optional(),
  business: businessSchema.optional(),
  // [DCR-1] The role-agreement checkbox. Optional so builds that predate the
  // control keep working — consent is recorded when the checkbox rode the
  // request, exactly as ticked. Never fabricated for old clients.
  acceptAgreement: z.boolean().optional(),
});

export async function partnerRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const service = new PartnerService(app.prisma, new NotificationService(app.prisma, app.io));

  /** POST /become — self-serve provisioning of a Rider/Driver/Vendor entity. */
  app.post('/become', auth, async (request, reply) => {
    const body = becomeSchema.parse(request.body);
    const { result, authorityCleanup } = await service.becomePartnerWithAuthority(
      request.user.userId,
      body,
      (tx, targetRole) => transitionUserRoleAuthorityInTransaction(
        tx,
        request.user.userId,
        targetRole,
      ),
      // [DCR-1] Ledger context for the role-agreement consent row.
      { accepted: body.acceptAgreement === true, ip: request.ip },
    );
    await completeUserRoleAuthorityTransition(app, authorityCleanup);
    reply.code(result.created ? 201 : 200);
    const provisioned = {
      kind: result.kind,
      id: result.id,
      created: result.created,
      roles: result.roles,
    };
    return {
      success: true,
      data: {
        ...provisioned,
        activeRole: authorityCleanup.activeRole,
        lastMoverRole: authorityCleanup.lastMoverRole,
      },
    };
  });
}
