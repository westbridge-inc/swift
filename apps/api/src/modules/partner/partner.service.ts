import { Prisma, type PrismaClient, type UserRole, type VehicleType, type RideClass } from '@prisma/client';
import { nanoid } from 'nanoid';
import { AppError, ValidationError } from '../../utils/errors';
import { VEHICLE_CLASSES } from '../../config/vehicle-classes';
import { FloatService } from '../dispatch/float.service';
import { NotificationService, notifyAdmins } from '../notification/notification.service';

// ---------------------------------------------------------------------------
// Partner provisioning (deterministic code — hard rule #1). `register` appends
// the role to User.roles[] but creates no operational entity; the rider/driver/
// vendor routes 404 until one exists. This module creates that entity self-serve
// at onboarding-submit, feeding the existing admin-approve → startTrial →
// go-online pipeline. Rider provisions minimally; Driver needs vehicle details;
// Vendor needs business details (all collected during onboarding).
// ---------------------------------------------------------------------------

export type Vehicle = { make: string; model: string; year: number; color: string; licensePlate: string };
export type VendorType = 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';
export type Business = {
  name: string;
  vendorType: VendorType;
  phone: string;
  addressLine1: string;
  city: string;
  region?: string;
  latitude: number;
  longitude: number;
};

export interface BecomePartnerInput {
  role: 'MOVER' | 'VENDOR';
  vehicleType?: VehicleType;
  vehicle?: Vehicle;
  business?: Business;
}

