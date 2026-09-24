import type { OnAudit } from '../../lib/audit-writer';
import { createHash } from 'node:crypto';
import type { PrismaClient, Subscription, SubscriptionPayment, Prisma, SubscriptionStatus } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins, tenantOfUser, tenantOfSubscription } from '../notification/notification.service';
import { getChannels } from '../../providers/notifications/channels';
import { CountryConfigService, partnerRateFor, PricingConfigError, type PartnerRate, type PartnerSubject, type SubscriptionTiers } from '../country/country-config.service';
import type { PaymentProvider } from '../../providers/payment/payment-provider';
import { getMmgProvider } from '../../providers/mmg/mmg-provider';
import type { MmgTransaction, MmgTxResult } from '../../providers/mmg/mmg-provider';
import { convertUsdToLocal, noticeRequired, FX_NOTICE_WINDOW_DAYS } from './fx';
import { postLedger, topupPostings, chargeSuccessPostings } from './ledger';
import { mapCardFailure, mapMmgFailure, type NormalizedFailure } from './failure-taxonomy';
import { log } from '../../utils/logger';
import { billingAttemptReclaimCounter, billingTerminalWithoutOutcomeGauge, billingOutcomeRepairsCounter, billingTopupDuplicateFingerprintCounter, billingTopupDuplicateReferenceCounter, billingTopupTailsPendingGauge, billingUnkeyedTopupDuplicatesGauge, cardChargesReconciledCounter, cardIntentsUnknownGauge, fxChargesIneligibleCounter } from '../../plugins/observability';
import { isDuplicateOn } from '../money/evidence';
import { weeklyFeeFor, weeklyFeeAmount } from './subscription-fee';
import { billingNoticeNote, deliverBillingNoticeByKey, drainPendingBillingNotices, type BillingNotice, type BillingNoticeLeaseGuard } from './billing-notice-delivery';
import { cardRailKilled } from '../../utils/card-rail';

// ---------------------------------------------------------------------------
// BillingService — the one place V1 touches money: Swift's own weekly fee.
// Deterministic code only (hard rule 1). Every money event lands in the
// append-only BillingEvent log; the unique idempotencyKey is the DB-level
// double-charge guard, safe under concurrent job runs.
// ---------------------------------------------------------------------------

const MAX_FAILED_ATTEMPTS = 3;

/** [M-04] What a recorded failure decided — computed and applied inside one transaction. */
type FailureOutcome = { attempts: number; willSuspend: boolean; nextRetryAt: Date; finalWarning: boolean };
type ChargeAttemptResult = (
  /** `spendPrepaid` = debit this much from the prepaid balance INSIDE the
   *  advance transaction, so the money and the week it buys commit together. */
  | { ok: true; ref: string; settlePaymentId?: string; spendPrepaid?: number; mmgEvidence?: MmgTransaction }
  | { ok: false; reason: string; failureCode?: NormalizedFailure; intentId?: string; failureRaw?: string }
  | { ok: false; pendingTx: string; clientKey: string; expiresAt: Date; intentId: string }
  | { ok: false; approvedWithId: MmgTxResult; clientKey: string; intentId: string }
  | { ok: false; approvedWithoutId: MmgTxResult; intentId: string }
  | { ok: false; unknown: true; clientKey: string; failureRaw?: string; intentId: string }
  | { ok: false; deferred: true; reopenPaymentId?: string }
  | { ok: false; dispatchRevoked: true; intentId: string }
) & { rail?: 'MOBILE_MONEY' | 'CARD' };
const RETRY_HOURS = 24;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Local request review threshold. It cannot expire an authorized provider
 * instruction: only a confirmed terminal provider outcome can do that. */
const MMG_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** [DB-028] How long an attempt may sit with no outcome before a later cycle
 *  treats it as abandoned rather than in progress. Longer than any single
 *  billing run — a run that is still inside an attempt is not stale, and the
 *  reclaim is fenced anyway, so this only has to be safely generous. */
const STALE_ATTEMPT_MS = 30 * 60 * 1000;
/** Poll backoff ladder [tollgate 14.1]: 30s → 60s → 2m → 5m cap, ±20% jitter
 *  applied at stamp time. Fresh rows poll fast (the approve-on-phone moment);
 *  old rows stop hammering the provider. */
const POLL_BACKOFF_CAP_SEC = 300;
const nextBackoff = (current: number) => Math.min(POLL_BACKOFF_CAP_SEC, Math.max(30, current * 2));
const jitter = (sec: number) => Math.round(sec * (0.8 + Math.random() * 0.4));
const PRESERVED_NO_DUNNING = 'PRESERVED_NO_DUNNING';
const MMG_APPROVAL_HOLD = 'MMG_APPROVAL_MISMATCH';
const MMG_HISTORY_HOLD = 'MMG_HISTORY_APPROVAL_UNVERIFIED';

type MmgApprovalEvidence = Pick<MmgTransaction, 'transactionId' | 'status'>
  & Partial<Pick<MmgTransaction, 'amountMinor' | 'currencyCode' | 'reference' | 'createdAt'>>
  & { reason?: string };

function usableMmgTransactionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function hasMmgApprovalHold(payment: Pick<SubscriptionPayment, 'paymentMethod' | 'failureCode' | 'failureRaw'>): boolean {
  const raw = payment.failureRaw;
  return payment.paymentMethod === 'MOBILE_MONEY' && (payment.failureCode === 'SETTLEMENT_MISMATCH'
    || payment.failureCode === 'HISTORY_APPROVAL_UNVERIFIED'
    || (!!raw && typeof raw === 'object' && !Array.isArray(raw)
      && (raw['settlementHold'] === MMG_APPROVAL_HOLD || raw['settlementHold'] === MMG_HISTORY_HOLD)));
}

/** Only the provider contract's reconciliation facts belong in this snapshot.
 * Do not trim, case-fold, convert money, or substitute issued values. JSON
 * cannot represent undefined/non-finite numbers: tag them explicitly instead
 * of silently dropping them or turning them into null. */
