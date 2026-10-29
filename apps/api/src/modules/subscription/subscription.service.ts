import { bindTenantTransaction } from '../../plugins/prisma';
import { requireIdentityAuthority, IdentityReviewRequiredError, lockIdentityAuthority } from '../integrity/identity-review';
import { currentDunningClock, lockBillingAuthority } from '../billing/dunning-clock';
import { lockVendorActivationBilling } from '../billing/billing-access';
import { holdFeeRiseInTx } from '../billing/fee-rise-notice';
import { type Prisma, type PrismaClient, type Subscription, type SubscriptionType, type VendorType } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { accountErasedUnderLock } from '../user/account-closure';
import { ReviewDemoMoneyRefusedError } from '../review/demo-policy';
import { activateMoverFeeType, lockFeeCollectionAuthority, lockMoverFeeAuthority, lockMoverSources, moverFeeTariffSubject, resolveMoverFeeAuthority } from './mover-fee-authority';
import { CountryConfigService, partnerRateFor, type PartnerRate } from '../country/country-config.service';
import { TrialEntitlementService } from '../integrity/trial-entitlement.service';
import { previewTrial } from '../integrity/enforcement';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// SubscriptionService — a subscription is BORN as a 14-day free trial the
// moment a participant goes live (mover documents verified / vendor approved).
// That is the only entry point into billing (BillingService just charges what
// exists). Per-entity, idempotent. Cash-first: trials bill from the prepaid
// balance; a missed payment flows through the normal grace → suspend path.
// ---------------------------------------------------------------------------

