import type { PrismaClient, Subscription, Prisma, SubscriptionStatus } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins, tenantOfUser, tenantOfSubscription } from '../notification/notification.service';
import { getChannels } from '../../providers/notifications/channels';
import { CountryConfigService, moverRateFor, vendorRateFor } from '../country/country-config.service';
import { feeBandFor } from '../../config/vehicle-classes';
import type { PaymentProvider } from '../../providers/payment/payment-provider';
import { getMmgProvider } from '../../providers/mmg/mmg-provider';
import { convertUsdToLocal } from './fx';
import { postLedger, topupPostings, chargeSuccessPostings } from './ledger';
import { mapMmgFailure, type NormalizedFailure } from './failure-taxonomy';
import { log } from '../../utils/logger';
import { billingTerminalWithoutOutcomeGauge, billingOutcomeRepairsCounter, billingTopupDuplicateFingerprintCounter, billingTopupTailsPendingGauge, billingUnkeyedTopupDuplicatesGauge } from '../../plugins/observability';

// ---------------------------------------------------------------------------
// BillingService — the one place V1 touches money: Swift's own weekly fee.
// Deterministic code only (hard rule 1). Every money event lands in the
// append-only BillingEvent log; the unique idempotencyKey is the DB-level
// double-charge guard, safe under concurrent job runs.
// ---------------------------------------------------------------------------

const MAX_FAILED_ATTEMPTS = 3;

/** [M-04] What a recorded failure decided — computed and applied inside one transaction. */
type FailureOutcome = { attempts: number; willSuspend: boolean; nextRetryAt: Date; finalWarning: boolean };
const RETRY_HOURS = 24;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Default request TTL until MMG answers Q2 of the question register — the
 *  poller expires an unapproved request past this, into normal dunning. */
const MMG_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** Poll backoff ladder [tollgate 14.1]: 30s → 60s → 2m → 5m cap, ±20% jitter
 *  applied at stamp time. Fresh rows poll fast (the approve-on-phone moment);
 *  old rows stop hammering the provider. */
const POLL_BACKOFF_CAP_SEC = 300;
const nextBackoff = (current: number) => Math.min(POLL_BACKOFF_CAP_SEC, Math.max(30, current * 2));
const jitter = (sec: number) => Math.round(sec * (0.8 + Math.random() * 0.4));

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

/**
 * [M-04] A seam for the atomicity proofs: called INSIDE the terminalization
 * transaction, after the payment's terminal compare-and-set and before the
 * failure outcome is written, so a thrown error rolls the whole transition
 * back exactly as a crash would. Never consulted for anything else.
 */
export interface BillingObserver {
  afterPaymentTerminalized?: (payment: { id: string; status: 'FAILED' | 'EXPIRED' }) => Promise<void>;
  /** [M-08] Called INSIDE the top-up command's transaction after every fact
   *  is staged (credit, receipt, ledger, audit, command row) and before the
   *  commit — a thrown error rolls the whole command back as a crash would. */
  afterTopUpCommandStaged?: () => Promise<void>;
}

/** [M-08] What a top-up command answers — stored with the command, replayed verbatim. */
export interface TopUpCommandResult {
  balance: number;
  currencyCode: string;
  billingEventId: string;
}

export const TOPUP_KEY_MIN = 8;
export const TOPUP_KEY_MAX = 128;
export function isUsableTopUpKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= TOPUP_KEY_MIN && key.length <= TOPUP_KEY_MAX;
}

export class BillingService {
  private countryConfig: CountryConfigService;

  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
    private payments: PaymentProvider,
    /** [M-04] Test seam only — see BillingObserver. Production passes nothing. */
    private readonly observer: BillingObserver = {},
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
        // [REPORT-013 F-013-09] A duplicate attempt key is NOT always
        // "already handled": a crash between the durable CHARGE_FAILED
        // record and its outcome application leaves failedAttempts at the
        // recorded level forever — every later run collides on the same key
        // and skipping here would suppress retries AND the suspension
        // permanently. If the failure record exists while its outcome never
        // landed, RESUME the outcome instead of skipping past it. (A fully
        // applied failure advanced failedAttempts, so its next key differs
        // and this branch is unreachable for it.)
        const failedKey = `failed:${sub.id}:${periodKey}:a${sub.failedAttempts}`;
        const recordedFailure = await this.prisma.billingEvent.findUnique({
          where: { idempotencyKey: failedKey },
          select: { note: true, amount: true },
        });
        if (recordedFailure) {
          // [M-04] The event exists but its outcome never landed (a crash of the
          // pre-transactional code): apply it now, in ONE transaction.
          return this.applyFailedCharge(
            sub, Number(recordedFailure.amount ?? 0), recordedFailure.note ?? 'Charge failed (outcome resumed after interruption)', now, periodKey,
          );
        }
        // [TA-S0-002] A run that reserved this attempt's MMG intent and died
        // before recording the outcome left a live intent the poller owns.
        // That is "pending", not "skipped" — and nobody re-initiates over it.
        const liveIntent = await this.prisma.subscriptionPayment.findUnique({
          where: { clientKey: this.mmgReference(sub) },
          select: { status: true },
        });
        if (liveIntent && (liveIntent.status === 'PENDING' || liveIntent.status === 'UNKNOWN')) return 'pending';
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
        charged.spendPrepaid,
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

