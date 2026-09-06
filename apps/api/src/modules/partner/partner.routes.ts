import type { FastifyInstance } from 'fastify';
import { AppError } from '../../utils/errors';
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
  // [DCR-1 · TA-S1-008] The role-agreement checkbox. It used to be optional "so builds that
  // predate the control keep working" — which made acceptance optional AT THE AUTHORITY: a
  // client that never showed the agreement could provision a partner with no consent row.
  // No released build predates the control, so the API now refuses without it (below); the
  // consent row is still written exactly as ticked, never fabricated.
  acceptAgreement: z.boolean().optional(),
});
export const AGREEMENT_REQUIRED = 'AGREEMENT_REQUIRED';

export async function partnerRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const service = new PartnerService(app.prisma, new NotificationService(app.prisma, app.io));

  /** POST /become — self-serve provisioning of a Rider/Driver/Vendor entity. */
  app.post('/become', auth, async (request, reply) => {
    const body = becomeSchema.parse(request.body);
    // [TA-S1-008] Acceptance is a precondition of the authority, not a courtesy of the client.
    if (body.acceptAgreement !== true) {
      throw new AppError(400, AGREEMENT_REQUIRED, `Accept the ${body.role === 'VENDOR' ? 'vendor' : 'driver'} agreement to continue — Swift records that you agreed, and cannot record what you did not.`);
    }
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
