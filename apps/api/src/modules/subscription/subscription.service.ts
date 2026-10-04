import { bindTenantTransaction } from '../../plugins/prisma';
import { requireIdentityAuthority, IdentityReviewRequiredError, lockIdentityAuthority } from '../integrity/identity-review';
import { type Prisma, type PrismaClient, type Subscription, type SubscriptionType, type VendorType } from '@prisma/client';
import { NotFoundError } from '../../utils/errors';
import { ReviewDemoMoneyRefusedError } from '../review/demo-policy';
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
  | { existing: null; type: SubscriptionType; priced: PartnerRate; currencyCode: string };

export class SubscriptionService {
  private countryConfig: CountryConfigService;

  constructor(private prisma: PrismaClient) {
    this.countryConfig = new CountryConfigService(prisma);
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

    const countryCode = rider.user.countryCode;
    const tiers = await this.countryConfig.getSubscriptionTiers(countryCode, db);
    const type: SubscriptionType = rider.riderType === 'COURIER' ? 'COURIER_RIDER' : 'DELIVERY_RIDER';
    // A rider's fee follows the VEHICLE, not the service: a canter doing
    // deliveries bills heavy delivery exactly like a canter doing courier work.
    const priced = partnerRateFor(tiers, { kind: 'RIDER', vehicleType: rider.vehicleType });
    return { existing: null, type, priced, currencyCode: await this.countryConfig.getCurrencyCode(countryCode, db) };
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

    const countryCode = driver.user.countryCode;
    const tiers = await this.countryConfig.getSubscriptionTiers(countryCode, db);
    // A minibus driver is a taxi driver: where the market prices taxis apart
    // the role decides the fee, car or bus; otherwise the vehicle band does.
    const priced = partnerRateFor(tiers, { kind: 'DRIVER', vehicleType: driver.vehicleType });
    return { existing: null, type: 'TAXI_DRIVER', priced, currencyCode: await this.countryConfig.getCurrencyCode(countryCode, db) };
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
    return { existing: null, type: VENDOR_SUB_TYPE[vendor.vendorType], priced, currencyCode: await this.countryConfig.getCurrencyCode(countryCode, db) };
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
    // [REVIEW-PARTNER] The store-review fiction is never priced: it holds no subscription (createRow refuses it).
    if (await this.isFiction(entity, db)) return null;
    const activation = await this.activation(entity, db);
    if (!activation.existing) {
      const human = await this.humanFor(entity, db);
      await requireIdentityAuthority(db, human.userId);
    }
    return activation.existing ? null : activation.priced;
  }

  /** Activation, identity decision, subscription and caller projection commit
   * together. Acquire the identity lock before any account/profile row lock. */
  async withActivation<T>(entity: ActivationEntity, apply: (tx: Prisma.TransactionClient, sub: Subscription) => Promise<T>, db: Db = this.prisma): Promise<T> {
    const run = async (tx: Prisma.TransactionClient) => {
      await bindTenantTransaction(tx);
      await lockIdentityAuthority(tx);
      const activation = await this.activation(entity, tx);
      const sub = activation.existing ?? await this.createRow(entity, activation.type, activation.priced.rate, activation.currencyCode, tx);
      return apply(tx, sub);
    };
    return '$transaction' in db ? db.$transaction(run) : run(db);
  }

  async startTrialForRider(riderId: string, db?: Db) { return this.start({ riderId }, db); }
  async startTrialForDriver(driverId: string, db?: Db) { return this.start({ driverId }, db); }
  async startTrialForVendor(vendorId: string, db?: Db) { return this.start({ vendorId }, db); }

  private async start(entity: ActivationEntity, db: Db = this.prisma) {
    const sub = await this.withActivation(entity, async (_tx, row) => row, db);
    // A transaction caller defers SAN to its established read backstop.
    if (!('$transaction' in db)) return sub;
    try {
      const { ensureSan } = await import('../billing/san.service');
      return { ...sub, san: await ensureSan(this.prisma, sub.id) };
    } catch (err) {
      log().error({ err, subscriptionId: sub.id }, 'SAN assignment at activation failed — backstop will heal');
      return sub;
    }
  }

