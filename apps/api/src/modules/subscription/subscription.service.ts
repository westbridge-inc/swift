import { Prisma, type PrismaClient, type Subscription, type SubscriptionType, type VendorType } from '@prisma/client';
import { NotFoundError } from '../../utils/errors';
import { CountryConfigService, partnerRateFor, type PartnerRate } from '../country/country-config.service';
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

type Db = PrismaClient | Prisma.TransactionClient;

/** The partner an activation path is about to make live. */
export type ActivationEntity = { riderId: string } | { driverId: string } | { vendorId: string };

/** What activating a partner would price: the subscription they already
 *  hold (nothing to price), or the type, market and rate a new trial is born on. */
type ActivationPricing =
  | { existing: Subscription }
  | { existing: null; type: SubscriptionType; priced: PartnerRate; countryCode: string };

export class SubscriptionService {
  private countryConfig: CountryConfigService;
  private trialLaw: TrialEntitlementService;

  constructor(private prisma: PrismaClient) {
    this.countryConfig = new CountryConfigService(prisma);
    this.trialLaw = new TrialEntitlementService(prisma);
  }

  // The three resolvers below read the partner and price them through THE
  // resolver — and are refused by it — exactly as the trial write is. They
  // write nothing, so the activation preflight and the trial itself cannot
  // disagree about a rate. `db` may be a caller's transaction.

  private async riderActivation(riderId: string, db: Db): Promise<ActivationPricing> {
    const rider = await db.rider.findUnique({
      where: { id: riderId },
      select: {
        riderType: true,
        vehicleType: true,
        subscription: true,
        user: { select: { countryCode: true } },
      },
    });
    if (!rider) throw new NotFoundError('Rider', riderId);
    if (rider.subscription) return { existing: rider.subscription };

    const tiers = await this.countryConfig.getSubscriptionTiers(rider.user.countryCode, db);
    const type: SubscriptionType = rider.riderType === 'COURIER' ? 'COURIER_RIDER' : 'DELIVERY_RIDER';
    // A rider's fee follows the VEHICLE, not the service: a canter doing
    // deliveries bills heavy delivery exactly like a canter doing courier work.
    const priced = partnerRateFor(tiers, { kind: 'RIDER', vehicleType: rider.vehicleType });
    return { existing: null, type, priced, countryCode: rider.user.countryCode };
  }

  private async driverActivation(driverId: string, db: Db): Promise<ActivationPricing> {
    const driver = await db.driver.findUnique({
      where: { id: driverId },
      select: {
        vehicleType: true,
        subscription: true,
        user: { select: { countryCode: true } },
      },
    });
    if (!driver) throw new NotFoundError('Driver', driverId);
    if (driver.subscription) return { existing: driver.subscription };

    const tiers = await this.countryConfig.getSubscriptionTiers(driver.user.countryCode, db);
    // A minibus driver is a taxi driver: where the market prices taxis apart
    // the role decides the fee, car or bus; otherwise the vehicle band does.
    const priced = partnerRateFor(tiers, { kind: 'DRIVER', vehicleType: driver.vehicleType });
    return { existing: null, type: 'TAXI_DRIVER', priced, countryCode: driver.user.countryCode };
  }

  private async vendorActivation(vendorId: string, db: Db): Promise<ActivationPricing> {
    const vendor = await db.vendor.findUnique({
      where: { id: vendorId },
      select: {
        vendorType: true,
        subscription: true,
        owner: {
          select: {
            user: { select: { countryCode: true } },
            _count: { select: { vendors: true } },
          },
        },
      },
    });
    if (!vendor) throw new NotFoundError('Vendor', vendorId);
    if (vendor.subscription) return { existing: vendor.subscription };

    const countryCode = vendor.owner.user.countryCode;
    const tiers = await this.countryConfig.getSubscriptionTiers(countryCode, db);
    // A brand-new store has no catalogue yet, so it is born on the small tier
    // and the weekly re-tier moves it up once its listings are counted. The
    // franchise basis IS known at signup, though: the owner's fifth store
    // should not spend its first week at the single-store price.
    const priced = partnerRateFor(tiers, {
      kind: 'VENDOR',
      isService: vendor.vendorType === 'SERVICE',
      activeListings: 0,
      ownedStores: vendor.owner._count.vendors,
    });
    return { existing: null, type: VENDOR_SUB_TYPE[vendor.vendorType], priced, countryCode };
  }

  private activation(entity: ActivationEntity, db: Db): Promise<ActivationPricing> {
    if ('riderId' in entity) return this.riderActivation(entity.riderId, db);
    if ('driverId' in entity) return this.driverActivation(entity.driverId, db);
    return this.vendorActivation(entity.vendorId, db);
  }

  /**
   * [PR1270-S2-03] The weekly rate an activation WOULD write — resolved and
   * refused exactly as `startTrialFor*` resolves it, but writing nothing.
   * Every activation path calls this BEFORE its first activation write, so a
   * market that cannot price a partner refuses the whole activation with
   * PRICING_CONFIG_INVALID instead of leaving an active, searchable partner
   * with no subscription. Null when the partner already holds a subscription:
   * nothing to price, nothing to block. `db` may be the caller's transaction
   * so the check rides its locks.
   */
  async priceForActivation(entity: ActivationEntity, db: Db = this.prisma): Promise<PartnerRate | null> {
    const activation = await this.activation(entity, db);
    return activation.existing ? null : activation.priced;
  }

  async startTrialForRider(riderId: string) {
    const activation = await this.riderActivation(riderId, this.prisma);
    if (activation.existing) return activation.existing; // idempotent
    return this.create({ riderId }, activation.type, activation.priced.rate, activation.countryCode);
  }

  async startTrialForDriver(driverId: string) {
    const activation = await this.driverActivation(driverId, this.prisma);
    if (activation.existing) return activation.existing;
    return this.create({ driverId }, activation.type, activation.priced.rate, activation.countryCode);
  }

  async startTrialForVendor(vendorId: string) {
    const activation = await this.vendorActivation(vendorId, this.prisma);
    if (activation.existing) return activation.existing;
    return this.create({ vendorId }, activation.type, activation.priced.rate, activation.countryCode);
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
    const sub = await this.createRow(entity, type, weeklyRate, currencyCode);
    // SAN at birth [san spec 2.4]: the number goes on welcome material so
    // it's familiar long before the first bill. Never blocks activation —
    // the ensureSan backstop on any later read heals a miss.
    try {
      const { ensureSan } = await import('../billing/san.service');
      const san = await ensureSan(this.prisma, sub.id);
      return { ...sub, san };
    } catch (e) {
      log().error({ err: e, subscriptionId: sub.id }, 'SAN assignment at activation failed — backstop will heal');
      return sub;
    }
  }

  private async createRow(
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
        // Every enforcement is explainable and appealable (Part 0.4/Part 4):
        // the billed-from-day-1 decision leaves its evidence row. Fraud/debt
        // paths already wrote theirs inside decide(); this covers the plain
        // consumed/active-elsewhere denials.
        if (decision.reason === 'TRIAL_CONSUMED' || decision.reason === 'TRIAL_ACTIVE_ELSEWHERE') {
          await this.prisma.enforcementAction.create({
            data: {
              accountId: human.userId,
              clusterId: decision.clusterId,
              level: 'DENY_TRIAL',
              reasonCode: decision.reason,
              signalsFired: [{ note: 'trial law at activation', role: human.role }] as never,
              decidedBy: 'SYSTEM',
            },
          }).catch(() => {});
        }
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