    if ('unknown' in charged) {
      // LAW M-5 — UNKNOWN is a first-class state. The initiate call itself
      // died transport-shaped: the request MAY be live on the payer's phone,
      // so it is neither failed (a second request could double-prompt) nor
      // succeeded (no money confirmed). The intent records our clientKey with
      // no provider id; the poller adopts it from transaction history or
      // expires it at TTL, and SWIFT-004 refuses to fire over it meanwhile.
      // [TA-S0-002] The intent row already exists (reserved before the
      // provider call); it just learns that the initiate itself died.
      await this.prisma.subscriptionPayment.updateMany({
        where: { id: charged.intentId, status: 'UNKNOWN', externalRef: null },
        data: {
          failureCode: 'TIMEOUT_UNKNOWN',
          ...(charged.failureRaw ? { failureRaw: { reason: charged.failureRaw } } : {}),
          expiresAt: new Date(now.getTime() + MMG_REQUEST_TTL_MS),
        },
      });
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
      // [TA-S0-002] The intent row was reserved before the provider call;
      // MMG's own id lands on it now, and the poller takes it from here.
      await this.prisma.subscriptionPayment.updateMany({
        where: { id: charged.intentId, status: 'UNKNOWN', externalRef: null },
        data: { status: 'PENDING', externalRef: charged.pendingTx, expiresAt: charged.expiresAt, failureCode: null },
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

    if (charged.intentId) {
      // [M-04] The intent row, the CHARGE_FAILED event and the dunning state
      // are ONE transition; a lost claim means another run already applied it.
      const outcome = await this.terminalizeFailedPayment(
        sub, { id: charged.intentId, amount },
        { status: 'FAILED', failureCode: charged.failureCode ?? 'PROVIDER_ERROR', from: ['UNKNOWN'], requireNoExternalRef: true, ...(charged.failureRaw ? { failureRaw: charged.failureRaw } : {}) },
        charged.reason, now, periodKey,
      );
      return outcome ?? 'skipped';
    }
    return this.applyFailedCharge(sub, amount, charged.reason, now, periodKey);
  }

  /** The MMG merchant reference for one attempt — ONE format, shared by the
   *  initiate, the duplicate-attempt check and the poller's adoption. */
  private mmgReference(sub: Pick<Subscription, 'id' | 'nextBillingDate' | 'failedAttempts'>): string {
    return `sub:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a${sub.failedAttempts}`;
  }

  /**
   * [TA-S0-002 / M-03] Reserve the durable MMG intent for one attempt BEFORE
   * the provider is asked: UNKNOWN, our clientKey, no provider id yet, the
   * TTL already ticking. `clientKey` is unique, so a second reservation for
   * the same attempt is refused at the database — that means a previous run
   * reserved it and died: the poller owns that row (history adoption by our
   * reference, or expiry at TTL) and no second prompt may ever be issued.
   * Returns null in that case.
   */
  private async reserveMmgIntent(sub: SubWithRelations, amount: number, reference: string, now = new Date()): Promise<{ id: string } | null> {
    try {
      return await this.prisma.subscriptionPayment.create({
        data: {
          subscriptionId: sub.id,
          amount,
          status: 'UNKNOWN',
          paymentMethod: sub.billingMethod,
          clientKey: reference,
          expiresAt: new Date(now.getTime() + MMG_REQUEST_TTL_MS),
          periodStart: sub.nextBillingDate,
          periodEnd: new Date(sub.nextBillingDate.getTime() + WEEK_MS),
        },
        select: { id: true },
      });
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        log().warn({ subscriptionId: sub.id, reference }, 'mmg intent already reserved for this attempt — deferring to the poller, never a second prompt');
        return null;
      }
      throw error;
    }
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
    /** `spendPrepaid` = debit this much from the prepaid balance INSIDE the
     *  advance transaction, so the money and the week it buys commit together. */
    | { ok: true; ref: string; settlePaymentId?: string; spendPrepaid?: number }
    | { ok: false; reason: string; failureCode?: NormalizedFailure; intentId?: string; failureRaw?: string }
    | { ok: false; pendingTx: string; clientKey: string; expiresAt: Date; intentId: string }
    | { ok: false; unknown: true; clientKey: string; failureRaw?: string; intentId: string }
    | { ok: false; deferred: true; reopenPaymentId?: string }
  > {
    // Prepaid balance is money Swift already holds — spend it before pinging any
    // external rail. This is also what makes an admin top-up reinstate a CARD/MMG
    // sub: the recorded cash settles the fee instead of firing a fresh (and
    // duplicate) external charge while the top-up sits unused and the partner
    // stays suspended.
    //
    // [PAY-1 M0 · S0] This USED to decrement here, in its own standalone write,
    // and then return — leaving the advance (payment row, period move, ledger) to
    // a SEPARATE transaction further down. A crash in between spent the payer's
    // credit and granted no week: money gone, service not given, and no ledger
    // entry to find it by. That is the worst failure a billing system has.
    //
    // So the decision is made here and the SPEND happens inside the advance's own
    // transaction (see applySuccessfulChargeInTx). The read below is deliberately
    // not the race guard — the conditional decrement in that transaction still
    // is, and it throws if someone else spent the balance first, rolling the whole
    // advance back. Worst case we skip a cycle and retry. We never take money
    // without granting the week it bought.
    const balanceRow = await this.prisma.prepaidBalance.findUnique({
      where: { subscriptionId: sub.id },
      select: { balance: true },
    });
    if (balanceRow && Number(balanceRow.balance) >= amount) {
      return { ok: true, ref: 'prepaid', spendPrepaid: amount };
    }

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
          OR: [{ externalRef: { not: null } }, { status: 'UNKNOWN' }],
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      for (const prior of priors) {
        // An UNKNOWN intent with no provider id can't be looked up — the
        // poller owns it (history adoption or TTL expiry). Never fire a new
        // request over a live UNKNOWN [LAW M-5].
        if (!prior.externalRef) {
          if (prior.status === 'UNKNOWN') return { ok: false, deferred: true };
          continue;
        }
        let priorStatus: string;
        try {
          priorStatus = (await mmg.transactionLookup({ transactionId: prior.externalRef })).status;
        } catch {
          return { ok: false, deferred: true, reopenPaymentId: prior.id }; // MMG down — never fire blind
        }
        if (priorStatus === 'approved') return { ok: true, ref: prior.externalRef, settlePaymentId: prior.id };
        if (priorStatus === 'pending') return { ok: false, deferred: true, reopenPaymentId: prior.id };
      }

      // §13 MMG rail — merchant-initiated. Amounts are minor units at the
      // provider seam; the reference doubles as the retry-safe correlation id
      // AND lands on the intent row as clientKey (the key that survives an
      // initiate timeout, when MMG's own id never came back).
      const reference = this.mmgReference(sub);

      // [TA-S0-002 / M-03] THE INTENT BEFORE THE EFFECT. The row used to be
      // written AFTER MMG answered — so a process that died between MMG
      // accepting the request and the row landing left a live prompt on the
      // payer's phone that nothing here could poll, settle, bank or retry,
      // while the next run collided on the attempt key and skipped forever.
      // Now the durable intent (UNKNOWN, our clientKey, no provider id yet)
      // exists before MMG is asked; every outcome below settles THAT row, and
      // a run that dies at any point leaves a row the poller already owns:
      // adopted from MMG's history by our reference, or expired at TTL.
      const intent = await this.reserveMmgIntent(sub, amount, reference);
      if (!intent) return { ok: false, deferred: true }; // this attempt's intent is already live — never a second prompt

      const result = await mmg.initiatePayment({
        payerId: sub.mmgPayerMsisdn,
        amountMinor: Math.round(amount * 100),
        currencyCode: sub.currencyCode,
        reference,
      });
      if (result.status === 'approved') return { ok: true, ref: result.transactionId, settlePaymentId: intent.id };
      if (result.status === 'pending' && result.transactionId) {
        return { ok: false, pendingTx: result.transactionId, clientKey: reference, expiresAt: new Date(Date.now() + MMG_REQUEST_TTL_MS), intentId: intent.id };
      }
      if (result.status === 'error' || result.status === 'pending') {
        // Transport-shaped (or pending with no id to poll by): the request
        // MAY be live on the payer's phone — UNKNOWN, owned by the poller.
        return { ok: false, unknown: true, clientKey: reference, failureRaw: result.reason, intentId: intent.id };
      }
      // MMG answered "no" (declined / reversed / expired at initiate): the
      // intent closes as FAILED on the same row, with the normalized code.
      const failureCode = mapMmgFailure(result.status, result.reason);
      // [M-04] The intent is NOT flipped here. billSubscription terminalizes
      // it together with the CHARGE_FAILED event and the dunning state in one
      // transaction; a flip here followed by a crash left a FAILED row whose
      // outcome never landed.
      return { ok: false, reason: result.reason ?? 'MMG request failed', failureCode, intentId: intent.id, ...(result.reason ? { failureRaw: result.reason } : {}) };
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
    /** Prepaid rail: debit this much inside the same transaction. */
    spendPrepaid?: number,
  ) {
    // One transaction for the whole advance [tollgate M-13]: the prepaid debit,
    // payment row, period move, audit event, and the balanced ledger posting
    // commit or roll back together — a crash can no longer strand a captured
    // payment without its period (or books without their entry), NOR spend a
    // payer's credit without granting the week [PAY-1 M0 S0]. Racing settlers
    // converge on identical absolute period values; the CHARGE_SUCCESS unique
    // key rolls the loser back whole.
    await this.prisma.$transaction(async (tx) => {
      await this.applySuccessfulChargeInTx(tx, sub, amount, paymentRef, now, periodKey, settlePaymentId, usdTrio, spendPrepaid);
    });
    await this.afterSuccessfulCharge(sub, amount, periodKey);
  }

  /** The transactional core of a successful charge — callable inside a LARGER
   *  transaction (the poller claims and advances atomically through here;
   *  SWIFT-004's full closure). Side effects (reinstate, notifications) live
   *  in afterSuccessfulCharge, outside any transaction. */
  private async applySuccessfulChargeInTx(
    tx: Prisma.TransactionClient,
    sub: SubWithRelations,
    amount: number,
    paymentRef: string,
    now: Date,
    periodKey: string,
    settlePaymentId?: string,
    usdTrio?: { amountUsd: number; fxRateId: string; fxRateUsed: number },
    spendPrepaid?: number,
  ) {
    const periodStart = sub.nextBillingDate;
    const periodEnd = new Date(periodStart.getTime() + WEEK_MS);

    // THE PREPAID SPEND — first, and inside this transaction, so the money and
    // the week it buys share one fate [PAY-1 M0 S0]. Still the atomic
    // conditional decrement, so it is still the race guard: if a concurrent
    // settler spent the balance between attemptCharge's read and here, count is
    // 0 and we throw, rolling back the payment row, the period move and the
    // ledger entry with it. The cycle simply retries. Skipping a week is
    // recoverable; taking money without granting service is not.
    if (spendPrepaid && spendPrepaid > 0) {
      const debited = await tx.prepaidBalance.updateMany({
        where: { subscriptionId: sub.id, balance: { gte: spendPrepaid } },
        data: { balance: { decrement: spendPrepaid } },
      });
      if (debited.count !== 1) {
        throw new Error(`prepaid balance no longer covers ${spendPrepaid} for subscription ${sub.id}`);
      }
    }

    if (settlePaymentId) {
      // A guard-detected late approval carries the row's own externalRef
      // (same value); a reserved intent approved at initiate learns it here.
      await tx.subscriptionPayment.update({
        where: { id: settlePaymentId },
        data: { status: 'CAPTURED', paidAt: now, externalRef: paymentRef, failureCode: null },
      });
    } else {
      await tx.subscriptionPayment.create({
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

    await tx.subscription.update({
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

    await tx.billingEvent.create({
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

    if (amount > 0) {
      const rail = paymentRef === 'prepaid' ? 'prepaid' : sub.billingMethod === 'CARD' ? 'CARD' : 'EXTERNAL';
      await postLedger(tx, {
        idempotencyKey: `ledger:success:${sub.id}:${periodKey}`,
        description: `Weekly fee collected (${rail === 'prepaid' ? 'prepaid balance' : sub.billingMethod}) — ${sub.type}`,
        occurredAt: now,
        entries: chargeSuccessPostings(sub.id, amount, rail),
      });
    }
  }

  /** Post-commit side effects of a successful charge. `sub` is the pre-charge
   *  snapshot — its status tells us whether this payment ended an
   *  interruption. */
  private async afterSuccessfulCharge(sub: SubWithRelations, amount: number, periodKey: string) {
    const wasInterrupted = sub.status === 'PAST_DUE' || sub.status === 'SUSPENDED' || sub.status === 'CHURNED';
    const periodEnd = new Date(sub.nextBillingDate.getTime() + WEEK_MS);

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

  /** The one wallet-credit tail every rail funnels through [LAW M-1], inside
   *  the caller's transaction: audit event (unique key = the exactly-once
   *  funnel), gapless receipt, balanced ledger posting, balance bump —
   *  all-or-nothing. recordTopUp wraps it; the poller banks late approvals
   *  through it. */
  private async creditWalletInTx(
    tx: Prisma.TransactionClient,
    opts: { subscriptionId: string; amount: number; currencyCode: string; eventKey: string; note: string; channel: string; mmgRef?: string },
  ) {
    const event = await tx.billingEvent.create({
      data: {
        subscriptionId: opts.subscriptionId,
        type: 'PREPAID_TOPUP',
        amount: opts.amount,
        currencyCode: opts.currencyCode,
        idempotencyKey: opts.eventKey,
        note: opts.note,
      },
    });
    // Every credit issues a sequential GRA-ready receipt [san spec 20.1]
    // inside the SAME tx — a replay rolls the receipt (and its counter claim)
    // back with it, so numbers stay gapless.
    const { issueReceipt } = await import('./receipts');
    await issueReceipt(tx, {
      subscriptionId: opts.subscriptionId,
      billingEventId: event.id,
      amount: opts.amount,
      channel: opts.channel,
      mmgRef: opts.mmgRef,
    });
    // Balanced books in the same tx [tollgate M-13]: money in from the
    // collection rail, owed to the payer's wallet until a week consumes it.
    await postLedger(tx, {
      idempotencyKey: `ledger:${opts.eventKey}`,
      description: `Wallet credit via ${opts.channel}${opts.mmgRef ? ` (${opts.mmgRef})` : ''}`,
      entries: topupPostings(opts.subscriptionId, opts.amount),
    });
    return tx.prepaidBalance.upsert({
      where: { subscriptionId: opts.subscriptionId },
      update: { balance: { increment: opts.amount } },
      create: { subscriptionId: opts.subscriptionId, balance: opts.amount, currencyCode: opts.currencyCode },
    });
  }

  /**
   * §13 MMG rail poller (BullMQ repeatable, ~2 min) — the intent machine's
   * resolution engine. Approved → claim AND advance in ONE transaction (the
   * full closure of SWIFT-004: a crash between claim and advance can no
   * longer strand a captured payment); if the week is already covered, the
   * money BANKS as wallet balance [tollgate BE-08] — a payer's approval is
   * never dropped. Declined/expired → the normal dunning path with a
   * normalized failure code. UNKNOWN intents (initiate timed out, no provider
   * id) are adopted from transaction history by our reference, or expire at
   * TTL [tollgate 6.6]. Rows poll on a per-row backoff ladder (30s→5m,
   * jittered), stamped BEFORE the provider call so a crash can't hot-loop.
   */
  async pollPendingMmgCharges(
    now = new Date(),
  ): Promise<{ settled: number; banked: number; adopted: number; failed: number; stillPending: number }> {
    const candidates = await this.prisma.subscriptionPayment.findMany({
      where: { status: { in: ['PENDING', 'UNKNOWN'] }, paymentMethod: 'MOBILE_MONEY' },
      orderBy: { lastPolledAt: { sort: 'asc', nulls: 'first' } },
      take: 400,
    });
    // Per-row backoff can't be expressed in one Prisma where — post-filter.
    const pending = candidates
      .filter((p) => !p.lastPolledAt || p.lastPolledAt.getTime() + p.pollBackoffSec * 1000 <= now.getTime())
      .slice(0, 200);
    const out = { settled: 0, banked: 0, adopted: 0, failed: 0, stillPending: 0 };
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
      const ttlAt = payment.expiresAt ?? new Date(payment.createdAt.getTime() + MMG_REQUEST_TTL_MS);

      // Stamp the poll clock FIRST — a crash mid-item degrades to a slower
      // retry, never a hot loop against the provider.
      await this.prisma.subscriptionPayment
        .updateMany({ where: { id: payment.id }, data: { lastPolledAt: now, pollBackoffSec: jitter(nextBackoff(payment.pollBackoffSec)) } })
        .catch(() => {});

      // ── UNKNOWN with no provider id: initiate timed out [tollgate 6.6] ──
      if (!payment.externalRef) {
        try {
          const recent = await mmg.transactionHistory({ from: payment.createdAt, limit: 100 });
          const match = payment.clientKey ? recent.find((t) => t.reference === payment.clientKey) : undefined;
          if (match) {
            // The request DID land — adopt MMG's id; the next tick resolves
            // it like any pending row (approved settles, declined duns).
            const adopted = await this.prisma.subscriptionPayment.updateMany({
              where: { id: payment.id, status: 'UNKNOWN', externalRef: null },
              data: { externalRef: match.transactionId, status: 'PENDING', failureCode: null },
            });
            if (adopted.count === 1) out.adopted += 1;
            continue;
          }
        } catch {
          out.stillPending += 1; // provider unreachable — UNKNOWN stays UNKNOWN [LAW M-5]
          continue;
        }
        if (now >= ttlAt) {
          // 6.6(c): the create itself had timed out AND the provider has no
          // record by our reference after the TTL — safe to close and dun.
          // [M-04] Terminal status and dunning outcome land in ONE transaction,
          // behind the same per-row boundary the lookup branch has: one row's
          // failure must never abort the sweep for every other payer.
          try {
            const outcome = await this.terminalizeFailedPayment(
              sub as SubWithRelations, payment, { status: 'EXPIRED', failureCode: 'REQUEST_EXPIRED', from: ['UNKNOWN'] },
              'MMG request lost in transit — never confirmed at MMG', now, periodKey,
            );
            if (!outcome) continue;
            out.failed += 1;
          } catch (err) {
            log().error({ err, paymentId: payment.id, subscriptionId: sub.id }, 'MMG poll expiry failed for one payment — continuing');
          }
        } else {
          out.stillPending += 1;
        }
        continue;
      }

      let status: string;
      let reportedMinor = 0;
      let reportedCurrency = '';
      try {
        const lookup = await mmg.transactionLookup({ transactionId: payment.externalRef });
        status = lookup.status;
        reportedMinor = lookup.amountMinor ?? 0;
        reportedCurrency = String(lookup.currencyCode ?? '').toUpperCase();
      } catch {
        out.stillPending += 1; // transport hiccup — the next tick retries
        continue;
      }

      // USD pricing Part 10 rule 3 / SO-6 posture: the settled amount must
      // match OUR amount and currency exactly. Missing/zero provider amounts
      // are mismatches too; approval alone is never proof of the right funds.
      const expectedMinor = Math.round(Number(payment.amount) * 100);
      const expectedCurrency = sub.currencyCode.toUpperCase();
      if (status === 'approved' && (reportedMinor !== expectedMinor || reportedCurrency !== expectedCurrency)) {
        try {
          await this.prisma.subscriptionPayment.updateMany({
            where: { id: payment.id, status: { in: ['PENDING', 'UNKNOWN'] } },
            data: { failureCode: 'AMOUNT_MISMATCH' },
          });
          await this.prisma.billingEvent.create({
            data: {
              subscriptionId: sub.id,
              type: 'REMINDER',
              currencyCode: sub.currencyCode,
              idempotencyKey: `mismatch:${payment.id}`,
              note: `RECONCILE_MISMATCH: MMG reports ${(reportedMinor / 100).toFixed(2)} ${reportedCurrency || '(missing currency)'} vs our ${Number(payment.amount).toFixed(2)} ${expectedCurrency} (payment ${payment.id})`,
            },
          });
          await notifyAdmins(this.prisma, this.notifications, {
            // Scoped to the payer's tenant [NOC-A F45].
            tenantId: await tenantOfSubscription(this.prisma, payment.subscriptionId),
            title: '⚠️ Payment settlement mismatch — held for review',
            body: `MMG did not confirm the exact amount and currency requested for a weekly-fee payment. It is NOT settled. Payment ${payment.id}.`,
            data: { kind: 'reconcile_mismatch', paymentId: payment.id, subscriptionId: sub.id },
          });
        } catch {
          /* already flagged — the dedup key holds */
        }
        out.stillPending += 1;
        continue;
      }

      const expired = status === 'expired' || (status === 'pending' && now.getTime() >= ttlAt.getTime());

      // SWIFT-AUD-D2-04, completed: settle is single-winner AND atomic. The
      // CAS claim now lives INSIDE the same transaction as the period advance
      // (or the bank), so a crash between them is impossible — the claim
      // rolls back with everything else and the next tick retries whole.
      try {
        if (status === 'approved') {
          // USD pinning across the async settle: the ATTEMPT's trio is the
          // truth — never re-price a late approval at today's rate.
          const trio = await this.pinnedTrioFor(sub.id, periodKey);
          const result = await this.prisma.$transaction(async (tx) => {
            const claimed = await tx.subscriptionPayment.updateMany({
              where: { id: payment.id, status: { in: ['PENDING', 'UNKNOWN'] } },
              data: { status: 'CAPTURED', paidAt: now, failureCode: null },
            });
            if (claimed.count === 0) return 'lost'; // another settler won this row
            const covered = await tx.billingEvent.findUnique({
              where: { idempotencyKey: `success:${sub.id}:${periodKey}` },
              select: { id: true },
            });
            if (covered) {
              // BE-08: another rail (cash top-up, prepaid) already paid this
              // week. The payer's approved money BANKS as wallet balance —
              // never double-charges the week, never silently vanishes.
              await this.creditWalletInTx(tx, {
                subscriptionId: sub.id,
                amount: Number(payment.amount),
                currencyCode: sub.currencyCode,
                eventKey: `bank:${payment.id}`,
                note: `late MMG approval banked — week ${periodKey} already covered (payment ${payment.id})`,
                channel: 'MMG_LATE_APPROVAL',
                mmgRef: payment.externalRef ?? undefined,
              });
              return 'banked';
            }
            await this.applySuccessfulChargeInTx(tx, sub as SubWithRelations, Number(payment.amount), payment.externalRef!, now, periodKey, payment.id, trio);
            return 'advanced';
          });
          if (result === 'lost') continue;
          if (result === 'banked') {
            out.banked += 1;
            await this.notifications.send({
              userId: this.payerUserId(sub as SubWithRelations),
              type: 'SYSTEM_ANNOUNCEMENT',
              title: 'MMG payment received — added to your balance',
              body: `Your MMG approval of $${Number(payment.amount).toLocaleString()} ${sub.currencyCode} arrived after this week was already paid. It's banked as balance and will cover your next week.`,
              audience: this.payerAudience(sub as SubWithRelations),
              data: { kind: 'billing_banked', subscriptionId: sub.id },
            }).catch(() => {});
            continue;
          }
          await this.afterSuccessfulCharge(sub as SubWithRelations, Number(payment.amount), periodKey);
          out.settled += 1;
        } else if (status === 'declined' || status === 'reversed' || expired) {
          // [M-04] Terminal status and dunning outcome land in ONE transaction.
          const outcome = await this.terminalizeFailedPayment(
            sub as SubWithRelations, payment,
            { status: expired ? 'EXPIRED' : 'FAILED', failureCode: expired ? 'REQUEST_EXPIRED' : mapMmgFailure(status), from: ['PENDING', 'UNKNOWN'] },
            `MMG request ${expired ? 'expired unapproved' : status}`, now, periodKey,
          );
          if (!outcome) continue;
          out.failed += 1;
        } else {
          out.stillPending += 1;
        }
      } catch (err) {
        // The whole claim+advance rolled back together — the row is still
        // claimable and the next tick retries it whole. Loud log so a
        // persistent failure surfaces instead of aging silently.
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

  /**
   * [M-04 · operations clause] The repair pass the spec asks for: "find
   * terminal payments lacking matching failure events/counters and repair
   * idempotently; observe terminal-without-outcome count and age."
   *
   * Since #994 the terminal status and the outcome commit together, so this
   * finds only what the pre-transactional code left behind (a FAILED/EXPIRED
   * row whose period has neither a CHARGE_FAILED nor a success event) — and
   * anything a future regression leaves, which is why it runs on every poll
   * tick and reports through the gauge. A subscription that has since left
   * the live states is not re-dunned.
   */
  async reconcileTerminalWithoutOutcome(now = new Date(), windowDays = 30): Promise<{ scanned: number; repaired: number; stillOpen: number; oldestMinutes: number | null }> {
    const since = new Date(now.getTime() - windowDays * 86_400_000);
    const terminal = await this.prisma.subscriptionPayment.findMany({
      where: { paymentMethod: 'MOBILE_MONEY', status: { in: ['FAILED', 'EXPIRED'] }, createdAt: { gte: since } },
      select: { id: true, subscriptionId: true, amount: true, periodStart: true, createdAt: true, lastPolledAt: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    let repaired = 0;
    let stillOpen = 0;
    let oldestMinutes: number | null = null;
    for (const p of terminal) {
      const periodKey = p.periodStart.toISOString().slice(0, 10);
      const [failure, success] = await Promise.all([
        this.prisma.billingEvent.findFirst({
          where: { subscriptionId: p.subscriptionId, type: 'CHARGE_FAILED', idempotencyKey: { startsWith: `failed:${p.subscriptionId}:${periodKey}:` } },
          select: { id: true },
        }),
        this.prisma.billingEvent.findUnique({ where: { idempotencyKey: `success:${p.subscriptionId}:${periodKey}` }, select: { id: true } }),
      ]);
      if (failure || success) continue;
      // The row records no terminalization time; the last poll (or creation) bounds the gap's age from below.
      const ageMinutes = Math.round((now.getTime() - (p.lastPolledAt ?? p.createdAt).getTime()) / 60_000);
      oldestMinutes = oldestMinutes == null ? ageMinutes : Math.max(oldestMinutes, ageMinutes);
      const sub = await this.prisma.subscription.findUnique({
        where: { id: p.subscriptionId },
        include: {
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          vendor: { select: { id: true, owner: { select: { userId: true } } } },
        },
      });
      if (!sub || !['ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(sub.status)) {
        stillOpen += 1; // a gap on a closed subscription is recorded, never re-dunned
        continue;
      }
      try {
        await this.applyFailedCharge(sub as SubWithRelations, Number(p.amount), 'Terminal MMG payment without a recorded outcome — repaired by reconciliation', now, periodKey);
        repaired += 1;
        billingOutcomeRepairsCounter.inc();
      } catch (err) {
        stillOpen += 1;
        log().error({ err, paymentId: p.id, subscriptionId: p.subscriptionId }, '[M-04] repair of a terminal payment without outcome failed — continuing');
      }
    }
    billingTerminalWithoutOutcomeGauge.set({ measure: 'count' }, stillOpen);
    billingTerminalWithoutOutcomeGauge.set({ measure: 'oldest_minutes' }, stillOpen > 0 ? (oldestMinutes ?? 0) : 0);
    if (repaired > 0 || stillOpen > 0) {
      log().warn({ scanned: terminal.length, repaired, stillOpen, oldestMinutes }, '[M-04] terminal MMG payments without a recorded outcome');
    }
    return { scanned: terminal.length, repaired, stillOpen, oldestMinutes };
  }

  /**
   * [M-04] A failed charge is ONE durable transition: the CHARGE_FAILED event
   * (created if absent — the F-013-09 repair path arrives with it already
   * recorded), the dunning counter, the subscription's PAST_DUE or SUSPENDED
   * state and, on suspension, the access rows and the SUSPENDED event — all
   * on the caller's transaction. Idempotent for a given subscription
   * snapshot: every value written is absolute (`failedAttempts + 1` from the
   * snapshot), so a repeat with the same snapshot lands the same row.
   */
  private async recordFailureInTx(
    tx: Prisma.TransactionClient,
    sub: SubWithRelations,
    amount: number,
    reason: string,
    now: Date,
    periodKey: string,
  ): Promise<FailureOutcome> {
    const failedKey = `failed:${sub.id}:${periodKey}:a${sub.failedAttempts}`;
    const recorded = await tx.billingEvent.findUnique({ where: { idempotencyKey: failedKey }, select: { id: true } });
    if (!recorded) {
      await tx.billingEvent.create({
        data: {
          subscriptionId: sub.id,
          type: 'CHARGE_FAILED',
          amount,
          currencyCode: sub.currencyCode,
          idempotencyKey: failedKey,
          note: reason,
        },
      });
    }
    const attempts = sub.failedAttempts + 1;
    const willSuspend = attempts >= MAX_FAILED_ATTEMPTS && sub.autoSuspendEnabled;
    const nextRetryAt = new Date(now.getTime() + RETRY_HOURS * 60 * 60 * 1000);
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status: (willSuspend ? 'SUSPENDED' : 'PAST_DUE') as SubscriptionStatus,
        failedAttempts: attempts,
        nextRetryAt,
        isInGracePeriod: !willSuspend,
        gracePeriodEnd: willSuspend ? null : nextRetryAt,
        ...(willSuspend ? { suspendedAt: now } : {}),
      },
    });
    if (willSuspend) await this.suspendAccessRows(tx, sub, periodKey);
    return { attempts, willSuspend, nextRetryAt, finalWarning: attempts === MAX_FAILED_ATTEMPTS - 1 && sub.autoSuspendEnabled };
  }

  /** [M-04] Post-commit notices for a failure outcome — best effort, never
   *  part of the transaction. (An outbox for these is the registered
   *  follow-up; today a lost notice is a lost notice, not a lost state.) */
  private async afterFailureNotices(sub: SubWithRelations, outcome: FailureOutcome, reason: string): Promise<void> {
    if (outcome.willSuspend) {
      await this.suspendAccessNotices(sub);
      return;
    }
    const { attempts, nextRetryAt, finalWarning } = outcome;
    if (finalWarning) {
      const when = nextRetryAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      await this.notifications.send({
        userId: this.payerUserId(sub),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Final warning — payment needed',
        body: `${reason}. Your subscription will be SUSPENDED at ${when} unless the weekly fee is paid. Pay now to keep operating.`,
        audience: this.payerAudience(sub),
        data: { kind: 'billing_final_warning', subscriptionId: sub.id, suspendsAt: nextRetryAt.toISOString() },
      }).catch(() => {});
      await this
        .smsPayer(sub, `Swift: your weekly fee is unpaid. Your account will be suspended at ${when} unless you pay. Open the app to pay now.`)
        .catch(() => {});
      await notifyAdmins(this.prisma, this.notifications, {
        tenantId: await tenantOfUser(this.prisma, sub.rider?.userId ?? sub.driver?.userId ?? sub.vendor?.owner.userId ?? null),
        title: 'Dunning — final warning issued',
        body: `Subscription ${sub.id} suspends at ${when} (attempt ${attempts}/${MAX_FAILED_ATTEMPTS}). Contact the payer directly before access is cut.`,
        data: { kind: 'billing_dunning_ops_task', subscriptionId: sub.id, suspendsAt: nextRetryAt.toISOString() },
      }).catch(() => {});
      return;
    }
    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Subscription payment failed',
      body: `${reason}. We will retry tomorrow (attempt ${attempts} of ${MAX_FAILED_ATTEMPTS}). Top up or update your card to stay active.`,
      audience: this.payerAudience(sub),
      data: { kind: 'billing_failed', subscriptionId: sub.id },
    }).catch(() => {});
  }

  /**
   * [M-04] A payment row's terminal failure AND its consequences, atomically:
   * the compare-and-set to FAILED/EXPIRED claims the row for exactly one
   * caller, and the event, the counter, the subscription state and (on
   * suspension) the access rows commit with it or not at all. Before this,
   * the row was flipped in one statement and the rest applied afterwards, so
   * a crash in between left a payment nobody polled and a subscription
   * nobody retried or suspended. Returns null when another settler already
   * claimed the row.
   */
  private async terminalizeFailedPayment(
    sub: SubWithRelations,
    payment: { id: string; amount: Prisma.Decimal | number },
    terminal: { status: 'FAILED' | 'EXPIRED'; failureCode: string; from: Array<'PENDING' | 'UNKNOWN'>; requireNoExternalRef?: boolean; failureRaw?: string },
    reason: string,
    now: Date,
    periodKey: string,
  ): Promise<'failed' | 'suspended' | null> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.subscriptionPayment.updateMany({
        where: { id: payment.id, status: { in: terminal.from }, ...(terminal.requireNoExternalRef ? { externalRef: null } : {}) },
        data: { status: terminal.status, failureCode: terminal.failureCode, ...(terminal.failureRaw ? { failureRaw: { reason: terminal.failureRaw } } : {}) },
      });
      if (claimed.count === 0) return null;
      await this.observer.afterPaymentTerminalized?.({ id: payment.id, status: terminal.status });
      return this.recordFailureInTx(tx, sub, Number(payment.amount), reason, now, periodKey);
    });
    if (!outcome) return null;
    await this.afterFailureNotices(sub, outcome, reason);
    return outcome.willSuspend ? 'suspended' : 'failed';
  }

  /** A failed charge with no payment row of its own (the card and prepaid
   *  rails, and the F-013-09 repair of an already-recorded failure): the same
   *  one transition, on its own transaction. */
  private async applyFailedCharge(
    sub: SubWithRelations,
    amount: number,
    reason: string,
    now: Date,
    periodKey: string,
  ): Promise<'failed' | 'suspended'> {
    const outcome = await this.prisma.$transaction((tx) => this.recordFailureInTx(tx, sub, amount, reason, now, periodKey));
    await this.afterFailureNotices(sub, outcome, reason);
    return outcome.willSuspend ? 'suspended' : 'failed';
  }

  /** Suspension row writes — MUST run on the same transaction that flips the
   *  subscription status, so the authority is one generation [REPORT-012
   *  F-012-05]. Notifications live in suspendAccessNotices (post-commit). */
  private async suspendAccessRows(tx: Prisma.TransactionClient, sub: SubWithRelations, periodKey: string) {
    if (sub.vendor) {
      // SUSPENDED vendors vanish from customer browse (which filters ACTIVE)
      await tx.vendor.update({
        where: { id: sub.vendor.id },
        data: { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING' },
      });
    }
    if (sub.rider) {
      await tx.rider.updateMany({
        where: { userId: sub.rider.userId },
        data: { isOnline: false, isAvailable: false },
      });
    }
    if (sub.driver) {
      await tx.driver.updateMany({
        where: { userId: sub.driver.userId },
        data: { isOnline: false, isAvailable: false },
      });
    }

    await tx.billingEvent.create({
      data: {
        subscriptionId: sub.id,
        type: 'SUSPENDED',
        currencyCode: sub.currencyCode,
        idempotencyKey: `suspended:${sub.id}:${periodKey}`,
        note: `Auto-suspended after ${MAX_FAILED_ATTEMPTS} failed charges`,
      },
    });
  }

  /** Post-commit suspension side effects (push + SMS). */
  private async suspendAccessNotices(sub: SubWithRelations) {
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
      // [REPORT-013 F-013-07] Payment restores ONLY what billing took. The
      // lifecycle CAS matches a billing-caused suspension exclusively — an
      // admin/safety suspension survives payment. Commerce reopens only
      // where the projection-maintained document truth (isVerified, kept
      // in-generation by every evidence path since v10) still stands: a
      // store whose documents died mid-suspension comes back ACTIVE but
      // closed, never a blind acceptingOrders=true.
      // Transition rule: a pre-migration suspension has a null source; the
      // only AUTOMATED suspender has always been billing, so null lifts with
      // payment (an admin can always re-suspend, which stamps ADMIN).
      await this.prisma.vendor.updateMany({
        where: {
          id: sub.vendor.id,
          status: 'SUSPENDED',
          OR: [{ suspensionSource: 'BILLING' }, { suspensionSource: null }],
        },
        data: { status: 'ACTIVE', suspensionSource: null },
      });
      await this.prisma.vendor.updateMany({
        where: { id: sub.vendor.id, status: 'ACTIVE', isVerified: true },
        data: { acceptingOrders: true },
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

  /**
   * Transaction-attached wallet credit. Money-rail callers that also own an
   * inbound payment row use this seam so the immutable billing event, receipt,
   * balanced ledger posting, wallet balance, and payment-state CAS commit as
   * one database operation. It deliberately performs no notification or
   * re-bill; those are post-commit effects handled by afterTopUpCommitted().
   */
  async recordTopUpInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      subscriptionId: string;
      amount: number;
      recordedBy: string;
      reference?: string;
      /** Globally unique for the real-world payment, not the destination. */
      eventKey: string;
    },
  ) {
    if (input.amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Top-up must be positive');
    const sub = await tx.subscription.findUnique({
      where: { id: input.subscriptionId },
      select: { id: true, currencyCode: true },
    });
    if (!sub) throw new NotFoundError('Subscription', input.subscriptionId);

    return this.creditWalletInTx(tx, {
      subscriptionId: input.subscriptionId,
      amount: input.amount,
      currencyCode: sub.currencyCode,
      eventKey: input.eventKey,
      note: input.reference
        ? `ref: ${input.reference} (by ${input.recordedBy})`
        : `recorded by ${input.recordedBy}`,
      channel: input.recordedBy.startsWith('agent-cash:')
        ? input.recordedBy.slice('agent-cash:'.length)
        : 'ADMIN_TOPUP',
      mmgRef: input.reference,
    });
  }

  /** Post-commit effects for a durable top-up. A caller may safely retry this
   * method: it moves no money; the billing engine's own event keys make an
   * immediate re-bill idempotent. */
  async afterTopUpCommitted(subscriptionId: string, amount: number): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
    });
    if (!sub) throw new NotFoundError('Subscription', subscriptionId);

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
      await this.billSubscription(sub as SubWithRelations);
    }
  }

  async recordTopUp(subscriptionId: string, amount: number, recordedBy: string, reference: string | undefined, clientKey: string) {
    if (amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Top-up must be positive');

    // Idempotency [SWIFT-030]: this is the only live collection path, so a retry
    // (network retry, admin double-tap) MUST NOT credit twice. The caller's
    // key makes the retry a no-op. [M-08] There is no longer a time-based
    // fallback: a top-up without a key was a top-up that could double on a
    // lost response, so the key is REQUIRED. The BillingEvent's unique
    // idempotencyKey is the DB-level guard — created FIRST inside the transaction,
    // so a replay rolls the whole thing back before the balance is ever touched.
    if (!isUsableTopUpKey(clientKey)) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', `A top-up needs an idempotency key of ${TOPUP_KEY_MIN}–${TOPUP_KEY_MAX} characters — the same key on a retry returns the same result instead of crediting twice.`);
    }
    const eventKey = `topup:${subscriptionId}:${clientKey}`;

    let balance;
    try {
      balance = await this.prisma.$transaction(async (tx) =>
        this.recordTopUpInTransaction(tx, {
          subscriptionId,
          amount,
          recordedBy,
          reference,
          eventKey,
        }),
      );
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        // Replay of an already-recorded top-up: return the current balance
        // without crediting again, notifying, or re-billing.
        return this.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId } });
      }
      throw error;
    }

    await this.afterTopUpCommitted(subscriptionId, amount);

    return balance;
  }

  /** [M-08] The prepaid top-up as ONE command. The admin's key and the
   *  request's fingerprint own the result: the same key with the same request
   *  replays the stored answer; the same key with a different request is
   *  refused. The credit, its receipt, the balanced ledger posting, the audit
   *  row and the command itself commit together; the downstream tail (payer
   *  notice + immediate re-bill) is recorded as owed on the command and run
   *  after the commit — a failure there leaves it owed, and the billing poll
   *  drains it. One inbound payment, one converged command. */
  async recordTopUpCommand(input: {
    adminId: string;
    idempotencyKey: string;
    requestHash: string;
    subscriptionId: string;
    amount: number;
    reference?: string;
    audit?: { ipAddress?: string; userAgent?: string };
  }): Promise<{ replayed: boolean; commandId: string; result: TopUpCommandResult }> {
    if (input.amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Top-up must be positive');
    if (!isUsableTopUpKey(input.idempotencyKey)) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', `A top-up needs an Idempotency-Key header of ${TOPUP_KEY_MIN}–${TOPUP_KEY_MAX} characters — the same key on a retry returns the same result instead of crediting twice.`);
    }
    const where = { adminId_idempotencyKey: { adminId: input.adminId, idempotencyKey: input.idempotencyKey } };
    const replay = (row: { id: string; requestHash: string; result: unknown }) => {
      if (row.requestHash !== input.requestHash) {
        billingTopupDuplicateFingerprintCounter.inc();
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This key was already used for a different top-up — a new top-up needs a new key.');
      }
      return { replayed: true, commandId: row.id, result: row.result as TopUpCommandResult };
    };
    const existing = await this.prisma.topUpCommand.findUnique({ where, select: { id: true, requestHash: true, result: true } });
    if (existing) return replay(existing);

    const eventKey = `topup:${input.subscriptionId}:${input.idempotencyKey}`;
    let command: { id: string; result: unknown };
    try {
      command = await this.prisma.$transaction(async (tx) => {
        const balance = await this.recordTopUpInTransaction(tx, {
          subscriptionId: input.subscriptionId,
          amount: input.amount,
          recordedBy: input.adminId,
          reference: input.reference,
          eventKey,
        });
        const event = await tx.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: eventKey }, select: { id: true } });
        // The operational evidence is part of the command, not a hope after it.
        await tx.auditLog.create({
          data: {
            userId: input.adminId,
            action: 'PREPAID_TOPUP',
            entity: 'Subscription',
            entityId: input.subscriptionId,
            changes: { amount: input.amount, reference: input.reference ?? null, idempotencyKey: input.idempotencyKey, billingEventId: event.id } as never,
            ipAddress: input.audit?.ipAddress,
            userAgent: input.audit?.userAgent,
          },
        });
        const result: TopUpCommandResult = { balance: Number(balance.balance), currencyCode: balance.currencyCode, billingEventId: event.id };
        const row = await tx.topUpCommand.create({
          data: {
            adminId: input.adminId,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            subscriptionId: input.subscriptionId,
            amount: input.amount,
            reference: input.reference ?? null,
            billingEventId: event.id,
            result: result as never,
          },
          select: { id: true, result: true },
        });
        await this.observer.afterTopUpCommandStaged?.();
        return row;
      });
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        // A concurrent request with the same key won the race: answer its result.
        const winner = await this.prisma.topUpCommand.findUnique({ where, select: { id: true, requestHash: true, result: true } });
        if (winner) return replay(winner);
      }
      throw error;
    }
    await this.runTopUpTail(command.id);
    return { replayed: false, commandId: command.id, result: command.result as TopUpCommandResult };
  }

  /** The command's downstream tail: the payer's notice and, while behind, an
   *  immediate re-bill. Never throws to the caller — the credit stands; an
   *  incomplete tail stays owed on the command and the poll retries it. */
  async runTopUpTail(commandId: string): Promise<boolean> {
    const command = await this.prisma.topUpCommand.findUniqueOrThrow({ where: { id: commandId } });
    if (command.tailDoneAt) return true;
    try {
      await this.afterTopUpCommitted(command.subscriptionId, Number(command.amount));
      await this.prisma.topUpCommand.update({ where: { id: commandId }, data: { tailDoneAt: new Date(), lastError: null } });
      return true;
    } catch (err) {
      await this.prisma.topUpCommand.update({
        where: { id: commandId },
        data: { tailAttempts: { increment: 1 }, lastError: err instanceof Error ? err.message.slice(0, 500) : String(err) },
      }).catch(() => {});
      log().error({ err, commandId, subscriptionId: command.subscriptionId }, '[M-08] top-up committed; its notice / re-bill tail is owed and will be retried');
      return false;
    }
  }

  /** [M-08 · operations] Drain owed tails older than a minute (bounded
   *  attempts), and publish how many remain. Run with every billing poll. */
  async drainTopUpTails(opts: { olderThanMs?: number; limit?: number; maxAttempts?: number } = {}): Promise<{ retried: number; done: number; pending: number }> {
    const olderThan = new Date(Date.now() - (opts.olderThanMs ?? 60_000));
    const owed = await this.prisma.topUpCommand.findMany({
      where: { tailDoneAt: null, createdAt: { lte: olderThan }, tailAttempts: { lt: opts.maxAttempts ?? 10 } },
      orderBy: { createdAt: 'asc' },
      take: opts.limit ?? 50,
      select: { id: true },
    });
    let done = 0;
    for (const row of owed) if (await this.runTopUpTail(row.id)) done += 1;
    const pending = await this.prisma.topUpCommand.count({ where: { tailDoneAt: null } });
    billingTopupTailsPendingGauge.set(pending);
    return { retried: owed.length, done, pending };
  }

  /** [M-08 · operations] Historical unkeyed top-ups (time-based keys from
   *  before the key was required) that look like one payment recorded twice:
   *  the same subscription, amount and reference within a day. Reported for
   *  human review against the provider reference — never reversed here. */
  async scanUnkeyedTopUpDuplicates(): Promise<Array<{ subscriptionId: string; amount: number; note: string | null; count: number }>> {
    const rows = await this.prisma.$queryRaw<Array<{ subscriptionId: string; amount: Prisma.Decimal; note: string | null; count: bigint }>>`
      SELECT "subscriptionId", "amount", "note", count(*)::bigint AS "count"
      FROM "billing_events"
      WHERE "type" = 'PREPAID_TOPUP'
        AND "idempotencyKey" ~ '^topup:[^:]+:[0-9]{13}:'
      GROUP BY "subscriptionId", "amount", "note", date_trunc('day', "createdAt")
      HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 200
    `;
    const found = rows.map((r) => ({ subscriptionId: r.subscriptionId, amount: Number(r.amount), note: r.note, count: Number(r.count) }));
    billingUnkeyedTopupDuplicatesGauge.set(found.length);
    if (found.length > 0) {
      log().warn({ count: found.length, sample: found.slice(0, 10) }, '[M-08] historical unkeyed top-ups that may be one payment recorded twice — review against the provider reference');
    }
    return found;
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
      // A malformed legacy row must not stop every healthy payer's reminder
      // run. Resolve the recipient before writing the immutable REMINDER
      // evidence; otherwise an orphan can acquire the idempotency key without
      // any notification ever being deliverable.
      let payerUserId: string;
      try {
        payerUserId = this.payerUserId(sub as SubWithRelations);
      } catch (error) {
        if (error instanceof AppError && error.code === 'ORPHAN_SUBSCRIPTION') {
          log().error({ subscriptionId: sub.id }, 'billing reminder skipped for orphan subscription');
          continue;
        }
        throw error;
      }

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
        userId: payerUserId,
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
   * Weekly tier check for movers: the band comes from the vehicle they have
   * registered TODAY, not the one they signed up on.
   *
   * Without this a driver who signs up on a car and later buys a minibus keeps
   * paying the standard rate forever — `weeklyRate` is a snapshot taken at
   * signup. Same shape as `recalculateVendorTiers` below, and it shares that
   * method's TIER_CHANGE event so one audit trail covers both.
   */
  async recalculateMoverTiers(): Promise<number> {
    const moverSubs = await this.prisma.subscription.findMany({
      where: {
        OR: [{ riderId: { not: null } }, { driverId: { not: null } }],
        status: { in: ['ACTIVE', 'PAST_DUE', 'TRIAL'] },
      },
      include: {
        rider: { select: { vehicleType: true, user: { select: { countryCode: true } } } },
        driver: { select: { vehicleType: true, user: { select: { countryCode: true } } } },
      },
    });

    let changed = 0;
    for (const sub of moverSubs) {
      const mover = sub.rider ?? sub.driver;
      if (!mover) continue;
      const tiers = await this.countryConfig.getSubscriptionTiers(mover.user.countryCode);
      const targetRate = moverRateFor(tiers, mover.vehicleType);

      // A negotiated rate is a human decision — a vehicle swap must not silently
      // overwrite it. Waived fees are likewise left alone.
      if (sub.customRate != null || sub.feeWaived) continue;
      if (Number(sub.weeklyRate) === targetRate) continue;

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
          note: `vehicle ${mover.vehicleType} -> ${feeBandFor(mover.vehicleType)} band`,
        },
      });
      changed += 1;
    }
    return changed;
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
          select: {
            id: true,
            vendorType: true,
            owner: {
              select: {
                user: { select: { countryCode: true, id: true } },
                _count: { select: { vendors: true } },
              },
            },
          },
        },
      },
    });

    let changed = 0;
    for (const sub of vendorSubs) {
      if (!sub.vendor) continue;
      const tiers = await this.countryConfig.getSubscriptionTiers(sub.vendor.owner.user.countryCode);

      const activeListings = await this.prisma.item.count({
        where: { vendorId: sub.vendor.id, isAvailable: true },
      });
      // The threshold count itself qualifies: "1000+ items" is >= 1000.
      const { rate: targetRate, reason, franchised } = vendorRateFor(tiers, {
        isService: sub.vendor.vendorType === 'SERVICE',
        activeListings,
        ownedStores: sub.vendor.owner._count.vendors,
      });

      // A negotiated rate or a waived fee is a human decision — a catalogue
      // growing past a threshold must never silently overwrite one.
      if (sub.customRate != null || sub.feeWaived) continue;

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
            note: `${activeListings} active listings, ${sub.vendor.owner._count.vendors} owned store(s) -> ${reason} tier${franchised ? ' (franchise discount)' : ''}`,
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