  /** [REVIEW-PARTNER] Is the partner behind this entity an account of the store-review fiction? (Read in `db`.) */
  async isFiction(entity: ActivationEntity, db: Db = this.prisma): Promise<boolean> {
    const human = await this.humanFor(entity, db);
    const rows = await db.$queryRaw<Array<{ kind: string }>>`
      SELECT t."kind"::text AS "kind" FROM "users" u JOIN "tenants" t ON t."id" = u."tenantId" WHERE u."id" = ${human.userId}`;
    return rows[0]?.kind === 'REVIEW';
  }

  /** The human behind the entity + their trial-law role (§3: the trial
   *  belongs to the human, not the account or the entity). */
  private async humanFor(entity: { riderId?: string; driverId?: string; vendorId?: string }, db: Db = this.prisma): Promise<{ userId: string; role: string }> {
    if (entity.riderId) {
      const r = await db.rider.findUniqueOrThrow({ where: { id: entity.riderId }, select: { userId: true } });
      return { userId: r.userId, role: 'RIDER' };
    }
    if (entity.driverId) {
      const d = await db.driver.findUniqueOrThrow({ where: { id: entity.driverId }, select: { userId: true } });
      return { userId: d.userId, role: 'DRIVER' };
    }
    const v = await db.vendor.findUniqueOrThrow({
      where: { id: entity.vendorId! },
      select: { owner: { select: { userId: true } } },
    });
    return { userId: v.owner.userId, role: 'VENDOR' };
  }

  private async createRow(
    entity: ActivationEntity, type: SubscriptionType, weeklyRate: number, currencyCode: string,
    tx: Prisma.TransactionClient,
  ) {
    const human = await this.humanFor(entity, tx);
    // [REVIEW-PARTNER · DL-5] No weekly fee is ever born for the store-review fiction: it has no
    // money rail, so a subscription would only be a bill nobody can or should pay.
    if (await this.isFiction(entity, tx)) throw new ReviewDemoMoneyRefusedError();
    await requireIdentityAuthority(tx, human.userId);
    // decide also records explainable denials. Every read and write uses the
    // same locked transaction, so quarantine cannot race a punishment or grant.
    const law = new TrialEntitlementService(tx as PrismaClient);
    const decision = await law.decide(human.userId, human.role, 'swift-default');
    if (!decision.grant && decision.reason === 'REVIEW_REQUIRED') throw new IdentityReviewRequiredError();
    const now = new Date();
    const end = decision.grant ? new Date(now.getTime() + TRIAL_DAYS * DAY_MS) : now;
    if (!decision.grant && (decision.reason === 'TRIAL_CONSUMED' || decision.reason === 'TRIAL_ACTIVE_ELSEWHERE')) {
      await tx.enforcementAction.create({ data: {
        accountId: human.userId, clusterId: decision.clusterId, level: 'DENY_TRIAL', reasonCode: decision.reason,
        signalsFired: [{ note: 'trial law at activation', role: human.role }] as never, decidedBy: 'SYSTEM',
      } });
    }
    const sub = await tx.subscription.create({ data: {
      ...entity, type, weeklyRate, currencyCode, billingMethod: 'CASH', currentPeriodStart: now,
      status: decision.grant ? 'TRIAL' : 'ACTIVE', isTrialActive: decision.grant,
      trialEndDate: end, currentPeriodEnd: end, nextBillingDate: end,
    } });
    if (decision.grant) await law.recordGrant(tx, {
      accountId: human.userId, clusterId: decision.clusterId, role: human.role,
      tenantId: 'swift-default', trialDays: TRIAL_DAYS, exception: decision.reason === 'EXCEPTION_GRANT',
    });
    return sub;
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