type Tx = Prisma.TransactionClient;
export type PartnerProvisionResult =
  | { kind: 'RIDER'; id: string; created: boolean; roles: UserRole[]; targetRole: 'RIDER' }
  | { kind: 'DRIVER'; id: string; created: boolean; roles: UserRole[]; targetRole: 'DRIVER' }
  | { kind: 'VENDOR'; id: string; created: boolean; roles: UserRole[]; targetRole: 'VENDOR_OWNER' };

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export class PartnerService {
  constructor(
    private prisma: PrismaClient,
    private notifications?: NotificationService,
  ) {}

  async becomePartner(userId: string, input: BecomePartnerInput): Promise<PartnerProvisionResult> {
    this.validateInput(input);
    const result = await this.prisma.$transaction((tx) => this.provisionLocked(tx, userId, input));
    await this.afterCommit(result, input);
    return result;
  }

  /** Compose provisioning with the route's authority transition in the same
   * transaction. A rejected role switch therefore cannot leave a ghost profile
   * or role behind, and concurrent joins cannot lose roles or race idempotency. */
  async becomePartnerWithAuthority<TCleanup>(
    userId: string,
    input: BecomePartnerInput,
    transitionAuthority: (tx: Tx, targetRole: UserRole) => Promise<TCleanup>,
  ): Promise<{ result: PartnerProvisionResult; authorityCleanup: TCleanup }> {
    this.validateInput(input);
    const combined = await this.prisma.$transaction(async (tx) => {
      const result = await this.provisionLocked(tx, userId, input);
      const authorityCleanup = await transitionAuthority(tx, result.targetRole);
      return { result, authorityCleanup };
    });
    await this.afterCommit(combined.result, input);
    return combined;
  }

  private validateInput(input: BecomePartnerInput): void {
    if (input.role === 'VENDOR') {
      if (!input.business) throw new ValidationError('Business details are required to sell on Swift');
      return;
    }
    if (!input.vehicleType) throw new ValidationError('Vehicle type is required to move with Swift');
    // Passenger-capable vehicles (car → Economy, wagon → Comfort, bus → Group)
    // provision a Driver at their tier so the vehicle earns on the higher-value
    // ride classes; cargo-only vehicles (bike, canter, box truck) are delivery
    // Riders. Maximises each vehicle's earning reach.
    const rideClass = VEHICLE_CLASSES[input.vehicleType]?.rideClass;
    if (rideClass && !input.vehicle) {
      throw new ValidationError('Vehicle details (make, model, year, colour, licence plate) are required to drive');
    }
  }

  private async provisionLocked(tx: Tx, userId: string, input: BecomePartnerInput): Promise<PartnerProvisionResult> {
    const rows = await tx.$queryRaw<Array<{ id: string; roles: UserRole[] }>>`
      SELECT "id", "roles"
      FROM "users"
      WHERE "id" = ${userId}
      FOR UPDATE
    `;
    const user = rows[0];
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    if (input.role === 'VENDOR') {
      return this.provisionVendor(tx, user.id, user.roles, input.business!);
    }
    const vehicleType = input.vehicleType!;
    const rideClass = VEHICLE_CLASSES[vehicleType]?.rideClass;
    return rideClass
      ? this.provisionDriver(tx, user.id, user.roles, input.vehicle, rideClass, vehicleType)
      : this.provisionRider(tx, user.id, user.roles, vehicleType);
  }

  /** Add the given roles if missing (idempotent). Active-role authority is
   * transitioned by the route through the shared locked protocol. */
  private async ensureRoles(tx: Tx, userId: string, current: UserRole[], add: UserRole[]): Promise<UserRole[]> {
    const missing = add.filter((r) => !current.includes(r));
    if (missing.length === 0) return current;
    const roles = [...current, ...missing];
    await tx.user.update({ where: { id: userId }, data: { roles } });
    return roles;
  }

  // Cargo-only vehicles (bike, motorbike, canters, box trucks) provision a
  // delivery/courier Rider. Passenger-capable vehicles (car, wagon, bus) take
  // the Driver path above, at their ride tier.
  private async provisionRider(tx: Tx, userId: string, roles: UserRole[], vehicleType: VehicleType): Promise<PartnerProvisionResult> {
    const existing = await tx.rider.findUnique({ where: { userId } });
    const rider = existing ?? (await tx.rider.create({ data: { userId, riderType: 'BOTH', vehicleType } }));
    // D.3 — seed the new rider's float limit from their trust level + country.
    if (!existing) await new FloatService(tx).recomputeForUser(userId);
    const updatedRoles = await this.ensureRoles(tx, userId, roles, ['MOVER', 'RIDER']);
    return { kind: 'RIDER' as const, id: rider.id, created: !existing, roles: updatedRoles, targetRole: 'RIDER' as const };
  }

  private async provisionDriver(tx: Tx, userId: string, roles: UserRole[], vehicle?: Vehicle, rideClass: RideClass = 'ECONOMY', vehicleType: VehicleType = 'CAR'): Promise<PartnerProvisionResult> {
    if (!vehicle) {
      throw new ValidationError('Vehicle details (make, model, year, colour, licence plate) are required to drive');
    }
    const existing = await tx.driver.findUnique({ where: { userId } });
    // [REPORT-014 F-014-01] The vehicle TAXONOMY is the authority for what a
    // vehicle physically is: seats come from it (never the schema default 4),
    // and the ride class is its class — a self-declared class can never
    // outrank the declared vehicle type.
    const taxonomy = VEHICLE_CLASSES[vehicleType];
    const driver =
      existing ??
      (await tx.driver.create({
        data: {
          userId,
          rideClass: taxonomy?.rideClass ?? rideClass,
          vehicleCapacity: taxonomy?.seats ?? 4,
          vehicleType,
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
    const updatedRoles = await this.ensureRoles(tx, userId, roles, ['MOVER', 'DRIVER']);
    return { kind: 'DRIVER' as const, id: driver.id, created: !existing, roles: updatedRoles, targetRole: 'DRIVER' as const };
  }

  private async provisionVendor(tx: Tx, userId: string, roles: UserRole[], business: Business): Promise<PartnerProvisionResult> {
    const owner = await tx.vendorOwner.upsert({ where: { userId }, create: { userId }, update: {} });

    // One store per owner at onboarding (idempotent).
    const existing = await tx.vendor.findFirst({ where: { ownerId: owner.id } });
    if (existing) {
      const updatedRoles = await this.ensureRoles(tx, userId, roles, ['VENDOR_OWNER']);
      return { kind: 'VENDOR' as const, id: existing.id, created: false, roles: updatedRoles, targetRole: 'VENDOR_OWNER' as const };
    }

    const vendor = await tx.vendor.create({
      data: {
        ownerId: owner.id,
        name: business.name,
        slug: `${slugify(business.name) || 'store'}-${nanoid(6)}`,
        vendorType: business.vendorType,
        phone: business.phone,
        addressLine1: business.addressLine1,
        city: business.city,
        region: business.region ?? '',
        latitude: business.latitude,
        longitude: business.longitude,
        status: 'PENDING_APPROVAL',
      },
    });
    const updatedRoles = await this.ensureRoles(tx, userId, roles, ['VENDOR_OWNER']);

    return { kind: 'VENDOR' as const, id: vendor.id, created: true, roles: updatedRoles, targetRole: 'VENDOR_OWNER' as const };
  }

  private async afterCommit(result: PartnerProvisionResult, input: BecomePartnerInput): Promise<void> {
    if (result.kind !== 'VENDOR' || !result.created || !this.notifications || !input.business) return;
    // External notification work happens only after the DB transaction commits;
    // a rolled-back or losing concurrent provisioning attempt emits nothing.
    await notifyAdmins(this.prisma, this.notifications, {
      // Follows the vendor just provisioned [NOC-A F45]: afterCommit sees the
      // provisioning RESULT, and result.id is the vendor that carries the tenant.
      tenantId: (await this.prisma.vendor.findUnique({ where: { id: result.id }, select: { tenantId: true } }).catch(() => null))?.tenantId ?? null,
      title: 'New business awaiting approval',
      body: `${input.business.name} (${input.business.vendorType.toLowerCase()}) just signed up and is waiting for review.`,
      data: { kind: 'vendor_pending', vendorId: result.id },
    });
  }
}
