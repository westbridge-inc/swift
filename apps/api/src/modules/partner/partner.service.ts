import type { PrismaClient, UserRole } from '@prisma/client';
import { AppError, ValidationError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// Partner provisioning (deterministic code — hard rule #1). `register` appends
// the role to User.roles[] but creates no operational entity; the rider/driver/
// vendor routes 404 until one exists. This module creates that entity self-serve
// at onboarding-submit, feeding the existing admin-approve → startTrial →
// go-online pipeline. Rider provisions minimally; a Driver needs vehicle details
// (licence/insurance URLs arrive during onboarding — documentsVerified, not URL
// presence, gates go-online).
// ---------------------------------------------------------------------------

export type Vehicle = { make: string; model: string; year: number; color: string; licensePlate: string };

export interface BecomePartnerInput {
  role: 'MOVER';
  vehicleType: 'BICYCLE' | 'MOTORCYCLE' | 'CAR';
  vehicle?: Vehicle;
}

export class PartnerService {
  constructor(private prisma: PrismaClient) {}

  async becomePartner(userId: string, input: BecomePartnerInput) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, roles: true } });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    return input.vehicleType === 'CAR'
      ? this.provisionDriver(user.id, user.roles, input.vehicle)
      : this.provisionRider(user.id, user.roles, input.vehicleType);
  }

  /** Add the given roles if missing (idempotent). */
  private async ensureRoles(userId: string, current: UserRole[], add: UserRole[]): Promise<UserRole[]> {
    const missing = add.filter((r) => !current.includes(r));
    if (missing.length === 0) return current;
    const roles = [...current, ...missing];
    await this.prisma.user.update({ where: { id: userId }, data: { roles } });
    return roles;
  }

  private async provisionRider(userId: string, roles: UserRole[], vehicleType: 'BICYCLE' | 'MOTORCYCLE') {
    const existing = await this.prisma.rider.findUnique({ where: { userId } });
    const rider = existing ?? (await this.prisma.rider.create({ data: { userId, riderType: 'BOTH', vehicleType } }));
    const updatedRoles = await this.ensureRoles(userId, roles, ['MOVER', 'RIDER']);
    return { kind: 'RIDER' as const, id: rider.id, created: !existing, roles: updatedRoles };
  }

  private async provisionDriver(userId: string, roles: UserRole[], vehicle?: Vehicle) {
    if (!vehicle) {
      throw new ValidationError('Vehicle details (make, model, year, colour, licence plate) are required to drive');
    }
    const existing = await this.prisma.driver.findUnique({ where: { userId } });
    const driver =
      existing ??
      (await this.prisma.driver.create({
        data: {
          userId,
          vehicleMake: vehicle.make,
          vehicleModel: vehicle.model,
          vehicleYear: vehicle.year,
          vehicleColor: vehicle.color,
          licensePlate: vehicle.licensePlate,
          // Filled during onboarding; documentsVerified (not URL presence) gates go-online.
          driverLicenseUrl: '',
          vehicleInsuranceUrl: '',
        },
      }));
    const updatedRoles = await this.ensureRoles(userId, roles, ['MOVER', 'DRIVER']);
    return { kind: 'DRIVER' as const, id: driver.id, created: !existing, roles: updatedRoles };
  }
}
