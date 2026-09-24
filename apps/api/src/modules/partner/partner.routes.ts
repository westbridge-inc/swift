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
import { requireStepUp } from '../auth/step-up';
import { VerificationService } from '../verification/verification.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';

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

/** [VEHICLES] PUT /vehicle — the vehicle a mover works with, changed. */
const changeVehicleSchema = z.object({
  vehicleType: z.nativeEnum(VehicleType),
  vehicle: vehicleSchema.optional(),
});

export async function partnerRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const notifications = new NotificationService(app.prisma, app.io);
  const service = new PartnerService(app.prisma, notifications);
  const verification = new VerificationService(app.prisma, notifications, getKycProvider());

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

  /**
   * PUT /vehicle — [VEHICLES] change the vehicle a mover works with (PartnerService
   * changeVehicleWithAuthority). A mover whose documents are verified steps up first: the
   * change takes them offline and retires the papers about the old vehicle, so it is
   * their livelihood, and a borrowed phone must not be able to do it. A mover still in
   * onboarding changes freely.
   */
  app.put('/vehicle', auth, async (request) => {
    const body = changeVehicleSchema.parse(request.body);
    const userId = request.user.userId;
    const [rider, driver] = await Promise.all([
      app.prisma.rider.findUnique({ where: { userId }, select: { documentsVerified: true } }),
      app.prisma.driver.findUnique({ where: { userId }, select: { documentsVerified: true } }),
    ]);
    const verified = !!rider?.documentsVerified || !!driver?.documentsVerified
      || ((!!rider || !!driver) && await verification.isRoleVerified(userId, 'MOVER'));
    if (verified) await requireStepUp(app, request);
    const { result, authorityCleanup } = await service.changeVehicleWithAuthority(
      userId,
      body,
      (tx, targetRole) => transitionUserRoleAuthorityInTransaction(tx, userId, targetRole),
    );
    if (authorityCleanup) {
      // Every profile this change took offline gives up its held offer and closes its online session.
      await completeUserRoleAuthorityTransition(app, {
        ...authorityCleanup,
        riderId: authorityCleanup.riderId ?? result.retiredRiderId,
        driverId: authorityCleanup.driverId ?? result.retiredDriverId,
      });
    }
    return {
      success: true,
      data: {
        kind: result.kind,
        id: result.id,
        vehicleType: result.vehicleType,
        previousVehicleType: result.previousVehicleType,
        changed: result.changed,
        retiredDocuments: result.retiredDocuments,
        withdrawnDocuments: result.withdrawnDocuments,
        activeRole: authorityCleanup?.activeRole ?? null,
        lastMoverRole: authorityCleanup?.lastMoverRole ?? null,
      },
    };
  });
}
