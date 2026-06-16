import { Prisma, type PrismaClient, type SubscriptionType, type VendorType } from '@prisma/client';
import { NotFoundError } from '../../utils/errors';
import { CountryConfigService } from '../country/country-config.service';

// ---------------------------------------------------------------------------
// SubscriptionService — a subscription is BORN as a 14-day free trial the
// moment a participant goes live (mover documents verified / vendor approved).
// That is the only entry point into billing (BillingService just charges what
// exists). Per-entity, idempotent. Cash-first: trials bill from the prepaid
// balance; a missed payment flows through the normal grace → suspend path.
// ---------------------------------------------------------------------------

const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const VENDOR_SUB_TYPE: Record<VendorType, SubscriptionType> = {
  RESTAURANT: 'RESTAURANT',
  SUPERMARKET: 'SUPERMARKET',
  STORE: 'RETAIL_STORE',
  SERVICE: 'SERVICE_PROVIDER',
};

export class SubscriptionService {
  private countryConfig: CountryConfigService;

  constructor(private prisma: PrismaClient) {
    this.countryConfig = new CountryConfigService(prisma);
  }

  async startTrialForRider(riderId: string) {
    const rider = await this.prisma.rider.findUnique({
      where: { id: riderId },
      select: {
        riderType: true,
        subscription: true,
        user: { select: { countryCode: true } },
      },
    });
    if (!rider) throw new NotFoundError('Rider', riderId);
    if (rider.subscription) return rider.subscription; // idempotent

    const tiers = await this.countryConfig.getSubscriptionTiers(rider.user.countryCode);
    const type: SubscriptionType = rider.riderType === 'COURIER' ? 'COURIER_RIDER' : 'DELIVERY_RIDER';
    return this.create({ riderId }, type, tiers.mover, rider.user.countryCode);
  }

  async startTrialForDriver(driverId: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: {
        subscription: true,
        user: { select: { countryCode: true } },
      },
    });
    if (!driver) throw new NotFoundError('Driver', driverId);
    if (driver.subscription) return driver.subscription;

    const tiers = await this.countryConfig.getSubscriptionTiers(driver.user.countryCode);
    return this.create({ driverId }, 'TAXI_DRIVER', tiers.mover, driver.user.countryCode);
  }

  async startTrialForVendor(vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: {
        vendorType: true,
        subscription: true,
        owner: { select: { user: { select: { countryCode: true } } } },
      },
    });
    if (!vendor) throw new NotFoundError('Vendor', vendorId);
    if (vendor.subscription) return vendor.subscription;

    const countryCode = vendor.owner.user.countryCode;
    const tiers = await this.countryConfig.getSubscriptionTiers(countryCode);
    return this.create({ vendorId }, VENDOR_SUB_TYPE[vendor.vendorType], tiers.smallVendor, countryCode);
  }

  private async create(
    entity: { riderId?: string; driverId?: string; vendorId?: string },
    type: SubscriptionType,
    weeklyRate: number,
    currencyCode: string,
  ) {
    const now = new Date();
    const trialEnd = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
    try {
      return await this.prisma.subscription.create({
        data: {
          ...entity,
          type,
          status: 'TRIAL',
          weeklyRate,
          currencyCode,
          billingMethod: 'CASH',
          isTrialActive: true,
          trialEndDate: trialEnd,
          currentPeriodStart: now,
          currentPeriodEnd: trialEnd,
          nextBillingDate: trialEnd,
        },
      });
    } catch (e) {
      // Concurrent create for the same entity — return the existing trial.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.prisma.subscription.findFirstOrThrow({ where: entity });
      }
      throw e;
    }
  }

  /**
   * Day-15 conversion: a trial whose 14 days have elapsed becomes ACTIVE and
   * immediately due, so the hourly billing cycle charges it next run. Returns
   * the number converted. Idempotent (only TRIAL rows past their end match).
   */
  async convertExpiredTrials(now = new Date()): Promise<number> {
    const res = await this.prisma.subscription.updateMany({
      where: { status: 'TRIAL', trialEndDate: { lte: now } },
      data: { status: 'ACTIVE', isTrialActive: false, nextBillingDate: now },
    });
    return res.count;
  }
}
