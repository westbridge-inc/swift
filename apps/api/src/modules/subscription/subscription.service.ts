import { Prisma, type PrismaClient, type SubscriptionType, type VendorType } from '@prisma/client';
import { NotFoundError } from '../../utils/errors';
import { CountryConfigService } from '../country/country-config.service';
import { TrialEntitlementService } from '../integrity/trial-entitlement.service';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// SubscriptionService — a subscription is BORN as a 14-day free trial the
// moment a participant goes live (mover documents verified / vendor approved).
// That is the only entry point into billing (BillingService just charges what
// exists). Per-entity, idempotent. Cash-first: trials bill from the prepaid
// balance; a missed payment flows through the normal grace → suspend path.
// ---------------------------------------------------------------------------

export const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const VENDOR_SUB_TYPE: Record<VendorType, SubscriptionType> = {
  RESTAURANT: 'RESTAURANT',
  SUPERMARKET: 'SUPERMARKET',
  STORE: 'RETAIL_STORE',
  SERVICE: 'SERVICE_PROVIDER',
};

export class SubscriptionService {
  private countryConfig: CountryConfigService;
  private trialLaw: TrialEntitlementService;

  constructor(private prisma: PrismaClient) {
    this.countryConfig = new CountryConfigService(prisma);
    this.trialLaw = new TrialEntitlementService(prisma);
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

  /** The human behind the entity + their trial-law role (§3: the trial
   *  belongs to the human, not the account or the entity). */
  private async humanFor(entity: { riderId?: string; driverId?: string; vendorId?: string }): Promise<{ userId: string; role: string }> {
    if (entity.riderId) {
      const r = await this.prisma.rider.findUniqueOrThrow({ where: { id: entity.riderId }, select: { userId: true } });
      return { userId: r.userId, role: 'RIDER' };
    }
    if (entity.driverId) {
      const d = await this.prisma.driver.findUniqueOrThrow({ where: { id: entity.driverId }, select: { userId: true } });
      return { userId: d.userId, role: 'DRIVER' };
    }
    const v = await this.prisma.vendor.findUniqueOrThrow({
      where: { id: entity.vendorId! },
      select: { owner: { select: { userId: true } } },
    });
    return { userId: v.owner.userId, role: 'VENDOR' };
  }

  private async create(
    entity: { riderId?: string; driverId?: string; vendorId?: string },
    type: SubscriptionType,
    weeklyRate: number,
    currencyCode: string,
  ) {
    const now = new Date();
    const trialEnd = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
    const base = {
      ...entity,
      type,
      weeklyRate,
      currencyCode,
      billingMethod: 'CASH' as const,
      currentPeriodStart: now,
    };

    // Trial law (§3.2): decide() is the only authority on trials. A denied
    // human still activates — BILLED FROM DAY 1 (same shape the day-15
    // conversion produces, so the hourly billing cycle charges it next run).
    const human = await this.humanFor(entity);
    const decision = await this.trialLaw.decide(human.userId, human.role, 'swift-default');

    const billedFromDayOne = () =>
      this.prisma.subscription.create({
        data: { ...base, status: 'ACTIVE', isTrialActive: false, trialEndDate: now, currentPeriodEnd: now, nextBillingDate: now },
      });

    try {
      if (!decision.grant) {
        log().info({ userId: human.userId, role: human.role, reason: decision.reason }, 'trial denied by entitlement law — subscription born billed');
        return await billedFromDayOne();
      }
      // Grant + subscription in ONE transaction (§3.1) — the TrialGrant unique
      // is the last line of defense when the same human activates twice at once.
      return await this.prisma.$transaction(async (tx) => {
        const sub = await tx.subscription.create({
          data: { ...base, status: 'TRIAL', isTrialActive: true, trialEndDate: trialEnd, currentPeriodEnd: trialEnd, nextBillingDate: trialEnd },
        });
        await this.trialLaw.recordGrant(tx, {
          accountId: human.userId,
          clusterId: decision.clusterId,
          role: human.role,
          tenantId: 'swift-default',
          trialDays: TRIAL_DAYS,
          exception: decision.reason === 'EXCEPTION_GRANT',
        });
        return sub;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const target = String((e.meta as { target?: unknown } | undefined)?.target ?? '');
        // Scenario I — the partial ACTIVE-grant unique lost the race: this
        // activation gets no second trial; it is born billed. Never a dead end.
        if (target.includes('trial_grants_one_active') || target.includes('clusterId')) {
          log().warn({ userId: human.userId, role: human.role }, 'trial-grant race lost — activating billed from day 1');
          return billedFromDayOne();
        }
        // Concurrent create for the same entity — return the existing row.
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
