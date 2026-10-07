import { bindTenantTransaction } from '../../plugins/prisma';
import { requireIdentityAuthority, IdentityReviewRequiredError, lockIdentityAuthority } from '../integrity/identity-review';
import { currentDunningClock, lockBillingAuthority } from '../billing/dunning-clock';
import { type Prisma, type PrismaClient, type Subscription, type SubscriptionType, type VendorType } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { ReviewDemoMoneyRefusedError } from '../review/demo-policy';
import { activateMoverFeeType, lockFeeCollectionAuthority, lockMoverFeeAuthority, lockMoverSources, moverFeeTariffSubject, resolveMoverFeeAuthority } from './mover-fee-authority';
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
        user: { select: { id: true, tenantId: true, countryCode: true } },
      },
    });
    if (!rider) throw new NotFoundError('Rider', riderId);
    const authority = await resolveMoverFeeAuthority(db, { userId: rider.user.id, tenantId: rider.user.tenantId });
    if (authority) return { existing: await db.subscription.findUniqueOrThrow({ where: { id: authority.canonicalSubscriptionId } }) };

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
        user: { select: { id: true, tenantId: true, countryCode: true } },
      },
    });
    if (!driver) throw new NotFoundError('Driver', driverId);
    const authority = await resolveMoverFeeAuthority(db, { userId: driver.user.id, tenantId: driver.user.tenantId });
    if (authority) {
      // A second role still preflights the tariff it is about to adopt.
      if (authority.feeType !== 'TAXI_DRIVER') {
        const tiers = await this.countryConfig.getSubscriptionTiers(driver.user.countryCode, db);
        partnerRateFor(tiers, { kind: 'DRIVER', vehicleType: driver.vehicleType });
      }
      return { existing: await db.subscription.findUniqueOrThrow({ where: { id: authority.canonicalSubscriptionId } }) };
    }

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
      // [#1393] One weekly fee per mover payer: the payer and every one of its
      // sources are locked (and ownership re-read) before the activation is read.
      const payer = 'vendorId' in entity ? null : await this.lockMoverPayer(entity, tx);
      const activation = await this.activation(entity, tx);
      const sub = payer && !('vendorId' in entity)
        ? await this.moverRow(entity, payer, activation, tx)
        : activation.existing ?? await this.createRow(entity, activation.type, activation.priced.rate, activation.currencyCode, tx, 'swift-default');
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

  /** [#1393 · mover fee authority] The payer and all of its mover sources,
   * locked in the common order, with the profile's owner re-read under the lock. */
  private async lockMoverPayer(entity: { riderId: string } | { driverId: string }, tx: Prisma.TransactionClient) {
    const profile = 'riderId' in entity
      ? await tx.rider.findUniqueOrThrow({ where: { id: entity.riderId }, select: { user: { select: { id: true, tenantId: true } } } })
      : await tx.driver.findUniqueOrThrow({ where: { id: entity.driverId }, select: { user: { select: { id: true, tenantId: true } } } });
    const payer = { userId: profile.user.id, tenantId: profile.user.tenantId };
    await lockMoverSources(tx, payer);
    const fresh = 'riderId' in entity
      ? await tx.rider.findUniqueOrThrow({ where: { id: entity.riderId }, select: { userId: true } })
      : await tx.driver.findUniqueOrThrow({ where: { id: entity.driverId }, select: { userId: true } });
    if (fresh.userId !== payer.userId) throw new AppError(409, 'MOVER_FEE_OWNERSHIP_INVALID', 'Mover ownership changed during activation.');
    return payer;
  }

  /** [#1393 · mover fee authority] A second role adopts the payer's canonical
   * subscription (a taxi activation re-tiers its future rate, with a record);
   * a new subscription is born on the trial law and joins the payer's fee authority. */
  private async moverRow(
    entity: { riderId: string } | { driverId: string }, payer: { userId: string; tenantId: string },
    activation: ActivationPricing, tx: Prisma.TransactionClient,
  ): Promise<Subscription> {
    if (activation.existing) {
      const authority = await activateMoverFeeType(tx, payer, 'driverId' in entity ? 'TAXI_DRIVER' : activation.existing.type);
      let sub = activation.existing;
      if (authority?.feeType === 'TAXI_DRIVER' && sub.customRate === null && !sub.feeWaived) {
        const tariff = await moverFeeTariffSubject(tx, authority);
        const tiers = await this.countryConfig.getSubscriptionTiers(tariff.countryCode, tx);
        const priced = partnerRateFor(tiers, tariff.subject);
        if (!sub.weeklyRate.equals(priced.rate)) {
          const from = Number(sub.weeklyRate);
          sub = await tx.subscription.update({ where: { id: sub.id }, data: { weeklyRate: priced.rate } });
          const seq = await tx.billingEvent.count({ where: { subscriptionId: sub.id, type: 'TIER_CHANGE' } }) + 1;
          await tx.billingEvent.create({ data: {
            subscriptionId: sub.id, type: 'TIER_CHANGE', amount: priced.rate, currencyCode: sub.currencyCode,
            idempotencyKey: `tier:${sub.id}:${seq}:${from}->${priced.rate}`,
            note: `Shared mover fee: taxi activation changes the future weekly rate from ${from} to ${priced.rate}; issued charges and periods retained.`,
          } });
        }
      }
      return sub;
    }
    const sub = await this.createRow(entity, activation.type, activation.priced.rate, activation.currencyCode, tx, payer.tenantId);
    await lockMoverFeeAuthority(tx, payer);
    return sub;
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
    tx: Prisma.TransactionClient, tenantId: string,
  ) {
    const human = await this.humanFor(entity, tx);
    // [REVIEW-PARTNER · DL-5] No weekly fee is ever born for the store-review fiction: it has no
    // money rail, so a subscription would only be a bill nobody can or should pay.
    if (await this.isFiction(entity, tx)) throw new ReviewDemoMoneyRefusedError();
    await requireIdentityAuthority(tx, human.userId);
    // decide also records explainable denials. Every read and write uses the
    // same locked transaction, so quarantine cannot race a punishment or grant.
    const law = new TrialEntitlementService(tx as PrismaClient);
    const decision = await law.decide(human.userId, human.role, tenantId);
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
      tenantId, trialDays: TRIAL_DAYS, exception: decision.reason === 'EXCEPTION_GRANT',
    });
    return sub;
  }

  /**
   * Day-15 conversion: a trial whose 14 days have elapsed becomes ACTIVE and
   * immediately due, so the hourly billing cycle charges it next run. Returns
   * the number converted. Idempotent (only TRIAL rows past their end match).
   */
  async convertExpiredTrials(now = new Date()): Promise<number> {
    const rows = await this.prisma.subscription.findMany({ where: { status: 'TRIAL', trialEndDate: { lte: now } }, select: { id: true } });
    let count = 0;
    for (const row of rows) {
      try {
        count += await this.prisma.$transaction(async (tx) => {
          if (!(await lockFeeCollectionAuthority(tx, row.id)).allowed) return 0;
          const { sub } = await lockBillingAuthority(tx, row.id);
          if (sub.status !== 'TRIAL' || !sub.trialEndDate || sub.trialEndDate > now) return 0;
          // Preserve the original obligation and time already paused before conversion.
          await tx.subscription.update({ where: { id: row.id }, data: { status: 'ACTIVE', isTrialActive: false } });
          await currentDunningClock(tx, row.id, now);
          return 1;
        });
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'MOVER_FEE_OWNERSHIP_INVALID') throw error;
        log().warn({ subscriptionId: row.id }, 'trial conversion held: original financial source has no valid payer');
      }
    }
    return count;
  }
}
