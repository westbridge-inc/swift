import type { PrismaClient, UserRole, VehicleType } from '@prisma/client';
import { nanoid } from 'nanoid';
import { AppError, ValidationError } from '../../utils/errors';
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

  async becomePartner(userId: string, input: BecomePartnerInput) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, roles: true } });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    if (input.role === 'VENDOR') {
      return this.provisionVendor(user.id, user.roles, input.business);
    }
    if (!input.vehicleType) throw new ValidationError('Vehicle type is required to move with Swift');
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

  // Every non-CAR vehicle provisions a delivery/courier Rider (CAR provisions a
  // taxi Driver above). The expanded fleet — wagon, buses, canters, box trucks —
  // are delivery-capable movers here; wiring buses/wagons into taxi passenger
  // service (the Driver side) is a later layer.
  private async provisionRider(userId: string, roles: UserRole[], vehicleType: VehicleType) {
    const existing = await this.prisma.rider.findUnique({ where: { userId } });
    const rider = existing ?? (await this.prisma.rider.create({ data: { userId, riderType: 'BOTH', vehicleType } }));
    // D.3 — seed the new rider's float limit from their trust level + country.
    if (!existing) await new FloatService(this.prisma).recomputeForUser(userId);
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

  private async provisionVendor(userId: string, roles: UserRole[], business?: Business) {
    if (!business) throw new ValidationError('Business details are required to sell on Swift');
    const owner = await this.prisma.vendorOwner.upsert({ where: { userId }, create: { userId }, update: {} });

    // One store per owner at onboarding (idempotent).
    const existing = await this.prisma.vendor.findFirst({ where: { ownerId: owner.id } });
    if (existing) {
      const updatedRoles = await this.ensureRoles(userId, roles, ['VENDOR_OWNER']);
      return { kind: 'VENDOR' as const, id: existing.id, created: false, roles: updatedRoles };
    }

    const vendor = await this.prisma.vendor.create({
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
    const updatedRoles = await this.ensureRoles(userId, roles, ['VENDOR_OWNER']);

    // A new business enters the manual approval queue — tell the reviewers,
    // or "we review within 24 hours" is a promise with no trigger (found
    // live: businesses sat PENDING_APPROVAL for weeks, unseen).
    if (this.notifications) {
      await notifyAdmins(this.prisma, this.notifications, {
        title: 'New business awaiting approval',
        body: `${vendor.name} (${business.vendorType.toLowerCase()}) just signed up and is waiting for review.`,
        data: { kind: 'vendor_pending', vendorId: vendor.id },
      });
    }

    return { kind: 'VENDOR' as const, id: vendor.id, created: true, roles: updatedRoles };
  }
}