function mmgApprovalObservation(evidence: MmgApprovalEvidence): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify({
    transactionId: evidence.transactionId,
    status: evidence.status,
    amountMinor: evidence.amountMinor,
    currencyCode: evidence.currencyCode,
    reference: evidence.reference,
    createdAt: evidence.createdAt,
    ...('reason' in evidence ? { reason: evidence.reason } : {}),
  }, (_key, value: unknown) => value === undefined ? { unavailable: 'undefined' }
    : typeof value === 'number' && !Number.isFinite(value) ? { invalidNumber: String(value) } : value)) as Prisma.InputJsonObject;
}

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
  /** [M-01] Called the instant the card processor has answered and before any
   *  local write — the crash the register names (money moved, nothing
   *  recorded). A thrown error here is that crash. */
  afterProviderReturned?: (result: { status: string; providerRef: string }) => Promise<void>;
  /** Review-only concurrency seams. Production never supplies these. */
  beforeLateMmgAuthorityLock?: (subscriptionId: string, tx: Prisma.TransactionClient) => Promise<void>;
  afterLateMmgAuthorityLocked?: (subscriptionId: string) => Promise<void>;
  afterSuccessfulChargePrepaidDebit?: (subscriptionId: string, tx: Prisma.TransactionClient) => Promise<void>;
  /** Runs after an intent exists but before the authority transaction that
   *  linearizes permission to send a new provider effect. Test-only. */
  beforeProviderEffectAuthorization?: (subscriptionId: string, paymentId: string, rail: 'CARD' | 'MOBILE_MONEY') => Promise<void>;
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
   * [E12] The lapse sweep for a stopped subscription. A partner who stopped
   * weekly billing stays ACTIVE exactly until the period they already paid
   * for ends (the operate gate refuses work from that instant); nothing bills
   * or reminds a row with autoRenew=false. At period end the row turns
   * PAUSED — not operable, owing nothing, and NOT terminal: resuming
   * (setBillingRail) restarts it with this week's fee billed like any
   * renewal. CANCELLED stays reserved for wind-down and closed accounts. Each
   * lapse writes one billing event, keyed by the row version it paused, so
   * the history says why the plan stopped. Runs in the process-billing job.
   */
  async lapseStoppedSubscriptions(now = new Date()): Promise<number> {
    const due = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE', autoRenew: false, currentPeriodEnd: { lte: now } },
      select: { id: true, currencyCode: true, updatedAt: true },
      take: 500,
    });
    let paused = 0;
    for (const sub of due) {
      // [DS207 F1] One row can never stop the sweep (or the rest of the
      // billing job after it): a failure is logged and the next row runs.
      try {
        const done = await this.prisma.$transaction(async (tx) => {
          // Guarded: a resume that armed autoRenew in between wins.
          const flipped = await tx.subscription.updateMany({
            where: { id: sub.id, status: 'ACTIVE', autoRenew: false, currentPeriodEnd: { lte: now } },
            data: { status: 'PAUSED', nextRetryAt: null, isInGracePeriod: false, gracePeriodEnd: null },
          });
          if (flipped.count !== 1) return false;
          await tx.billingEvent.create({
            data: {
              subscriptionId: sub.id,
              type: 'TIER_CHANGE',
              currencyCode: sub.currencyCode,
              // [DS207 F1] Keyed by the row version this lapse paused, not by
              // the period: a resume that has not been charged yet leaves the
              // same currentPeriodEnd, and a second stop must be able to pause
              // it again without colliding with the first pause's event.
              idempotencyKey: `pause:${sub.id}:${sub.updatedAt.toISOString()}`,
              note: 'Plan paused at the end of the paid period — weekly billing was stopped by the partner',
            },
          });
          return true;
        });
        if (done) paused += 1;
      } catch (err) {
        log().error({ err, subscriptionId: sub.id }, 'stopped-plan lapse failed for one subscription — continuing');
      }
    }
    return paused;
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
    /** [DB-028] Internal: this call has already won the attempt, by reclaiming
     *  a stale one. The attempt event exists; re-inserting it would collide
     *  with the very row that licensed this pass. */
    reclaimedAttempt = false,
  ): Promise<'succeeded' | 'failed' | 'suspended' | 'skipped' | 'pending'> {
    // An unresolved positive observation may concern this or an older attempt.
    // A new retry key, rail choice or wallet top-up is not manual disposition.
    if (await this.subscriptionHasMmgApprovalHold(this.prisma, sub.id)) return 'pending';
    const periodKey = sub.nextBillingDate.toISOString().slice(0, 10);
    const attemptKey = `charge:${sub.id}:${periodKey}:a${sub.failedAttempts}`;
    const usd = usdCtx === undefined ? await this.loadUsdPricing() : usdCtx;
    const priced = await this.priceEligibleFor(sub, usd);

    if (!reclaimedAttempt) try {
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
        }) ?? await this.prisma.subscriptionPayment.findUnique({
          // [M-01] ...or this attempt's CARD intent, reserved before the charge.
          where: { clientKey: this.cardReference(sub) },
          select: { status: true },
        });
        if (liveIntent && (liveIntent.status === 'PENDING' || liveIntent.status === 'UNKNOWN')) {
          billingAttemptReclaimCounter.labels('blocked_intent').inc();
          return 'pending';
        }
        // [DB-028] An attempt with NO outcome and NO intent behind it is not
        // "already handled" — it is a run that committed the attempt and then
        // died before doing anything at all. Skipping it here is permanent:
        // the period and the failed-attempt level never move, so every future
        // cycle recomputes the same key, collides, and skips again. Billing
        // for that subscriber stops for good, silently, and the nightly
        // invariant only reports the symptom.
        //
        // Once the attempt is older than a whole run could take, nobody is
        // working it. Reclaim it — fenced, so two reclaimers cannot both go
        // forward — and take the charge from the top. Nothing external was
        // reserved (both rails write their intent before they call out), and
        // the provider keys are deterministic regardless.
        if (await this.reclaimStaleAttempt(sub, attemptKey, now)) {
          return this.billSubscription(sub, now, usd, true);
        }
        return 'skipped'; // someone (or a concurrent run) already attempted this
      }
      throw error;
    }

    const amount = Number(priced.amount);

    // Waived subscriptions advance for free, with the audit trail intact
    if (sub.feeWaived || amount === 0) {
      const applied = await this.applySuccessfulCharge(sub, 0, 'fee-waived', now, periodKey);
      if (!applied) return 'skipped';
      // A waive covers ONE period — the admin notice promises "for this period".
      // Clear it so normal billing resumes next cycle instead of a permanent free
      // ride (silent, recurring revenue loss). A genuinely $0 tier (amount===0,
      // feeWaived false) is NOT a waive and stays free.
      if (sub.feeWaived) {
        await this.prisma.subscription.update({ where: { id: sub.id }, data: { feeWaived: false } });
      }
      return 'succeeded';
    }

    const charged = await this.attemptCharge(sub, amount, now);

    if (charged.ok) {
      if (charged.rail === 'MOBILE_MONEY') {
        if (!charged.settlePaymentId) throw new Error(`MMG approval for ${sub.id} has no durable intent`);
        if (!charged.mmgEvidence) throw new Error(`MMG approval for ${sub.id} has no verified lookup evidence`);
        const outcome = await this.settleApprovedMmgPayment(
          sub,
          charged.settlePaymentId,
          charged.mmgEvidence,
          now,
        );
        if (outcome === 'held') return 'pending';
        return outcome === 'lost' ? 'skipped' : 'succeeded';
      }
      // A guard-detected late approval settles the ORIGINAL pending row in place
      // (settlePaymentId); a fresh success creates its own CAPTURED row.
      const applied = await this.applySuccessfulCharge(
        sub, amount, charged.ref, now, periodKey,
        'settlePaymentId' in charged ? charged.settlePaymentId : undefined,
        priced.usdTrio,
        charged.spendPrepaid,
      );
      return applied ? 'succeeded' : 'skipped';
    }

    if ('dispatchRevoked' in charged) return 'skipped';

    if ('deferred' in charged) {
      // SWIFT-004: a prior MMG request for this period is still live at MMG (or
      // MMG is unreachable). Don't create a second request/row — re-attach the
      // poller to the original and push the retry clock; the poller settles a
      // late approval or duns a genuine expiry on a later tick, never a duplicate.
      if (charged.reopenPaymentId) {
        await this.persistPaymentNonterminalObservation(sub, {
          paymentId: charged.reopenPaymentId,
          from: ['FAILED'],
          data: { status: 'PENDING' },
          now,
        });
      }
      return 'pending';
    }

    if ('approvedWithoutId' in charged) {
      // An affirmative initiate response lacks settlement proof and a usable
      // lookup key. Quarantine the exact observation on the reserved intent;
      // neither dunning nor a second prompt may follow from this ambiguity.
      await this.settleApprovedMmgPayment(sub, charged.intentId, charged.approvedWithoutId, now);
      return 'pending';
    }

    if ('approvedWithId' in charged) {
      // A usable lookup id does not turn the initiate response into settlement
      // proof. Store its positive fact and id under one money-authority lock;
      // only a later complete matching lookup may clear the provisional hold.
      await this.retainMmgHistoryApproval(
        sub, charged.intentId, charged.approvedWithId, now, 'initiate', charged.clientKey,
      );
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
      await this.persistPaymentNonterminalObservation(sub, {
        paymentId: charged.intentId,
        paymentMethod: charged.rail === 'MOBILE_MONEY' ? 'MOBILE_MONEY' : 'CARD',
        from: ['UNKNOWN'],
        requireNoExternalRef: true,
        data: {
          failureCode: 'TIMEOUT_UNKNOWN',
          ...(charged.failureRaw ? { failureRaw: { reason: charged.failureRaw } } : {}),
          expiresAt: new Date(now.getTime() + MMG_REQUEST_TTL_MS),
        },
        now,
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
      const shouldNotify = await this.persistPaymentNonterminalObservation(sub, {
        paymentId: charged.intentId,
        from: ['UNKNOWN'],
        requireNoExternalRef: true,
        data: { status: 'PENDING', externalRef: charged.pendingTx, expiresAt: charged.expiresAt, failureCode: null },
        now,
      });
      if (shouldNotify) {
        await this.notifications.send({
          userId: this.payerUserId(sub),
          type: 'SYSTEM_ANNOUNCEMENT',
          title: 'Approve your weekly fee in MMG',
          body: `We sent an MMG request for $${amount.toLocaleString()} ${sub.currencyCode}. Approve it on your phone to stay active.`,
          audience: this.payerAudience(sub),
          data: { kind: 'billing_mmg_pending', subscriptionId: sub.id },
        });
      }
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

  /**
   * [DB-028] Reclaim a weekly-charge attempt that nobody is working.
   *
   * The attempt event is the claim. It is also append-only evidence, which is
   * exactly why it makes a poor lock: a run that commits it and then dies
   * holds that claim forever, and every later cycle collides on the same key
   * and skips. Billing for that subscriber stops permanently, in silence.
   *
   * A stale attempt is one that is OLDER than any run could plausibly still be
   * inside, with no failure record, no success record and no live provider
   * intent for the same period and attempt level — the caller has already
   * established the last three. This method establishes the first, and then
   * claims the reclaim itself under a unique key, so if two cycles reach the
   * same stale attempt together exactly one goes forward and the other skips.
   * The generation in that key lets a reclaim that itself dies be reclaimed in
   * turn, rather than replacing one permanent block with another.
   *
   * Interim containment, and named as such: DB-028's target design is a
   * durable attempt state machine with a lease and a fenced reconciler. This
   * closes the hole that design closes without a second money table, and the
   * census test asserts no aged attempt is left unaccounted for either way.
   */
  private async reclaimStaleAttempt(
    sub: Pick<Subscription, 'id' | 'nextBillingDate' | 'failedAttempts'>,
    attemptKey: string,
    now: Date,
  ): Promise<boolean> {
    const attempt = await this.prisma.billingEvent.findUnique({
      where: { idempotencyKey: attemptKey },
      select: { createdAt: true },
    });
    if (!attempt) return false;
    if (now.getTime() - attempt.createdAt.getTime() < STALE_ATTEMPT_MS) return false;

    const periodKey = sub.nextBillingDate.toISOString().slice(0, 10);
    const base = `${sub.id}:${periodKey}:a${sub.failedAttempts}`;
    // A success for this period means the attempt DID complete; never re-charge.
    const settled = await this.prisma.billingEvent.findFirst({
      where: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS', idempotencyKey: { startsWith: `success:${sub.id}:${periodKey}` } },
      select: { id: true },
    });
    if (settled) return false;

    // A reclaim already in progress is not a second licence. The unique key
    // below stops two cycles that compute the SAME generation, but a cycle
    // arriving a second after the winner would otherwise count one reclaim,
    // mint the next generation and charge alongside it — the winner's charge
    // and this one, both live, with only the success record's timing between
    // them. So a new generation may be minted ONLY when the latest reclaim is
    // itself stale, i.e. its own run has been gone as long as the attempt's.
    const reclaims = await this.prisma.billingEvent.findMany({
      where: { subscriptionId: sub.id, idempotencyKey: { startsWith: `reclaim:${base}:` } },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const latest = reclaims[0];
    if (latest && now.getTime() - latest.createdAt.getTime() < STALE_ATTEMPT_MS) {
      billingAttemptReclaimCounter.labels('lost_race').inc();
      return false; // someone is working this attempt right now
    }
    const generation = reclaims.length;
    try {
      await this.prisma.billingEvent.create({
        data: {
          subscriptionId: sub.id,
          type: 'CHARGE_ATTEMPT_RECLAIMED',
          amount: 0,
          currencyCode: 'GYD',
          idempotencyKey: `reclaim:${base}:g${generation}`,
          note: `Attempt from ${attempt.createdAt.toISOString()} had no outcome and no provider intent; reclaimed`,
        },
      });
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        billingAttemptReclaimCounter.labels('lost_race').inc();
        return false; // another cycle won this reclaim
      }
      throw error;
    }
    billingAttemptReclaimCounter.labels('reclaimed').inc();
    return true;
  }

  /** The MMG merchant reference for one attempt — ONE format, shared by the
   *  initiate, the duplicate-attempt check and the poller's adoption. */
  private mmgReference(sub: Pick<Subscription, 'id' | 'nextBillingDate' | 'failedAttempts'>): string {
    return `sub:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a${sub.failedAttempts}`;
  }

  /** [M-01 / M-02] The card rail's idempotency key for one attempt: ours, the
   *  processor's, and the intent row's clientKey — ONE value. It advances only
   *  with failedAttempts, and failedAttempts advances only on a PROVEN
   *  terminal, so an ambiguous result retries under the same key and the
   *  processor's own idempotency makes the capture exactly-once. */
  private cardReference(sub: Pick<Subscription, 'id' | 'nextBillingDate' | 'failedAttempts'>): string {
    return `card:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a${sub.failedAttempts}`;
  }

  /** [M-01] The card intent before the charge — the same durable row the MMG
   *  rail reserves before it asks the provider. */
  private reserveCardIntent(sub: SubWithRelations, amount: number, reference: string, now = new Date()): Promise<{ id: string } | null> {
    return this.reserveMmgIntent(sub, amount, reference, now);
  }

  /**
   * [TA-S0-002 / M-03] Reserve the durable MMG intent for one attempt BEFORE
   * the provider is asked: UNKNOWN, our clientKey, no provider id yet, the
   * TTL already ticking. `clientKey` is unique, so a second reservation for
   * the same attempt is refused at the database — that means a previous run
   * reserved it and died: the poller owns that row (history adoption by our
   * reference, or expiry of a never-authorized reservation) and no second
   * prompt may ever be issued.
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
          failureRaw: { providerEffect: 'NOT_SENT', providerRail: sub.billingMethod },
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
    return weeklyFeeFor(sub);
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

  /** [M-01 / M-02] The card reconciler, run with every billing poll: every
   *  UNKNOWN card intent is retrieved by its key. Captured → settled in place
   *  (the paid week, the success event, the ledger — the defect the register
   *  names, repaired, and paged); declined → the proven terminal enters
   *  dunning; never received → waits until TTL without automatically reissuing
   *  an old instruction; still unknown → waits, and its age is published.
   *  The kill switch never stops this. */
  async reconcileUnknownCardCharges(now = new Date()): Promise<{ settled: number; declined: number; reissued: number; expired: number; stillUnknown: number; oldestMinutes: number }> {
    const out = { settled: 0, declined: 0, reissued: 0, expired: 0, stillUnknown: 0, oldestMinutes: 0 };
    const rows = await this.prisma.subscriptionPayment.findMany({
      where: { paymentMethod: 'CARD', status: 'UNKNOWN' },
      // Durable least-recently-polled order rotates an indefinitely unknown
      // authorized instruction behind later captures. Stable ties prevent a
      // fixed first page from starving row 201 and beyond.
      orderBy: [
        { lastPolledAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      take: 200,
    });
    for (const row of rows) {
      // Stamp even malformed/orphaned intents so they cannot monopolize the
      // first page. A failed durable stamp aborts this pass instead of
      // repeating the same 200 while claiming progress.
      const stamped = await this.prisma.subscriptionPayment.updateMany({
        where: { id: row.id, status: 'UNKNOWN' }, data: { lastPolledAt: now },
      });
      if (stamped.count === 0) continue;
      const sub = await this.prisma.subscription.findUnique({
        where: { id: row.subscriptionId },
        include: {
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          vendor: { select: { id: true, owner: { select: { userId: true } } } },
        },
      });
      if (!sub || !row.clientKey) { out.stillUnknown += 1; continue; }
      const periodKey = row.periodStart.toISOString().slice(0, 10);
      const amount = Number(row.amount);
      const ttlAt = row.expiresAt ?? new Date(row.createdAt.getTime() + MMG_REQUEST_TTL_MS);

      const found = await this.payments.lookupCharge({ idempotencyKey: row.clientKey, providerRef: row.externalRef ?? undefined });
      if (found.status === 'succeeded') {
        // The processor took the money and we had no local payment: repair it
        // exactly once, then tell a person it happened.
        const trio = await this.pinnedTrioFor(sub.id, periodKey);
        const applied = await this.applySuccessfulCharge(sub as SubWithRelations, amount, found.providerRef ?? row.clientKey, now, periodKey, row.id, trio);
        if (!applied) { out.stillUnknown += 1; continue; }
        out.settled += 1;
        cardChargesReconciledCounter.labels('captured_late').inc();
        log().error({ paymentId: row.id, subscriptionId: sub.id, providerRef: found.providerRef }, '[M-01] card charge captured by the processor with no local payment — settled by reconciliation');
        await notifyAdmins(this.prisma, this.notifications, {
          tenantId: await tenantOfSubscription(this.prisma, sub.id),
          title: '💳 A card charge was captured with no local payment — repaired',
          body: `A captured card payment for subscription ${sub.id} now has a durable payment and ledger disposition. Current lifecycle authority chose a paid week or a wallet liability; inspect payment ${row.id} and its billing events. Reconciliation did not override cancellation or deletion.`,
          data: { kind: 'billing_invariants', alert: 'card-captured-without-local-payment', subscriptionId: sub.id, paymentId: row.id },
        }).catch(() => {});
        continue;
      }
      if (found.status === 'failed') {
        const outcome = await this.terminalizeFailedPayment(
          sub as SubWithRelations, row,
          { status: 'FAILED', failureCode: mapCardFailure(found.reason), from: ['UNKNOWN'], ...(found.reason ? { failureRaw: found.reason } : {}) },
          found.reason ?? 'Card declined', now, periodKey,
        );
        if (outcome) { out.declined += 1; cardChargesReconciledCounter.labels('declined').inc(); }
        continue;
      }
      if (found.status === 'not_found') {
        // Reconciliation can observe money already sent; it cannot license a
        // new effect from an old snapshot. Even a lifecycle recheck just before
        // chargeToken races cancellation. Keep polling until a proved terminal
        // instead of automatically reissuing this instruction.
        if (now.getTime() >= ttlAt.getTime()) {
          const outcome = await this.terminalizeFailedPayment(
            sub as SubWithRelations, row,
            {
              status: 'EXPIRED', failureCode: 'PROVIDER_NOT_FOUND', from: ['UNKNOWN'],
              providerAbsenceOnly: true,
              preserveWithoutDunning: {
                providerOutcome: 'PROVEN_NOT_FOUND',
                recoveryDisposition: 'MANUAL_RECONCILIATION',
              },
            },
            'Card instruction never reached the processor before its TTL', now, periodKey,
          );
          if (outcome) {
            out.expired += 1;
            cardChargesReconciledCounter.labels('expired').inc();
            if (outcome === 'skipped') {
              await notifyAdmins(this.prisma, this.notifications, {
                tenantId: await tenantOfSubscription(this.prisma, sub.id),
                title: 'Card instruction absent — manual reconciliation required',
                body: `The processor repeatedly reported no charge for payment ${row.id}. The subscription was not dunned and no replacement instruction was sent. Review the payment before authorizing a new billing attempt.`,
                data: { kind: 'billing_manual_reconciliation', alert: 'card-provider-not-found', subscriptionId: sub.id, paymentId: row.id },
              }).catch(() => {});
            }
          } else out.stillUnknown += 1;
          continue;
        }
      }
      out.stillUnknown += 1;
    }
    const remaining = await this.prisma.subscriptionPayment.findFirst({ where: { paymentMethod: 'CARD', status: 'UNKNOWN' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    const count = await this.prisma.subscriptionPayment.count({ where: { paymentMethod: 'CARD', status: 'UNKNOWN' } });
    out.oldestMinutes = remaining ? Math.max(0, Math.round((now.getTime() - remaining.createdAt.getTime()) / 60_000)) : 0;
    cardIntentsUnknownGauge.labels('count').set(count);
    cardIntentsUnknownGauge.labels('oldest_minutes').set(out.oldestMinutes);
    return out;
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

  /** [M-14] The notice is a charge gate. A materially changed local amount
   *  (the >2% rule) is charged only if the notice for THAT rate was DELIVERED
   *  at least FX_NOTICE_WINDOW_DAYS before this invoice. Otherwise the payer
   *  is charged what they were told last time — their previous rate, pinned
   *  from their last successful charge (the prior price version) — and the
   *  charge is counted ineligible for a person to see. Before, the run's
   *  latest effective rate was charged unconditionally while a swallowed send
   *  left the database saying "noticed". */
  private async priceEligibleFor(sub: Subscription, usd: UsdPricingCtx | null): Promise<ReturnType<BillingService['priceFor']>> {
    const priced = this.priceFor(sub, usd);
    if (!usd || !priced.usdTrio) return priced;
    const last = await this.prisma.billingEvent.findFirst({
      where: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS', amount: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { amount: true, currencyCode: true, fxRateId: true, fxRateUsed: true },
    });
    if (!last?.amount) return priced; // a first charge: nothing was announced before, nothing changed
    if (!noticeRequired(Number(last.amount), Number(priced.amount))) return priced;
    if (last.fxRateId === usd.rateId) return priced; // the payer already paid at this very rate
    const notice = await this.prisma.billingEvent.findUnique({
      where: { idempotencyKey: `fxnotice:${sub.id}:${usd.rateId}` },
      select: { deliveredAt: true },
    });
    const deadline = sub.nextBillingDate.getTime() - FX_NOTICE_WINDOW_DAYS * 86_400_000;
    if (notice?.deliveredAt && notice.deliveredAt.getTime() <= deadline) return priced; // told, in time
    fxChargesIneligibleCounter.inc();
    if (last.fxRateId && last.fxRateUsed && last.currencyCode === usd.currency) {
      const previous = convertUsdToLocal(priced.usdTrio.amountUsd, Number(last.fxRateUsed), usd.increment);
      log().warn(
        { subscriptionId: sub.id, newRateId: usd.rateId, previousRateId: last.fxRateId, delivered: notice?.deliveredAt ?? null, nextBillingDate: sub.nextBillingDate },
        '[M-14] FX notice not delivered in time — charging the previously announced rate',
      );
      return { amount: previous.amountLocal, usdTrio: { amountUsd: priced.usdTrio.amountUsd, fxRateId: last.fxRateId, fxRateUsed: Number(last.fxRateUsed) } };
    }
    // No pinned previous rate (a legacy charge): the exact amount they were
    // charged last time is the prior price version.
    log().warn({ subscriptionId: sub.id, newRateId: usd.rateId }, '[M-14] FX notice not delivered in time and no pinned previous rate — charging the last charged amount');
    return { amount: Number(last.amount) };
  }

  /** Prepaid balance settles FIRST (money already in hand); otherwise CARD
   *  charges the stored token and MOBILE_MONEY pushes an MMG request the payer
   *  approves on their phone. */
  private async attemptCharge(
    sub: SubWithRelations,
    amount: number,
    now: Date,
  ): Promise<ChargeAttemptResult> {
    if (await this.subscriptionHasMmgApprovalHold(this.prisma, sub.id)) return { ok: false, deferred: true };
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
      select: { balance: true, currencyCode: true },
    });
    if (balanceRow && balanceRow.currencyCode !== sub.currencyCode) {
      throw new AppError(409, 'WALLET_CURRENCY_MISMATCH', 'Wallet currency does not match the issued weekly fee; reconciliation is required');
    }
    if (balanceRow && Number(balanceRow.balance) >= amount) {
      return { ok: true, ref: 'prepaid', spendPrepaid: amount };
    }

    if (sub.billingMethod === 'CARD' && sub.paymentToken) {
      // [M-01] The kill switch stops NEW instructions only; the reconciler
      // that settles what the processor already did never stops.
      if (cardRailKilled()) return { ok: false, deferred: true };

      // [M-01 / M-02] THE INTENT BEFORE THE EFFECT, on the card rail. Before,
      // the processor was asked with nothing durable on our side: a process
      // that died after the capture and before applySuccessfulCharge left a
      // charged payer with no paid week, no payment row and no ledger line,
      // and every rerun collided on the attempt key and skipped forever. And
      // an ambiguous transport result was recorded as a decline, dunned, and
      // retried under a NEW key — a second capture and a wrongful suspension.
      const key = this.cardReference(sub);
      const live = await this.prisma.subscriptionPayment.findUnique({ where: { clientKey: key } });
      let intentId: string;
      if (live) {
        if (live.status === 'CAPTURED') return { ok: true, ref: live.externalRef ?? key, settlePaymentId: live.id };
        if (live.status === 'UNKNOWN') {
          // Retrieve the truth by the same key BEFORE any retry.
          const found = await this.payments.lookupCharge({ idempotencyKey: key, providerRef: live.externalRef ?? undefined });
          if (found.status === 'succeeded') return { ok: true, ref: found.providerRef ?? key, settlePaymentId: live.id };
          if (found.status === 'failed') {
            return { ok: false, reason: found.reason ?? 'Card declined', failureCode: mapCardFailure(found.reason), intentId: live.id, ...(found.reason ? { failureRaw: found.reason } : {}) };
          }
          if (found.status === 'unknown') return { ok: false, deferred: true }; // the processor cannot say: the reconciler owns it
          return { ok: false, deferred: true }; // not_found is reconciliation work, never automatic reissue
        } else {
          // A proven terminal for this exact key: this attempt is over; the
          // next one carries the next key. Nothing to send.
          return { ok: false, deferred: true };
        }
      } else {
        const reserved = await this.reserveCardIntent(sub, amount, key, now);
        if (!reserved) return { ok: false, deferred: true }; // a concurrent run holds this attempt
        intentId = reserved.id;
      }

      if (!await this.authorizeProviderEffect(sub, intentId, 'CARD', now)) {
        return { ok: false, dispatchRevoked: true, intentId, rail: 'CARD' };
      }

      const result = await this.payments.chargeToken({
        token: sub.paymentToken,
        amount,
        currencyCode: sub.currencyCode,
        idempotencyKey: key,
        description: `Swift weekly subscription (${sub.type})`,
      });
      await this.observer.afterProviderReturned?.(result);
      if (result.code === 'CARD_RAIL_DISABLED') return { ok: false, deferred: true };
      if (result.status === 'succeeded') return { ok: true, ref: result.providerRef, settlePaymentId: intentId };
      if (result.status === 'unknown') {
        return { ok: false, unknown: true, clientKey: key, intentId, ...(result.reason ? { failureRaw: result.reason } : {}) };
      }
      return { ok: false, reason: result.reason ?? 'Charge declined', failureCode: mapCardFailure(result.reason), intentId, ...(result.reason ? { failureRaw: result.reason } : {}) };
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
        if (hasMmgApprovalHold(prior)) return { ok: false, deferred: true, rail: 'MOBILE_MONEY' };
        // An UNKNOWN intent with no provider id can't be looked up — the
        // poller owns it (history adoption or TTL expiry). Never fire a new
        // request over a live UNKNOWN [LAW M-5].
        if (!prior.externalRef) {
          if (prior.status === 'UNKNOWN') return { ok: false, deferred: true, rail: 'MOBILE_MONEY' };
          continue;
        }
        let priorLookup: MmgTransaction;
        try {
          priorLookup = await mmg.transactionLookup({ transactionId: prior.externalRef });
        } catch {
          return { ok: false, deferred: true, reopenPaymentId: prior.id, rail: 'MOBILE_MONEY' }; // MMG down — never fire blind
        }
        if (priorLookup.status === 'approved') {
          return { ok: true, ref: prior.externalRef, settlePaymentId: prior.id, rail: 'MOBILE_MONEY', mmgEvidence: priorLookup };
        }
        if (priorLookup.status === 'pending') return { ok: false, deferred: true, reopenPaymentId: prior.id, rail: 'MOBILE_MONEY' };
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
      const intent = await this.reserveMmgIntent(sub, amount, reference, now);
      if (!intent) return { ok: false, deferred: true, rail: 'MOBILE_MONEY' }; // this attempt's intent is already live — never a second prompt

      if (!await this.authorizeProviderEffect(sub, intent.id, 'MOBILE_MONEY', now)) {
        return { ok: false, dispatchRevoked: true, intentId: intent.id, rail: 'MOBILE_MONEY' };
      }

      const result = await mmg.initiatePayment({
        payerId: sub.mmgPayerMsisdn,
        amountMinor: Math.round(amount * 100),
        currencyCode: sub.currencyCode,
        reference,
      });
      // Initiate does not return the amount/currency/reference proof required
      // to bank money or grant a paid week. Even an immediate "approved"
      // response remains a live intent until lookup returns the full evidence.
      if (result.status === 'approved' && usableMmgTransactionId(result.transactionId)) {
        return { ok: false, approvedWithId: result, clientKey: reference, intentId: intent.id, rail: 'MOBILE_MONEY' };
      }
      if (result.status === 'pending' && usableMmgTransactionId(result.transactionId)) {
        return { ok: false, pendingTx: result.transactionId, clientKey: reference, expiresAt: new Date(Date.now() + MMG_REQUEST_TTL_MS), intentId: intent.id, rail: 'MOBILE_MONEY' };
      }
      if (result.status === 'approved') {
        return { ok: false, approvedWithoutId: result, intentId: intent.id, rail: 'MOBILE_MONEY' };
      }
      if (result.status === 'error' || result.status === 'pending') {
        // Transport-shaped (or pending with no id to poll by): the request
        // MAY be live on the payer's phone — UNKNOWN, owned by the poller.
        return { ok: false, unknown: true, clientKey: reference, failureRaw: result.reason, intentId: intent.id, rail: 'MOBILE_MONEY' };
      }
      // MMG answered "no" (declined / reversed / expired at initiate): the
      // intent closes as FAILED on the same row, with the normalized code.
      const failureCode = mapMmgFailure(result.status, result.reason);
      // [M-04] The intent is NOT flipped here. billSubscription terminalizes
      // it together with the CHARGE_FAILED event and the dunning state in one
      // transaction; a flip here followed by a crash left a FAILED row whose
      // outcome never landed.
      return { ok: false, reason: result.reason ?? 'MMG request failed', failureCode, intentId: intent.id, rail: 'MOBILE_MONEY', ...(result.reason ? { failureRaw: result.reason } : {}) };
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
  ): Promise<boolean> {
    // One transaction for the whole advance [tollgate M-13]: the prepaid debit,
    // payment row, period move, audit event, and the balanced ledger posting
    // commit or roll back together — a crash can no longer strand a captured
    // payment without its period (or books without their entry), NOR spend a
    // payer's credit without granting the week [PAY-1 M0 S0]. Racing settlers
    // converge on identical absolute period values; the CHARGE_SUCCESS unique
    // key rolls the loser back whole.
    const settled = await this.prisma.$transaction(async (tx) => {
      const disposition = await this.applySuccessfulChargeInTx(tx, sub, amount, paymentRef, now, periodKey, settlePaymentId, usdTrio, spendPrepaid);
      if (disposition !== 'advanced') return { disposition };
      const payment = settlePaymentId ? await tx.subscriptionPayment.findUnique({ where: { id: settlePaymentId } }) : null;
      const settledPeriodKey = payment?.periodStart.toISOString().slice(0, 10) ?? periodKey;
      const event = await tx.billingEvent.findUnique({ where: { idempotencyKey: `success:${sub.id}:${settledPeriodKey}` } });
      if (!event) throw new Error('Successful charge has no durable success event');
      return { disposition, amount: Number(event.amount), currencyCode: event.currencyCode, periodKey: settledPeriodKey };
    });
    if (settled.disposition === 'skipped' || settled.disposition === 'held') return false;
    if (settled.disposition === 'advanced') await this.afterSuccessfulCharge({ ...sub, currencyCode: settled.currencyCode! }, settled.amount!, settled.periodKey!);
    return true;
  }

  /** The transactional core of a successful charge — callable inside a LARGER
   *  transaction (the poller claims and advances atomically through here;
   *  SWIFT-004's full closure). MMG also restores access in that transaction;
   *  its afterSuccessfulCharge tail sends notices only. */
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
  ): Promise<'advanced' | 'banked' | 'held' | 'skipped'> {
    // Every path that can touch both the subscription aggregate and its wallet
    // takes the same payer -> subscription -> wallet order. Late-MMG banking
    // uses this order too; without it, prepaid could own the wallet while MMG
    // owned the subscription and PostgreSQL correctly killed the cycle.
    const authority = await this.lockSubscriptionMoneyAuthority(tx, sub);
    const mmgHeld = await this.subscriptionHasMmgApprovalHold(tx, sub.id);
    // A card capture is an external money fact, not permission to reactivate a
    // subscription. Fence its durable intent and choose a single disposition
    // before applying the ordinary prepaid/free/service-advance path below.
    if (settlePaymentId && !spendPrepaid) {
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${settlePaymentId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: settlePaymentId } });
      if (payment?.paymentMethod === 'CARD') {
        if (payment.subscriptionId !== sub.id || !['UNKNOWN', 'CAPTURED'].includes(payment.status)) return 'skipped';
        const originalPeriodKey = payment.periodStart.toISOString().slice(0, 10);
        const [banked, covered, originalAttempt] = await Promise.all([
          tx.billingEvent.findUnique({ where: { idempotencyKey: `bank:${payment.id}` } }),
          tx.billingEvent.findUnique({ where: { idempotencyKey: `success:${sub.id}:${originalPeriodKey}` } }),
          payment.clientKey?.startsWith(`card:${sub.id}:`)
            ? tx.billingEvent.findUnique({ where: { idempotencyKey: `charge:${payment.clientKey.slice(5)}` } })
            : Promise.resolve(null),
        ]);
        if (banked || (payment.status === 'CAPTURED' && covered?.paymentRef === payment.externalRef)) return 'skipped';
        if (!paymentRef || (payment.externalRef && payment.externalRef !== paymentRef)) {
          throw new AppError(409, 'CARD_REFERENCE_MISMATCH', 'Card capture does not match the durable intent');
        }
        const currencyCode = originalAttempt?.currencyCode ?? sub.currencyCode;
        const bankCapture = mmgHeld || covered || !this.successfulChargeAuthorityAllowsAdvance(authority, sub);
        if (bankCapture && await this.holdWalletCurrencyMismatch(tx, payment, currencyCode, paymentRef)) return 'held';
        const claimed = await tx.subscriptionPayment.updateMany({
          where: { id: payment.id, subscriptionId: sub.id, paymentMethod: 'CARD', status: payment.status, externalRef: payment.externalRef },
          data: { status: 'CAPTURED', paidAt: now, externalRef: paymentRef, failureCode: null },
        });
        if (claimed.count !== 1) return 'skipped';
        amount = Number(payment.amount);
        periodKey = originalPeriodKey;
        sub = { ...sub, billingMethod: 'CARD', nextBillingDate: payment.periodStart, currencyCode };
        usdTrio = originalAttempt?.amountUsd && originalAttempt.fxRateId && originalAttempt.fxRateUsed
          ? { amountUsd: Number(originalAttempt.amountUsd), fxRateId: originalAttempt.fxRateId, fxRateUsed: Number(originalAttempt.fxRateUsed) }
          : undefined;
        if (bankCapture) {
          await this.creditWalletInTx(tx, {
            subscriptionId: sub.id, amount, currencyCode: sub.currencyCode,
            eventKey: `bank:${payment.id}`, channel: 'CARD_LATE_APPROVAL', rail: 'CARD',
            note: `Card payment received for ${periodKey}; banked without changing subscription lifecycle (payment ${payment.id})`,
          });
          return 'banked';
        }
      }
    }
    if (mmgHeld) return 'held';
    if (!this.successfulChargeAuthorityAllowsAdvance(authority, sub)) return 'skipped';
    const current = { ...sub, status: authority.status } as SubWithRelations;
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
        where: { subscriptionId: sub.id, currencyCode: sub.currencyCode, balance: { gte: spendPrepaid } },
        data: { balance: { decrement: spendPrepaid } },
      });
      if (debited.count !== 1) {
        throw new Error(`prepaid balance no longer covers ${spendPrepaid} for subscription ${sub.id}`);
      }
      await this.observer.afterSuccessfulChargePrepaidDebit?.(sub.id, tx);
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
    // Access restoration belongs to the same locked generation as the debit,
    // captured attempt and period advance. A cancellation/deletion that wins
    // afterwards therefore stays final; no stale post-commit writer can reopen
    // the vendor or emit a reinstatement assertion.
    if (['PAST_DUE', 'SUSPENDED', 'CHURNED'].includes(authority.status)) {
      await this.reinstateRows(tx, current, periodKey);
    }
    return 'advanced';
  }

  /** Post-commit side effect only. Access already committed with the economic
   *  transition. Copy is historical because lifecycle authority can change
   *  again before this best-effort notification is delivered. */
  private async afterSuccessfulCharge(sub: SubWithRelations, amount: number, periodKey: string, _settlementCommitted = true) {
    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Subscription payment received',
      body: `$${amount.toLocaleString()} ${sub.currencyCode} received for the billing period starting ${periodKey}. Check Swift for your current account status.`,
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
    opts: { subscriptionId: string; amount: number; currencyCode: string; eventKey: string; note: string; channel: string; mmgRef?: string; rail?: 'CARD' },
  ) {
    // One subscription has one currency-denominated wallet. Even an empty
    // wallet must never be relabelled or incremented with another currency.
    // Materialize/lock the row, then include its currency in the monetary CAS;
    // a concurrent creator or currency edit cannot turn the read into consent.
    const wallet = await this.lockWalletInTx(tx, opts.subscriptionId, opts.currencyCode);
    if (wallet.currencyCode !== opts.currencyCode) {
      throw new AppError(409, 'WALLET_CURRENCY_MISMATCH', 'Received money and wallet currencies differ; reconciliation is required');
    }
    const credited = await tx.prepaidBalance.updateMany({
      where: { subscriptionId: opts.subscriptionId, currencyCode: opts.currencyCode },
      data: { balance: { increment: opts.amount } },
    });
    if (credited.count !== 1) {
      throw new AppError(409, 'WALLET_CURRENCY_MISMATCH', 'Wallet currency changed before credit; reconciliation is required');
    }
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
      entries: topupPostings(opts.subscriptionId, opts.amount, opts.rail),
    });
    return tx.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: opts.subscriptionId } });
  }

  private lockWalletInTx(tx: Prisma.TransactionClient, subscriptionId: string, currencyCode: string) {
    return tx.prepaidBalance.upsert({
      where: { subscriptionId },
      // A zero increment still takes the row's write lock. An empty update
      // may be optimized to a SELECT and cannot serialize a currency check.
      update: { balance: { increment: 0 } },
      create: { subscriptionId, balance: 0, currencyCode },
    });
  }

  /** The provider's capture is durable evidence even when it cannot enter the
   * existing wallet. Keep the intent pollable with its provider reference and
   * one manual-reconciliation fact; no receipt, wallet credit or success is
   * asserted until the currency conflict is resolved. Caller owns the payer,
   * subscription and payment locks; creditWalletInTx also fences its own CAS. */
  private async holdWalletCurrencyMismatch(
    tx: Prisma.TransactionClient,
    payment: SubscriptionPayment,
    currencyCode: string,
    providerRef: string,
  ): Promise<false | { notify: boolean }> {
    const wallet = await this.lockWalletInTx(tx, payment.subscriptionId, currencyCode);
    if (wallet.currencyCode === currencyCode) return false;
    const existing = payment.failureRaw && typeof payment.failureRaw === 'object' && !Array.isArray(payment.failureRaw)
      ? payment.failureRaw : {};
    await tx.subscriptionPayment.update({
      where: { id: payment.id },
      data: {
        status: payment.paymentMethod === 'CARD' ? 'UNKNOWN' : 'PENDING',
        externalRef: providerRef,
        failureCode: 'WALLET_CURRENCY_MISMATCH',
        failureRaw: {
          ...existing,
          providerOutcome: 'CAPTURED',
          currencyCode,
          recoveryDisposition: 'MANUAL_RECONCILIATION',
        },
      },
    });
    const eventKey = `wallet-currency:${payment.id}`;
    const existingEvent = await tx.billingEvent.findUnique({ where: { idempotencyKey: eventKey }, select: { id: true } });
    if (!existingEvent) {
      await tx.billingEvent.create({
        data: {
          subscriptionId: payment.subscriptionId,
          type: 'REMINDER', amount: payment.amount, currencyCode,
          idempotencyKey: eventKey, paymentRef: providerRef,
          note: `Captured ${currencyCode} payment held for manual reconciliation; wallet is ${wallet.currencyCode} (payment ${payment.id})`,
        },
      });
    }
    return { notify: !existingEvent };
  }

  /** The payment holds the current quarantine; append-only billing events
   * retain every distinct approval fact. No automatic path clears this marker.
   * A separate, audited manual reconciliation must decide its disposition. */
  private async subscriptionHasMmgApprovalHold(
    db: Pick<Prisma.TransactionClient, 'subscriptionPayment'>,
    subscriptionId: string,
    exceptPaymentId?: string,
  ): Promise<boolean> {
    return !!await db.subscriptionPayment.findFirst({
      where: {
        subscriptionId,
        paymentMethod: 'MOBILE_MONEY',
        ...(exceptPaymentId ? { id: { not: exceptPaymentId } } : {}),
        OR: [
          { failureCode: 'SETTLEMENT_MISMATCH' },
          { failureCode: 'HISTORY_APPROVAL_UNVERIFIED' },
          { failureRaw: { path: ['settlementHold'], equals: MMG_APPROVAL_HOLD } },
          { failureRaw: { path: ['settlementHold'], equals: MMG_HISTORY_HOLD } },
        ],
      },
      select: { id: true },
    });
  }

  private async retainMmgApprovalHold(
    tx: Prisma.TransactionClient,
    payment: SubscriptionPayment,
    attemptCurrency: string | null,
    evidence: MmgApprovalEvidence,
    reason: string,
    now: Date,
  ): Promise<boolean> {
    const existing = payment.failureRaw && typeof payment.failureRaw === 'object' && !Array.isArray(payment.failureRaw)
      ? payment.failureRaw : {};
    const providerObservation = mmgApprovalObservation(evidence);
    const expectedPayment = {
      transactionId: payment.externalRef,
      amountMinor: Math.round(Number(payment.amount) * 100),
      currencyCode: attemptCurrency,
      reference: payment.clientKey,
    };
    const evidenceKey = `mmg-approval-evidence:${payment.id}:${createHash('sha256').update(JSON.stringify(providerObservation)).digest('hex')}`;
    if (!await tx.billingEvent.findUnique({ where: { idempotencyKey: evidenceKey }, select: { id: true } })) {
      await tx.billingEvent.create({
        data: {
          subscriptionId: payment.subscriptionId,
          type: 'REMINDER',
          // The observed currency/amount stay verbatim in the evidence note;
          // no money posting or receipt is asserted by this non-monetary event.
          currencyCode: attemptCurrency ?? '',
          idempotencyKey: evidenceKey,
          paymentRef: evidence.transactionId,
          note: JSON.stringify({ providerObservation, expectedPayment, reason, observedAt: now.toISOString(), previousStatus: payment.status }),
        },
      });
    }
    await tx.subscriptionPayment.update({
      where: { id: payment.id },
      data: {
        // Reopen FAILED/EXPIRED rows so the positive observation stays in the
        // poller's discoverable set. A previously CAPTURED row has already
        // posted money and service; keep that disposition while quarantining
        // the contradictory positive observation for manual reconciliation.
        status: payment.status === 'CAPTURED' ? 'CAPTURED' : 'PENDING',
        failureCode: 'SETTLEMENT_MISMATCH',
        failureRaw: {
          ...existing,
          providerOutcome: 'CAPTURED',
          recoveryDisposition: 'MANUAL_RECONCILIATION',
          settlementHold: MMG_APPROVAL_HOLD,
          ...(existing['settlementHold'] === MMG_APPROVAL_HOLD && existing['providerObservation'] ? {} : {
            providerObservation,
            expectedPayment,
            providerObservationEventKey: evidenceKey,
            firstObservedAt: now.toISOString(),
          }),
        },
      },
    });
    await tx.subscription.update({ where: { id: payment.subscriptionId }, data: { nextRetryAt: null } });
    const noticeKey = `mismatch:${payment.id}`;
    const existingNotice = await tx.billingEvent.findUnique({ where: { idempotencyKey: noticeKey }, select: { id: true } });
    if (existingNotice) return false;
    await tx.billingEvent.create({
      data: {
        subscriptionId: payment.subscriptionId,
        type: 'REMINDER', currencyCode: attemptCurrency ?? '',
        idempotencyKey: noticeKey,
        note: billingNoticeNote({
          noticeVersion: 1, target: 'admins', evidenceKey,
          title: 'Payment settlement held for review',
          body: `An MMG approval requires manual reconciliation. Inspect the retained provider evidence for payment ${payment.id} before further action.`,
          data: { kind: 'reconcile_mismatch', paymentId: payment.id, subscriptionId: payment.subscriptionId },
        }),
      },
    });
    // The first observation stages one durable page intent. Delivery is
    // independently retried from this event if the process dies or admins are
    // unavailable after commit.
    return true;
  }

  private async notifyMmgReconciliationHold(_sub: SubWithRelations, _reason: string, paymentId: string): Promise<void> {
    try {
      await deliverBillingNoticeByKey(this.prisma, this.notifications, `mismatch:${paymentId}`);
    } catch (err) {
      log().warn({ err, paymentId }, 'MMG reconciliation page remains due from its committed billing event');
    }
  }

  /** History or initiation is affirmative evidence, not yet a lookup-confirmed
   * settlement. Preserve its exact facts and a discoverable hold in the same
   * authority transaction that adopts a usable provider id. Initiation is
   * bound to the request reference we just sent; history must supply its own
   * matching reference. A later negative lookup cannot license dunning;
   * a complete matching approved lookup may resolve this provisional hold. */
  private async retainMmgHistoryApproval(
    sub: SubWithRelations,
    paymentId: string,
    evidence: MmgApprovalEvidence,
    now: Date,
    source: 'history' | 'initiate' = 'history',
    initiatedReference?: string,
  ): Promise<'adopted' | 'held' | 'lost'> {
    if (evidence.status !== 'approved') return 'lost';
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockPaymentOutcomeAuthority(tx, sub);
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${paymentId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.subscriptionId !== sub.id || payment.paymentMethod !== 'MOBILE_MONEY'
        || !payment.clientKey
        || (source === 'history' ? evidence.reference !== payment.clientKey
          : payment.clientKey !== initiatedReference || !usableMmgTransactionId(evidence.transactionId))
        || !['UNKNOWN', 'PENDING', 'FAILED', 'EXPIRED', 'CAPTURED'].includes(payment.status)) {
        return { kind: 'lost' as const };
      }

      const originalAttempt = payment.clientKey.startsWith(`sub:${sub.id}:`)
        ? await tx.billingEvent.findUnique({ where: { idempotencyKey: `charge:${payment.clientKey.slice(4)}` } })
        : null;
      if (payment.status === 'CAPTURED') {
        // The first ID's complete lookup has already won the money CAS. A
        // different positive ID cannot undo that posting or vanish merely
        // because it arrived second. The mismatch helper appends exact evidence
        // and holds future billing without touching paidAt, ledger or period.
        if (!payment.externalRef || !usableMmgTransactionId(evidence.transactionId)
          || payment.externalRef === evidence.transactionId) return { kind: 'lost' as const };
        const reason = `approved MMG ${source} identifier differs from an already captured payment`;
        const notify = await this.retainMmgApprovalHold(
          tx, payment, originalAttempt?.currencyCode ?? null, evidence, reason, now,
        );
        return { kind: 'held' as const, notify, reason, paymentId: payment.id };
      }
      const observation = mmgApprovalObservation(evidence);
      const evidenceKey = `mmg-approval-evidence:${payment.id}:${createHash('sha256').update(JSON.stringify(observation)).digest('hex')}`;
      if (!await tx.billingEvent.findUnique({ where: { idempotencyKey: evidenceKey }, select: { id: true } })) {
        await tx.billingEvent.create({
          data: {
            subscriptionId: payment.subscriptionId,
            type: 'REMINDER', currencyCode: originalAttempt?.currencyCode ?? '',
            idempotencyKey: evidenceKey,
            paymentRef: usableMmgTransactionId(evidence.transactionId) ? evidence.transactionId : undefined,
            note: JSON.stringify({
              providerObservation: observation,
              expectedPayment: {
                transactionId: payment.externalRef,
                amountMinor: Math.round(Number(payment.amount) * 100),
                currencyCode: originalAttempt?.currencyCode ?? null,
                reference: payment.clientKey,
              },
              reason: `approved MMG ${source} pending authoritative lookup`,
              observedAt: now.toISOString(), previousStatus: payment.status,
            }),
          },
        });
      }
      const existingRaw = payment.failureRaw && typeof payment.failureRaw === 'object' && !Array.isArray(payment.failureRaw)
        ? payment.failureRaw : {};
      const alreadyHeld = hasMmgApprovalHold(payment);
      const usableId = usableMmgTransactionId(evidence.transactionId);
      const conflictingId = usableId && !!payment.externalRef && payment.externalRef !== evidence.transactionId;
      const attachId = usableId && !payment.externalRef;
      await tx.subscriptionPayment.update({
        where: { id: payment.id },
        data: {
          status: usableId || payment.externalRef ? 'PENDING' : 'UNKNOWN',
          ...(attachId ? { externalRef: evidence.transactionId } : {}),
          failureCode: conflictingId ? 'SETTLEMENT_MISMATCH' : alreadyHeld ? payment.failureCode : 'HISTORY_APPROVAL_UNVERIFIED',
          failureRaw: {
            ...existingRaw,
            providerOutcome: 'CAPTURED',
            ...(conflictingId ? { recoveryDisposition: 'MANUAL_RECONCILIATION', settlementHold: MMG_APPROVAL_HOLD } : {}),
            ...(alreadyHeld ? {} : {
              ...(!conflictingId ? { recoveryDisposition: 'LOOKUP_OR_MANUAL_RECONCILIATION', settlementHold: MMG_HISTORY_HOLD } : {}),
              providerObservation: observation,
              providerObservationEventKey: evidenceKey,
              firstObservedAt: now.toISOString(),
            }),
          },
        },
      });
      await tx.subscription.update({ where: { id: sub.id }, data: { nextRetryAt: null } });
      return { kind: attachId ? 'adopted' as const : 'held' as const };
    });
    if ('notify' in result && result.notify) {
      await this.notifyMmgReconciliationHold(sub, result.reason, result.paymentId);
    }
    return result.kind;
  }

  private async adoptMmgHistoryId(
    sub: SubWithRelations,
    paymentId: string,
    evidence: MmgTransaction,
  ): Promise<boolean> {
    if (!usableMmgTransactionId(evidence.transactionId)) return false;
    return this.prisma.$transaction(async (tx) => {
      await this.lockPaymentOutcomeAuthority(tx, sub);
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${paymentId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.subscriptionId !== sub.id || payment.paymentMethod !== 'MOBILE_MONEY'
        || payment.status !== 'UNKNOWN' || payment.externalRef || hasMmgApprovalHold(payment)
        || !payment.clientKey || evidence.reference !== payment.clientKey) return false;
      const adopted = await tx.subscriptionPayment.updateMany({
        where: { id: payment.id, status: 'UNKNOWN', externalRef: null },
        data: { externalRef: evidence.transactionId, status: 'PENDING', failureCode: null },
      });
      return adopted.count === 1;
    });
  }

  /**
   * Serialize a late MMG outcome against account deletion and subscription
   * cancellation, then read the authority that is current INSIDE the money
   * transaction. The user lock is first because account deletion owns that row
   * first; a deletion that has already crossed its authority cut-off therefore
   * cannot be followed by a stale subscription snapshot reactivating service.
   *
   * PAUSED is deliberately preserved too. It is excluded from the billing
   * cycle and from OPERABLE_STATUSES; no repository transition says that an
   * asynchronously approved old prompt resumes it. PAST_DUE, SUSPENDED and
   * CHURNED retain their established pay-to-reinstate behaviour.
   */
  private async lockSubscriptionMoneyAuthority(
    tx: Prisma.TransactionClient,
    sub: SubWithRelations,
  ): Promise<{ payerStatus: string; payerPhone: string; status: SubscriptionStatus; autoRenew: boolean }> {
    const payerUserId = this.payerUserId(sub);
    const payerRows = await tx.$queryRaw<Array<{ status: string; phone: string }>>`
      SELECT "status", "phone" FROM "users" WHERE "id" = ${payerUserId} FOR UPDATE
    `;
    const subRows = await tx.$queryRaw<Array<{ status: SubscriptionStatus; autoRenew: boolean }>>`
      SELECT "status", "autoRenew" FROM "subscriptions" WHERE "id" = ${sub.id} FOR UPDATE
    `;
    const payer = payerRows[0];
    const fresh = subRows[0];
    if (!payer) throw new AppError(500, 'ORPHAN_SUBSCRIPTION', `Subscription ${sub.id} has no payer authority row`);
    if (!fresh) throw new AppError(500, 'ORPHAN_SUBSCRIPTION', `Subscription ${sub.id} disappeared during MMG settlement`);
    return { payerStatus: payer.status, payerPhone: payer.phone, status: fresh.status, autoRenew: fresh.autoRenew };
  }

  private successfulChargeAuthorityAllowsAdvance(
    authority: { payerStatus: string; payerPhone: string; status: SubscriptionStatus; autoRenew: boolean },
    sub: SubWithRelations,
  ): boolean {
    const payerUserId = this.payerUserId(sub);
    const deletedAccount = authority.payerStatus === 'DEACTIVATED' || authority.payerPhone === `deleted:${payerUserId}`;
    return !deletedAccount
      && authority.payerStatus === 'ACTIVE'
      && authority.autoRenew
      && ['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CHURNED'].includes(authority.status);
  }

  private async lockPaymentOutcomeAuthority(
    tx: Prisma.TransactionClient,
    sub: SubWithRelations,
  ): Promise<{ bankInsteadOfAdvance: boolean; deletedAccount: boolean; suppressNotice: boolean; status: SubscriptionStatus }> {
    await this.observer.beforeLateMmgAuthorityLock?.(sub.id, tx);
    const locked = await this.lockSubscriptionMoneyAuthority(tx, sub);
    await this.observer.afterLateMmgAuthorityLocked?.(sub.id);

    // Status is mutable administrative state. The tombstone is the durable
    // erasure marker and must continue to win after DEACTIVATED -> BANNED.
    const payerUserId = this.payerUserId(sub);
    const deletedAccount = locked.payerStatus === 'DEACTIVATED' || locked.payerPhone === `deleted:${payerUserId}`;
    if (deletedAccount || locked.status === 'CANCELLED') {
      // Contain old deletion rows as well as new ones. Immutable payment facts
      // remain below, but no future billing job may select this subscription.
      await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELLED', autoRenew: false, nextRetryAt: null },
      });
      return { bankInsteadOfAdvance: true, deletedAccount, suppressNotice: deletedAccount, status: 'CANCELLED' };
    }
    return {
      bankInsteadOfAdvance: !this.successfulChargeAuthorityAllowsAdvance(locked, sub),
      deletedAccount: false,
      suppressNotice: locked.payerStatus !== 'ACTIVE',
      status: locked.status,
    };
  }

  /**
   * Linearization point for a NEW external money effect. Intent reservation is
   * not permission to send: immediately before CARD charge/MMG prompt dispatch,
   * lock payer -> subscription -> payment and persist which side won.
   *
   * If cancellation/deletion commits first, the provider is never called and
   * the known-unsent intent becomes terminal, non-dunning evidence. If this
   * transaction commits first, its AUTHORIZED marker is the durable cut-off;
   * later cancellation still wins lifecycle state while the already-authorized
   * provider result is reconciled/banked exactly once.
   */
  private async authorizeProviderEffect(
    sub: SubWithRelations,
    paymentId: string,
    rail: 'CARD' | 'MOBILE_MONEY',
    now: Date,
  ): Promise<boolean> {
    await this.observer.beforeProviderEffectAuthorization?.(sub.id, paymentId, rail);
    return this.prisma.$transaction(async (tx) => {
      const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${paymentId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.subscriptionId !== sub.id || payment.paymentMethod !== rail
        || payment.status !== 'UNKNOWN' || payment.externalRef !== null) return false;

      const maySend = !await this.subscriptionHasMmgApprovalHold(tx, sub.id)
        && !authority.bankInsteadOfAdvance
        && !authority.suppressNotice
        && ['ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(authority.status);
      if (!maySend) {
        await tx.subscriptionPayment.updateMany({
          where: {
            id: payment.id,
            subscriptionId: sub.id,
            paymentMethod: rail,
            status: 'UNKNOWN',
            externalRef: null,
          },
          data: {
            status: 'EXPIRED',
            failureCode: 'DISPATCH_REVOKED',
            failureRaw: {
              providerEffect: 'NOT_SENT',
              providerRail: rail,
              revokedAt: now.toISOString(),
              subscriptionOutcome: PRESERVED_NO_DUNNING,
              subscriptionStatus: authority.status,
              recoveryDisposition: 'NO_PROVIDER_EFFECT',
            },
          },
        });
        return false;
      }

      const authorized = await tx.subscriptionPayment.updateMany({
        where: {
          id: payment.id,
          subscriptionId: sub.id,
          paymentMethod: rail,
          status: 'UNKNOWN',
          externalRef: null,
        },
        data: {
          failureRaw: {
            providerEffect: 'AUTHORIZED',
            providerRail: rail,
            authorizedAt: now.toISOString(),
          },
        },
      });
      return authorized.count === 1;
    });
  }

  /**
   * A provider call may return after deletion, cancellation, pause, another
   * poller, or a successful settlement has already won. Preserve the provider
   * observation, but arm another retry (and license an approval notice) only
   * while the exact payment CAS wins under the current locked subscription
   * authority. This is intentionally the same payer -> subscription -> payment
   * lock order as terminalization and settlement.
   */
  private async persistPaymentNonterminalObservation(
    sub: SubWithRelations,
    input: {
      paymentId: string;
      paymentMethod?: 'MOBILE_MONEY' | 'CARD';
      from: Array<'UNKNOWN' | 'FAILED'>;
      requireNoExternalRef?: boolean;
      data: Prisma.SubscriptionPaymentUpdateManyMutationInput;
      now: Date;
    },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${input.paymentId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: input.paymentId } });
      if (payment && hasMmgApprovalHold(payment)) return false;
      const existingRaw = payment?.failureRaw && typeof payment.failureRaw === 'object' && !Array.isArray(payment.failureRaw)
        ? payment.failureRaw : {};
      const observedRaw = input.data.failureRaw && typeof input.data.failureRaw === 'object' && !Array.isArray(input.data.failureRaw)
        ? input.data.failureRaw : {};
      const observed = await tx.subscriptionPayment.updateMany({
        where: {
          id: input.paymentId,
          subscriptionId: sub.id,
          paymentMethod: input.paymentMethod ?? 'MOBILE_MONEY',
          status: { in: input.from },
          ...(input.requireNoExternalRef ? { externalRef: null } : {}),
        },
        data: { ...input.data, failureRaw: { ...existingRaw, ...observedRaw } },
      });
      if (observed.count !== 1) return false;

      const live = await tx.subscription.findUnique({
        where: { id: sub.id },
        select: { autoRenew: true },
      });
      if (await this.subscriptionHasMmgApprovalHold(tx, sub.id)
        || authority.bankInsteadOfAdvance || authority.suppressNotice || !live?.autoRenew
        || !['ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(authority.status)) return false;

      await tx.subscription.update({
        where: { id: sub.id },
        data: { nextRetryAt: new Date(input.now.getTime() + RETRY_HOURS * 60 * 60 * 1000) },
      });
      return true;
    });
  }

  private mmgApprovalMismatch(
    payment: {
      amount: Prisma.Decimal;
      externalRef: string | null;
      clientKey: string | null;
    },
    attemptCurrency: string | null,
    evidence: MmgApprovalEvidence,
  ): string | null {
    const providerId = String(evidence.transactionId ?? '').trim();
    const providerCurrency = String(evidence.currencyCode ?? '').trim().toUpperCase();
    const providerReference = String(evidence.reference ?? '').trim();
    const expectedProviderId = String(payment.externalRef ?? '').trim();
    const expectedReference = String(payment.clientKey ?? '').trim();
    const expectedCurrency = String(attemptCurrency ?? '').trim().toUpperCase();
    const expectedMinor = Math.round(Number(payment.amount) * 100);

    if (!providerId || providerId !== expectedProviderId) return 'provider transaction id does not match the durable intent';
    if (!expectedReference || providerReference !== expectedReference) return 'merchant reference does not match the durable intent';
    if (typeof evidence.amountMinor !== 'number' || !Number.isSafeInteger(evidence.amountMinor)
      || evidence.amountMinor <= 0 || evidence.amountMinor !== expectedMinor) {
      return 'provider amount does not match the durable intent';
    }
    // [G2-F1] Before the fix a subscription's MMG request carried the COUNTRY
    // code "GY" as its currency; the data migration corrected the durable
    // attempt pin to "GYD". A request still in flight across that deploy can
    // come back with "GY" on its evidence. MMG is a Guyana-only rail, so "GY"
    // is the same money as "GYD" here — and only that one equivalence: any
    // other disagreement is still refused.
    const mmgCurrency = (code: string) => (code === 'GY' ? 'GYD' : code);
    if (!expectedCurrency || !providerCurrency || mmgCurrency(providerCurrency) !== mmgCurrency(expectedCurrency)) {
      return 'provider currency does not match the durable charge attempt';
    }
    return null;
  }

  /**
   * The single post-provider authority for an approved MMG intent. Both an
   * immediate provider response and the asynchronous poller enter here. The
   * payer -> subscription locks choose bank-vs-advance from current durable
   * state, and the payment CAS fences the economic disposition so only one
   * observer may credit a wallet or grant the week.
   */
  private async settleApprovedMmgPayment(
    sub: SubWithRelations,
    paymentId: string,
    evidence: MmgApprovalEvidence,
    now: Date,
  ): Promise<'advanced' | 'banked' | 'held' | 'lost'> {
    if (evidence.status !== 'approved') return 'lost';
    const result = await this.prisma.$transaction(async (tx) => {
      const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${paymentId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.subscriptionId !== sub.id || payment.paymentMethod !== 'MOBILE_MONEY'
        || !['PENDING', 'UNKNOWN', 'FAILED', 'EXPIRED'].includes(payment.status)) {
        return { kind: 'lost' as const };
      }
      const originalAttempt = payment.clientKey?.startsWith(`sub:${sub.id}:`)
        ? await tx.billingEvent.findUnique({ where: { idempotencyKey: `charge:${payment.clientKey.slice(4)}` } })
        : null;
      const mismatch = this.mmgApprovalMismatch(payment, originalAttempt?.currencyCode ?? null, evidence);
      const raw = payment.failureRaw && typeof payment.failureRaw === 'object' && !Array.isArray(payment.failureRaw)
        ? payment.failureRaw : {};
      const provisionalHistoryHold = raw['settlementHold'] === MMG_HISTORY_HOLD;
      if (mismatch || (hasMmgApprovalHold(payment) && !provisionalHistoryHold)) {
        const reason = mismatch ?? 'An earlier approved mismatch still requires manual reconciliation';
        const notify = await this.retainMmgApprovalHold(tx, payment, originalAttempt?.currencyCode ?? null, evidence, reason, now);
        return { kind: 'held' as const, reason, paymentId: payment.id, notify };
      }

      const periodKey = payment.periodStart.toISOString().slice(0, 10);
      const covered = await tx.billingEvent.findUnique({
        where: { idempotencyKey: `success:${sub.id}:${periodKey}` },
        select: { id: true },
      });
      const otherApprovalHeld = await this.subscriptionHasMmgApprovalHold(tx, sub.id, payment.id);
      if (covered || authority.bankInsteadOfAdvance || otherApprovalHeld) {
        const walletHold = await this.holdWalletCurrencyMismatch(tx, payment, originalAttempt!.currencyCode, evidence.transactionId);
        if (walletHold) return { kind: 'held' as const, reason: 'Captured payment currency differs from the wallet', paymentId: payment.id, notify: walletHold.notify };
      }

      const claimed = await tx.subscriptionPayment.updateMany({
        where: {
          id: paymentId,
          subscriptionId: sub.id,
          paymentMethod: 'MOBILE_MONEY',
          status: { in: ['PENDING', 'UNKNOWN', 'FAILED', 'EXPIRED'] },
          externalRef: evidence.transactionId,
          clientKey: evidence.reference!,
        },
        data: {
          status: 'CAPTURED', paidAt: now, failureCode: null,
          ...(provisionalHistoryHold ? {
            failureRaw: Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'settlementHold')),
          } : {}),
        },
      });
      if (claimed.count === 0) return { kind: 'lost' as const };

      // The approved intent is the immutable money fact. A retry may have a
      // different price and attempt pin; neither can rewrite money received.
      const amount = Number(payment.amount);
      // `mmgApprovalMismatch` already proved this exact issued-attempt pin.
      // Never let a later rail/currency preference rewrite received money.
      const settlementCurrency = originalAttempt!.currencyCode;
      const usdTrio = originalAttempt?.amountUsd && originalAttempt.fxRateId && originalAttempt.fxRateUsed
        ? { amountUsd: Number(originalAttempt.amountUsd), fxRateId: originalAttempt.fxRateId, fxRateUsed: Number(originalAttempt.fxRateUsed) }
        : undefined;
      const current = {
        ...sub,
        status: authority.status,
        nextBillingDate: payment.periodStart,
        billingMethod: 'MOBILE_MONEY' as const,
        currencyCode: settlementCurrency,
      };

      if (covered || authority.bankInsteadOfAdvance || otherApprovalHeld) {
        const reason = covered
          ? `week ${periodKey} already covered`
          : otherApprovalHeld ? 'another payment requires manual reconciliation'
          : `subscription is ${authority.status}${authority.deletedAccount ? ' after account deletion' : ''}`;
        await this.creditWalletInTx(tx, {
          subscriptionId: sub.id,
          amount,
          currencyCode: settlementCurrency,
          eventKey: `bank:${payment.id}`,
          note: `late MMG approval banked — ${reason} (payment ${payment.id})`,
          channel: 'MMG_LATE_APPROVAL',
          mmgRef: evidence.transactionId,
        });
        return { kind: 'banked' as const, reason, notify: !authority.suppressNotice, amount, currencyCode: settlementCurrency };
      }

      const applied = await this.applySuccessfulChargeInTx(
        tx,
        current,
        amount,
        evidence.transactionId,
        now,
        periodKey,
        payment.id,
        usdTrio,
      );
      if (applied !== 'advanced') throw new Error(`Locked MMG authority changed while settling payment ${payment.id}`);
      return { kind: 'advanced' as const, current, amount, periodKey };
    });

    if (result.kind === 'held' && result.notify) {
      await this.notifyMmgReconciliationHold(sub, result.reason, result.paymentId);
    } else if (result.kind === 'banked' && result.notify) {
      await this.notifications.send({
        userId: this.payerUserId(sub),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'MMG payment received — added to your balance',
        body: `Your MMG approval of $${result.amount.toLocaleString()} ${result.currencyCode} arrived after ${result.reason}. It's banked as balance and has not changed your subscription state.`,
        audience: this.payerAudience(sub),
        data: { kind: 'billing_banked', subscriptionId: sub.id },
      }).catch(() => {});
    } else if (result.kind === 'advanced') {
      await this.afterSuccessfulCharge(result.current, result.amount, result.periodKey);
    }
    return result.kind;
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
            // Positive history must become durable BEFORE a later lookup can
            // contradict it. Both the observation and ID adoption serialize
            // with payer, subscription and payment authority.
            if (match.status === 'approved') {
              const observed = await this.retainMmgHistoryApproval(sub as SubWithRelations, payment.id, match, now);
              if (observed === 'adopted') out.adopted += 1;
              else out.stillPending += 1;
            } else if (await this.adoptMmgHistoryId(sub as SubWithRelations, payment.id, match)) {
              out.adopted += 1;
            } else out.stillPending += 1;
            continue;
          }
        } catch {
          out.stillPending += 1; // provider unreachable — UNKNOWN stays UNKNOWN [LAW M-5]
          continue;
        }
        if (now >= ttlAt) {
          // A never-authorized reservation may expire. A dispatched request
          // remains UNKNOWN: an empty history page is not proof of absence.
          // [M-04] Terminal status and dunning outcome land in ONE transaction,
          // behind the same per-row boundary the lookup branch has: one row's
          // failure must never abort the sweep for every other payer.
          try {
            const outcome = await this.terminalizeFailedPayment(
              sub as SubWithRelations, payment, { status: 'EXPIRED', failureCode: 'REQUEST_EXPIRED', from: ['UNKNOWN'], providerAbsenceOnly: true },
              'MMG request lost in transit — never confirmed at MMG', now, periodKey,
            );
            if (!outcome) { out.stillPending += 1; continue; }
            out.failed += 1;
          } catch (err) {
            log().error({ err, paymentId: payment.id, subscriptionId: sub.id }, 'MMG poll expiry failed for one payment — continuing');
          }
        } else {
          out.stillPending += 1;
        }
        continue;
      }

      let lookup: MmgTransaction;
      try {
        lookup = await mmg.transactionLookup({ transactionId: payment.externalRef });
      } catch {
        out.stillPending += 1; // transport hiccup — the next tick retries
        continue;
      }
      const status = lookup.status;
      const expired = status === 'expired' || (status === 'pending' && now.getTime() >= ttlAt.getTime());

      // SWIFT-AUD-D2-04, completed: settle is single-winner AND atomic. The
      // CAS claim now lives INSIDE the same transaction as the period advance
      // (or the bank), so a crash between them is impossible — the claim
      // rolls back with everything else and the next tick retries whole.
      try {
        if (status === 'approved') {
          const result = await this.settleApprovedMmgPayment(
            sub as SubWithRelations,
            payment.id,
            lookup,
            now,
          );
          if (result === 'lost') continue;
          if (result === 'held') {
            out.stillPending += 1;
            continue;
          }
          if (result === 'banked') {
            out.banked += 1;
            continue;
          }
          out.settled += 1;
        } else if (status === 'declined' || status === 'reversed' || expired) {
          // [M-04] Terminal status and dunning outcome land in ONE transaction.
          const outcome = await this.terminalizeFailedPayment(
            sub as SubWithRelations, payment,
            { status: expired ? 'EXPIRED' : 'FAILED', failureCode: expired ? 'REQUEST_EXPIRED' : mapMmgFailure(status), from: ['PENDING', 'UNKNOWN'], providerAbsenceOnly: status === 'pending' },
            `MMG request ${expired ? 'expired unapproved' : status}`, now, periodKey,
          );
          if (!outcome) { out.stillPending += 1; continue; }
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
   * is unavailable through this boundary, including unchecked runtime callers.
   *
   * [E12] This is also the RESUME action: it arms auto-renew in the same
   * transaction as the rail write, so a partner who stopped weekly billing
   * resumes on the rail they pick. A PAUSED plan (stopped, then its paid
   * period ended) restarts ACTIVE and due now. A CANCELLED (wind-down) or
   * CHURNED (closed after non-payment) subscription is refused with 409 —
   * resuming must not silently reopen a closed account.
   */
  async setBillingRail(subscriptionId: string, method: 'CASH' | 'MOBILE_MONEY', mmgPayerMsisdn?: string) {
    if (method !== 'CASH' && method !== 'MOBILE_MONEY') {
      throw new AppError(400, 'BILLING_RAIL_UNAVAILABLE', 'Choose cash or mobile money.');
    }
    if (method === 'MOBILE_MONEY' && !mmgPayerMsisdn?.trim()) {
      throw new AppError(400, 'MSISDN_REQUIRED', 'Your MMG account number is required to pay the weekly fee via MMG.');
    }
    let resumedFromPause = false;
    const updated = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: SubscriptionStatus }>>`
        SELECT "status" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE
      `;
      const fresh = rows[0];
      if (!fresh) throw new NotFoundError('Subscription', subscriptionId);
      if (fresh.status === 'CANCELLED' || fresh.status === 'CHURNED') {
        throw new AppError(
          409,
          'SUBSCRIPTION_CLOSED',
          fresh.status === 'CHURNED'
            ? 'Your subscription is closed after non-payment. Pay your weekly fee to rejoin, then set your billing method again.'
            : 'This subscription has ended. Contact Swift to renew before resuming weekly billing.',
        );
      }
      // Resume the retry clock for a subscription that is behind or suspended:
      // the cycle's PAST_DUE/SUSPENDED arm selects on nextRetryAt, which the
      // stop cleared. Arming now lets the next run attempt the owed week.
      const behind = fresh.status === 'PAST_DUE' || fresh.status === 'SUSPENDED';
      // [E12] A PAUSED plan (stopped, then its paid period ran out) restarts
      // NOW: ACTIVE and due immediately, so the next cycle charges this week
      // (its period starts at nextBillingDate) exactly like any renewal, and a
      // failed charge follows the normal dunning.
      const paused = fresh.status === 'PAUSED';
      resumedFromPause = paused;
      return tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          billingMethod: method,
          mmgPayerMsisdn: method === 'MOBILE_MONEY' ? mmgPayerMsisdn!.trim() : null,
          autoRenew: true,
          ...(behind ? { nextRetryAt: new Date() } : {}),
          ...(paused ? { status: 'ACTIVE', nextBillingDate: new Date(), nextRetryAt: null } : {}),
        },
      });
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
    // [DS207 F2] A resumed PAUSED plan is charged NOW, through the same
    // instant path a top-up uses, not at the next hourly cycle: otherwise a
    // partner could resume, work until just before the cycle, stop again and
    // never pay for that work. A failed or in-flight charge follows the normal
    // dunning; the cycle still retries a row that remains due.
    if (resumedFromPause) {
      try {
        const sub = await this.prisma.subscription.findUnique({
          where: { id: subscriptionId },
          include: {
            rider: { select: { userId: true } },
            driver: { select: { userId: true } },
            vendor: { select: { id: true, owner: { select: { userId: true } } } },
          },
        });
        if (sub) await this.billSubscription(sub as SubWithRelations);
      } catch (err) {
        log().error({ err, subscriptionId }, 'instant charge after resuming a paused plan failed — the billing cycle retries');
      }
    }
    return updated;
  }

  /**
   * [E12] A partner's self-serve "stop weekly billing" (method NONE). One
   * transaction with the subscription row locked FOR UPDATE — the same locking
   * shape as `lockSubscriptionMoneyAuthority` — so a concurrent resume or
   * cycle cannot interleave. Sets `autoRenew=false` and `nextRetryAt=null`
   * only: the rail (`billingMethod` / `mmgPayerMsisdn`) stays so a resume
   * knows where to come back, and status/balance/debt are untouched (an owed
   * week is still owed; nothing is reinstated or cleared). Writes ONE
   * TIER_CHANGE note event — the `setBillingRail` precedent — keyed by the
   * locked row's pre-stop `updatedAt`, so a double-stop is a no-op rather than
   * a second event, while a later stop after a resume gets its own key. A
   * partner action this consequential also writes an audit row naming the
   * actor, matching the billing module's top-up precedent.
   */
  async stopBilling(subscriptionId: string, actorUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: SubscriptionStatus; autoRenew: boolean; currencyCode: string; updatedAt: Date }>>`
        SELECT "id", "status", "autoRenew", "currencyCode", "updatedAt" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE
      `;
      const fresh = rows[0];
      if (!fresh) throw new NotFoundError('Subscription', subscriptionId);
      // [DS198 D5] A closed subscription has nothing to stop: say so rather
      // than answering a no-op 200.
      if (fresh.status === 'CANCELLED' || fresh.status === 'CHURNED') {
        throw new AppError(409, 'SUBSCRIPTION_CLOSED', 'This subscription has already ended; there is no weekly billing to stop.');
      }
      if (!fresh.autoRenew) {
        // Idempotent double-stop: already stopped — change nothing, write no
        // second event, add no second audit row.
        return tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
      }
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: { autoRenew: false, nextRetryAt: null },
      });
      await tx.billingEvent.create({
        data: {
          subscriptionId,
          type: 'TIER_CHANGE',
          currencyCode: fresh.currencyCode,
          idempotencyKey: `stop:${subscriptionId}:${fresh.updatedAt.toISOString()}`,
          note: 'Weekly billing stopped by the partner',
        },
      });
      await tx.auditLog.create({
        data: {
          userId: actorUserId,
          action: 'BILLING_STOPPED',
          entity: 'Subscription',
          entityId: subscriptionId,
          changes: { autoRenew: false, nextRetryAt: null },
        },
      });
      return tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    });
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
    // Exclude every recognized outcome BEFORE the cap. Filtering ordinary
    // CHARGE_FAILED/success rows in the loop let the same 500 oldest handled
    // rows crowd a later real gap out of every run forever. The window count
    // makes stillOpen an honest snapshot even when more than 500 gaps exist.
    const terminal = await this.prisma.$queryRaw<Array<{
      id: string;
      subscriptionId: string;
      amount: Prisma.Decimal;
      periodStart: Date;
      createdAt: Date;
      lastPolledAt: Date | null;
      failureRaw: Prisma.JsonValue | null;
      openCount: number;
    }>>`
      SELECT p."id", p."subscriptionId", p."amount", p."periodStart", p."createdAt", p."lastPolledAt", p."failureRaw",
             (COUNT(*) OVER())::int AS "openCount"
      FROM "subscription_payments" p
      WHERE p."paymentMethod" = 'MOBILE_MONEY'::"PaymentMethod"
        AND p."status" IN ('FAILED'::"PaymentStatus", 'EXPIRED'::"PaymentStatus")
        AND p."createdAt" >= ${since}
        AND COALESCE(p."failureRaw"->>'subscriptionOutcome', '') <> ${PRESERVED_NO_DUNNING}
        AND NOT EXISTS (
          SELECT 1
          FROM "billing_events" e
          WHERE e."subscriptionId" = p."subscriptionId"
            AND (
              (e."type" = 'CHARGE_FAILED'::"BillingEventType"
                AND e."idempotencyKey" LIKE 'failed:' || p."subscriptionId" || ':'
                  || to_char(p."periodStart" AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ':%')
              OR e."idempotencyKey" = 'success:' || p."subscriptionId" || ':'
                || to_char(p."periodStart" AT TIME ZONE 'UTC', 'YYYY-MM-DD')
            )
        )
      ORDER BY p."createdAt" ASC, p."id" ASC
      LIMIT 500
    `;
    let repaired = 0;
    let resolved = 0;
    const snapshotOpen = Number(terminal[0]?.openCount ?? 0);
    let failedInBatch = 0;
    let oldestMinutes: number | null = null;
    for (const p of terminal) {
      // The row records no terminalization time; the last poll (or creation) bounds the gap's age from below.
      const ageMinutes = Math.round((now.getTime() - (p.lastPolledAt ?? p.createdAt).getTime()) / 60_000);
      const sub = await this.prisma.subscription.findUnique({
        where: { id: p.subscriptionId },
        include: {
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          vendor: { select: { id: true, owner: { select: { userId: true } } } },
        },
      });
      if (!sub) {
        failedInBatch += 1;
        oldestMinutes = oldestMinutes == null ? ageMinutes : Math.max(oldestMinutes, ageMinutes);
        continue;
      }
      try {
        const reason = 'Terminal MMG payment without a recorded outcome — repaired by reconciliation';
        const result = await this.prisma.$transaction(async (tx) => {
          // The scan is only a candidate list. Deletion/cancellation, approval,
          // another repair or a retry may have committed since it was read.
          const authority = await this.lockPaymentOutcomeAuthority(tx, sub as SubWithRelations);
          if (await this.subscriptionHasMmgApprovalHold(tx, sub.id)) return { kind: 'skipped' as const };
          // Retry adoption can reopen a FAILED payment without locking the
          // subscription; fence its status too, after payer -> subscription.
          await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${p.id} FOR UPDATE`;
          const payment = await tx.subscriptionPayment.findUnique({ where: { id: p.id } });
          if (!payment || payment.subscriptionId !== sub.id || payment.paymentMethod !== 'MOBILE_MONEY'
            || !['FAILED', 'EXPIRED'].includes(payment.status)) return { kind: 'skipped' as const };
          const existing = payment.failureRaw && typeof payment.failureRaw === 'object' && !Array.isArray(payment.failureRaw)
            ? payment.failureRaw as Prisma.JsonObject
            : {};
          if (existing['subscriptionOutcome'] === PRESERVED_NO_DUNNING) return { kind: 'skipped' as const };
          const periodKey = payment.periodStart.toISOString().slice(0, 10);
          const [failure, success] = await Promise.all([
            tx.billingEvent.findFirst({
              where: { subscriptionId: sub.id, type: 'CHARGE_FAILED', idempotencyKey: { startsWith: `failed:${sub.id}:${periodKey}:` } },
              select: { id: true },
            }),
            tx.billingEvent.findUnique({ where: { idempotencyKey: `success:${sub.id}:${periodKey}` }, select: { id: true } }),
          ]);
          if (failure || success) return { kind: 'skipped' as const };
          if (authority.bankInsteadOfAdvance || !['ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(authority.status)) {
            await tx.subscriptionPayment.update({
              where: { id: payment.id },
              data: {
                failureRaw: {
                  ...existing,
                  subscriptionOutcome: PRESERVED_NO_DUNNING,
                  subscriptionStatus: authority.status,
                } as Prisma.InputJsonObject,
              },
            });
            return { kind: 'preserved' as const };
          }
          // Dunning counters are authority too: a stale retry snapshot must
          // not overwrite a more recent failure or successful payment.
          const fresh = await tx.subscription.findUnique({ where: { id: sub.id } });
          if (!fresh) throw new Error(`Locked subscription ${sub.id} disappeared during MMG repair`);
          const current = { ...sub, ...fresh } as SubWithRelations;
          const outcome = await this.recordFailureInTx(tx, current, Number(payment.amount), reason, now, periodKey);
          return { kind: 'dunned' as const, current, outcome };
        });
        if (result.kind === 'skipped') {
          resolved += 1;
          continue;
        }
        repaired += 1;
        resolved += 1;
        billingOutcomeRepairsCounter.inc();
        if (result.kind === 'dunned') await this.afterFailureNotices(result.current, result.outcome, reason);
      } catch (err) {
        failedInBatch += 1;
        oldestMinutes = oldestMinutes == null ? ageMinutes : Math.max(oldestMinutes, ageMinutes);
        log().error({ err, paymentId: p.id, subscriptionId: p.subscriptionId }, '[M-04] repair of a terminal payment without outcome failed — continuing');
      }
    }
    const stillOpen = Math.max(failedInBatch, snapshotOpen - resolved);
    if (stillOpen > 0 && oldestMinutes == null && terminal.length > 0) {
      const boundary = terminal[terminal.length - 1]!;
      oldestMinutes = Math.round((now.getTime() - (boundary.lastPolledAt ?? boundary.createdAt).getTime()) / 60_000);
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
    terminal: {
      status: 'FAILED' | 'EXPIRED';
      failureCode: string;
      from: Array<'PENDING' | 'UNKNOWN'>;
      requireNoExternalRef?: boolean;
      failureRaw?: string;
      preserveWithoutDunning?: { providerOutcome: string; recoveryDisposition: string };
      /** Local TTL / empty lookup is not a terminal provider acknowledgement. */
      providerAbsenceOnly?: boolean;
    },
    reason: string,
    now: Date,
    periodKey: string,
  ): Promise<'failed' | 'suspended' | 'skipped' | null> {
    const result = await this.prisma.$transaction(async (tx) => {
      // All rails preserve current lifecycle authority; a card decline must
      // not overwrite cancellation merely because it is not an MMG result.
      const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
      if (await this.subscriptionHasMmgApprovalHold(tx, sub.id)) return null;
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${payment.id} FOR UPDATE`;
      const currentPayment = await tx.subscriptionPayment.findUnique({ where: { id: payment.id } });
      if (!currentPayment || currentPayment.subscriptionId !== sub.id) return null;
      const existingRaw = currentPayment.failureRaw && typeof currentPayment.failureRaw === 'object' && !Array.isArray(currentPayment.failureRaw)
        ? currentPayment.failureRaw : {};
      // Dispatch and local expiry share the exact authority/payment locks. An
      // expiry winner prevents dispatch; a dispatch winner remains pollable
      // until the provider confirms a terminal outcome. A clock or empty
      // lookup cannot prove an outstanding request will never capture.
      if (existingRaw['providerOutcome'] === 'CAPTURED'
        || (terminal.providerAbsenceOnly && (existingRaw['providerEffect'] !== 'NOT_SENT' || currentPayment.externalRef))) return null;
      const baseFailureRaw = {
        ...existingRaw,
        ...(terminal.failureRaw ? { reason: terminal.failureRaw } : {}),
        ...(terminal.preserveWithoutDunning ?? {}),
      };
      const claimed = await tx.subscriptionPayment.updateMany({
        where: { id: payment.id, status: { in: terminal.from }, ...(terminal.requireNoExternalRef ? { externalRef: null } : {}) },
        data: {
          status: terminal.status,
          failureCode: terminal.failureCode,
          ...(Object.keys(baseFailureRaw).length > 0 ? { failureRaw: baseFailureRaw } : {}),
        },
      });
      if (claimed.count === 0) return null;
      await this.observer.afterPaymentTerminalized?.({ id: payment.id, status: terminal.status });

      if (authority) {
        // The provider call happened outside this transaction. Its subscription
        // snapshot is therefore evidence of what was attempted, not authority
        // to suspend the payer now. The payer -> subscription locks above make
        // the following fresh read and covered-period check one stable
        // generation with the payment CAS and any dunning mutation.
        const [fresh, covered] = await Promise.all([
          tx.subscription.findUnique({ where: { id: sub.id } }),
          tx.billingEvent.findUnique({
            where: { idempotencyKey: `success:${sub.id}:${periodKey}` },
            select: { id: true },
          }),
        ]);
        if (!fresh) throw new Error(`Locked subscription ${sub.id} disappeared during MMG terminalization`);
        const terminalForDunning = !['ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(authority.status);
        if (authority.bankInsteadOfAdvance || terminalForDunning || covered || terminal.preserveWithoutDunning) {
          await tx.subscriptionPayment.update({
            where: { id: payment.id },
            data: {
              failureRaw: {
                ...baseFailureRaw,
                reason: terminal.failureRaw ?? reason,
                subscriptionOutcome: PRESERVED_NO_DUNNING,
                subscriptionStatus: authority.status,
                ...(covered ? { periodOutcome: 'ALREADY_PAID' } : {}),
              },
            },
          });
          return { kind: 'preserved' as const };
        }
        const current = { ...sub, ...fresh, status: authority.status } as SubWithRelations;
        return {
          kind: 'dunned' as const,
          current,
          outcome: await this.recordFailureInTx(tx, current, Number(payment.amount), reason, now, periodKey),
        };
      }

      return { kind: 'dunned' as const, current: sub, outcome: await this.recordFailureInTx(tx, sub, Number(payment.amount), reason, now, periodKey) };
    });
    if (!result) return null;
    if (result.kind === 'preserved') return 'skipped';
    await this.afterFailureNotices(result.current, result.outcome, reason);
    return result.outcome.willSuspend ? 'suspended' : 'failed';
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
  ): Promise<'failed' | 'suspended' | 'skipped'> {
    const result = await this.prisma.$transaction(async (tx) => {
      const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
      if (await this.subscriptionHasMmgApprovalHold(tx, sub.id)) return null;
      const covered = await tx.billingEvent.findUnique({ where: { idempotencyKey: `success:${sub.id}:${periodKey}` }, select: { id: true } });
      if (authority.bankInsteadOfAdvance || covered || !['ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(authority.status)) return null;
      const fresh = await tx.subscription.findUnique({ where: { id: sub.id } });
      if (!fresh) throw new Error(`Locked subscription ${sub.id} disappeared during failure reconciliation`);
      const current = { ...sub, ...fresh } as SubWithRelations;
      return { current, outcome: await this.recordFailureInTx(tx, current, amount, reason, now, periodKey) };
    });
    if (!result) return 'skipped';
    await this.afterFailureNotices(result.current, result.outcome, reason);
    return result.outcome.willSuspend ? 'suspended' : 'failed';
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

  private async reinstateRows(tx: Prisma.TransactionClient, sub: SubWithRelations, periodKey: string) {
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
      await tx.vendor.updateMany({
        where: {
          id: sub.vendor.id,
          status: 'SUSPENDED',
          OR: [{ suspensionSource: 'BILLING' }, { suspensionSource: null }],
        },
        data: { status: 'ACTIVE', suspensionSource: null },
      });
      await tx.vendor.updateMany({
        where: { id: sub.vendor.id, status: 'ACTIVE', isVerified: true },
        data: { acceptingOrders: true },
      });
    }

    await tx.billingEvent.create({
      data: {
        subscriptionId: sub.id,
        type: 'REINSTATED',
        currencyCode: sub.currencyCode,
        idempotencyKey: `reinstated:${sub.id}:${periodKey}:${Date.now()}`,
        note: 'Payment received — access restored',
      },
    });
  }

  /** Best-effort SMS to the payer — dunning escalation channel (§11: the
   *  scarce resource is attention; push may be muted or the app deleted).
   *  Never throws into a billing decision. */
  private async smsPayer(sub: SubWithRelations, body: string, renewNoticeLease?: BillingNoticeLeaseGuard) {
    const user = await this.prisma.user.findUnique({
      where: { id: this.payerUserId(sub) },
      select: { phone: true },
    });
    if (!user?.phone) throw new Error('payer phone unavailable');
    // The subscription and phone lookups may outlive a committed notice's
    // lease. Renew only the unexpired current token, after all preparation and
    // immediately before invoking the provider; a stale worker leaves it due.
    if (renewNoticeLease) {
      // A successful UPDATE can reach this worker after its renewed lease has
      // expired. Start before the query so a delayed response or paused worker
      // consumes the full budget. This matches the notice's 120-second DB lease
      // without comparing host wall time with database time.
      const renewalStarted = performance.now();
      if (!await renewNoticeLease() || performance.now() - renewalStarted >= 120_000) {
        throw new Error('billing notice lease lost before SMS');
      }
    }
    await getChannels().sms.sendSms(user.phone, body);
  }

  private async sendNoticeSms(subscriptionId: string, userId: string, body: string, renewLease: BillingNoticeLeaseGuard): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
    });
    if (!sub || this.payerUserId(sub) !== userId) throw new Error('billing notice payer changed');
    await this.smsPayer(sub, body, renewLease);
  }

  /** Retry committed notice intents independently of the current subscription
   * state. In particular, CHURNED no longer hides an undelivered final notice. */
  async drainPendingNotices(now = new Date()): Promise<{ attempted: number; delivered: number }> {
    return drainPendingBillingNotices(this.prisma, this.notifications, now, (subscriptionId, userId, body, renewLease) =>
      this.sendNoticeSms(subscriptionId, userId, body, renewLease));
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
    for (const candidate of suspended) {
      try {
        // The selection is only a candidate. MMG hold creation takes these
        // same payer -> subscription locks, so a hold committed first must be
        // visible before either the churn CAS or daily nudge event is written.
        const decision = await this.prisma.$transaction(async (tx) => {
          const authority = await this.lockSubscriptionMoneyAuthority(tx, candidate as SubWithRelations);
          if (authority.status !== 'SUSPENDED') return null;
          const sub = await tx.subscription.findUnique({
            where: { id: candidate.id },
            include: {
              rider: { select: { userId: true } },
              driver: { select: { userId: true } },
              vendor: { select: { id: true, owner: { select: { userId: true } } } },
            },
          });
          if (!sub || sub.status !== 'SUSPENDED' || await this.subscriptionHasMmgApprovalHold(tx, sub.id)) return null;
          const suspendedSince = sub.suspendedAt ?? sub.updatedAt; // pre-migration rows fall back to last touch
          if (now.getTime() - suspendedSince.getTime() >= suspensionMaxDays() * DAY_MS) {
            // Keep the state and its audit fact in one commit. The CAS also
            // protects against an older writer that does not take this lock.
            const moved = await tx.subscription.updateMany({
              where: { id: sub.id, status: 'SUSPENDED' },
              data: { status: 'CHURNED', nextRetryAt: null, isInGracePeriod: false, gracePeriodEnd: null },
            });
            if (moved.count === 0) return null;
            const noticeKey = `churned:${sub.id}:${suspendedSince.toISOString()}`;
            const notice: BillingNotice = {
              noticeVersion: 1, target: 'payer', userId: this.payerUserId(sub), audience: this.payerAudience(sub),
              title: 'Subscription closed',
              body: 'Your subscription was closed after 30 days unpaid. You can rejoin anytime — pay your weekly fee and your access is restored.',
              sms: 'Swift: your subscription was closed after 30 days unpaid. Rejoin anytime — pay in the app and access is restored instantly.',
              data: { kind: 'billing_churned', subscriptionId: sub.id },
            };
            await tx.billingEvent.create({
              data: {
                subscriptionId: sub.id,
                type: 'CHURNED',
                currencyCode: sub.currencyCode,
                // Identify the suspension episode, not its calendar day: a
                // same-day re-suspension must not collide with the prior event.
                idempotencyKey: noticeKey,
                note: billingNoticeNote(notice),
              },
            });
            return { kind: 'churned' as const, noticeKey };
          }

          // The REMINDER key is the per-day gate. A duplicate aborts this
          // transaction and is handled as an idempotent loser below.
          const dayKey = now.toISOString().slice(0, 10);
          const noticeKey = `nudge:${sub.id}:${dayKey}`;
          const rail =
            sub.billingMethod === 'MOBILE_MONEY'
              ? 'Approve the MMG request on your phone (or tap Pay in the app)'
              : sub.billingMethod === 'CARD'
                ? 'Update your card or tap Pay in the app'
                : 'Top up your prepaid balance in the app';
          const notice: BillingNotice = {
            noticeVersion: 1, target: 'payer', userId: this.payerUserId(sub), audience: this.payerAudience(sub),
            title: 'Suspended — pay to restore access',
            body: `Your weekly fee of $${weeklyFeeAmount(sub).toLocaleString()} ${sub.currencyCode} is unpaid. ${rail} and your access is restored instantly.`,
            sms: `Swift: your account is still suspended. ${rail} — access is restored the moment you pay.`,
            data: { kind: 'billing_suspended_nudge', subscriptionId: sub.id },
          };
          await tx.billingEvent.create({
            data: {
              subscriptionId: sub.id,
              type: 'REMINDER',
              currencyCode: sub.currencyCode,
              idempotencyKey: noticeKey,
              note: billingNoticeNote(notice),
            },
          });
          return { kind: 'nudged' as const, noticeKey };
        });
        if (!decision) continue;

        if (decision.kind === 'churned') out.churned += 1;
        else out.nudged += 1;
        try {
          await deliverBillingNoticeByKey(this.prisma, this.notifications, decision.noticeKey, now,
            (subscriptionId, userId, body, renewLease) => this.sendNoticeSms(subscriptionId, userId, body, renewLease));
        } catch (err) {
          log().warn({ err, subscriptionId: candidate.id }, 'billing notice remains due after committed sweep');
        }
      } catch (err) {
        if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') continue; // already nudged/churned
        log().error({ err, subscriptionId: candidate.id }, 'suspended-sweep failed for one subscription — continuing');
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
    // idempotencyKey is the DB-level guard inside the credit transaction, so
    // a replay rolls back its entire conditional wallet increment as well.
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
    /** [A-12] REQUIRED: the provider transaction this credit is evidence of. */
    reference: string;
    audit?: { ipAddress?: string; userAgent?: string };
    /** [ADM-002] The caller's audit row, written INSIDE the command transaction
     *  as its evidence; without it the row this command always wrote stands. */
    onAudit?: OnAudit;
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
        // [ADM-002] An admin route supplies the canonical row (reason, digests,
        // the amount and reference as facts); the command's own row stands
        // only when nothing upstream audits.
        if (input.onAudit) {
          await input.onAudit(tx, { amount: input.amount, reference: input.reference ?? null, idempotencyKey: input.idempotencyKey, billingEventId: event.id });
        } else {
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
        }
        const result: TopUpCommandResult = { balance: Number(balance.balance), currencyCode: balance.currencyCode, billingEventId: event.id };
        const row = await tx.topUpCommand.create({
          data: {
            adminId: input.adminId,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            subscriptionId: input.subscriptionId,
            amount: input.amount,
            reference: input.reference,
            providerRef: input.reference,
            billingEventId: event.id,
            result: result as never,
          },
          select: { id: true, result: true },
        });
        await this.observer.afterTopUpCommandStaged?.();
        return row;
      });
    } catch (error) {
      // [A-12] TWO different conflicts land here and they mean opposite things.
      // A clash on the REFERENCE is a second credit for one real-world
      // transfer — refuse it, loudly. A clash on the idempotency key is the
      // same request arriving twice — answer the winner's result.
      if (isDuplicateOn(error, 'providerRef')) {
        billingTopupDuplicateReferenceCounter.inc();
        throw new AppError(
          409,
          'TOPUP_REFERENCE_ALREADY_CREDITED',
          'That transfer reference has already been credited. One transfer credits one subscription — check the billing events before recording it again.',
        );
      }
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
   * Weekly tier check for movers: the rate comes from the role they hold and
   * the vehicle they have registered TODAY, not the one they signed up on.
   *
   * Without this a rider who signs up on a motorbike and later buys a canter
   * keeps paying the standard rate forever — `weeklyRate` is a snapshot taken
   * at signup. Same shape as `recalculateVendorTiers` below, and it shares that
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
      try {
        const mover = sub.rider ?? sub.driver;
        if (!mover) continue;
        // A negotiated rate is a human decision — a vehicle swap must not silently
        // overwrite it. Waived fees are likewise left alone.
        if (sub.customRate != null || sub.feeWaived) continue;

        const role = sub.rider ? 'RIDER' : 'DRIVER';
        const tiers = await this.countryConfig.getSubscriptionTiers(mover.user.countryCode);
        const target = this.retierTarget(sub.id, tiers, { kind: role, vehicleType: mover.vehicleType });
        if (!target || Number(sub.weeklyRate) === target.rate) continue;

        const note = `${role === 'DRIVER' ? 'taxi driver' : 'rider'} on ${mover.vehicleType} -> ${target.tier} tier`;
        if (await this.applyTierChange(sub, target, note)) changed += 1;
      } catch (error) {
        this.holdTierChange(sub.id, error);
      }
    }
    return changed;
  }

  /** The rate the re-tier moves a subscription to — or null when its market's
   *  config cannot price it, which HOLDS the current rate (loudly) instead of
   *  writing a zero or stopping the run for every healthy subscription. */
  private retierTarget(subscriptionId: string, tiers: SubscriptionTiers, subject: PartnerSubject): PartnerRate | null {
    try {
      return partnerRateFor(tiers, subject);
    } catch (error) {
      if (!(error instanceof PricingConfigError)) throw error;
      log().error({ subscriptionId, key: error.details?.['key'] }, 'tier recalculation held: weekly-fee config cannot price this subscription');
      return null;
    }
  }

  /** [PR1270-S2-06] One subscription's failure is logged and held; the run
   *  goes on to the next, so a single bad row never stops the market's re-tier. */
  private holdTierChange(subscriptionId: string, error: unknown): void {
    log().error({ err: error, subscriptionId }, 'tier recalculation held: this subscription could not be moved; the run continued');
  }

  /**
   * [PR1270-S2-06] ONE transition is ONE transaction: the new rate and its
   * TIER_CHANGE event commit together or not at all, so a crash between them
   * can no longer leave a changed bill with no audit row. The rate write is a
   * compare-and-set on the rate this run read: two runs racing over the same
   * subscription (the weekly job and an operator's manual run) move it once
   * and write one event — the loser matches nothing and writes nothing.
   *
   * Key policy: `tier:<subscription>:<n>:<from>-><to>` — the n-th tier
   * change of this subscription, counted under the row lock the CAS above
   * takes, so it is unique per transition by construction: a same-day return
   * to an earlier rate is transition n+2, never a replay of n, and no clock is
   * involved. The job's idempotency is carried by the rate itself: a re-run
   * finds the rate already at target and skips before it gets here.
   */
  private async applyTierChange(
    sub: { id: string; weeklyRate: Prisma.Decimal; currencyCode: string },
    target: PartnerRate,
    note: string,
  ): Promise<boolean> {
    const from = Number(sub.weeklyRate);
    return this.prisma.$transaction(async (tx) => {
      const won = await tx.subscription.updateMany({
        where: { id: sub.id, weeklyRate: sub.weeklyRate },
        data: { weeklyRate: target.rate },
      });
      if (won.count === 0) return false;
      const seq = (await tx.billingEvent.count({ where: { subscriptionId: sub.id, type: 'TIER_CHANGE' } })) + 1;
      await tx.billingEvent.create({
        data: {
          subscriptionId: sub.id,
          type: 'TIER_CHANGE',
          amount: target.rate,
          currencyCode: sub.currencyCode,
          idempotencyKey: `tier:${sub.id}:${seq}:${from}->${target.rate}`,
          note,
        },
      });
      return true;
    });
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
      try {
        if (!sub.vendor) continue;
        // A negotiated rate or a waived fee is a human decision — a catalogue
        // growing past a threshold must never silently overwrite one.
        if (sub.customRate != null || sub.feeWaived) continue;

        const tiers = await this.countryConfig.getSubscriptionTiers(sub.vendor.owner.user.countryCode);
        const activeListings = await this.prisma.item.count({
          where: { vendorId: sub.vendor.id, isAvailable: true },
        });
        // The threshold count itself qualifies: "1000+ items" is >= 1000.
        const target = this.retierTarget(sub.id, tiers, {
          kind: 'VENDOR',
          isService: sub.vendor.vendorType === 'SERVICE',
          activeListings,
          ownedStores: sub.vendor.owner._count.vendors,
        });
        if (!target || Number(sub.weeklyRate) === target.rate) continue;

        const note = `${activeListings} active listings, ${sub.vendor.owner._count.vendors} owned store(s) -> ${target.tier} tier${target.franchised ? ' (franchise discount)' : ''}`;
        if (await this.applyTierChange(sub, target, note)) changed += 1;
      } catch (error) {
        this.holdTierChange(sub.id, error);
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