export const TRIAL_DAYS = 14;
/** The trial ledger tenant every store's trial grant is written under (withActivation -> createRow). */
export const STORE_TRIAL_TENANT = 'swift-default';
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
          },
        },
      },
    });
    if (!vendor) throw new NotFoundError('Vendor', vendorId);
    if (vendor.subscription) return { existing: vendor.subscription };

    const countryCode = vendor.owner.user.countryCode;
    const tiers = await this.countryConfig.getSubscriptionTiers(countryCode, db);
    // A brand-new store has no catalogue yet, so it is born on the small tier
    // and the weekly re-tier moves it up once its listings are counted. Each
    // store is its own account with its own tier: how many other stores its
    // owner has never changes its price (owner, 13 Oct 2026).
    const priced = partnerRateFor(tiers, {
      kind: 'VENDOR',
      isService: vendor.vendorType === 'SERVICE',
      activeListings: 0,
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
      // [#1879 S3-3 · REVIEW-G R1] No activation write for an erased account. The person's users row is locked
      // here (a mover's already is, by lockMoverPayer), so an erasure either commits its cut-off first and this
      // refuses, or waits behind this transaction and its wind-down then cancels what was written.
      if (await accountErasedUnderLock(tx, payer?.userId ?? (await this.humanFor(entity, tx)).userId)) {
        throw new AppError(409, 'ACCOUNT_CLOSED', 'This account has been deleted. Nothing can be activated for it.');
      }
      const activation = await this.activation(entity, tx);
      const sub = payer && !('vendorId' in entity)
        ? await this.moverRow(entity, payer, activation, tx)
        : activation.existing ?? await this.createRow(entity, activation.type, activation.priced.rate, activation.currencyCode, tx, STORE_TRIAL_TENANT);
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
        // [REVIEW-G #1844 S3-1 · COORD 17 Oct 23:41Z · GUARDRAILS §7 standing rule 2] A fee the
        // mover has already paid a week at is never raised at once: a higher taxi card rate is HELD
        // for the 14-day fee-change notice (F2, billing/fee-rise-notice.ts), told and applied only
        // from the weekly fee it was told for. Before any paid week (a trial) the role they activate
        // prices the first fee, in either activation order.
        const from = Number(sub.weeklyRate);
        const paidAtRate = priced.rate > from && !!await tx.subscriptionPayment.findFirst({
          where: { subscriptionId: sub.id, status: 'CAPTURED', amount: { gt: 0 } }, select: { id: true } });
        // [REVIEW-M #1844 S4-1] A paid weekly rate of 0 or less is legacy or hand-made data: never kept
        // as the floor, nor raised at once to the taxi rate. The activation is refused (loudly: the approval
        // outbox retries it with backoff, then dead-letters it to the admin page) until finance corrects it.
        if (paidAtRate && !(from > 0)) {
          throw new AppError(409, 'MOVER_FEE_FINANCE_ACTION_REQUIRED', 'This mover\'s weekly fee on record is 0 or less; finance must correct it before the taxi role is added.', { reason: 'LEGACY_RATE_NOT_POSITIVE' });
        }
        const nextRate = paidAtRate ? from : priced.rate;
        if (paidAtRate) {
          await holdFeeRiseInTx(tx, { subscriptionId: sub.id, from, to: priced.rate, currencyCode: sub.currencyCode, source: 'TAXI_ACTIVATION', now: new Date() });
        }
        if (nextRate !== from) {
          sub = await tx.subscription.update({ where: { id: sub.id }, data: { weeklyRate: nextRate } });
          const seq = await tx.billingEvent.count({ where: { subscriptionId: sub.id, type: 'TIER_CHANGE' } }) + 1;
          await tx.billingEvent.create({ data: {
            subscriptionId: sub.id, type: 'TIER_CHANGE', amount: nextRate, currencyCode: sub.currencyCode,
            idempotencyKey: `tier:${sub.id}:${seq}:${from}->${nextRate}`,
            note: `Shared mover fee: taxi activation changes the future weekly rate from ${from} to ${nextRate}; issued charges and periods retained.`,
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
    // [CHAINS · owner 29 Oct 2026] A store whose owner ALREADY holds a running store trial of their own (ordinary
    // or a founder exception's) is a branch of that owner: it shares the running trial (same end day) while another
    // of the owner's stores is in it, and is billed from approval after. Never a fresh 14 days, never a second
    // grant (REVIEW-M #2211 S3-2: a second exception grant for the same account collides with the first). Only an
    // account with no running trial of its own may be granted one (FIRST_TRIAL, or a founder exception).
    // FIRST_TRIAL means the cluster holds no store trial at all, so there is no own trial to share.
    const vendorTrialOpen = 'vendorId' in entity && (decision.reason === 'EXCEPTION_GRANT' || decision.reason === 'TRIAL_ACTIVE_ELSEWHERE');
    const ownGrant = vendorTrialOpen ? await ownRunningStoreTrial(tx, human.userId, tenantId, now) : null;
    const branchOf = ownGrant && 'vendorId' in entity ? await tx.vendor.findUnique({ where: { id: entity.vendorId }, select: { ownerId: true } }) : null;
    const shared = ownGrant && branchOf && 'vendorId' in entity
      ? await sharedChainTrialEnd(tx, { ownerId: branchOf.ownerId, exceptVendorId: entity.vendorId, grantEndsAt: ownGrant.endsAt, now })
      : null;
    // [REVIEW-M #2211 S3-2 residue] An exception gives a store trial only to an account that holds no ACTIVE store
    // trial grant of its own. A grant row stays ACTIVE past its end (nothing flips it), so an owner whose own trial
    // ENDED would otherwise be granted again: a second VENDOR:EX row collides with the first (the branch could never
    // be approved), and an ordinary ended trial would turn into a fresh 14 days. Branches added after the owner's
    // trial pay from approval. [REVIEW-G/M #2211 S4-1] A grant spent by churn (CONSUMED) is not counted: a live
    // founder exception may still give a returning owner a trial, exactly as before this change.
    const ownEver = vendorTrialOpen && decision.reason === 'EXCEPTION_GRANT' && !ownGrant
      ? await tx.trialGrant.findFirst({
        where: { tenantId, accountId: human.userId, role: { in: ['VENDOR', `VENDOR:EX:${human.userId}`] }, status: 'ACTIVE' },
        select: { id: true },
      })
      : null;
    const fresh = decision.grant && !ownGrant && !ownEver;
    const trial = fresh || shared !== null;
    const end = fresh ? new Date(now.getTime() + TRIAL_DAYS * DAY_MS) : shared ?? now;
    if (!trial && !decision.grant && (decision.reason === 'TRIAL_CONSUMED' || decision.reason === 'TRIAL_ACTIVE_ELSEWHERE')) {
      await tx.enforcementAction.create({ data: {
        accountId: human.userId, clusterId: decision.clusterId, level: 'DENY_TRIAL', reasonCode: decision.reason,
        signalsFired: [{ note: 'trial law at activation', role: human.role }] as never, decidedBy: 'SYSTEM',
      } });
    }
    // [CHAINS] The owner's chain deal, when it is not above this store's own fee (it never raises a fee). Read under
    // the settlement locks a deal is written under (setChainDeal), so a branch activated while a deal is being set
    // is born on it or waits for it (REVIEW-M #2211 S4-4).
    if ('vendorId' in entity) await lockVendorActivationBilling(tx, human.userId);
    const deal = 'vendorId' in entity ? await chainDealFor(tx, entity.vendorId, weeklyRate, currencyCode) : null;
    const sub = await tx.subscription.create({ data: {
      ...entity, type, weeklyRate, currencyCode, billingMethod: 'CASH', currentPeriodStart: now,
      status: trial ? 'TRIAL' : 'ACTIVE', isTrialActive: trial,
      trialEndDate: end, currentPeriodEnd: end, nextBillingDate: end,
      ...(deal !== null ? { customRate: deal } : {}),
    } });
    // [REVIEW-M #2211 S4-3] A branch born on its owner's chain deal says so in its fee history.
    if (deal !== null && deal < weeklyRate) await tx.billingEvent.create({ data: {
      subscriptionId: sub.id, type: 'TIER_CHANGE', amount: deal, currencyCode,
      idempotencyKey: `chaindeal:${sub.id}:born:${weeklyRate}->${deal}`,
      note: `Chain deal: this store starts on its owner's negotiated weekly fee ${deal} (its own fee is ${weeklyRate}).`,
    } });
    if (fresh) await law.recordGrant(tx, {
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

/** [CHAINS] The trial grant this account is running for its stores, if any: its own ordinary VENDOR grant or a founder
 *  exception's (`VENDOR:EX:<account>`), ACTIVE and not past its end. Any cluster: a merge can move it. */
export async function ownRunningStoreTrial(
  db: Prisma.TransactionClient | PrismaClient, userId: string, tenantId: string, now: Date,
): Promise<{ endsAt: Date } | null> {
  return db.trialGrant.findFirst({
    where: { tenantId, accountId: userId, role: { in: ['VENDOR', `VENDOR:EX:${userId}`] }, status: 'ACTIVE', endsAt: { gt: now } },
    orderBy: { endsAt: 'asc' },
    select: { endsAt: true },
  });
}

/**
 * [CHAINS · owner 29 Oct 2026: "shared chain trial"] A store added to a chain while the owner's free trial runs shares
 * that trial: it ends when the trial does. The caller has found the owner's OWN running store trial (ownRunningStoreTrial);
 * this finds another store of the SAME owner in a live trial now, and answers the earlier of that store's trial end and
 * the grant's own end (a branch never outlives the trial), or null (no store is in the trial: billed from approval).
 */
export async function sharedChainTrialEnd(
  tx: Prisma.TransactionClient | PrismaClient,
  input: { ownerId: string; exceptVendorId?: string; grantEndsAt: Date; now: Date },
): Promise<Date | null> {
  const sibling = await tx.subscription.findFirst({
    where: {
      vendor: { ownerId: input.ownerId }, ...(input.exceptVendorId ? { vendorId: { not: input.exceptVendorId } } : {}),
      status: 'TRIAL', isTrialActive: true, trialEndDate: { gt: input.now },
    },
    orderBy: { trialEndDate: 'asc' },
    select: { trialEndDate: true },
  });
  if (!sibling?.trialEndDate) return null;
  return sibling.trialEndDate < input.grantEndsAt ? sibling.trialEndDate : input.grantEndsAt;
}

/** [CHAINS] The owner's chain deal for a store about to be priced: the deal when it is in the same currency, else null.
 *  It is the store's custom rate, which is never charged above the store's own tier rate (weeklyFeeFor). */
export async function chainDealFor(
  db: Prisma.TransactionClient | PrismaClient, vendorId: string, weeklyRate: number, currencyCode: string,
): Promise<number | null> {
  const store = await db.vendor.findUnique({ where: { id: vendorId }, select: { owner: { select: { dealWeeklyRate: true, dealCurrencyCode: true } } } });
  const deal = store?.owner.dealWeeklyRate;
  if (deal === null || deal === undefined || store?.owner.dealCurrencyCode !== currencyCode) return null;
  // A standing rule (REVIEW-G/M #2211 S3-1): the branch is born on the deal even when its own tier fee is lower today;
  // the biller charges the lower of the two (weeklyFeeFor), so it never pays more than either.
  const rate = Number(deal);
  return rate > 0 ? rate : null;
}

/**
 * [CHAINS] The told-before read for the add-a-branch screen: the day a branch approved NOW would end its shared
 * trial, or null when it would be billed from approval. Reads only. The same conditions as sharedChainTrialEnd, read
 * through the trial law's own preview (a held or owing cluster shares nothing); activation decides again.
 */
export async function chainTrialPreview(prisma: PrismaClient, userId: string, now: Date): Promise<Date | null> {
  const owner = await prisma.vendorOwner.findUnique({ where: { userId }, select: { id: true } });
  if (!owner) return null;
  // Store trials live in the default tenant's trial ledger: withActivation creates every store's row there.
  const law = await previewTrial(prisma, userId, 'VENDOR', STORE_TRIAL_TENANT);
  if (law.reason !== 'TRIAL_ACTIVE_ELSEWHERE' && law.reason !== 'EXCEPTION_GRANT') return null;
  const own = await ownRunningStoreTrial(prisma, userId, STORE_TRIAL_TENANT, now);
  if (!own) return null;
  return sharedChainTrialEnd(prisma, { ownerId: owner.id, grantEndsAt: own.endsAt, now });
}
