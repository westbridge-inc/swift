import type { PrismaClient, Subscription, Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { getChannels } from '../../providers/notifications/channels';
import { CountryConfigService } from '../country/country-config.service';
import type { PaymentProvider } from '../../providers/payment/payment-provider';
import { getMmgProvider } from '../../providers/mmg/mmg-provider';
import { convertUsdToLocal } from './fx';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// BillingService — the one place V1 touches money: Swift's own weekly fee.
// Deterministic code only (hard rule 1). Every money event lands in the
// append-only BillingEvent log; the unique idempotencyKey is the DB-level
// double-charge guard, safe under concurrent job runs.
// ---------------------------------------------------------------------------

const MAX_FAILED_ATTEMPTS = 3;
const RETRY_HOURS = 24;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** USD pricing (System 2): the run-scoped context — one rate, one book. */
interface UsdPricingCtx {
  rateId: string;
  rate: number;
  increment: number;
  currency: string;
  book: Map<string, number>; // `${role}|${tier ?? ''}` → amountUsd
}

/** SubscriptionType → price-book role. Tier = the subscription type itself. */
const SUB_TYPE_TRIAL_ROLE: Record<string, string> = {
  RESTAURANT: 'VENDOR',
  SUPERMARKET: 'VENDOR',
  RETAIL_STORE: 'VENDOR',
  SERVICE_PROVIDER: 'SERVICE',
  DELIVERY_RIDER: 'RIDER',
  COURIER_RIDER: 'RIDER',
  TAXI_DRIVER: 'DRIVER',
};
/** §11 — how long a subscription may sit SUSPENDED before it goes CHURNED
 *  (terminal: dunning stops, the daily MMG re-request stops; paying rejoins). */
const suspensionMaxDays = () => {
  const v = Number(process.env['BILLING_SUSPENSION_MAX_DAYS']);
  return Number.isFinite(v) && v > 0 ? v : 30;
};
/** Catalogue size (active listings) at which a vendor moves to the large tier —
 *  1000+ items. Config can override per country. */
const DEFAULT_LARGE_CATALOGUE_THRESHOLD = 1000;

type SubWithRelations = Subscription & {
  rider: { userId: string } | null;
  driver: { userId: string } | null;
  vendor: { id: string; owner: { userId: string } } | null;
};

export interface BillingCycleResult {
  processed: number;
  succeeded: number;
  failed: number;
  suspended: number;
  skipped: number;
  errors: number;
  /** MMG merchant-initiated requests awaiting the payer's phone approval */
  pending: number;
}

export class BillingService {
  private countryConfig: CountryConfigService;

  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
    private payments: PaymentProvider,
  ) {
    this.countryConfig = new CountryConfigService(prisma);
  }

  // -------------------------------------------------------------------------
  // The weekly cycle
  // -------------------------------------------------------------------------

  /** Bill everything due. One subscription's failure never kills the batch. */
  async runBillingCycle(now = new Date()): Promise<BillingCycleResult> {
    const due = await this.prisma.subscription.findMany({
      where: {
        autoRenew: true,
        OR: [
          // ACTIVE respects nextRetryAt too [debug-ledger P2]: an in-flight
          // MMG request parks the sub ACTIVE with a future retry stamp — the
          // hourly cycle must not re-initiate the same week while it pends.
          {
            status: 'ACTIVE',
            nextBillingDate: { lte: now },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
          // Failed charges retry daily, while due — including SUSPENDED, so a
          // top-up between runs gets picked up even without the instant path
          { status: { in: ['PAST_DUE', 'SUSPENDED'] }, nextRetryAt: { lte: now } },
        ],
      },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
    });

    const result: BillingCycleResult = { processed: 0, succeeded: 0, failed: 0, suspended: 0, skipped: 0, errors: 0, pending: 0 };

    // USD pricing (Part 20): ONE rate per billing run, resolved here and
    // stamped on every charge this run creates. Null = flag off → legacy.
    const usd = await this.loadUsdPricing();

    for (const sub of due) {
      result.processed += 1;
      try {
        const outcome = await this.billSubscription(sub as SubWithRelations, now, usd);
        result[outcome] += 1;
      } catch {
        // Partial failure mid-batch: record and continue
        result.errors += 1;
      }
    }

    return result;
  }

  /**
   * Bill one subscription. Idempotent: the CHARGE_ATTEMPT event's unique key
   * (subscription + period + retry level) makes a second concurrent or
   * repeated run a no-op at the database level.
   */
  async billSubscription(
    sub: SubWithRelations,
    now = new Date(),
    /** USD pricing context — pass the RUN's context from runBillingCycle;
     *  single-charge callers may pass undefined to resolve fresh. */
    usdCtx?: UsdPricingCtx | null,
  ): Promise<'succeeded' | 'failed' | 'suspended' | 'skipped' | 'pending'> {
    const periodKey = sub.nextBillingDate.toISOString().slice(0, 10);
    const attemptKey = `charge:${sub.id}:${periodKey}:a${sub.failedAttempts}`;
    const usd = usdCtx === undefined ? await this.loadUsdPricing() : usdCtx;
    const priced = this.priceFor(sub, usd);

    try {
      await this.prisma.billingEvent.create({
        data: {
          subscriptionId: sub.id,
          type: 'CHARGE_ATTEMPT',
          amount: priced.amount,
          currencyCode: sub.currencyCode,
          idempotencyKey: attemptKey,
          ...(priced.usdTrio ?? {}),
        },
      });
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        return 'skipped'; // someone (or a concurrent run) already attempted this
      }
      throw error;
    }

    const amount = Number(priced.amount);

    // Waived subscriptions advance for free, with the audit trail intact
    if (sub.feeWaived || amount === 0) {
      await this.applySuccessfulCharge(sub, 0, 'fee-waived', now, periodKey);
      // A waive covers ONE period — the admin notice promises "for this period".
      // Clear it so normal billing resumes next cycle instead of a permanent free
      // ride (silent, recurring revenue loss). A genuinely $0 tier (amount===0,
      // feeWaived false) is NOT a waive and stays free.
      if (sub.feeWaived) {
        await this.prisma.subscription.update({ where: { id: sub.id }, data: { feeWaived: false } });
      }
      return 'succeeded';
    }

    const charged = await this.attemptCharge(sub, amount);

    if (charged.ok) {
      // A guard-detected late approval settles the ORIGINAL pending row in place
      // (settlePaymentId); a fresh success creates its own CAPTURED row.
      await this.applySuccessfulCharge(
        sub, amount, charged.ref, now, periodKey,
        'settlePaymentId' in charged ? charged.settlePaymentId : undefined,
        priced.usdTrio,
      );
      return 'succeeded';
    }

    if ('deferred' in charged) {
      // SWIFT-004: a prior MMG request for this period is still live at MMG (or
      // MMG is unreachable). Don't create a second request/row — re-attach the
      // poller to the original and push the retry clock; the poller settles a
      // late approval or duns a genuine expiry on a later tick, never a duplicate.
      if (charged.reopenPaymentId) {
        await this.prisma.subscriptionPayment.updateMany({
          where: { id: charged.reopenPaymentId, status: 'FAILED' },
          data: { status: 'PENDING' },
        });
      }
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { nextRetryAt: new Date(now.getTime() + RETRY_HOURS * 60 * 60 * 1000) },
      });
      return 'pending';
    }

    if ('pendingTx' in charged) {
      // MMG merchant-initiated: the request is on the payer's phone. Record
      // the in-flight payment; the poller settles it either way. The retry
      // clock still advances so an ignored request becomes tomorrow's dunning
      // attempt instead of a same-hour duplicate ping.
      await this.prisma.subscriptionPayment.create({
        data: {
          subscriptionId: sub.id,
          amount,
          status: 'PENDING',
          paymentMethod: sub.billingMethod,
          externalRef: charged.pendingTx,
          periodStart: sub.nextBillingDate,
          periodEnd: new Date(sub.nextBillingDate.getTime() + WEEK_MS),
        },
      });
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { nextRetryAt: new Date(now.getTime() + RETRY_HOURS * 60 * 60 * 1000) },
      });
      await this.notifications.send({
        userId: this.payerUserId(sub),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Approve your weekly fee in MMG',
        body: `We sent an MMG request for $${amount.toLocaleString()} ${sub.currencyCode}. Approve it on your phone to stay active.`,
        audience: this.payerAudience(sub),
        data: { kind: 'billing_mmg_pending', subscriptionId: sub.id },
      });
      return 'pending';
    }

    return this.applyFailedCharge(sub, amount, charged.reason, now, periodKey);
  }

  private amountFor(sub: Subscription): Prisma.Decimal | number {
    return sub.customRate ?? sub.weeklyRate;
  }

  /** USD pricing (System 2 ②): the run-scoped pricing context — ONE FxRate +
   *  the active price book, resolved at job start and stamped on every charge
   *  the run creates (acceptance #16). Null = flag off → legacy behavior,
   *  byte-identical. */
  private async loadUsdPricing(): Promise<UsdPricingCtx | null> {
    const tenant = await this.prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' } });
    if (!tenant?.usdPricingEnabled) return null;
    const { resolveRateForRun } = await import('./fx');
    const rate = await resolveRateForRun(this.prisma, tenant.settlementCurrency);
    if (!rate) {
      log().warn({ currency: tenant.settlementCurrency }, 'usd pricing enabled but NO FX rate exists — billing falls back to legacy local rates');
      return null;
    }
    const entries = await this.prisma.priceBookEntry.findMany({ where: { active: true } });
    const book = new Map<string, number>();
    for (const e of entries) book.set(`${e.role}|${e.tier ?? ''}`, Number(e.amountUsd));
    return {
      rateId: rate.id,
      rate: Number(rate.rate),
      increment: Number(tenant.roundingIncrement),
      currency: tenant.settlementCurrency,
      book,
    };
  }

  /** The pinned trio from this period's charge attempt — recovered for late
   *  settles (MMG poll) so a moved rate can never touch an issued charge. */
  private async pinnedTrioFor(subscriptionId: string, periodKey: string): Promise<{ amountUsd: number; fxRateId: string; fxRateUsed: number } | undefined> {
    const attempt = await this.prisma.billingEvent.findFirst({
      where: { subscriptionId, type: 'CHARGE_ATTEMPT', idempotencyKey: { startsWith: `charge:${subscriptionId}:${periodKey}` }, amountUsd: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { amountUsd: true, fxRateId: true, fxRateUsed: true },
    });
    if (!attempt?.amountUsd || !attempt.fxRateId || !attempt.fxRateUsed) return undefined;
    return { amountUsd: Number(attempt.amountUsd), fxRateId: attempt.fxRateId, fxRateUsed: Number(attempt.fxRateUsed) };
  }

  /** Price one subscription under the context. customRate (an explicit local
   *  override) and any missing book entry keep the LEGACY local amount with a
   *  loud log — pricing never blocks billing. */
  private priceFor(sub: Subscription, usd: UsdPricingCtx | null): { amount: Prisma.Decimal | number; usdTrio?: { amountUsd: number; fxRateId: string; fxRateUsed: number } } {
    if (!usd || sub.customRate) return { amount: this.amountFor(sub) };
    const role = SUB_TYPE_TRIAL_ROLE[sub.type] ?? 'VENDOR';
    const amountUsd = usd.book.get(`${role}|${sub.type}`) ?? usd.book.get(`${role}|`);
    if (amountUsd === undefined) {
      log().warn({ subscriptionId: sub.id, type: sub.type }, 'usd pricing: no price-book entry — legacy local rate used');
      return { amount: this.amountFor(sub) };
    }
    const converted = convertUsdToLocal(amountUsd, usd.rate, usd.increment);
    if (converted.minClamped) {
      log().warn({ subscriptionId: sub.id, amountUsd }, 'usd pricing: MIN_CLAMPED — local amount clamped to one increment');
    }
    return { amount: converted.amountLocal, usdTrio: { amountUsd, fxRateId: usd.rateId, fxRateUsed: usd.rate } };
  }

  /** Prepaid balance settles FIRST (money already in hand); otherwise CARD
   *  charges the stored token and MOBILE_MONEY pushes an MMG request the payer
   *  approves on their phone. */
  private async attemptCharge(
    sub: SubWithRelations,
    amount: number,
  ): Promise<
    | { ok: true; ref: string; settlePaymentId?: string }
    | { ok: false; reason: string }
    | { ok: false; pendingTx: string }
    | { ok: false; deferred: true; reopenPaymentId?: string }
  > {
    // Prepaid balance is money Swift already holds — spend it before pinging any
    // external rail. Atomic conditional decrement (no read-then-write race). This
    // is also what makes an admin top-up reinstate a CARD/MMG sub: the recorded
    // cash settles the fee instead of firing a fresh (and duplicate) external
    // charge while the top-up sits unused and the partner stays suspended.
    const prepaid = await this.prisma.prepaidBalance.updateMany({
      where: { subscriptionId: sub.id, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (prepaid.count === 1) return { ok: true, ref: 'prepaid' };

    if (sub.billingMethod === 'CARD' && sub.paymentToken) {
      const result = await this.payments.chargeToken({
        token: sub.paymentToken,
        amount,
        currencyCode: sub.currencyCode,
        idempotencyKey: `prov:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a${sub.failedAttempts}`,
        description: `Swift weekly subscription (${sub.type})`,
      });
      return result.status === 'succeeded'
        ? { ok: true, ref: result.providerRef }
        : { ok: false, reason: result.reason ?? 'Charge declined' };
    }

    if (sub.billingMethod === 'MOBILE_MONEY' && sub.mmgPayerMsisdn) {
      const mmg = getMmgProvider();
      // SWIFT-004 — MMG double-charge guard. The poller's synthetic 24h expiry
      // can mark a prior request FAILED while MMG still holds it live on the
      // payer's phone; initiating again here would put a SECOND approvable
      // charge out for the same week. Reconcile every prior request for THIS
      // period against MMG's own truth before firing a new one:
      //   approved → settle off it (the money is already in — no new charge);
      //   still pending, or MMG unreachable → don't fire; re-attach the poller
      //     to the original so a late approval still settles and a genuine
      //     expiry still duns, minus the duplicate;
      //   only a provably-dead prior (declined/expired/reversed) lets one through.
      const priors = await this.prisma.subscriptionPayment.findMany({
        where: {
          subscriptionId: sub.id,
          paymentMethod: 'MOBILE_MONEY',
          periodStart: sub.nextBillingDate,
          externalRef: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      for (const prior of priors) {
        let priorStatus: string;
        try {
          priorStatus = (await mmg.transactionLookup({ transactionId: prior.externalRef! })).status;
        } catch {
          return { ok: false, deferred: true, reopenPaymentId: prior.id }; // MMG down — never fire blind
        }
        if (priorStatus === 'approved') return { ok: true, ref: prior.externalRef!, settlePaymentId: prior.id };
        if (priorStatus === 'pending') return { ok: false, deferred: true, reopenPaymentId: prior.id };
      }

      // §13 MMG rail — merchant-initiated. Amounts are minor units at the
      // provider seam; the reference doubles as the retry-safe correlation id.
      const result = await mmg.initiatePayment({
        payerId: sub.mmgPayerMsisdn,
        amountMinor: Math.round(amount * 100),
        currencyCode: sub.currencyCode,
        reference: `sub:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a${sub.failedAttempts}`,
      });
      if (result.status === 'approved') return { ok: true, ref: result.transactionId };
      if (result.status === 'pending' && result.transactionId) return { ok: false, pendingTx: result.transactionId };
      return { ok: false, reason: result.reason ?? 'MMG request failed' };
    }

    // Prepaid already tried and came up short above; no usable external rail
    // (a CASH sub with an empty balance, or a CARD/MMG sub missing credentials).
    return { ok: false, reason: 'Insufficient prepaid balance' };
  }

  private async applySuccessfulCharge(
    sub: SubWithRelations,
    amount: number,
    paymentRef: string,
    now: Date,
    periodKey: string,
    /** Settle an existing PENDING payment row (MMG poll path) instead of creating one. */
    settlePaymentId?: string,
    /** USD pricing: the pinned trio from the charge attempt (System 2 ②). */
    usdTrio?: { amountUsd: number; fxRateId: string; fxRateUsed: number },
  ) {
    const periodStart = sub.nextBillingDate;
    const periodEnd = new Date(periodStart.getTime() + WEEK_MS);
    const wasInterrupted = sub.status === 'PAST_DUE' || sub.status === 'SUSPENDED' || sub.status === 'CHURNED';

    if (settlePaymentId) {
      await this.prisma.subscriptionPayment.update({
        where: { id: settlePaymentId },
        data: { status: 'CAPTURED', paidAt: now },
      });
    } else {
      await this.prisma.subscriptionPayment.create({
        data: {
          subscriptionId: sub.id,
          amount,
          status: 'CAPTURED',
          paymentMethod: sub.billingMethod,
          externalRef: paymentRef,
          periodStart,
          periodEnd,
          paidAt: now,
        },
      });
    }

    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
        lastPaymentDate: now,
        failedAttempts: 0,
        nextRetryAt: null,
        isInGracePeriod: false,
        gracePeriodEnd: null,
        suspendedAt: null,
      },
    });

    await this.prisma.billingEvent.create({
      data: {
        subscriptionId: sub.id,
        type: 'CHARGE_SUCCESS',
        amount,
        currencyCode: sub.currencyCode,
        idempotencyKey: `success:${sub.id}:${periodKey}`,
        paymentRef,
        ...(usdTrio ?? {}),
      },
    });

    if (wasInterrupted) {
      await this.reinstate(sub, periodKey);
    }

    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Subscription payment received',
      body: `$${amount.toLocaleString()} ${sub.currencyCode} received. You are active until ${periodEnd.toISOString().slice(0, 10)}.`,
      audience: this.payerAudience(sub),
      data: { kind: 'billing_success', subscriptionId: sub.id },
    });
  }

  /**
   * §13 MMG rail poller (BullMQ repeatable, ~2 min): settle every in-flight
   * merchant-initiated request. Approved → the period advances off the SAME
   * pending payment row (no duplicate). Declined/expired — or older than 24h —
   * → the normal dunning path (PAST_DUE → retries → suspend). Still-pending
   * stays pending; the payer's phone is the clock, the DB is the truth.
   */
  async pollPendingMmgCharges(now = new Date()): Promise<{ settled: number; failed: number; stillPending: number }> {
    const pending = await this.prisma.subscriptionPayment.findMany({
      where: { status: 'PENDING', paymentMethod: 'MOBILE_MONEY', externalRef: { not: null } },
      take: 200,
    });
    const out = { settled: 0, failed: 0, stillPending: 0 };
    if (pending.length === 0) return out;

    const mmg = getMmgProvider();
    for (const payment of pending) {
      const sub = await this.prisma.subscription.findUnique({
        where: { id: payment.subscriptionId },
        include: {
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          vendor: { select: { id: true, owner: { select: { userId: true } } } },
        },
      });
      if (!sub) continue;
      const periodKey = payment.periodStart.toISOString().slice(0, 10);

      let status: string;
      let reportedMinor = 0;
      try {
        const lookup = await mmg.transactionLookup({ transactionId: payment.externalRef! });
        status = lookup.status;
        reportedMinor = lookup.amountMinor ?? 0;
      } catch {
        out.stillPending += 1; // transport hiccup — the next tick retries
        continue;
      }

      // USD pricing Part 10 rule 3 / SO-6 posture: the settled amount must
      // match OUR amount exactly. A mismatch is NEVER silently absorbed and
      // never auto-settled — flag once for the founder and hold the row.
      // (reportedMinor 0 = provider didn't echo an amount; nothing to check.)
      if (status === 'approved' && reportedMinor > 0 && reportedMinor !== Math.round(Number(payment.amount) * 100)) {
        try {
          await this.prisma.billingEvent.create({
            data: {
              subscriptionId: sub.id,
              type: 'REMINDER',
              currencyCode: sub.currencyCode,
              idempotencyKey: `mismatch:${payment.id}`,
              note: `RECONCILE_MISMATCH: MMG reports ${(reportedMinor / 100).toFixed(2)} vs our ${Number(payment.amount).toFixed(2)} (payment ${payment.id})`,
            },
          });
          await notifyAdmins(this.prisma, this.notifications, {
            title: '⚠️ Payment amount mismatch — held for review',
            body: `MMG reports a different amount than we requested on a weekly-fee payment. It is NOT settled. Payment ${payment.id}.`,
            data: { kind: 'reconcile_mismatch', paymentId: payment.id, subscriptionId: sub.id },
          });
        } catch {
          /* already flagged — the dedup key holds */
        }
        out.stillPending += 1;
        continue;
      }

      const expired =
        status === 'expired' ||
        (status === 'pending' && now.getTime() - payment.createdAt.getTime() > 24 * 60 * 60 * 1000);

      // SWIFT-AUD-D2-04: settle is single-winner. The PENDING→terminal write
      // is a compare-and-set claim; a second poller delivery (overlapping
      // tick, second instance, an admin top-up racing the poll) matches 0
      // rows and skips — it can never re-advance the period or die on the
      // billing-event idempotency key. Each item is isolated in try/catch so
      // one settle failure can't kill the rest of the run. (Full transactional
      // coupling of claim+advance ships with the MMG expiryTime program.)
      try {
        if (status === 'approved') {
          const claimed = await this.prisma.subscriptionPayment.updateMany({
            where: { id: payment.id, status: 'PENDING' },
            data: { status: 'CAPTURED', paidAt: now },
          });
          if (claimed.count === 0) continue; // another settler won this row
          // USD pinning across the async settle: the ATTEMPT's trio is the
          // truth — never re-price a late approval at today's rate.
          await this.applySuccessfulCharge(
            sub as SubWithRelations, Number(payment.amount), payment.externalRef!, now, periodKey, payment.id,
            await this.pinnedTrioFor(sub.id, periodKey),
          );
          out.settled += 1;
        } else if (status === 'declined' || status === 'reversed' || expired) {
          const claimed = await this.prisma.subscriptionPayment.updateMany({
            where: { id: payment.id, status: 'PENDING' },
            data: { status: 'FAILED' },
          });
          if (claimed.count === 0) continue;
          await this.applyFailedCharge(sub as SubWithRelations, Number(payment.amount), `MMG request ${expired ? 'expired unapproved' : status}`, now, periodKey);
          out.failed += 1;
        } else {
          out.stillPending += 1;
        }
      } catch (err) {
        // The claim may have landed while the advance threw — the payment row
        // is terminal and the subscription lags one poll. Loud log with the
        // ids so ops can reconcile; the next legitimate cycle self-corrects
        // the period, and the row never double-charges.
        log().error({ err, paymentId: payment.id, subscriptionId: sub.id }, 'MMG poll settle failed for one payment — continuing');
      }
    }
    return out;
  }

  /**
   * §13 rail selection — one place flips how a subscription pays. CASH is the
   * prepaid path; MOBILE_MONEY needs the payer's MMG account. CARD enrollment
   * stays with the tokenization flow, not here.
   */
  async setBillingRail(subscriptionId: string, method: 'CASH' | 'MOBILE_MONEY', mmgPayerMsisdn?: string) {
    if (method === 'MOBILE_MONEY' && !mmgPayerMsisdn?.trim()) {
      throw new AppError(400, 'MSISDN_REQUIRED', 'Your MMG account number is required to pay the weekly fee via MMG.');
    }
    const updated = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        billingMethod: method,
        mmgPayerMsisdn: method === 'MOBILE_MONEY' ? mmgPayerMsisdn!.trim() : null,
      },
    });
    await this.prisma.billingEvent.create({
      data: {
        subscriptionId,
        type: 'TIER_CHANGE',
        currencyCode: updated.currencyCode,
        idempotencyKey: `rail:${subscriptionId}:${Date.now()}`,
        note: `Billing rail set to ${method}${method === 'MOBILE_MONEY' ? ' (MMG merchant-initiated)' : ' (prepaid)'}`,
      },
    });
    // Identity-integrity capture (§2.1 MMG_PAYER — HARD: the money doesn't
    // lie). Fire-and-forget; A4 payer-laundering unions + any §3.4
    // retroactive trial reconciliation happen inside the capture.
    if (method === 'MOBILE_MONEY' && mmgPayerMsisdn) {
      const human = await this.prisma.subscription.findUnique({
        where: { id: subscriptionId },
        select: {
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          vendor: { select: { owner: { select: { userId: true } } } },
        },
      });
      const userId = human?.rider?.userId ?? human?.driver?.userId ?? human?.vendor?.owner.userId;
      if (userId) {
        const { captureMmgPayer } = await import('../integrity/capture-hooks');
        const role = human?.rider ? 'RIDER' : human?.driver ? 'DRIVER' : 'VENDOR';
        captureMmgPayer(this.prisma, { userId, role, payerMsisdn: mmgPayerMsisdn.trim() });
      }
    }
    return updated;
  }

  private async applyFailedCharge(
    sub: SubWithRelations,
    amount: number,
    reason: string,
    now: Date,
    periodKey: string,
  ): Promise<'failed' | 'suspended'> {
    const attempts = sub.failedAttempts + 1;
    const willSuspend = attempts >= MAX_FAILED_ATTEMPTS && sub.autoSuspendEnabled;

    await this.prisma.billingEvent.create({
      data: {
        subscriptionId: sub.id,
        type: 'CHARGE_FAILED',
        amount,
        currencyCode: sub.currencyCode,
        idempotencyKey: `failed:${sub.id}:${periodKey}:a${sub.failedAttempts}`,
        note: reason,
      },
    });

    const nextRetryAt = new Date(now.getTime() + RETRY_HOURS * 60 * 60 * 1000);
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: willSuspend ? 'SUSPENDED' : 'PAST_DUE',
        failedAttempts: attempts,
        nextRetryAt,
        isInGracePeriod: !willSuspend,
        gracePeriodEnd: willSuspend ? null : nextRetryAt,
        ...(willSuspend ? { suspendedAt: now } : {}),
      },
    });

    if (willSuspend) {
      await this.suspendAccess(sub, periodKey);
      return 'suspended';
    }

    // §11 dunning depth: the LAST retry before suspension escalates —
    // final-warning copy that NAMES the suspension moment, an SMS (the
    // scarce resource is attention; push may be muted or the app gone), and
    // an ops task so a human reaches out before access is cut (stage 4).
    const finalWarning = attempts === MAX_FAILED_ATTEMPTS - 1 && sub.autoSuspendEnabled;
    if (finalWarning) {
      const when = nextRetryAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      await this.notifications.send({
        userId: this.payerUserId(sub),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Final warning — payment needed',
        body: `${reason}. Your subscription will be SUSPENDED at ${when} unless the weekly fee is paid. Pay now to keep operating.`,
        audience: this.payerAudience(sub),
        data: { kind: 'billing_final_warning', subscriptionId: sub.id, suspendsAt: nextRetryAt.toISOString() },
      });
      await this
        .smsPayer(sub, `Swift: your weekly fee is unpaid. Your account will be suspended at ${when} unless you pay. Open the app to pay now.`)
        .catch(() => {});
      await notifyAdmins(this.prisma, this.notifications, {
        title: 'Dunning — final warning issued',
        body: `Subscription ${sub.id} suspends at ${when} (attempt ${attempts}/${MAX_FAILED_ATTEMPTS}). Contact the payer directly before access is cut.`,
        data: { kind: 'billing_dunning_ops_task', subscriptionId: sub.id, suspendsAt: nextRetryAt.toISOString() },
      }).catch(() => {});
    } else {
      await this.notifications.send({
        userId: this.payerUserId(sub),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Subscription payment failed',
        body: `${reason}. We will retry tomorrow (attempt ${attempts} of ${MAX_FAILED_ATTEMPTS}). Top up or update your card to stay active.`,
        audience: this.payerAudience(sub),
        data: { kind: 'billing_failed', subscriptionId: sub.id },
      });
    }
    return 'failed';
  }

  // -------------------------------------------------------------------------
  // Suspend / reinstate
  // -------------------------------------------------------------------------

  /** Suspension removes the payer from the platform until they pay. */
  private async suspendAccess(sub: SubWithRelations, periodKey: string) {
    if (sub.vendor) {
      // SUSPENDED vendors vanish from customer browse (which filters ACTIVE)
      await this.prisma.vendor.update({
        where: { id: sub.vendor.id },
        data: { status: 'SUSPENDED', acceptingOrders: false },
      });
    }
    if (sub.rider) {
      await this.prisma.rider.updateMany({
        where: { userId: sub.rider.userId },
        data: { isOnline: false, isAvailable: false },
      });
    }
    if (sub.driver) {
      await this.prisma.driver.updateMany({
        where: { userId: sub.driver.userId },
        data: { isOnline: false, isAvailable: false },
      });
    }

    await this.prisma.billingEvent.create({
      data: {
        subscriptionId: sub.id,
        type: 'SUSPENDED',
        currencyCode: sub.currencyCode,
        idempotencyKey: `suspended:${sub.id}:${periodKey}`,
        note: `Auto-suspended after ${MAX_FAILED_ATTEMPTS} failed charges`,
      },
    });

    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Subscription suspended',
      body: 'Your subscription is unpaid and your access is suspended. Top up or pay to be reinstated instantly.',
      audience: this.payerAudience(sub),
      data: { kind: 'billing_suspended', subscriptionId: sub.id },
    });
    // §11 stage 5→6: the suspension notice also lands as SMS with the way
    // back in — the payer may have lost the app or muted push entirely.
    await this
      .smsPayer(sub, 'Swift: your account is suspended for non-payment. Pay your weekly fee in the app (or top up your balance) and access is restored instantly.')
      .catch(() => {});
  }

  private async reinstate(sub: SubWithRelations, periodKey: string) {
    if (sub.vendor) {
      await this.prisma.vendor.update({
        where: { id: sub.vendor.id },
        data: { status: 'ACTIVE', acceptingOrders: true },
      });
    }

    await this.prisma.billingEvent.create({
      data: {
        subscriptionId: sub.id,
        type: 'REINSTATED',
        currencyCode: sub.currencyCode,
        idempotencyKey: `reinstated:${sub.id}:${periodKey}:${Date.now()}`,
        note: 'Payment received — access restored',
      },
    });

    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Subscription reinstated',
      body: 'Payment received — welcome back. Your access is restored.',
      audience: this.payerAudience(sub),
      data: { kind: 'billing_reinstated', subscriptionId: sub.id },
    });
  }

  /** Best-effort SMS to the payer — dunning escalation channel (§11: the
   *  scarce resource is attention; push may be muted or the app deleted).
   *  Never throws into a billing decision. */
  private async smsPayer(sub: SubWithRelations, body: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: this.payerUserId(sub) },
      select: { phone: true },
    });
    if (!user?.phone) return;
    await getChannels().sms.sendSms(user.phone, body);
  }

  /**
   * §11 stages 6..N + churn: runs with the billing job. Every SUSPENDED
   * subscription gets ONE reinstatement nudge per day (push + SMS, idempotent
   * via the REMINDER event key — restart/overlap safe), and one that has sat
   * suspended past SUSPENSION_MAX_DAYS goes CHURNED: terminal for dunning
   * (drops out of the cycle's retry set, the daily MMG re-request stops, the
   * nudges stop) but never for the door back in — any payment reinstates.
   */
  async sweepSuspended(now = new Date()): Promise<{ nudged: number; churned: number }> {
    const suspended = await this.prisma.subscription.findMany({
      where: { status: 'SUSPENDED' },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
      take: 500,
    });
    const out = { nudged: 0, churned: 0 };
    for (const sub of suspended) {
      try {
        const suspendedSince = sub.suspendedAt ?? sub.updatedAt; // pre-migration rows fall back to last touch
        if (now.getTime() - suspendedSince.getTime() >= suspensionMaxDays() * DAY_MS) {
          // CAS so racing job runs churn exactly once.
          const moved = await this.prisma.subscription.updateMany({
            where: { id: sub.id, status: 'SUSPENDED' },
            data: { status: 'CHURNED', nextRetryAt: null, isInGracePeriod: false, gracePeriodEnd: null },
          });
          if (moved.count === 0) continue;
          await this.prisma.billingEvent.create({
            data: {
              subscriptionId: sub.id,
              type: 'CHURNED',
              currencyCode: sub.currencyCode,
              idempotencyKey: `churned:${sub.id}:${suspendedSince.toISOString().slice(0, 10)}`,
              note: `Suspended ${suspensionMaxDays()} days without payment — dunning stopped`,
            },
          }).catch(() => {}); // audit best-effort; the CAS above is the state truth
          await this.notifications.send({
            userId: this.payerUserId(sub as SubWithRelations),
            type: 'SYSTEM_ANNOUNCEMENT',
            title: 'Subscription closed',
            body: 'Your subscription was closed after 30 days unpaid. You can rejoin anytime — pay your weekly fee and your access is restored.',
            audience: this.payerAudience(sub),
            data: { kind: 'billing_churned', subscriptionId: sub.id },
          });
          await this
            .smsPayer(sub as SubWithRelations, 'Swift: your subscription was closed after 30 days unpaid. Rejoin anytime — pay in the app and access is restored instantly.')
            .catch(() => {});
          out.churned += 1;
          continue;
        }

        // Daily nudge — the REMINDER event's unique key IS the per-day gate.
        const dayKey = now.toISOString().slice(0, 10);
        try {
          await this.prisma.billingEvent.create({
            data: {
              subscriptionId: sub.id,
              type: 'REMINDER',
              currencyCode: sub.currencyCode,
              idempotencyKey: `nudge:${sub.id}:${dayKey}`,
              note: 'Daily reinstatement nudge while suspended',
            },
          });
        } catch (error) {
          if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') continue; // already nudged today
          throw error;
        }
        const rail =
          sub.billingMethod === 'MOBILE_MONEY'
            ? 'Approve the MMG request on your phone (or tap Pay in the app)'
            : sub.billingMethod === 'CARD'
              ? 'Update your card or tap Pay in the app'
              : 'Top up your prepaid balance in the app';
        await this.notifications.send({
          userId: this.payerUserId(sub as SubWithRelations),
          type: 'SYSTEM_ANNOUNCEMENT',
          title: 'Suspended — pay to restore access',
          body: `Your weekly fee of $${Number(sub.customRate ?? sub.weeklyRate).toLocaleString()} ${sub.currencyCode} is unpaid. ${rail} and your access is restored instantly.`,
          audience: this.payerAudience(sub),
          data: { kind: 'billing_suspended_nudge', subscriptionId: sub.id },
        });
        await this
          .smsPayer(sub as SubWithRelations, `Swift: your account is still suspended. ${rail} — access is restored the moment you pay.`)
          .catch(() => {});
        out.nudged += 1;
      } catch (err) {
        log().error({ err, subscriptionId: sub.id }, 'suspended-sweep failed for one subscription — continuing');
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Prepaid top-ups (manual confirm in admin for now)
  // -------------------------------------------------------------------------

  async recordTopUp(subscriptionId: string, amount: number, recordedBy: string, reference?: string, clientKey?: string) {
    if (amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Top-up must be positive');

    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
    });
    if (!sub) throw new NotFoundError('Subscription', subscriptionId);

    // Idempotency [SWIFT-030]: this is the only live collection path, so a retry
    // (network retry, admin double-tap) MUST NOT credit twice. A client-supplied
    // Idempotency-Key makes the retry a no-op; without one we fall back to a
    // time-based key (the caller opted out of dedup). The BillingEvent's unique
    // idempotencyKey is the DB-level guard — created FIRST inside the transaction,
    // so a replay rolls the whole thing back before the balance is ever touched.
    const eventKey = clientKey
      ? `topup:${subscriptionId}:${clientKey}`
      : `topup:${subscriptionId}:${Date.now()}:${recordedBy}`;

    let balance;
    try {
      balance = await this.prisma.$transaction(async (tx) => {
        const event = await tx.billingEvent.create({
          data: {
            subscriptionId,
            type: 'PREPAID_TOPUP',
            amount,
            currencyCode: sub.currencyCode,
            idempotencyKey: eventKey,
            note: reference ? `ref: ${reference} (by ${recordedBy})` : `recorded by ${recordedBy}`,
          },
        });
        // Every credit issues a sequential GRA-ready receipt [san spec 20.1]
        // inside the SAME tx — a replayed top-up rolls the receipt (and its
        // counter claim) back with it, so numbers stay gapless.
        const { issueReceipt } = await import('./receipts');
        await issueReceipt(tx, {
          subscriptionId,
          billingEventId: event.id,
          amount,
          channel: recordedBy.startsWith('agent-cash:') ? recordedBy.slice('agent-cash:'.length) : 'ADMIN_TOPUP',
          mmgRef: reference,
        });
        return tx.prepaidBalance.upsert({
          where: { subscriptionId },
          update: { balance: { increment: amount } },
          create: { subscriptionId, balance: amount, currencyCode: sub.currencyCode },
        });
      });
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        // Replay of an already-recorded top-up: return the current balance
        // without crediting again, notifying, or re-billing.
        return this.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId } });
      }
      throw error;
    }

    await this.notifications.send({
      userId: this.payerUserId(sub as SubWithRelations),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Top-up received',
      body: `$${amount.toLocaleString()} ${sub.currencyCode} added to your subscription balance.`,
      audience: this.payerAudience(sub),
      data: { kind: 'billing_topup', subscriptionId },
    });

    // A top-up while behind triggers an instant billing attempt — paying
    // reinstates immediately, no waiting for the next cycle. CHURNED included:
    // churn is terminal for DUNNING, never for the door back in (§11).
    if (sub.status === 'PAST_DUE' || sub.status === 'SUSPENDED' || sub.status === 'CHURNED') {
      const fresh = await this.prisma.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
        include: {
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          vendor: { select: { id: true, owner: { select: { userId: true } } } },
        },
      });
      await this.billSubscription(fresh as SubWithRelations);
    }

    return balance;
  }

  // -------------------------------------------------------------------------
  // Reminders & tier recalculation
  // -------------------------------------------------------------------------

  /** One reminder per subscription per period, 24h before the due date. */
  async sendUpcomingReminders(now = new Date()): Promise<number> {
    const dayAhead = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const upcoming = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE', autoRenew: true, nextBillingDate: { gt: now, lte: dayAhead } },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
    });

    let sent = 0;
    for (const sub of upcoming) {
      const periodKey = sub.nextBillingDate.toISOString().slice(0, 10);
      try {
        await this.prisma.billingEvent.create({
          data: {
            subscriptionId: sub.id,
            type: 'REMINDER',
            amount: this.amountFor(sub),
            currencyCode: sub.currencyCode,
            idempotencyKey: `reminder:${sub.id}:${periodKey}`,
          },
        });
      } catch (error) {
        if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') continue; // already reminded
        throw error;
      }

      await this.notifications.send({
        userId: this.payerUserId(sub as SubWithRelations),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Subscription due tomorrow',
        body: `Your weekly fee of $${Number(this.amountFor(sub)).toLocaleString()} ${sub.currencyCode} is due tomorrow.`,
        audience: this.payerAudience(sub),
        data: { kind: 'billing_reminder', subscriptionId: sub.id },
      });
      sent += 1;
    }
    return sent;
  }

  /**
   * Weekly tier check: vendor tier comes from catalogue size (active listing
   * count) and CountryConfig rates — NEVER from sales (zero-commission model).
   */
  async recalculateVendorTiers(): Promise<number> {
    const vendorSubs = await this.prisma.subscription.findMany({
      where: { vendorId: { not: null }, status: { in: ['ACTIVE', 'PAST_DUE', 'TRIAL'] } },
      include: {
        vendor: {
          select: { id: true, owner: { select: { user: { select: { countryCode: true, id: true } } } } },
        },
      },
    });

    let changed = 0;
    for (const sub of vendorSubs) {
      if (!sub.vendor) continue;
      const tiers = await this.countryConfig.getSubscriptionTiers(sub.vendor.owner.user.countryCode);
      const threshold = tiers['largeCatalogueThreshold'] ?? DEFAULT_LARGE_CATALOGUE_THRESHOLD;

      const activeListings = await this.prisma.item.count({
        where: { vendorId: sub.vendor.id, isAvailable: true },
      });
      // "1000+ items" → large: the threshold count itself qualifies.
      const isLarge = activeListings >= threshold;
      const targetRate = isLarge ? tiers.largeVendor : tiers.smallVendor;

      if (Number(sub.weeklyRate) !== targetRate) {
        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: { weeklyRate: targetRate },
        });
        await this.prisma.billingEvent.create({
          data: {
            subscriptionId: sub.id,
            type: 'TIER_CHANGE',
            amount: targetRate,
            currencyCode: sub.currencyCode,
            idempotencyKey: `tier:${sub.id}:${new Date().toISOString().slice(0, 10)}:${targetRate}`,
            note: `${activeListings} active listings -> ${isLarge ? 'large' : 'small'} tier`,
          },
        });
        changed += 1;
      }
    }
    return changed;
  }

  private payerUserId(sub: SubWithRelations): string {
    const userId = sub.rider?.userId ?? sub.driver?.userId ?? sub.vendor?.owner.userId;
    if (!userId) throw new AppError(500, 'ORPHAN_SUBSCRIPTION', `Subscription ${sub.id} has no payer`);
    return userId;
  }

  /** Billing notices belong to the surface that pays the fee. */
  private payerAudience(sub: SubWithRelations): 'earner' | 'business' {
    return sub.vendor ? 'business' : 'earner';
  }
}
