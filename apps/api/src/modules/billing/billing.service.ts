import { billingEffectsReady, requireBillingEffectsReady } from './billing-cutover';
import { recordTrialCoverageInTx, stoppedTrialOwesNothingInTx, voluntaryResumeProofInTx } from './obligation-evidence';
import { resumeVoluntaryObligationInTx } from './dunning-clock';
import { verifiedCheckoutCredit } from './confirmation-finance';
import { enqueueFeeDemandInTx } from './fee-demand-delivery';
import type { OnAudit } from '../../lib/audit-writer';
import { createHash, randomUUID } from 'node:crypto';
import { hasMmgTerminalProof, isMmgTerminalStatus, matchesLookupGeneration, mmgNegativeMatches, mmgPaymentRaw, mmgTerminalProof, paymentFacts, type MmgLookupObservation } from './mmg-terminal-evidence';
import type { PrismaClient, Subscription, SubscriptionPayment, Prisma, SubscriptionStatus, SubscriptionType } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { isReviewSubscription, ReviewDemoMoneyRefusedError } from '../review/demo-policy';
import { getTenantId } from '../../plugins/tenant-context';
import { NotificationService, notifyAdmins, tenantOfUser, tenantOfSubscription } from '../notification/notification.service';
import { CountryConfigService, partnerRateFor, PricingConfigError, type PartnerRate, type PartnerSubject, type SubscriptionTiers } from '../country/country-config.service';
import type { PaymentProvider } from '../../providers/payment/payment-provider';
import { getMmgProvider, mmgDisabled } from '../../providers/mmg/mmg-provider';
import { noLivePayPath } from './fee-pause';
import { consumeMmgReactivation, feePauseHoldsBilling, feePauseSpanOpen, mmgReactivationPeriodEnd } from './mmg-pause';
import type { MmgTransaction, MmgTxResult } from '../../providers/mmg/mmg-provider';
import { convertUsdToLocal, noticeRequired, FX_NOTICE_WINDOW_DAYS } from './fx';
import { restoreBillingAccess } from './billing-access';
import { postLedger, topupPostings, chargeSuccessPostings } from './ledger';
import { mapCardFailure, mapMmgFailure, type NormalizedFailure } from './failure-taxonomy';
import { log } from '../../utils/logger';
import { billingAttemptReclaimCounter, billingTerminalWithoutOutcomeGauge, billingOutcomeRepairsCounter, billingTopupDuplicateFingerprintCounter, billingTopupDuplicateReferenceCounter, billingTopupTailsPendingGauge, billingUnkeyedTopupDuplicatesGauge, cardChargesReconciledCounter, cardIntentsUnknownGauge, fxChargesIneligibleCounter } from '../../plugins/observability';
import { isDuplicateOn } from '../money/evidence';
import { weeklyFeeFor } from './subscription-fee';
import { billingNoticeNote, deliverBillingNoticeByKey, drainPendingBillingNotices, type BillingNotice } from './billing-notice-delivery';
import { FEE_RESTORE_LINE, feeDueLine, mmgPayLine } from './fee-notice-copy';
import { checkoutAmountGyd, mmgCheckoutLive } from './fee-pay-actions';
import { amountDueNow } from './amount-due';
import { weeklyFeeAmount } from './subscription-fee';
import { payInfo } from './agent-cash.service';
import { claimProviderPaymentInTx, ProviderIdentityError, subscriptionTenantInTx } from './provider-identity';
import { cardRailKilled, cardRailV2Enabled } from '../../utils/card-rail';
import {
  assertNever, bindingOf, chargeMatchesIntent, describeBinding, sameBinding,
  type CardChargeOutcome, type CardRailBinding, type CardRailProvider, type CardRailSource, type ChargedAmount,
} from '../../providers/card/card-provider';
import { toProviderMinor } from '../../utils/currency-amount';
import { openVaultToken } from './card-vault';
import { observedStatus, recordCardObservation } from './card-observations';
import { activeOverdueMs, activeDeadline, advanceDunningObligation, beginConfirmationInTx, currentDunningClock, FULL_FEE_GRACE_MS, FEE_RETRY_MS, hasConfirmationInTx, resolveConfirmationInTx, resumedNoEarlierThan, scheduleDunningFailure, suspensionRetentionMs } from './dunning-clock';
import { lockBillingAuthority, paymentConfirmationSource, projectDunningClock, resolvePaymentConfirmationInTx } from './dunning-clock';
import { lockFeeCollectionAuthority, lockMoverFeeAuthority, lockSubscriptionPayer, moverFeeTariffSubject, resolveMoverFeeAuthority, subscriptionPayer } from '../subscription/mover-fee-authority';

// ---------------------------------------------------------------------------
// BillingService — the one place V1 touches money: Swift's own weekly fee.
// Deterministic code only (hard rule 1). Every money event lands in the
// append-only BillingEvent log; the unique idempotencyKey is the DB-level
// double-charge guard, safe under concurrent job runs.
// ---------------------------------------------------------------------------

const MAX_FAILED_ATTEMPTS = 3;

/** [M-04] What a recorded failure decided — computed and applied inside one transaction. */
/** `suspendsAt`: the shared clock's grace deadline, the instant access stops unless the fee is paid. */
type FailureOutcome = { attempts: number; willSuspend: boolean; nextRetryAt: Date; suspendsAt: Date; finalWarning: boolean };
/** The suspension moment as a notice states it (minute precision, UTC). */
const suspensionMoment = (at: Date) => at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
type ChargeAttemptResult = (
  /** `spendPrepaid` = debit this much from the prepaid balance INSIDE the
   *  advance transaction, so the money and the week it buys commit together. */
  | { ok: true; ref: string; settlePaymentId?: string; spendPrepaid?: number; mmgEvidence?: MmgTransaction }
  | { ok: false; reason: string; failureCode?: NormalizedFailure; intentId?: string; failureRaw?: string; mmgInitiateFailure?: MmgTransaction }
  | { ok: false; pendingTx: string; clientKey: string; expiresAt: Date; intentId: string }
  | { ok: false; approvedWithId: MmgTxResult; clientKey: string; intentId: string }
  | { ok: false; approvedWithoutId: MmgTxResult; intentId: string }
  | { ok: false; unknown: true; clientKey: string; failureRaw?: string; intentId: string }
  | { ok: false; deferred: true; reopenPaymentId?: string }
  | { ok: false; dispatchRevoked: true; intentId: string }
  /** [PT-1 · C4] The bank wants the cardholder present (3-D Secure). Not a
   *  decline: no strike, no second instruction for this attempt, a notice.
   *  `recorded` = the intent already carries this outcome from an earlier run. */
  | { ok: false; requiresAction: true; intentId: string; recorded?: boolean }
) & { rail?: 'MOBILE_MONEY' | 'CARD' };

/** [PT-1] What one v2 provider answer about an instrument charge means to billing. */
type InstrumentVerdict =
  | { status: 'succeeded'; providerRef: string }
  | { status: 'failed'; reason: string; providerRef?: string }
  | { status: 'requires_action'; reason: string }
  | { status: 'pending' }
  | { status: 'unknown'; reason: string; absent: boolean }
  /** The provider reported a different amount or currency: held for a person. */
  | { status: 'held' };

/** [PT-1] A v2 retrieval, in the shape the card reconciler already reads
 *  (the legacy lookup's four statuses) plus the two v2 adds. */
type InstrumentLookup =
  | { status: 'succeeded'; providerRef: string }
  | { status: 'failed'; reason: string; providerRef?: string }
  | { status: 'requires_action'; reason: string }
  | { status: 'not_found' }
  | { status: 'unknown'; reason: string }
  | { status: 'held' };
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
/**
 * [AX332 F1] The plans the weekly re-tier moves, movers and vendors alike. A
 * DORMANT plan (PAUSED: billing stopped and its paid period over; SUSPENDED:
 * behind on the fee) is charged again at resume or at the next dunning retry,
 * so its FUTURE rate follows the rate card like any other plan's. Leaving it
 * out charged a rider paused on 8,000 exactly 8,000 the moment they resumed.
 * Only the rate moves: a negotiated or waived rate is still skipped, and a
 * charge already issued keeps its amount (the re-tier never writes a payment
 * row). CANCELLED and CHURNED are closed and never re-tiered.
 */
const RETIER_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'PAST_DUE', 'TRIAL', 'PAUSED', 'SUSPENDED'];
/** [AX318 R1] A v2 intent still AUTHORIZED this long after it was created
 *  belongs to a run that died between authorization and handoff (the two are
 *  milliseconds apart in a live run). */
const UNSENT_INTENT_GRACE_MS = 10 * 60 * 1000;
const isNeverHandedOff = (row: Pick<SubscriptionPayment, 'failureRaw' | 'externalRef'>): boolean =>
  !row.externalRef && !!row.failureRaw && typeof row.failureRaw === 'object' && !Array.isArray(row.failureRaw)
  && (row.failureRaw as Record<string, unknown>)['providerEffect'] === 'AUTHORIZED';
const MMG_APPROVAL_HOLD = 'MMG_APPROVAL_MISMATCH';
const MMG_HISTORY_HOLD = 'MMG_HISTORY_APPROVAL_UNVERIFIED';
/** [PT-1] A hosted Pay-now payment's clientKey: `cardpay:<card session id>`.
 *  The session sweep owns these rows; the weekly-intent reconciler skips them. */
export const CARD_PAY_NOW_KEY_PREFIX = 'cardpay:';
/** [PT-1] Why an instrument charge did not happen — shown to the partner in
 *  the ordinary failure notice ("<reason>. We will retry tomorrow…", then the
 *  real ways to pay from fee-notice-copy.ts). A fact, never a door: the app
 *  has no card screen until card rail v2 ships one. */
const NO_CARD_REASON = 'There is no card on file for the weekly fee';
const EXPIRED_CARD_REASON = 'The card on file for the weekly fee has expired';

/** [PT-1] A card is usable through the last day of its expiry month (UTC). */
export function cardExpiredAt(card: { expMonth: number; expYear: number }, now: Date): boolean {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return card.expYear < year || (card.expYear === year && card.expMonth < month);
}

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
  /** [PT-1 · AX297 F1] Card rail v2 weekly charge. The first runs after the
   *  cycle has read the card and opened its vault, before the transaction
   *  that locks payer -> subscription -> card and creates the authorized
   *  intent; the second runs inside that transaction the moment the card row
   *  is locked. Test-only. */
  beforeInstrumentChargeAuthorization?: (subscriptionId: string, instrumentId: string) => Promise<void>;
  afterInstrumentChargeLocked?: (subscriptionId: string, instrumentId: string, tx: Prisma.TransactionClient) => Promise<void>;
  /** [AX318 R1] Around the handoff (phase two): before its transaction, and
   *  after it committed HANDED_OFF, immediately before the provider is asked.
   *  Test-only. */
  beforeInstrumentChargeHandoff?: (subscriptionId: string, intentId: string) => Promise<void>;
  afterInstrumentChargeHandedOff?: (subscriptionId: string, intentId: string) => Promise<void>;
}

/** Why a v2 card intent that was never handed to the provider was closed. */
export type UnsentCardIntentReason = 'CARD_REMOVED' | 'CARD_REPLACED' | 'CARD_OUT_OF_SERVICE' | 'DISPATCH_REVOKED' | 'NEVER_HANDED_OFF';

/**
 * [PT-1 · AX318 R1] Close v2 card intents that were AUTHORIZED but never
 * handed to the provider. Nothing was sent under them: the provider is asked
 * only after the handoff CAS (AUTHORIZED -> HANDED_OFF) won, and these rows
 * still say AUTHORIZED, which is the CAS condition. Each ends EXPIRED /
 * DISPATCH_REVOKED / NOT_SENT with no strike (PRESERVED_NO_DUNNING) and its
 * key is released (`<key>:void:<id>`), so the attempt is billed again from
 * the top on whatever card is on file; the row keeps its evidence and the
 * key it had. The provider never saw that key, so it is free to reuse.
 * Returns how many rows were closed.
 */
export async function closeUnsentCardIntents(
  tx: Prisma.TransactionClient,
  target: { intentId: string } | { instrumentId: string },
  reason: UnsentCardIntentReason,
  now: Date,
): Promise<number> {
  const marker = JSON.stringify({
    providerEffect: 'NOT_SENT', cancelledBy: reason, revokedAt: now.toISOString(),
    subscriptionOutcome: 'PRESERVED_NO_DUNNING', recoveryDisposition: 'NO_PROVIDER_EFFECT',
  });
  const candidates = await tx.subscriptionPayment.findMany({ where: 'intentId' in target ? { id: target.intentId } : { instrumentId: target.instrumentId }, select: { subscriptionId: true } });
  for (const subscriptionId of [...new Set(candidates.map((p) => p.subscriptionId))].sort()) await lockBillingAuthority(tx, subscriptionId);
  let rows: Array<{ id: string; subscriptionId: string }>;
  if ('intentId' in target) {
    rows = await tx.$queryRaw`
      UPDATE "subscription_payments"
      SET "status" = 'EXPIRED', "failureCode" = 'DISPATCH_REVOKED', "clientKey" = "clientKey" || ':void:' || "id",
          "failureRaw" = COALESCE("failureRaw", '{}'::jsonb) || ${marker}::jsonb || jsonb_build_object('voidedKey', "clientKey")
      WHERE "id" = ${target.intentId} AND "paymentMethod" = 'CARD' AND "instrumentId" IS NOT NULL
        AND "status" = 'UNKNOWN' AND "externalRef" IS NULL AND "failureRaw"->>'providerEffect' = 'AUTHORIZED' RETURNING "id", "subscriptionId"`;
  } else {
  rows = await tx.$queryRaw`
    UPDATE "subscription_payments"
    SET "status" = 'EXPIRED', "failureCode" = 'DISPATCH_REVOKED', "clientKey" = "clientKey" || ':void:' || "id",
        "failureRaw" = COALESCE("failureRaw", '{}'::jsonb) || ${marker}::jsonb || jsonb_build_object('voidedKey', "clientKey")
    WHERE "instrumentId" = ${target.instrumentId} AND "paymentMethod" = 'CARD'
      AND "status" = 'UNKNOWN' AND "externalRef" IS NULL AND "failureRaw"->>'providerEffect' = 'AUTHORIZED' RETURNING "id", "subscriptionId"`;
  }
  for (const row of rows) await resolvePaymentConfirmationInTx(tx, row.subscriptionId, row.id, 'PROVEN_NO_EFFECT', { actor: 'card-authority', reference: reason }, now);
  return rows.length;
}

/** [AX318 R1] Charges on a card that were HANDED to the provider and have no
 *  final answer yet: money that is moving, or may have moved. */
export async function cardChargesInFlight(tx: Prisma.TransactionClient, instrumentId: string): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM "subscription_payments"
    WHERE "instrumentId" = ${instrumentId} AND "status" = 'UNKNOWN'
      AND COALESCE("failureRaw"->>'providerEffect', '') <> 'AUTHORIZED'`;
  return Number(row?.n ?? 0);
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

/** [MMG checkout F2] Thrown inside a push-rail settlement whose MMG transaction
 *  is already on record for another credit: it rolls the settlement back whole
 *  (no half-claimed payment, no orphan identity) before the hold is applied. */
class PushIdentityRefused extends Error {
  constructor(readonly identityCode: string) {
    super(`push settlement refused by the provider identity (${identityCode})`);
  }
}

export class BillingService {
  private countryConfig: CountryConfigService;
  private cardRailProvider: CardRailProvider | null | undefined;

  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
    private payments: PaymentProvider,
    /** [M-04] Test seam only — see BillingObserver. Production passes nothing. */
    private readonly observer: BillingObserver = {},
    /** [PT-1] Card rail v2: where this process gets its v2 provider. Resolved
     *  only when v2 work needs it. A process that does not wire it never
     *  charges an instrument (the charge defers to the billing worker, which
     *  does) and never falls back to the legacy token. */
    private readonly cardRail?: CardRailSource,
  ) {
    this.countryConfig = new CountryConfigService(prisma);
  }

  // -------------------------------------------------------------------------
  // The weekly cycle
  // -------------------------------------------------------------------------

  async surfaceConfirmationReviews(now = new Date()): Promise<number> {
    const due = await this.prisma.paymentConfirmationHold.findMany({ where: {
      status: { in: ['ACTIVE', 'SETTLEMENT_APPLY_PENDING'] }, reviewDueAt: { lte: now }, reviewNotifiedAt: null,
    }, orderBy: [{ reviewDueAt: 'asc' }, { id: 'asc' }], take: 200 });
    let notified = 0;
    for (const hold of due) {
      await notifyAdmins(this.prisma, this.notifications, {
        tenantId: hold.tenantId, title: 'Weekly-fee payment needs confirmation',
        body: 'A payment has been waiting for confirmation for more than one day. Review it in payment confirmations; collection remains paused.',
        data: { kind: 'billing_manual_reconciliation', subscriptionId: hold.subscriptionId, confirmationId: hold.id },
        dedupeKey: `confirmation-review:${hold.id}`, requireAll: true,
      });
      await this.prisma.paymentConfirmationHold.updateMany({ where: { id: hold.id, status: { in: ['ACTIVE', 'SETTLEMENT_APPLY_PENDING'] }, reviewNotifiedAt: null }, data: { reviewNotifiedAt: now } });
      notified += 1;
    }
    return notified;
  }

  /** Bill everything due. One subscription's failure never kills the batch. */
  async runBillingCycle(now = new Date()): Promise<BillingCycleResult> {
    await this.recoverConfirmationSettlements(undefined, now);
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
  async lapseStoppedSubscriptions(now = new Date()): Promise<{ paused: number; failed: number }> {
    const due = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE', autoRenew: false, currentPeriodEnd: { lte: now } },
      select: { id: true, currencyCode: true, updatedAt: true },
      take: 500,
    });
    let paused = 0;
    let failed = 0;
    for (const sub of due) {
      // [DS207 F1] One row can never stop the sweep (or the rest of the
      // billing job after it): a failure is logged and counted, and the next
      // row runs. [DS213 F1-1] The count reaches the job's billing-failure
      // page, so a row that keeps failing is seen, not just logged.
      try {
        const done = await this.prisma.$transaction(async (tx) => {
          if (!(await lockFeeCollectionAuthority(tx, sub.id)).allowed) return false;
          const fresh = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });
          const clock = await currentDunningClock(tx, sub.id, now);
          // A resumed but uncollected obligation is still owed. A stopped
          // flag and an old period end cannot erase that liability.
          let proof = await voluntaryResumeProofInTx(tx, fresh, clock);
          // [E12] A trial that ended while billing was stopped owed nothing:
          // its free period is recorded as zero-fee coverage, then it lapses
          // like any covered period (and resumes charged at the resume).
          if (!proof && await stoppedTrialOwesNothingInTx(tx, fresh, clock)) {
            await recordTrialCoverageInTx(tx, fresh);
            proof = await voluntaryResumeProofInTx(tx, fresh, clock);
          }
          if (!proof) return false;
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
              // The exact settled obligation can lapse only once. An unpaid
              // resumed obligation cannot reuse the old period's proof.
              idempotencyKey: `pause:${sub.id}:${clock.id}:${clock.epoch}`,
              amount: proof.payment.amount, paymentRef: proof.payment.externalRef,
              note: 'Plan paused at the end of the paid period — weekly billing was stopped by the partner',
            },
          });
          return true;
        });
        if (done) paused += 1;
      } catch (err) {
        failed += 1;
        log().error({ err, subscriptionId: sub.id }, 'stopped-plan lapse failed for one subscription — continuing');
      }
    }
    return { paused, failed };
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
    // Selection is not collection authority. Old workers carrying a second
    // source ID must not open another fee after the payer has one authority.
    const candidate = await this.prisma.$transaction(async (tx) => {
      const authority = await lockFeeCollectionAuthority(tx, sub.id);
      if (!authority.allowed) return null;
      const fresh = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: {
        rider: { select: { userId: true } }, driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      } });
      // A worker selected one period and attempt. Refreshing ownership or
      // price must not license it to open the next retry after another worker
      // already advanced that selection.
      if (fresh.nextBillingDate.getTime() !== sub.nextBillingDate.getTime() || fresh.failedAttempts !== sub.failedAttempts) return null;
      return { ...fresh, type: authority.mover?.feeType ?? fresh.type };
    });
    if (!candidate) return 'skipped';
    sub = candidate;
    // An unresolved positive observation may concern this or an older attempt.
    // A new retry key, rail choice or wallet top-up is not manual disposition.
    // [PROD-PATH] No live way to pay (MMG off, no live card rail: fee-pause.ts):
    // EVERY subscription's fee is PAUSED before anything is written — no
    // attempt, no prepaid spend, no failure, no grace enforcement
    // (finishExhaustedGrace below), and the duplicate-attempt recovery (which
    // can apply a recorded failure) is never reached. Its dunning clock is
    // paused for the span (mmg-pause.ts). Once a way to pay is back, billing
    // still waits until the resume has recorded that subscription's
    // reactivation, so its next fee covers only the week in progress, whatever
    // job runs first.
    if (await feePauseHoldsBilling(this.prisma, sub.id)) return 'pending';
    if (await this.subscriptionHasConfirmationHold(this.prisma, sub.id, undefined, now)) return 'pending';
    const exhausted = await this.finishExhaustedGrace(sub, now);
    if (exhausted) return exhausted;
    const periodKey = sub.nextBillingDate.toISOString().slice(0, 10);
    const attemptKey = `charge:${sub.id}:${periodKey}:a${sub.failedAttempts}`;
    const usd = usdCtx === undefined ? await this.loadUsdPricing() : usdCtx;
    let priced = await this.priceEligibleFor(sub, usd);

    if (!reclaimedAttempt) try {
      const reserved = await this.prisma.$transaction(async (tx) => {
        const current = await lockFeeCollectionAuthority(tx, sub.id);
        if (!current.allowed) return false;
        const latest = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });
        if (latest.nextBillingDate.getTime() !== sub.nextBillingDate.getTime() || latest.failedAttempts !== sub.failedAttempts
          || (current.mover?.feeType ?? latest.type) !== sub.type || Number(latest.weeklyRate) !== Number(sub.weeklyRate)
          || String(latest.customRate) !== String(sub.customRate) || latest.feeWaived !== sub.feeWaived) return false;
        await tx.billingEvent.create({
          data: {
            subscriptionId: sub.id,
            type: 'CHARGE_ATTEMPT',
            amount: priced.amount,
            currencyCode: sub.currencyCode,
            idempotencyKey: attemptKey,
            ...(priced.usdTrio ?? {}),
          },
        });
        return true;
      });
      if (!reserved) return 'skipped';
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
          // [DS219 F2-1R1] ...unless it DID land after this snapshot was read: a
          // concurrent run that won the same attempt key and failed has already
          // moved failedAttempts on. Resume only at the level the record
          // describes, checked under the row lock, so one real failure is never
          // counted twice (a premature final warning, an early suspension).
          return this.applyFailedCharge(
            sub, Number(recordedFailure.amount ?? 0), recordedFailure.note ?? 'Charge failed (outcome resumed after interruption)', now, periodKey,
            sub.failedAttempts,
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

    // [PT-1 · AX318 R2] A reclaimed attempt is dispatched, checked and settled
    // exactly as it was ISSUED: its own CHARGE_ATTEMPT record's amount,
    // currency and pinned USD trio, never today's price or the subscription's
    // current currency. So what is sent, what the answer is checked against
    // and what is booked are one record. A new price applies to the next
    // attempt, which gets its own key.
    if (reclaimedAttempt) {
      const issued = await this.prisma.billingEvent.findUnique({
        where: { idempotencyKey: attemptKey },
        select: { amount: true, currencyCode: true, amountUsd: true, fxRateId: true, fxRateUsed: true },
      });
      if (!issued || issued.amount === null) {
        log().error({ subscriptionId: sub.id, attemptKey }, '[PT-1 AX318-R2] reclaimed attempt has no issued amount — nothing dispatched');
        return 'skipped';
      }
      priced = {
        amount: issued.amount,
        ...(issued.amountUsd !== null && issued.fxRateId && issued.fxRateUsed !== null
          ? { usdTrio: { amountUsd: Number(issued.amountUsd), fxRateId: issued.fxRateId, fxRateUsed: Number(issued.fxRateUsed) } }
          : {}),
      };
      sub = { ...sub, currencyCode: issued.currencyCode };
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

    if ('requiresAction' in charged) {
      // [PT-1 · C4] Off-session 3-D Secure is not a decline: no CHARGE_FAILED,
      // no failed attempt, no second instruction for this attempt — the
      // partner is told, and a hosted Pay now (their bank present) pays it.
      await this.holdForCardAction(sub, charged.intentId, amount, now, charged.recorded === true);
      return 'pending';
    }

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
        { status: 'FAILED', failureCode: charged.failureCode ?? 'PROVIDER_ERROR', from: ['UNKNOWN'], requireNoExternalRef: true, ...(charged.mmgInitiateFailure ? { mmgInitiateFailure: charged.mmgInitiateFailure } : {}), ...(charged.failureRaw ? { failureRaw: charged.failureRaw } : {}) },
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
    // [PROD-PATH] The period the fee buys is fixed on the intent (a payment's
    // period is immutable once a confirmation is attached).
    const { periodEnd: intentPeriodEnd } = await mmgReactivationPeriodEnd(this.prisma, sub.id, sub.nextBillingDate, now);
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
          periodEnd: intentPeriodEnd,
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

  // -------------------------------------------------------------------------
  // [PT-1] Card rail v2 — the weekly fee on an enrolled card
  // -------------------------------------------------------------------------

  /** This process's v2 provider, or null when none is wired (or it cannot be
   *  built). Null never falls back to anything: v2 work simply defers. */
  private resolveCardRail(): CardRailProvider | null {
    if (this.cardRailProvider !== undefined) return this.cardRailProvider;
    if (!this.cardRail) return (this.cardRailProvider = null);
    try {
      this.cardRailProvider = this.cardRail();
    } catch (err) {
      log().error({ err }, '[PT-1] card rail v2 provider unavailable — instrument charges defer, nothing is charged');
      this.cardRailProvider = null;
    }
    return this.cardRailProvider;
  }

  /**
   * [PT-1] The weekly fee on the subscription's ACTIVE instrument. Every law of
   * the legacy card path holds here too: the kill switch stops NEW
   * instructions only; one durable intent per attempt, reserved and authorized
   * BEFORE the provider is asked; an existing intent is retrieved by its key
   * before anything could be re-sent; UNKNOWN is never a decline. Added:
   *  - only an ACTIVE instrument is charged; one past its expiry month is
   *    retired as EXPIRED and never sent;
   *  - [C2] the instrument's binding must be the configured provider's own —
   *    a mismatch sends nothing, dunns nobody and pages a person;
   *  - a capture reporting a different amount or currency is HELD, never booked;
   *  - [C4] requires_action is not a decline.
   */
  private async attemptInstrumentCharge(sub: SubWithRelations, amount: number, now: Date): Promise<ChargeAttemptResult> {
    if (cardRailKilled()) return { ok: false, deferred: true };
    const key = this.cardReference(sub);
    const live = await this.prisma.subscriptionPayment.findUnique({ where: { clientKey: key } });
    if (live) return this.resumeCardIntent(sub, live, key, now);

    const cardRail = this.resolveCardRail();
    if (!cardRail) return { ok: false, deferred: true };
    const instrument = await this.prisma.paymentInstrument.findFirst({ where: { subscriptionId: sub.id, status: 'ACTIVE' } });
    if (!instrument) return { ok: false, reason: NO_CARD_REASON };
    if (cardExpiredAt(instrument, now)) {
      await this.prisma.paymentInstrument.updateMany({ where: { id: instrument.id, status: 'ACTIVE' }, data: { status: 'EXPIRED', expiredAt: now } });
      return { ok: false, reason: EXPIRED_CARD_REASON };
    }
    const binding = bindingOf(instrument);
    if (!sameBinding(binding, cardRail.binding)) {
      await this.alertCardBindingMismatch(sub, instrument, cardRail.binding);
      return { ok: false, deferred: true };
    }
    // Opened before anything is reserved: a vault that cannot open leaves no intent behind.
    const vaultToken = await openVaultToken(instrument);
    const intended: ChargedAmount = { amountMinor: toProviderMinor(amount, sub.currencyCode, 'card.v2.weekly'), currencyCode: sub.currencyCode };
    // [AX297 F1] Everything above read the card WITHOUT a lock. Whether it may
    // be charged is decided under payer -> subscription -> card, where the
    // intent is created already authorized.
    const authorized = await this.authorizeInstrumentCharge(sub, { amount, key, instrumentId: instrument.id, now });
    switch (authorized.outcome) {
      case 'authorized': break;
      case 'busy': return { ok: false, deferred: true }; // a concurrent run holds this attempt
      case 'revoked': return { ok: false, dispatchRevoked: true, intentId: authorized.intentId, rail: 'CARD' };
      case 'card_changed':
        // Removed or replaced after the read above: nothing was sent and
        // nothing counts against the partner. The attempt has no intent, so
        // the cycle takes it from the top once it is stale (reclaimStaleAttempt)
        // and bills whatever card is on file then.
        log().warn({ subscriptionId: sub.id, instrumentId: instrument.id, cardStatus: authorized.cardStatus }, '[PT-1 AX297-F1] card left service before the charge was authorized — nothing sent, nobody penalised');
        return { ok: false, deferred: true };
      default: return assertNever(authorized, 'instrument charge authorization');
    }
    const reserved = { id: authorized.intentId };

    // [AX318 R1] Phase two, immediately before the provider is asked: the
    // handoff (AUTHORIZED -> HANDED_OFF) under the same payer -> subscription
    // -> card locks, re-checking the card and the lifecycle there. A removal
    // or replacement that committed after phase one closed this intent (or
    // left the card out of service): nothing is sent. Only a won handoff calls.
    const handoff = await this.handOffInstrumentCharge(sub, { intentId: reserved.id, instrumentId: instrument.id, now });
    switch (handoff) {
      case 'handed_off': break;
      case 'revoked': return { ok: false, dispatchRevoked: true, intentId: reserved.id, rail: 'CARD' };
      case 'card_changed':
      case 'lost':
        log().warn({ subscriptionId: sub.id, instrumentId: instrument.id, intentId: reserved.id, handoff }, '[PT-1 AX318-R1] charge not handed to the provider — nothing sent, nobody penalised');
        return { ok: false, deferred: true };
      default: return assertNever(handoff, 'instrument charge handoff');
    }

    const result = await cardRail.chargeInstrument({ binding, vaultToken, idempotencyKey: key, ...intended });
    await this.observer.afterProviderReturned?.({ status: result.status, providerRef: result.providerRef ?? '' });
    const verdict = await this.judgeInstrumentAnswer(sub, instrument, reserved.id, 'CHARGE', result, intended, now);
    switch (verdict.status) {
      case 'succeeded': return { ok: true, ref: verdict.providerRef, settlePaymentId: reserved.id, rail: 'CARD' };
      case 'failed': return { ok: false, reason: verdict.reason, failureCode: mapCardFailure(verdict.reason), intentId: reserved.id, failureRaw: verdict.reason };
      case 'requires_action': return { ok: false, requiresAction: true, intentId: reserved.id };
      case 'pending': return { ok: false, unknown: true, clientKey: key, intentId: reserved.id, failureRaw: 'Pending at the card provider' };
      case 'unknown': return { ok: false, unknown: true, clientKey: key, intentId: reserved.id, failureRaw: verdict.reason };
      case 'held': return { ok: false, deferred: true };
      default: return assertNever(verdict, 'instrument charge verdict');
    }
  }

  /** An intent already exists for this attempt: its truth is retrieved, and
   *  no second instruction is ever sent under the same key. */
  private async resumeCardIntent(sub: SubWithRelations, live: SubscriptionPayment, key: string, now: Date): Promise<ChargeAttemptResult> {
    if (live.status === 'CAPTURED') return { ok: true, ref: live.externalRef ?? key, settlePaymentId: live.id };
    if (live.status === 'UNKNOWN') {
      if (live.failureCode === 'AMOUNT_MISMATCH') return { ok: false, deferred: true }; // held for a person
      const found = live.instrumentId
        ? await this.lookupInstrumentCharge(sub, live, now)
        : await this.payments.lookupCharge({ idempotencyKey: key, providerRef: live.externalRef ?? undefined });
      if (found.status === 'succeeded') return { ok: true, ref: found.providerRef ?? key, settlePaymentId: live.id };
      if (found.status === 'failed') {
        return { ok: false, reason: found.reason ?? 'Card declined', failureCode: mapCardFailure(found.reason), intentId: live.id, ...(found.reason ? { failureRaw: found.reason } : {}) };
      }
      if (found.status === 'requires_action') return { ok: false, requiresAction: true, intentId: live.id };
      return { ok: false, deferred: true }; // unknown, not found or held: the reconciler owns it
    }
    // A proven terminal for this exact key: this attempt is over. One that
    // ended asking for the cardholder keeps saying so — without a second
    // instruction and without a strike.
    if (live.failureCode === 'REQUIRES_ACTION') return { ok: false, requiresAction: true, intentId: live.id, recorded: true };
    return { ok: false, deferred: true };
  }

  /** [C2] The truth of a v2 intent, asked of the provider its instrument is
   *  bound to. A configuration naming another provider asks nobody. */
  private async lookupInstrumentCharge(sub: SubWithRelations, row: SubscriptionPayment, now: Date): Promise<InstrumentLookup> {
    const cardRail = this.resolveCardRail();
    if (!cardRail) return { status: 'unknown', reason: 'No card rail v2 provider is wired in this process' };
    const instrument = row.instrumentId ? await this.prisma.paymentInstrument.findUnique({ where: { id: row.instrumentId } }) : null;
    if (!instrument || !row.clientKey) return { status: 'unknown', reason: 'The intent names no instrument that exists' };
    const binding = bindingOf(instrument);
    if (!sameBinding(binding, cardRail.binding)) {
      await this.alertCardBindingMismatch(sub, instrument, cardRail.binding);
      return { status: 'unknown', reason: `Bound to ${describeBinding(binding)}, not the configured provider` };
    }
    // The currency the attempt was issued in (its pinned event), as the charge
    // path sent it. [AX297 F2] Never the subscription's current currency: an
    // attempt with no record of its own cannot be judged, so it is not.
    const attempt = await this.prisma.billingEvent.findUnique({
      where: { idempotencyKey: `charge:${row.clientKey.slice('card:'.length)}` },
      select: { currencyCode: true },
    });
    if (!attempt) {
      log().error({ paymentId: row.id, subscriptionId: sub.id }, '[PT-1 AX297-F2] card intent has no charge-attempt record — its currency is unknown, so it is not judged');
      return { status: 'unknown', reason: 'The charge attempt this intent belongs to has no record, so its currency is unknown' };
    }
    const currencyCode = attempt.currencyCode;
    const intended: ChargedAmount = { amountMinor: toProviderMinor(Number(row.amount), currencyCode, 'card.v2.retrieve'), currencyCode };
    const answer = await cardRail.retrieve({ binding, idempotencyKey: row.clientKey, ...(row.externalRef ? { providerRef: row.externalRef } : {}) });
    const verdict = await this.judgeInstrumentAnswer(sub, instrument, row.id, 'RETRIEVE', answer, intended, now);
    switch (verdict.status) {
      case 'succeeded': return { status: 'succeeded', providerRef: verdict.providerRef };
      case 'failed': return { status: 'failed', reason: verdict.reason, ...(verdict.providerRef ? { providerRef: verdict.providerRef } : {}) };
      case 'requires_action': return { status: 'requires_action', reason: verdict.reason };
      case 'pending': return { status: 'unknown', reason: 'Pending at the card provider' };
      case 'unknown': return verdict.absent ? { status: 'not_found' } : { status: 'unknown', reason: verdict.reason };
      case 'held': return { status: 'held' };
      default: return assertNever(verdict, 'instrument lookup verdict');
    }
  }

  /** One provider answer about an instrument charge: recorded as evidence
   *  (best effort — the payment row carries the outcome either way), checked
   *  against what the intent asked for, and reduced to what billing acts on. */
  private async judgeInstrumentAnswer(
    sub: SubWithRelations,
    instrument: { id: string; provider: string; environment: string },
    paymentId: string,
    source: 'CHARGE' | 'RETRIEVE',
    answer: CardChargeOutcome,
    intended: ChargedAmount,
    now: Date,
  ): Promise<InstrumentVerdict> {
    const disagrees = (answer.status === 'succeeded' || answer.status === 'pending') && !chargeMatchesIntent(answer, intended);
    await recordCardObservation(this.prisma, {
      source,
      instrumentId: instrument.id,
      paymentId,
      subscriptionId: sub.id,
      provider: instrument.provider,
      environment: instrument.environment,
      rawSha256: answer.rawSha256,
      parsedStatus: observedStatus(answer.status),
      verdict: disagrees ? 'REJECTED_MISMATCH' : 'ACCEPTED',
    }).catch((err) => log().warn({ err, paymentId }, '[PT-1] card observation not recorded — the payment row still carries the outcome'));
    switch (answer.status) {
      case 'succeeded':
      case 'pending':
        if (!chargeMatchesIntent(answer, intended)) {
          await this.holdCardAmountMismatch(sub, paymentId, answer, intended, now);
          return { status: 'held' };
        }
        return answer.status === 'succeeded' ? { status: 'succeeded', providerRef: answer.providerRef } : { status: 'pending' };
      case 'failed': return { status: 'failed', reason: answer.reason, ...(answer.providerRef ? { providerRef: answer.providerRef } : {}) };
      case 'requires_action': return { status: 'requires_action', reason: answer.reason };
      case 'unknown': return { status: 'unknown', reason: answer.reason, absent: answer.absent === true };
      default: return assertNever(answer, 'card charge outcome');
    }
  }

  /**
   * [PT-1 · AX318 R1] Phase two of a weekly card charge: the handoff. Under
   * payer -> subscription -> card -> payment (the order removal and
   * replacement take for the first three), and only if the card is still this
   * subscription's ACTIVE card and the lifecycle still allows sending, the
   * intent moves AUTHORIZED -> HANDED_OFF by compare-and-set; that commit is
   * the point after which the charge is in flight. Otherwise the intent is
   * closed as NOT_SENT and its key released (closeUnsentCardIntents).
   * `lost`: the intent was no longer AUTHORIZED (a removal or the reconciler
   * closed it first). The caller asks the provider only on `handed_off`.
   */
  private async handOffInstrumentCharge(
    sub: SubWithRelations,
    input: { intentId: string; instrumentId: string; now: Date },
  ): Promise<'handed_off' | 'card_changed' | 'revoked' | 'lost'> {
    await this.observer.beforeInstrumentChargeHandoff?.(sub.id, input.intentId);
    const { intentId, instrumentId, now } = input;
    const outcome = await this.prisma.$transaction(async (tx) => {
      const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
      const [card] = await tx.$queryRaw<Array<{ status: string; subscriptionId: string }>>`
        SELECT "status", "subscriptionId" FROM "payment_instruments" WHERE "id" = ${instrumentId} FOR UPDATE
      `;
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${intentId} FOR UPDATE`;
      if (!card || card.subscriptionId !== sub.id || card.status !== 'ACTIVE') {
        await closeUnsentCardIntents(tx, { intentId }, 'CARD_OUT_OF_SERVICE', now);
        return 'card_changed' as const;
      }
      const maySend = !await this.subscriptionHasConfirmationHold(tx, sub.id, intentId, now)
        && !authority.bankInsteadOfAdvance
        && !authority.suppressNotice
        && ['ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(authority.status);
      if (!maySend) {
        await closeUnsentCardIntents(tx, { intentId }, 'DISPATCH_REVOKED', now);
        return 'revoked' as const;
      }
      const won = await tx.$executeRaw`
        UPDATE "subscription_payments"
        SET "failureRaw" = COALESCE("failureRaw", '{}'::jsonb) || jsonb_build_object('providerEffect', 'HANDED_OFF', 'handedOffAt', ${now.toISOString()}::text)
        WHERE "id" = ${intentId} AND "status" = 'UNKNOWN' AND "externalRef" IS NULL AND "failureRaw"->>'providerEffect' = 'AUTHORIZED'`;
      return won === 1 ? 'handed_off' as const : 'lost' as const;
    });
    if (outcome === 'handed_off') await this.observer.afterInstrumentChargeHandedOff?.(sub.id, intentId);
    return outcome;
  }

  /**
   * [PT-1 · AX297 F1] Phase one of a weekly card charge. ONE transaction
   * locks payer -> subscription -> card (the order a partner removing a card
   * and an enrolment replacing one also take), re-reads the card there, and
   * creates this attempt's intent AUTHORIZED. The provider is not asked yet:
   * phase two, the handoff (handOffInstrumentCharge), decides that, under
   * the same locks, immediately before the call [AX318 R1].
   *
   *  - The card is no longer this subscription's ACTIVE card (a removal or
   *    replacement committed after the unlocked read): no intent at all, no
   *    effect, no strike. The attempt waits for the next cycle.
   *  - A removal or replacement arriving while this holds the locks waits for
   *    it, and follows a charge that was authorized while the card was active
   *    (reconciled like any other).
   *  - Cancellation, deletion or a hold won (the lifecycle rule of
   *    authorizeProviderEffect): the intent is written as terminal NOT_SENT
   *    evidence, exactly as the legacy path leaves it.
   *  - Another run already holds this attempt's key: busy, nothing written.
   *
   * No intent is ever left NOT_SENT for a card that left service, so an
   * attempt never waits on one forever.
   */
  private async authorizeInstrumentCharge(
    sub: SubWithRelations,
    input: { amount: number; key: string; instrumentId: string; now: Date },
  ): Promise<
    | { outcome: 'authorized'; intentId: string }
    | { outcome: 'revoked'; intentId: string }
    | { outcome: 'card_changed'; cardStatus: string }
    | { outcome: 'busy' }
  > {
    await this.observer.beforeInstrumentChargeAuthorization?.(sub.id, input.instrumentId);
    const { amount, key, instrumentId, now } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
        const [card] = await tx.$queryRaw<Array<{ status: string; subscriptionId: string }>>`
          SELECT "status", "subscriptionId" FROM "payment_instruments" WHERE "id" = ${instrumentId} FOR UPDATE
        `;
        await this.observer.afterInstrumentChargeLocked?.(sub.id, instrumentId, tx);
        if (!card || card.subscriptionId !== sub.id || card.status !== 'ACTIVE') {
          return { outcome: 'card_changed' as const, cardStatus: card?.status ?? 'MISSING' };
        }
        const maySend = !await this.subscriptionHasConfirmationHold(tx, sub.id, undefined, now)
          && !authority.bankInsteadOfAdvance
          && !authority.suppressNotice
          && ['ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(authority.status);
        const intent = await tx.subscriptionPayment.create({
          data: {
            subscriptionId: sub.id,
            amount,
            paymentMethod: 'CARD',
            clientKey: key,
            instrumentId,
            expiresAt: new Date(now.getTime() + MMG_REQUEST_TTL_MS),
            periodStart: sub.nextBillingDate,
            periodEnd: (await mmgReactivationPeriodEnd(tx, sub.id, sub.nextBillingDate, now)).periodEnd,
            ...(maySend
              ? { status: 'UNKNOWN' as const, failureRaw: { providerEffect: 'AUTHORIZED', providerRail: 'CARD', authorizedAt: now.toISOString() } }
              : {
                  status: 'EXPIRED' as const,
                  failureCode: 'DISPATCH_REVOKED' satisfies NormalizedFailure,
                  failureRaw: {
                    providerEffect: 'NOT_SENT',
                    providerRail: 'CARD',
                    revokedAt: now.toISOString(),
                    subscriptionOutcome: PRESERVED_NO_DUNNING,
                    subscriptionStatus: authority.status,
                    recoveryDisposition: 'NO_PROVIDER_EFFECT',
                  },
                }),
          },
          select: { id: true },
        });
        if (maySend) await beginConfirmationInTx(tx, sub.id, { paymentId: intent.id }, 'CARD_AUTHORIZATION_PENDING', now);
        return maySend ? { outcome: 'authorized' as const, intentId: intent.id } : { outcome: 'revoked' as const, intentId: intent.id };
      });
    } catch (error) {
      // The key is unique: a concurrent run created this attempt's intent first.
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') return { outcome: 'busy' };
      throw error;
    }
  }

  /**
   * [PT-1 · C4] Off-session 3-D Secure. The intent ends FAILED with
   * failureCode REQUIRES_ACTION and the PRESERVED_NO_DUNNING marker, so no
   * path counts it as a strike and its key never sends a second instruction.
   * The retry clock moves a day so the cycle does not re-enter the attempt
   * every hour, and the partner is told — once per attempt — in words that
   * name only the ways to pay that exist today (fee-notice-copy.ts); the
   * hosted Pay now (card screens: PT-2/PT-3) pays the week with them present.
   */
  private async holdForCardAction(sub: SubWithRelations, paymentId: string, amount: number, now: Date, recorded: boolean): Promise<void> {
    const notify = await this.prisma.$transaction(async (tx) => {
      const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${paymentId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.subscriptionId !== sub.id || payment.paymentMethod !== 'CARD') return false;
      let first = false;
      if (!recorded && payment.status === 'UNKNOWN') {
        const existing = payment.failureRaw && typeof payment.failureRaw === 'object' && !Array.isArray(payment.failureRaw)
          ? payment.failureRaw : {};
        const moved = await tx.subscriptionPayment.updateMany({
          where: { id: paymentId, status: 'UNKNOWN' },
          data: {
            status: 'FAILED',
            failureCode: 'REQUIRES_ACTION' satisfies NormalizedFailure,
            failureRaw: {
              ...existing,
              providerOutcome: 'REQUIRES_ACTION',
              subscriptionOutcome: PRESERVED_NO_DUNNING,
              recoveryDisposition: 'PARTNER_CONFIRMS_CARD',
              observedAt: now.toISOString(),
            },
          },
        });
        first = moved.count === 1;
      }
      await beginConfirmationInTx(tx, sub.id, { paymentId }, 'REQUIRES_ACTION', now);
      return first && !authority.suppressNotice;
    });
    if (!notify) return;
    // Only what is true about paying (fee-notice-copy.ts): the confirmation
    // door arrives with the card screens. Until then, the paying sentence
    // every fee notice carries [owner rule 2026-09-29]: the MMG checkout while
    // it is live, otherwise the amount due; never an agent or a Swift Number.
    const payLine = await this.feePayLine(sub, null);
    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Card payment not completed',
      body: `Your bank asked to confirm this week's card payment of $${amount.toLocaleString()} ${sub.currencyCode}, which cannot be done automatically, so it did not go through. You were not charged, and this does not count against you. ${payLine} ${FEE_RESTORE_LINE}`,
      audience: this.payerAudience(sub),
      data: { kind: 'billing_card_action_required', subscriptionId: sub.id },
      dedupeKey: `card-action:${paymentId}`,
    }).catch(() => {});
  }

  /** The provider reports a different amount or currency than the intent
   *  asked for. Nothing is booked, nobody is dunned, nothing is re-sent: the
   *  intent stays UNKNOWN under a named hold carrying both figures, and a
   *  person is paged once. */
  private async holdCardAmountMismatch(
    sub: SubWithRelations,
    paymentId: string,
    reported: ChargedAmount & { status: 'succeeded' | 'pending'; providerRef?: string },
    intended: ChargedAmount,
    now: Date,
  ): Promise<void> {
    const held = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${paymentId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.status !== 'UNKNOWN' || payment.failureCode === 'AMOUNT_MISMATCH') return false;
      const existing = payment.failureRaw && typeof payment.failureRaw === 'object' && !Array.isArray(payment.failureRaw)
        ? payment.failureRaw : {};
      await tx.subscriptionPayment.update({
        where: { id: paymentId },
        data: {
          failureCode: 'AMOUNT_MISMATCH' satisfies NormalizedFailure,
          failureRaw: {
            ...existing,
            providerOutcome: reported.status === 'succeeded' ? 'CAPTURED' : 'PENDING',
            recoveryDisposition: 'MANUAL_RECONCILIATION',
            reported: { amountMinor: reported.amountMinor, currencyCode: reported.currencyCode, providerRef: reported.providerRef ?? null },
            intended: { amountMinor: intended.amountMinor, currencyCode: intended.currencyCode },
            heldAt: now.toISOString(),
          },
        },
      });
      return true;
    });
    if (!held) return;
    log().error({ subscriptionId: sub.id, paymentId, reported: { amountMinor: reported.amountMinor, currencyCode: reported.currencyCode }, intended }, '[PT-1] card provider reported a different amount or currency — held, nothing booked');
    await notifyAdmins(this.prisma, this.notifications, {
      tenantId: await tenantOfSubscription(this.prisma, sub.id),
      title: '💳 Card charge held — the amount does not match',
      body: `The card provider reports ${reported.amountMinor} ${reported.currencyCode} (minor units) for payment ${paymentId}, but Swift asked for ${intended.amountMinor} ${intended.currencyCode}. Nothing was booked and the partner was not penalised. Reconcile against the provider before any further action.`,
      data: { kind: 'billing_invariants', alert: 'card-charge-amount-mismatch', subscriptionId: sub.id, paymentId },
      dedupeKey: `card-amount-mismatch:${paymentId}`,
    }).catch(() => {});
  }

  /** [C2] A token is only ever sent to the provider, environment and account
   *  that minted it. A configuration naming another sends nothing, dunns
   *  nobody, and pages a person once per mismatch. */
  private async alertCardBindingMismatch(
    sub: SubWithRelations,
    instrument: { id: string; provider: string; environment: string; providerAccount: string },
    configured: CardRailBinding,
  ): Promise<void> {
    const bound = bindingOf(instrument);
    log().error({ subscriptionId: sub.id, instrumentId: instrument.id, bound: describeBinding(bound), configured: describeBinding(configured) }, '[PT-1 C2] card instrument bound to another provider setup — refused, nothing charged');
    await notifyAdmins(this.prisma, this.notifications, {
      tenantId: await tenantOfSubscription(this.prisma, sub.id),
      title: '💳 Card charge refused — the card belongs to another provider setup',
      body: `The saved card for subscription ${sub.id} was issued by ${describeBinding(bound)}, but this server is set up for ${describeBinding(configured)}. Nothing was charged and the partner was not penalised. Restore the configuration, or ask the partner to add their card again.`,
      data: { kind: 'billing_invariants', alert: 'card-instrument-binding-mismatch', subscriptionId: sub.id, instrumentId: instrument.id },
      dedupeKey: `card-binding:${instrument.id}:${describeBinding(configured)}`,
    }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // [PT-1] Hosted Pay now — what it costs, and how its capture is booked
  // -------------------------------------------------------------------------

  /**
   * [PT-1] The server's price for a hosted Pay now: the weekly fee for the
   * period that starts at nextBillingDate, priced exactly as the weekly cycle
   * prices it. When a week is owed, that is the owed week; when nothing is
   * due, it is the next week, paid ahead. A client never names the amount.
   */
  async quoteCardPayNow(subscriptionId: string, now = new Date()): Promise<{ amount: number; currencyCode: string; periodStart: Date; due: boolean;
    feeBasis: { authorityRevision: number | null; type: SubscriptionType; weeklyRate: number; customRate: string; feeWaived: boolean } }> {
    let sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new NotFoundError('Subscription', subscriptionId);
    const payer = await subscriptionPayer(this.prisma, subscriptionId);
    let authorityRevision: number | null = null;
    if (payer.kind === 'MOVER') {
      const authority = await resolveMoverFeeAuthority(this.prisma, payer);
      if (!authority || authority.state !== 'ACTIVE' || authority.canonicalSubscriptionId !== subscriptionId) {
        throw new AppError(409, 'MOVER_FEE_REVIEW_REQUIRED', 'This weekly fee needs review before another payment.');
      }
      sub = { ...sub, type: authority.feeType };
      authorityRevision = authority.revision;
    }
    if (sub.feeWaived) throw new AppError(409, 'NOTHING_TO_PAY', 'This week is waived — there is nothing to pay.');
    const priced = await this.priceEligibleFor(sub, await this.loadUsdPricing());
    const amount = Number(priced.amount);
    if (!(amount > 0)) throw new AppError(409, 'NOTHING_TO_PAY', 'There is no weekly fee to pay.');
    const due = sub.nextBillingDate.getTime() <= now.getTime() || ['PAST_DUE', 'SUSPENDED', 'CHURNED'].includes(sub.status);
    return { amount, currencyCode: sub.currencyCode, periodStart: sub.nextBillingDate, due,
      feeBasis: { authorityRevision, type: sub.type, weeklyRate: Number(sub.weeklyRate), customRate: String(sub.customRate), feeWaived: sub.feeWaived } };
  }

  /**
   * [PT-1] Book a verified hosted Pay-now capture — ONCE — through
   * applySuccessfulCharge, the path every rail uses: under the payer ->
   * subscription -> payment locks it advances the paid week and reinstates a
   * billing suspension, or, when that week is already covered or the
   * subscription may not advance, banks the money to the wallet. The payment
   * row's compare-and-set and the success / bank event keys make a repeat a
   * no-op. Returns what durably happened.
   */
  async settleHostedCardPayment(input: { subscriptionId: string; paymentId: string; providerRef: string; now?: Date }): Promise<
    { outcome: 'advanced' | 'banked' | 'not_settled' } | { outcome: 'held'; failureCode: string }
  > {
    const now = input.now ?? new Date();
    const [sub, payment] = await Promise.all([
      this.prisma.subscription.findUnique({
        where: { id: input.subscriptionId },
        include: {
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          vendor: { select: { id: true, owner: { select: { userId: true } } } },
        },
      }),
      this.prisma.subscriptionPayment.findUnique({ where: { id: input.paymentId } }),
    ]);
    if (!sub || !payment || payment.subscriptionId !== sub.id || payment.paymentMethod !== 'CARD') return { outcome: 'not_settled' };
    const periodKey = payment.periodStart.toISOString().slice(0, 10);
    // The amount and currency booked are the SESSION's, read inside the
    // settlement transaction (applySuccessfulChargeInTx) — never this
    // snapshot's current currency [AX297 F2].
    await this.applySuccessfulCharge(sub as SubWithRelations, Number(payment.amount), input.providerRef, now, periodKey, payment.id);
    const [after, banked] = await Promise.all([
      this.prisma.subscriptionPayment.findUnique({ where: { id: payment.id } }),
      this.prisma.billingEvent.findUnique({ where: { idempotencyKey: `bank:${payment.id}` }, select: { id: true } }),
    ]);
    if (banked) return { outcome: 'banked' };
    if (after?.status === 'CAPTURED' && after.externalRef === input.providerRef) return { outcome: 'advanced' };
    if (after?.failureCode === 'WALLET_CURRENCY_MISMATCH' || after?.failureCode === 'CURRENCY_UNPINNED') {
      return { outcome: 'held', failureCode: after.failureCode };
    }
    return { outcome: 'not_settled' };
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
  async reconcileUnknownCardCharges(now = new Date()): Promise<{ settled: number; declined: number; reissued: number; expired: number; stillUnknown: number; actionRequired: number; oldestMinutes: number }> {
    const out = { settled: 0, declined: 0, reissued: 0, expired: 0, stillUnknown: 0, actionRequired: 0, oldestMinutes: 0 };
    // [AX318 R4] Rows this process will not act on are left out BEFORE any
    // write: a hosted Pay now belongs to its session's sweep, and with no card
    // rail v2 provider wired (CARD_RAIL_V2 off and not draining) a v2 intent
    // is not even stamped. The gauges below still count every unknown row.
    const v2Wired = this.resolveCardRail() !== null;
    const rows = await this.prisma.subscriptionPayment.findMany({
      where: {
        paymentMethod: 'CARD',
        status: 'UNKNOWN',
        OR: [{ clientKey: null }, { NOT: { clientKey: { startsWith: CARD_PAY_NOW_KEY_PREFIX } } }],
        ...(v2Wired ? {} : { instrumentId: null }),
      },
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
      // [PT-1] A charge held because the provider reported a different amount
      // waits for a person.
      if (row.failureCode === 'AMOUNT_MISMATCH') { out.stillUnknown += 1; continue; }
      // [AX318 R1] A v2 intent still AUTHORIZED was never handed to the
      // provider (its run died between the two phases): nothing was sent, so
      // nobody is asked. Past a grace no live run could still be inside, it is
      // closed as NOT_SENT and its key released; the attempt is billed again.
      if (row.instrumentId && isNeverHandedOff(row)) {
        if (now.getTime() - row.createdAt.getTime() >= UNSENT_INTENT_GRACE_MS) {
          const closed = await this.prisma.$transaction((tx) => closeUnsentCardIntents(tx, { intentId: row.id }, 'NEVER_HANDED_OFF', now));
          if (closed === 1) out.expired += 1; else out.stillUnknown += 1;
        } else out.stillUnknown += 1;
        continue;
      }
      const periodKey = row.periodStart.toISOString().slice(0, 10);
      const amount = Number(row.amount);
      const ttlAt = row.expiresAt ?? new Date(row.createdAt.getTime() + MMG_REQUEST_TTL_MS);

      // [PT-1 · C2] A v2 intent is retrieved from the provider, environment and
      // account its instrument is bound to — never from whatever is configured
      // for new charges. A legacy intent keeps its legacy lookup.
      const found = row.instrumentId
        ? await this.lookupInstrumentCharge(sub as SubWithRelations, row, now)
        : await this.payments.lookupCharge({ idempotencyKey: row.clientKey, providerRef: row.externalRef ?? undefined });
      if (found.status === 'requires_action') {
        await this.holdForCardAction(sub as SubWithRelations, row.id, amount, now, false);
        out.actionRequired += 1;
        continue;
      }
      if (found.status === 'held') { out.stillUnknown += 1; continue; }
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
    if (await this.subscriptionHasConfirmationHold(this.prisma, sub.id, undefined, now)) return { ok: false, deferred: true };
    // [PROD-PATH] No live way to pay: the fee is paused before the prepaid
    // spend and before the no-rail fall-through (which would record a
    // failure). billSubscription stops earlier; this is its second wall.
    if (noLivePayPath()) return { ok: false, deferred: true };
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

    // [PT-1] Card rail v2: the weekly card charge uses the subscription's
    // ACTIVE instrument, through the provider recorded ON it. The legacy
    // bare token on the subscription is never read on this path — not even
    // as a fallback (card-rail-census.test.ts holds that).
    if (sub.billingMethod === 'CARD' && cardRailV2Enabled()) {
      return this.attemptInstrumentCharge(sub, amount, now);
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

    // [PROD-PATH] MMG switched off while another way to pay (a card) is live:
    // nobody's fee is paused, and the partner's billing method is their own
    // choice, so choosing MMG must not dodge the fee. Nothing is sent to MMG:
    // this week has no automatic rail, exactly like a cash subscription, and
    // fails, so the partner is told to pay another way. A request already in
    // flight for the week never fails under it: the dunning clock holds it as
    // a payment being confirmed (dunning-clock.ts), and this method's first
    // line defers on that hold.
    if (sub.billingMethod === 'MOBILE_MONEY' && mmgDisabled()) {
      return { ok: false, reason: 'MMG payments are switched off right now' };
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
        const lookupSource = await this.startMmgLookup(sub, prior.id, now);
        if (!lookupSource?.externalRef) return { ok: false, deferred: true, rail: 'MOBILE_MONEY' };
        let priorLookup: MmgTransaction;
        try {
          priorLookup = await mmg.transactionLookup({ transactionId: lookupSource.externalRef });
        } catch {
          return { ok: false, deferred: true, reopenPaymentId: prior.id, rail: 'MOBILE_MONEY' }; // MMG down — never fire blind
        }
        if (priorLookup.status === 'approved') {
          return { ok: true, ref: prior.externalRef, settlePaymentId: prior.id, rail: 'MOBILE_MONEY', mmgEvidence: priorLookup };
        }
        if (!await this.confirmPriorMmgTerminal(sub, lookupSource, priorLookup, now)) {
          return { ok: false, deferred: true, rail: 'MOBILE_MONEY' };
        }
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
      return { ok: false, reason: result.reason ?? 'MMG request failed', failureCode, intentId: intent.id, rail: 'MOBILE_MONEY',
        mmgInitiateFailure: { status: result.status, transactionId: result.transactionId, reference, amountMinor: Math.round(amount * 100), currencyCode: sub.currencyCode }, ...(result.reason ? { failureRaw: result.reason } : {}) };
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
    if (settled.disposition === 'held' && settlePaymentId) await this.pageUnpinnedCardCapture(sub, settlePaymentId);
    if (settled.disposition === 'skipped' || settled.disposition === 'held') return false;
    if (settled.disposition === 'advanced') await this.afterSuccessfulCharge({ ...sub, currencyCode: settled.currencyCode! }, settled.amount!, settled.periodKey!);
    return true;
  }

  /** [PT-1 · AX318 R3] A weekly card capture held because its attempt record
   *  cannot vouch for its currency (CURRENCY_UNPINNED) is put in front of the
   *  tenant's admins, once per payment, exactly as a held Pay now is (that
   *  one is paged by its session's hold). Resolution: the admin card-hold
   *  queue (PT-2). */
  private async pageUnpinnedCardCapture(sub: SubWithRelations, paymentId: string): Promise<void> {
    const payment = await this.prisma.subscriptionPayment.findUnique({
      where: { id: paymentId }, select: { paymentMethod: true, failureCode: true, clientKey: true, amount: true, externalRef: true },
    });
    if (!payment || payment.paymentMethod !== 'CARD' || payment.failureCode !== 'CURRENCY_UNPINNED') return;
    if (payment.clientKey?.startsWith(CARD_PAY_NOW_KEY_PREFIX)) return;
    await notifyAdmins(this.prisma, this.notifications, {
      tenantId: await tenantOfSubscription(this.prisma, sub.id),
      title: '💳 Card payment held — its currency cannot be confirmed',
      body: `A weekly card payment for subscription ${sub.id} was captured by the card provider (payment ${paymentId}, ${Number(payment.amount).toLocaleString()} in its issued currency), but its charge-attempt record is missing, so the currency it was issued in cannot be confirmed. Nothing was booked and the partner was not penalised. Reconcile it against the provider before any further action.`,
      data: { kind: 'billing_invariants', alert: 'card-capture-currency-unpinned', subscriptionId: sub.id, paymentId },
      dedupeKey: `card-unpinned:${paymentId}`,
    }).catch(() => {});
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
    const mmgHeld = await this.subscriptionHasConfirmationHold(tx, sub.id, settlePaymentId, now);
    // A card capture is an external money fact, not permission to reactivate a
    // subscription. Fence its durable intent and choose a single disposition
    // before applying the ordinary prepaid/free/service-advance path below.
    if (settlePaymentId && !spendPrepaid) {
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${settlePaymentId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: settlePaymentId } });
      if (payment?.paymentMethod === 'CARD') {
        if (payment.subscriptionId !== sub.id || !['UNKNOWN', 'CAPTURED'].includes(payment.status)) return 'skipped';
        const originalPeriodKey = payment.periodStart.toISOString().slice(0, 10);
        const payNowSessionId = payment.clientKey?.startsWith(CARD_PAY_NOW_KEY_PREFIX)
          ? payment.clientKey.slice(CARD_PAY_NOW_KEY_PREFIX.length)
          : null;
        const [banked, covered, originalAttempt, payNowSession] = await Promise.all([
          tx.billingEvent.findUnique({ where: { idempotencyKey: `bank:${payment.id}` } }),
          tx.billingEvent.findUnique({ where: { idempotencyKey: `success:${sub.id}:${originalPeriodKey}` } }),
          payment.clientKey?.startsWith(`card:${sub.id}:`)
            ? tx.billingEvent.findUnique({ where: { idempotencyKey: `charge:${payment.clientKey.slice(5)}` } })
            : Promise.resolve(null),
          payNowSessionId
            ? tx.cardSession.findUnique({ where: { id: payNowSessionId }, select: { subscriptionId: true, paymentId: true, amount: true, currencyCode: true } })
            : Promise.resolve(null),
        ]);
        if (banked || (payment.status === 'CAPTURED' && covered?.paymentRef === payment.externalRef)) return 'skipped';
        if (!paymentRef || (payment.externalRef && payment.externalRef !== paymentRef)) {
          throw new AppError(409, 'CARD_REFERENCE_MISMATCH', 'Card capture does not match the durable intent');
        }
        // [PT-1 · AX297 F2] A capture is booked in the currency it was priced,
        // sent and checked in, pinned where it was issued: a hosted Pay now's
        // SESSION (amount and currency frozen at the database), a weekly
        // attempt's CHARGE_ATTEMPT event. Never the subscription's current
        // currency, which may have changed since. A v2 capture whose issuing
        // record cannot vouch for it is held for a person, never guessed.
        // (Legacy card intents keep their existing reading.)
        const currencyCode = payNowSessionId
          ? (payNowSession
            && payNowSession.subscriptionId === sub.id
            && payNowSession.paymentId === payment.id
            && payNowSession.amount?.equals(payment.amount)
            ? payNowSession.currencyCode
            : null)
          : payment.instrumentId
            ? originalAttempt?.currencyCode ?? null
            : originalAttempt?.currencyCode ?? sub.currencyCode;
        if (!currencyCode) {
          await this.holdUnpinnedCardCapture(tx, payment, paymentRef);
          return 'held';
        }
        const bankCapture = mmgHeld || covered || !this.successfulChargeAuthorityAllowsAdvance(authority, sub);
        if (bankCapture && await this.holdWalletCurrencyMismatch(tx, payment, currencyCode, paymentRef)) return 'held';
        const claimed = await tx.subscriptionPayment.updateMany({
          where: { id: payment.id, subscriptionId: sub.id, paymentMethod: 'CARD', status: payment.status, externalRef: payment.externalRef },
          data: { status: 'CAPTURED', paidAt: now, externalRef: paymentRef, failureCode: null },
        });
        if (claimed.count !== 1) return 'skipped';
        await resolvePaymentConfirmationInTx(tx, sub.id, payment.id, 'PAID', { actor: 'card-settlement', reference: paymentRef }, now);
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
    // [PROD-PATH] Owner ruling: the first fee after a way to pay comes back
    // covers the weeks nobody could pay and the week in progress — only that
    // week is billed. A settled intent keeps the period fixed when it was
    // reserved; the reactivation record is consumed only by a period that
    // reaches past it (consumeMmgReactivation).
    const coverage = await mmgReactivationPeriodEnd(tx, sub.id, periodStart, now);
    const settledRow = settlePaymentId
      ? await tx.subscriptionPayment.findUnique({ where: { id: settlePaymentId }, select: { periodStart: true, periodEnd: true } })
      : null;
    const periodEnd = settledRow && settledRow.periodStart.getTime() === periodStart.getTime() ? settledRow.periodEnd : coverage.periodEnd;

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

    // The obligation advances on the success record just booked, in the
    // currency this settlement was pinned to (never relabelled).
    await advanceDunningObligation(tx, sub.id, periodEnd, now, sub.currencyCode);
    await consumeMmgReactivation(tx, sub.id, periodEnd);

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
    opts: { subscriptionId: string; amount: number; currencyCode: string; eventKey: string; note: string; channel: string; mmgRef?: string; rail?: 'CARD'; expectedTenantId?: string },
  ) {
    // A system payment has no request tenant. Derive ownership from the
    // trusted payer inside this transaction, never from a receipt default.
    const tenantId = await subscriptionTenantInTx(tx, opts.subscriptionId);
    const requestTenantId = getTenantId();
    if (requestTenantId && requestTenantId !== tenantId) {
      throw new AppError(403, 'SUBSCRIPTION_TENANT_MISMATCH', 'The payment tenant does not match the subscription payer.');
    }
    if (opts.expectedTenantId && opts.expectedTenantId !== tenantId) {
      throw new ProviderIdentityError('PROVIDER_TXN_TENANT_CONFLICT', 'The checkout tenant does not match the subscription payer.');
    }
    // One subscription has one currency-denominated wallet. Even an empty
    // wallet must never be relabelled or incremented with another currency.
    // Materialize/lock the row, then include its currency in the monetary CAS;
    // a concurrent creator or currency edit cannot turn the read into consent.
    const payer = await lockSubscriptionPayer(tx, opts.subscriptionId);
    if (payer.kind === 'MOVER') await lockMoverFeeAuthority(tx, payer);
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
      tenantId,
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
    if (payer.kind === 'MOVER') await lockMoverFeeAuthority(tx, payer);
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
    await beginConfirmationInTx(tx, payment.subscriptionId, await paymentConfirmationSource(tx, payment.id), 'WALLET_CURRENCY_MISMATCH');
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

  /** [PT-1 · AX297 F2] A v2 card capture whose issuing record (its Pay-now
   * session, or its weekly CHARGE_ATTEMPT) cannot vouch for its currency is
   * not booked in any currency. The intent keeps the provider reference and
   * one manual-reconciliation fact; a person decides. Caller owns the payer,
   * subscription and payment locks. */
  private async holdUnpinnedCardCapture(tx: Prisma.TransactionClient, payment: SubscriptionPayment, providerRef: string): Promise<void> {
    const existing = payment.failureRaw && typeof payment.failureRaw === 'object' && !Array.isArray(payment.failureRaw)
      ? payment.failureRaw : {};
    await beginConfirmationInTx(tx, payment.subscriptionId, await paymentConfirmationSource(tx, payment.id), 'CURRENCY_UNPINNED');
    await tx.subscriptionPayment.update({
      where: { id: payment.id },
      data: {
        status: 'UNKNOWN',
        externalRef: providerRef,
        failureCode: 'CURRENCY_UNPINNED' satisfies NormalizedFailure,
        failureRaw: { ...existing, providerOutcome: 'CAPTURED', recoveryDisposition: 'MANUAL_RECONCILIATION' },
      },
    });
    log().error({ paymentId: payment.id, subscriptionId: payment.subscriptionId }, '[PT-1 AX297-F2] captured card payment has no record of the currency it was issued in — held, nothing booked');
  }

  /** The payment holds the current quarantine; append-only billing events
   * retain every distinct approval fact. No automatic path clears this marker.
   * A separate, audited manual reconciliation must decide its disposition. */
  private async subscriptionHasConfirmationHold(
    db: PrismaClient | Prisma.TransactionClient,
    subscriptionId: string,
    exceptPaymentId?: string,
    now = new Date(),
  ): Promise<boolean> {
    const check = async (tx: Prisma.TransactionClient) => {
      const payment = exceptPaymentId ? await tx.subscriptionPayment.findUnique({ where: { id: exceptPaymentId }, select: { clientKey: true } }) : null;
      const except = payment?.clientKey?.startsWith(CARD_PAY_NOW_KEY_PREFIX)
        ? { cardSessionId: payment.clientKey.slice(CARD_PAY_NOW_KEY_PREFIX.length) }
        : exceptPaymentId ? { paymentId: exceptPaymentId } : undefined;
      return hasConfirmationInTx(tx, subscriptionId, now, except);
    };
    return '$transaction' in db ? db.$transaction(check) : check(db);
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
    await beginConfirmationInTx(tx, payment.subscriptionId, { paymentId: payment.id }, 'MMG_APPROVAL_REVIEW', now);
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
  ): Promise<{ payerStatus: string; payerPhone: string; status: SubscriptionStatus; autoRenew: boolean; collectionAllowed: boolean }> {
    const owner = await lockSubscriptionPayer(tx, sub.id);
    const collection = await lockFeeCollectionAuthority(tx, sub.id);
    const payer = await tx.user.findUniqueOrThrow({ where: { id: owner.userId }, select: { status: true, phone: true } });
    const fresh = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id }, select: { status: true, autoRenew: true } });
    return { payerStatus: payer.status, payerPhone: payer.phone, status: fresh.status, autoRenew: fresh.autoRenew, collectionAllowed: collection.allowed };
  }

  private successfulChargeAuthorityAllowsAdvance(
    authority: { payerStatus: string; payerPhone: string; status: SubscriptionStatus; autoRenew: boolean; collectionAllowed: boolean },
    sub: SubWithRelations,
  ): boolean {
    const payerUserId = this.payerUserId(sub);
    const deletedAccount = authority.payerStatus === 'DEACTIVATED' || authority.payerPhone === `deleted:${payerUserId}`;
    return !deletedAccount
      && authority.collectionAllowed
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
      suppressNotice: locked.payerStatus !== 'ACTIVE' || !locked.collectionAllowed,
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

      const liveObligation = await tx.subscription.findUnique({ where: { id: sub.id }, select: { nextBillingDate: true, failedAttempts: true } });
      const sameObligation = liveObligation?.nextBillingDate.getTime() === sub.nextBillingDate.getTime()
        && liveObligation.failedAttempts === sub.failedAttempts
        && payment.periodStart.getTime() === sub.nextBillingDate.getTime();
      const maySend = sameObligation && !await this.subscriptionHasConfirmationHold(tx, sub.id, undefined, now)
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
      if (authorized.count === 1) await beginConfirmationInTx(tx, sub.id, { paymentId }, 'PAYMENT_DISPATCHED', now);
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
      // The approval prompt belongs to THIS instruction: its own confirmation
      // hold never silences it, while another payment still being confirmed
      // does. The retry schedule is the shared clock's projection (paused
      // while this instruction is confirmed), never a stamp written here.
      if (await this.subscriptionHasConfirmationHold(tx, sub.id, input.paymentId, input.now)
        || authority.bankInsteadOfAdvance || authority.suppressNotice || !live?.autoRenew
        || !['ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(authority.status)) return false;
      return true;
    });
  }

  private async mmgAttemptCurrency(tx: Prisma.TransactionClient, payment: SubscriptionPayment): Promise<string | null> {
    if (!payment.clientKey?.startsWith(`sub:${payment.subscriptionId}:`)) return null;
    const attempt = await tx.billingEvent.findUnique({ where: { idempotencyKey: `charge:${payment.clientKey.slice(4)}` } });
    return attempt?.currencyCode ?? null;
  }

  private async startMmgLookup(sub: SubWithRelations, paymentId: string, now: Date): Promise<SubscriptionPayment | null> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPaymentOutcomeAuthority(tx, sub);
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${paymentId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.subscriptionId !== sub.id || payment.paymentMethod !== 'MOBILE_MONEY'
        || !['UNKNOWN', 'PENDING', 'FAILED', 'EXPIRED'].includes(payment.status)) return null;
      return tx.subscriptionPayment.update({ where: { id: payment.id }, data: { failureRaw: {
        ...mmgPaymentRaw(payment), mmgLookupGeneration: randomUUID(), mmgLookupStartedAt: now.toISOString(),
      } } });
    });
  }

  private mmgLookupObservation(payment: SubscriptionPayment, evidence: MmgTransaction): MmgLookupObservation {
    return { generation: String(mmgPaymentRaw(payment)['mmgLookupGeneration']), facts: paymentFacts(payment), evidence };
  }

  /** Preserve every paid/held fact and the original instruction identity. A
   * legacy terminal flag without proof becomes pollable, never a new debit. */
  private async holdUnprovenMmgInTx(tx: Prisma.TransactionClient, payment: SubscriptionPayment, now: Date): Promise<void> {
    if (payment.status === 'CAPTURED') return;
    const raw = mmgPaymentRaw(payment);
    await tx.subscriptionPayment.update({ where: { id: payment.id }, data: {
      status: payment.externalRef ? 'PENDING' : 'UNKNOWN',
      ...(hasMmgApprovalHold(payment) || raw['providerOutcome'] === 'CAPTURED' ? {} : { failureCode: 'MMG_TERMINAL_UNPROVEN' }),
      failureRaw: { ...raw, ...(raw['mmgUnprovenTerminal'] ? {} : {
        mmgUnprovenTerminal: { previousStatus: payment.status, previousFailureCode: payment.failureCode,
          observedAt: now.toISOString() },
      }) },
    } });
    await beginConfirmationInTx(tx, payment.subscriptionId, { paymentId: payment.id }, 'MMG_TERMINAL_UNPROVEN', now);
  }

  private async confirmPriorMmgTerminal(sub: SubWithRelations, snapshot: SubscriptionPayment, evidence: MmgTransaction, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPaymentOutcomeAuthority(tx, sub);
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${snapshot.id} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: snapshot.id } });
      if (!payment || payment.subscriptionId !== sub.id || payment.paymentMethod !== 'MOBILE_MONEY'
        || !['UNKNOWN', 'PENDING', 'FAILED', 'EXPIRED'].includes(payment.status)) return false;
      const raw = mmgPaymentRaw(payment);
      if (payment.paidAt || hasMmgApprovalHold(payment) || raw['providerOutcome'] === 'CAPTURED') return false;
      const observation = this.mmgLookupObservation(snapshot, evidence);
      const currency = await this.mmgAttemptCurrency(tx, payment);
      if (!matchesLookupGeneration(payment, observation)) return false;
      if (!mmgNegativeMatches(payment, currency, evidence)) {
        await this.holdUnprovenMmgInTx(tx, payment, now);
        return false;
      }
      // Live rows are resolved by the poller atomically with their outcome.
      // A retry may only pass a pre-existing terminal outcome for this period.
      if (!['FAILED', 'EXPIRED'].includes(payment.status) || payment.periodStart.getTime() !== sub.nextBillingDate.getTime()) return false;
      await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { failureRaw: {
        ...raw, mmgTerminalEvidence: mmgTerminalProof(payment, currency!, evidence, 'LOOKUP', observation.generation, now),
      } } });
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
    const settle = () => this.prisma.$transaction(async (tx) => {
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
      const otherApprovalHeld = await this.subscriptionHasConfirmationHold(tx, sub.id, payment.id, now);
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

      // [I3 · MMG checkout F2] One MMG transaction, one credit, whichever channel
      // reaches it first: the push rail claims the same provider identity as
      // agent cash, admin top-ups and the MMG checkout, inside this settlement.
      // A transaction another channel already credited (or on record for another
      // account or amount) rolls this settlement back whole and is held for a
      // person (below), never settled here.
      try {
        await claimProviderPaymentInTx(tx, {
          provider: 'MMG',
          providerTxnId: evidence.transactionId,
          amount: Number(payment.amount),
          currencyCode: originalAttempt!.currencyCode,
          subscriptionId: sub.id,
          tenantId: await subscriptionTenantInTx(tx, sub.id),
          creditedBy: `push:${payment.id}`,
        });
      } catch (error) {
        if (error instanceof ProviderIdentityError) throw new PushIdentityRefused(error.identityCode);
        throw error;
      }

      await resolvePaymentConfirmationInTx(tx, sub.id, payment.id, 'PAID', { actor: 'mmg-settlement', reference: evidence.transactionId }, now);

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
    let result: Awaited<ReturnType<typeof settle>> | { kind: 'held'; reason: string; paymentId: string; notify: boolean } | { kind: 'lost' };
    try {
      result = await settle();
    } catch (error) {
      if (!(error instanceof PushIdentityRefused)) throw error;
      result = await this.holdPushOnIdentityConflict(sub, paymentId, evidence, error.identityCode, now);
    }

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

  /** [MMG checkout F2] The push rail's settlement found its MMG transaction on
   *  record for another credit and rolled back whole. Keep the approval as
   *  evidence and hold it for a person, in its own transaction, under the same
   *  payer -> subscription -> payment lock order. Nothing is booked. */
  private async holdPushOnIdentityConflict(
    sub: SubWithRelations,
    paymentId: string,
    evidence: MmgApprovalEvidence,
    identityCode: string,
    now: Date,
  ): Promise<{ kind: 'held'; reason: string; paymentId: string; notify: boolean } | { kind: 'lost' }> {
    const reason = `The MMG transaction is already on record for another credit (${identityCode})`;
    return this.prisma.$transaction(async (tx) => {
      await this.lockSubscriptionMoneyAuthority(tx, sub);
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${paymentId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.subscriptionId !== sub.id || payment.paymentMethod !== 'MOBILE_MONEY' || payment.status === 'CAPTURED') {
        return { kind: 'lost' as const };
      }
      const originalAttempt = payment.clientKey?.startsWith(`sub:${sub.id}:`)
        ? await tx.billingEvent.findUnique({ where: { idempotencyKey: `charge:${payment.clientKey.slice(4)}` } })
        : null;
      const notify = await this.retainMmgApprovalHold(tx, payment, originalAttempt?.currencyCode ?? null, evidence, reason, now);
      return { kind: 'held' as const, reason, paymentId: payment.id, notify };
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
    // [PROD-PATH] MMG fully off: no row is stamped, looked up, expired or
    // dunned. Only MMG's own answer may resolve a request it once accepted
    // [LAW M-5], so every row waits, untouched, until MMG is switched on.
    if (mmgDisabled()) {
      out.stillPending = pending.length;
      return out;
    }

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

      const lookupSource = await this.startMmgLookup(sub as SubWithRelations, payment.id, now);
      if (!lookupSource?.externalRef) { out.stillPending += 1; continue; }
      let lookup: MmgTransaction;
      try {
        lookup = await mmg.transactionLookup({ transactionId: lookupSource.externalRef });
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
            { status: expired ? 'EXPIRED' : 'FAILED', failureCode: expired ? 'REQUEST_EXPIRED' : mapMmgFailure(status), from: ['PENDING', 'UNKNOWN'], providerAbsenceOnly: status === 'pending', mmgLookup: this.mmgLookupObservation(lookupSource, lookup) },
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
    // [REVIEW-PARTNER · DL-5] The store-review fiction has no money rail to choose (before any write).
    if (await isReviewSubscription(this.prisma, subscriptionId)) throw new ReviewDemoMoneyRefusedError();
    let resumedFromPause = false;
    // The instant charge below is anchored to exactly this due date (DS213 F2-1).
    const resumedAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      if (!(await lockFeeCollectionAuthority(tx, subscriptionId)).allowed) {
        throw new AppError(409, 'MOVER_FEE_REVIEW_REQUIRED', 'This weekly fee needs review before billing can resume.');
      }
      const { sub: fresh } = await lockBillingAuthority(tx, subscriptionId);
      const clock = await currentDunningClock(tx, subscriptionId, resumedAt);
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
      // [E12] A PAUSED plan (stopped, then its paid period ran out) restarts
      // NOW: ACTIVE and due immediately, so the next cycle charges this week
      // (its period starts at nextBillingDate) exactly like any renewal, and a
      // failed charge follows the normal dunning.
      const paused = fresh.status === 'PAUSED';
      if (paused && clock.pausedAt) throw new AppError(409, 'PAYMENT_CONFIRMING', 'The weekly-fee payment is being confirmed.');
      if (paused && !await resumeVoluntaryObligationInTx(tx, fresh, clock, resumedAt)) return null;
      resumedFromPause = paused;
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          billingMethod: method,
          mmgPayerMsisdn: method === 'MOBILE_MONEY' ? mmgPayerMsisdn!.trim() : null,
          autoRenew: true,
        },
      });
      if (!paused) await projectDunningClock(tx, clock, resumedAt);
      return tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    });
    if (!updated) throw new AppError(409, 'BILLING_OBLIGATION_REVIEW_REQUIRED', 'The paused weekly fee needs finance review before a new period can start.');
    await this.prisma.billingEvent.create({
      data: {
        subscriptionId,
        type: 'TIER_CHANGE',
        currencyCode: updated.currencyCode,
        idempotencyKey: `rail:${subscriptionId}:${Date.now()}`,
        note: `Billing rail set to ${method}${method === 'MOBILE_MONEY' ? ' (MMG merchant-initiated)' : ' (prepaid)'}`,
      },
    });
    // Preserve the declaration as advisory provenance, never an identity edge.
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
        await captureMmgPayer(this.prisma, { userId, role, subscriptionId, payerMsisdn: mmgPayerMsisdn.trim() }).catch((err) => log().error({ err }, 'advisory payer observation failed; money facts unchanged'));
      }
    }
    // [DS207 F2] A resumed PAUSED plan is charged NOW, through the same
    // instant path a top-up uses, not at the next hourly cycle: otherwise a
    // partner could resume, work until just before the cycle, stop again and
    // never pay for that work. A failed or in-flight charge follows the normal
    // dunning; the cycle still retries a row that remains due.
    if (resumedFromPause) {
      try {
        await this.chargeResumedPlan(subscriptionId, resumedAt);
      } catch (err) {
        log().error({ err, subscriptionId }, 'instant charge after resuming a paused plan failed — the billing cycle retries');
      }
    }
    return updated;
  }

  /**
   * [E12 · DS213 F2-1] The instant charge for a resumed PAUSED plan, anchored
   * to the week the resume made due. The row is re-read after the resume
   * commits; if the hourly cycle charged it in between, nextBillingDate has
   * already moved a week on, and billing the re-read row would take the NEXT
   * week (the CHARGE_ATTEMPT key dedupes only within one period). So it bills
   * only while the row is still ACTIVE, auto-renewing and due at exactly
   * `resumedDue`; otherwise the cycle already did it. A concurrent cycle that
   * has not yet advanced the row races on the SAME week's attempt key, which
   * lets exactly one charge through.
   */
  async chargeResumedPlan(
    subscriptionId: string,
    resumedDue: Date,
  ): Promise<'succeeded' | 'failed' | 'suspended' | 'skipped' | 'pending'> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
    });
    if (!sub || sub.status !== 'ACTIVE' || !sub.autoRenew || sub.nextBillingDate.getTime() !== resumedDue.getTime()) {
      return 'skipped';
    }
    return this.billSubscription(sub as SubWithRelations);
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
    // [REVIEW-PARTNER · DL-5] The store-review fiction has no weekly billing to stop.
    if (await isReviewSubscription(this.prisma, subscriptionId)) throw new ReviewDemoMoneyRefusedError();
    return this.prisma.$transaction(async (tx) => {
      const payer = await lockSubscriptionPayer(tx, subscriptionId);
      if (payer.userId !== actorUserId) throw new AppError(403, 'FORBIDDEN', 'This weekly fee belongs to another payer.');
      if (payer.kind === 'MOVER') {
        const authority = await lockMoverFeeAuthority(tx, payer);
        if (authority?.canonicalSubscriptionId !== subscriptionId) throw new AppError(409, 'MOVER_FEE_SOURCE_CHANGED', 'Use the current shared weekly fee.');
        // Only the canonical fee collects and gates both roles. Changing an
        // alias here would invent a separate manual stop that a later shared
        // resume could not distinguish from an original source restriction.
      }
      const { sub: fresh } = await lockBillingAuthority(tx, subscriptionId);
      await currentDunningClock(tx, subscriptionId);
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
    // [PROD-PATH] MMG switched off: a terminal MMG payment's outcome is a
    // dunning step (CHARGE_FAILED, PAST_DUE, SUSPENDED). The pause holds it
    // until MMG is on again, when this pass applies it as before.
    if (mmgDisabled()) return { scanned: 0, repaired: 0, stillOpen: 0, oldestMinutes: null };
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
          const currency = await this.mmgAttemptCurrency(tx, payment);
          const financeResolution = typeof existing['financeConfirmationId'] === 'string'
            ? await tx.paymentConfirmationHold.findFirst({ where: { id: existing['financeConfirmationId'], paymentId: payment.id,
              subscriptionId: payment.subscriptionId, status: 'PROVEN_UNPAID', resolvedBy: { not: null }, resolutionEvidence: { not: null } } }) : null;
          if (financeResolution && existing['providerOutcome'] !== 'CAPTURED' && !hasMmgApprovalHold(payment)) {
            await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { failureRaw: {
              ...existing, subscriptionOutcome: PRESERVED_NO_DUNNING, recoveryDisposition: 'FINANCE_CONFIRMED_UNPAID',
            } } });
            return { kind: 'preserved' as const };
          }
          const provenUnsent = existing['providerEffect'] === 'NOT_SENT' && !payment.externalRef;
          if (!provenUnsent && !hasMmgTerminalProof(payment, currency)) {
            await this.holdUnprovenMmgInTx(tx, payment, now);
            return { kind: 'unproven' as const };
          }
          if (await this.subscriptionHasConfirmationHold(tx, sub.id, payment.id, now)) return { kind: 'unproven' as const };
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
          if (fresh.nextBillingDate.getTime() !== payment.periodStart.getTime()) {
            await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { failureRaw: {
              ...existing, subscriptionOutcome: PRESERVED_NO_DUNNING, periodOutcome: 'DIFFERENT_OBLIGATION',
            } } });
            return { kind: 'preserved' as const };
          }
          const current = { ...sub, ...fresh } as SubWithRelations;
          const outcome = await this.recordFailureInTx(tx, current, Number(payment.amount), reason, now, periodKey);
          return { kind: 'dunned' as const, current, outcome };
        });
        if (result.kind === 'unproven') {
          failedInBatch += 1;
          oldestMinutes = oldestMinutes == null ? ageMinutes : Math.max(oldestMinutes, ageMinutes);
          continue;
        }
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
  private async finishExhaustedGrace(sub: SubWithRelations, now: Date): Promise<'pending' | 'suspended' | null> {
    // [PROD-PATH] Nothing suspends anyone while no partner can pay.
    if (noLivePayPath()) return 'pending';
    const result = await this.prisma.$transaction(async (tx) => {
      const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
      const clock = await currentDunningClock(tx, sub.id, now);
      const fresh = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      if (fresh.status !== 'PAST_DUE' || fresh.failedAttempts < MAX_FAILED_ATTEMPTS || !fresh.autoSuspendEnabled) return null;
      if (clock.pausedAt || authority.bankInsteadOfAdvance || !fresh.autoRenew) return 'pending' as const;
      await tx.billingDunningClock.update({ where: { subscriptionId: sub.id }, data: { retryAtMs: BigInt(FULL_FEE_GRACE_MS) } });
      await tx.subscription.update({ where: { id: sub.id }, data: { nextRetryAt: activeDeadline(clock, FULL_FEE_GRACE_MS, now) } });
      if (activeOverdueMs(clock, now) < FULL_FEE_GRACE_MS || resumedNoEarlierThan(clock, now)) return 'pending' as const;
      await tx.subscription.update({ where: { id: sub.id }, data: { status: 'SUSPENDED', suspendedAt: now, isInGracePeriod: false } });
      await this.suspendAccessRows(tx, { ...sub, ...fresh }, fresh.nextBillingDate.toISOString().slice(0, 10), now);
      return 'suspended' as const;
    });
    if (result === 'suspended') await this.suspendAccessNotices(sub);
    return result;
  }

  private async recordFailureInTx(
    tx: Prisma.TransactionClient,
    sub: SubWithRelations,
    amount: number,
    reason: string,
    now: Date,
    periodKey: string,
  ): Promise<FailureOutcome> {
    await requireBillingEffectsReady(tx);
    // [PROD-PATH] The one place a failure is recorded, dunned or suspended:
    // never while no partner has a live way to pay. Every caller is already
    // walled; this refusal rolls back whatever transaction reached it.
    if (noLivePayPath()) throw new AppError(409, 'FEE_PAUSED', 'No way to pay the weekly fee is live: the fee is paused, never failed.');
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
    const scheduled = await scheduleDunningFailure(tx, sub.id, now);
    const attempts = sub.failedAttempts + 1;
    const willSuspend = attempts >= MAX_FAILED_ATTEMPTS && sub.autoSuspendEnabled && scheduled.maySuspend;
    const gracePeriodEnd = activeDeadline(scheduled.clock, FULL_FEE_GRACE_MS, now)!;
    const nextRetryAt = attempts >= MAX_FAILED_ATTEMPTS && !willSuspend && sub.autoSuspendEnabled
      ? gracePeriodEnd : activeDeadline(scheduled.clock, scheduled.clock.retryAtMs!, now)!;
    if (attempts >= MAX_FAILED_ATTEMPTS && !willSuspend && sub.autoSuspendEnabled) {
      await tx.billingDunningClock.update({ where: { subscriptionId: sub.id }, data: { retryAtMs: BigInt(FULL_FEE_GRACE_MS) } });
    }
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status: (willSuspend ? 'SUSPENDED' : 'PAST_DUE') as SubscriptionStatus,
        failedAttempts: attempts,
        nextRetryAt,
        isInGracePeriod: !willSuspend,
        gracePeriodEnd,
        ...(willSuspend ? { suspendedAt: now } : {}),
      },
    });
    if (willSuspend) await this.suspendAccessRows(tx, sub, periodKey, now);
    else {
      const final = attempts === MAX_FAILED_ATTEMPTS - 1 && sub.autoSuspendEnabled;
      const payLine = await this.feePayLine(sub, null);
      // [§11] The final warning names the moment: the shared 48-hour grace
      // deadline, when every gate stops this partner unless the fee is paid. A
      // payment that starts confirming before then only moves it later.
      const when = suspensionMoment(gracePeriodEnd);
      await enqueueFeeDemandInTx(tx, {
        userId: this.payerUserId(sub), type: 'SYSTEM_ANNOUNCEMENT', audience: this.payerAudience(sub),
        title: final ? 'Final warning — payment needed' : 'Subscription payment failed',
        body: final ? `${reason}. Your subscription will be SUSPENDED at ${when} unless the weekly fee is paid. ${payLine}`
          : `${reason}. We will retry after the remaining retry interval. ${payLine}`,
        data: { kind: final ? 'billing_final_warning' : 'billing_failed', subscriptionId: sub.id, ...(final ? { suspendsAt: gracePeriodEnd.toISOString() } : {}) },
        feeStageKey: `${final ? 'final-warning' : 'failed'}:a${attempts}`,
        ...(final ? { feeSms: `Swift: your weekly fee is unpaid. Your account will be suspended at ${when} unless you pay. ${payLine}` } : {}),
      });
    }
    return { attempts, willSuspend, nextRetryAt, suspendsAt: gracePeriodEnd, finalWarning: attempts === MAX_FAILED_ATTEMPTS - 1 && sub.autoSuspendEnabled };
  }

  /** [M-04] Post-commit notices for a failure outcome — best effort, never
   *  part of the transaction. (An outbox for these is the registered
   *  follow-up; today a lost notice is a lost notice, not a lost state.) */
  private async afterFailureNotices(sub: SubWithRelations, outcome: FailureOutcome, reason: string): Promise<void> {
    if (outcome.willSuspend) {
      await this.suspendAccessNotices(sub);
      return;
    }
    const { attempts, suspendsAt, finalWarning } = outcome;
    const payLine = await this.feePayLine(sub, null);
    if (finalWarning) {
      // The committed notice of this stage (recordFailureInTx) is what is
      // delivered: the same stage key finds it, so this repeats its words.
      const when = suspensionMoment(suspendsAt);
      await this.notifications.send({
        userId: this.payerUserId(sub),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Final warning — payment needed',
        body: `${reason}. Your subscription will be SUSPENDED at ${when} unless the weekly fee is paid. ${payLine}`,
        audience: this.payerAudience(sub),
        data: { kind: 'billing_final_warning', subscriptionId: sub.id, suspendsAt: suspendsAt.toISOString() },
        feeStageKey: `final-warning:a${attempts}`,
        feeSms: `Swift: your weekly fee is unpaid. Your account will be suspended at ${when} unless you pay. ${payLine}`,
      }).catch(() => {});
      await notifyAdmins(this.prisma, this.notifications, {
        tenantId: await tenantOfUser(this.prisma, sub.rider?.userId ?? sub.driver?.userId ?? sub.vendor?.owner.userId ?? null),
        title: 'Dunning — final warning issued',
        body: `Subscription ${sub.id} suspends at ${when} (attempt ${attempts}/${MAX_FAILED_ATTEMPTS}) unless paid; a payment that starts confirming first moves it later. Check its current payment status before contacting the payer.`,
        data: { kind: 'billing_dunning_ops_task', subscriptionId: sub.id, suspendsAt: suspendsAt.toISOString() },
      }).catch(() => {});
      return;
    }
    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Subscription payment failed',
      body: `${reason}. We will retry tomorrow (attempt ${attempts} of ${MAX_FAILED_ATTEMPTS}). ${payLine}`,
      audience: this.payerAudience(sub),
      data: { kind: 'billing_failed', subscriptionId: sub.id },
      feeStageKey: `failed:a${attempts}`,
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
      mmgLookup?: MmgLookupObservation;
      mmgInitiateFailure?: MmgTransaction;
    },
    reason: string,
    now: Date,
    periodKey: string,
  ): Promise<'failed' | 'suspended' | 'skipped' | null> {
    const result = await this.prisma.$transaction(async (tx) => {
      // All rails preserve current lifecycle authority; a card decline must
      // not overwrite cancellation merely because it is not an MMG result.
      const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
      await currentDunningClock(tx, sub.id, now);
      await tx.$queryRaw`SELECT "id" FROM "subscription_payments" WHERE "id" = ${payment.id} FOR UPDATE`;
      const currentPayment = await tx.subscriptionPayment.findUnique({ where: { id: payment.id } });
      if (!currentPayment || currentPayment.subscriptionId !== sub.id) return null;
      const existingRaw = currentPayment.failureRaw && typeof currentPayment.failureRaw === 'object' && !Array.isArray(currentPayment.failureRaw)
        ? currentPayment.failureRaw : {};
      // Dispatch and local expiry share the exact authority/payment locks. An
      // expiry winner prevents dispatch; a dispatch winner remains pollable
      // until the provider confirms a terminal outcome. A clock or empty
      // lookup cannot prove an outstanding request will never capture.
      if (currentPayment.paidAt || existingRaw['providerOutcome'] === 'CAPTURED'
        || (terminal.providerAbsenceOnly && (existingRaw['providerEffect'] !== 'NOT_SENT' || currentPayment.externalRef))) return null;
      let negativeProof: Prisma.InputJsonObject | undefined;
      if (currentPayment.paymentMethod === 'MOBILE_MONEY' && !terminal.providerAbsenceOnly) {
        if (!terminal.from.includes(currentPayment.status as 'UNKNOWN' | 'PENDING') || hasMmgApprovalHold(currentPayment)) return null;
        const currency = await this.mmgAttemptCurrency(tx, currentPayment);
        if (terminal.mmgLookup && !matchesLookupGeneration(currentPayment, terminal.mmgLookup)) return null;
        if (terminal.mmgLookup && matchesLookupGeneration(currentPayment, terminal.mmgLookup)
          && mmgNegativeMatches(currentPayment, currency, terminal.mmgLookup.evidence)) {
          negativeProof = mmgTerminalProof(currentPayment, currency!, terminal.mmgLookup.evidence, 'LOOKUP', terminal.mmgLookup.generation, now);
        } else if (terminal.mmgInitiateFailure && !currentPayment.externalRef
          && existingRaw['providerEffect'] === 'AUTHORIZED' && typeof existingRaw['authorizedAt'] === 'string'
          && isMmgTerminalStatus(terminal.mmgInitiateFailure.status)
          && terminal.mmgInitiateFailure.reference === currentPayment.clientKey
          && terminal.mmgInitiateFailure.amountMinor === Math.round(Number(currentPayment.amount) * 100)
          && terminal.mmgInitiateFailure.currencyCode === currency) {
          negativeProof = mmgTerminalProof(currentPayment, currency!, terminal.mmgInitiateFailure, 'INITIATE', existingRaw['authorizedAt'], now);
        } else {
          await this.holdUnprovenMmgInTx(tx, currentPayment, now);
          return null;
        }
      }
      const baseFailureRaw = {
        ...existingRaw,
        ...(negativeProof ? { mmgTerminalEvidence: negativeProof } : {}),
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
      await resolvePaymentConfirmationInTx(tx, sub.id, payment.id, terminal.providerAbsenceOnly ? 'PROVEN_NO_EFFECT' : 'PROVEN_UNPAID', { actor: 'provider-confirmation', reference: terminal.failureCode }, now);
      const anotherConfirmation = await this.subscriptionHasConfirmationHold(tx, sub.id, undefined, now);
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
        if (authority.bankInsteadOfAdvance || terminalForDunning || covered || terminal.preserveWithoutDunning || anotherConfirmation
          || fresh.nextBillingDate.getTime() !== currentPayment.periodStart.getTime()) {
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
    /** The failure level the caller's record describes; when the locked row is
     *  no longer at it, that outcome already landed and nothing is applied. */
    expectedFailedAttempts?: number,
  ): Promise<'failed' | 'suspended' | 'skipped'> {
    const result = await this.prisma.$transaction(async (tx) => {
      const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
      if (await this.subscriptionHasConfirmationHold(tx, sub.id, undefined, now)) return null;
      const covered = await tx.billingEvent.findUnique({ where: { idempotencyKey: `success:${sub.id}:${periodKey}` }, select: { id: true } });
      if (authority.bankInsteadOfAdvance || covered || !['ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(authority.status)) return null;
      const fresh = await tx.subscription.findUnique({ where: { id: sub.id } });
      if (!fresh) throw new Error(`Locked subscription ${sub.id} disappeared during failure reconciliation`);
      if (expectedFailedAttempts !== undefined && fresh.failedAttempts !== expectedFailedAttempts) return null;
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
  private async suspendAccessRows(tx: Prisma.TransactionClient, sub: SubWithRelations, periodKey: string, now: Date) {
    await requireBillingEffectsReady(tx);
    const clock = await currentDunningClock(tx, sub.id, now);
    const elapsed = activeOverdueMs(clock, now);
    if (clock.pausedAt || elapsed < FULL_FEE_GRACE_MS || resumedNoEarlierThan(clock, now)) {
      throw new AppError(409, 'BILLING_GRACE_ACTIVE', 'Weekly-fee grace is still active.');
    }
    await tx.billingDunningClock.update({ where: { subscriptionId: sub.id }, data: {
      nudgeAtMs: BigInt(elapsed + FEE_RETRY_MS), churnAtMs: BigInt(elapsed + suspensionRetentionMs()),
    } });
    if (sub.vendor) {
      // SUSPENDED vendors vanish from customer browse (which filters ACTIVE).
      // Billing suspends only an open store, or re-stamps its own suspension.
      // A store already suspended for another reason (an admin, safety,
      // wind-down, or none recorded), awaiting approval, or closed keeps its
      // state, so a later fee payment cannot open it (restoreBillingAccess
      // lifts BILLING suspensions only).
      await tx.vendor.updateMany({
        where: { id: sub.vendor.id, OR: [{ status: 'ACTIVE' }, { status: 'SUSPENDED', suspensionSource: 'BILLING' }] },
        data: { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING' },
      });
    }
    const moverUserId = sub.rider?.userId ?? sub.driver?.userId;
    if (moverUserId) {
      await tx.rider.updateMany({ where: { userId: moverUserId }, data: { isOnline: false, isAvailable: false } });
      await tx.driver.updateMany({ where: { userId: moverUserId }, data: { isOnline: false, isAvailable: false } });
    }

    const payLine = await this.feePayLine(sub, null);
    await enqueueFeeDemandInTx(tx, {
      userId: this.payerUserId(sub), type: 'SYSTEM_ANNOUNCEMENT', audience: this.payerAudience(sub),
      title: 'Subscription suspended', body: `Your subscription is unpaid and your access is suspended. ${payLine} ${FEE_RESTORE_LINE}`,
      data: { kind: 'billing_suspended', subscriptionId: sub.id }, feeStageKey: 'suspended',
      feeSms: `Swift: your account is suspended for non-payment. ${payLine} ${FEE_RESTORE_LINE}`,
    });
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

  /** Post-commit suspension side effects (push + SMS). The paying sentence
   *  is fee-notice-copy.ts: the MMG checkout only while it is live, otherwise
   *  the amount and when it is due. */
  private async suspendAccessNotices(sub: SubWithRelations) {
    const payLine = await this.feePayLine(sub, null);
    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Subscription suspended',
      body: `Your subscription is unpaid and your access is suspended. ${payLine} ${FEE_RESTORE_LINE}`,
      audience: this.payerAudience(sub),
      data: { kind: 'billing_suspended', subscriptionId: sub.id },
      feeStageKey: 'suspended',
      feeSms: `Swift: your account is suspended for non-payment. ${payLine} ${FEE_RESTORE_LINE}`,
    });
  }

  private async reinstateRows(tx: Prisma.TransactionClient, sub: SubWithRelations, periodKey: string) {
    // [REPORT-013 F-013-07] Payment restores ONLY what billing took: the one
    // shared restore (billing-access.ts), also used by the wrongful-suspension heal.
    if (sub.vendor) await restoreBillingAccess(tx, sub.vendor.id);

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

  /** Retry committed notice intents independently of the current subscription
   * state. In particular, CHURNED no longer hides an undelivered final notice. */
  async drainPendingNotices(now = new Date()): Promise<{ attempted: number; delivered: number }> {
    const historical = await drainPendingBillingNotices(this.prisma, this.notifications, now);
    const current = await this.notifications.drainFeeDemands();
    return { attempted: historical.attempted + current.attempted, delivered: historical.delivered + current.delivered };
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
        // The paying sentences for the notices below, read before the
        // transaction: the committed note is the audit record of the decision.
        const payLine = await this.feePayLine(candidate, null);
        const mmgLine = await this.mmgLineIfOwed(candidate);
        // The selection is only a candidate. MMG hold creation takes these
        // same payer -> subscription locks, so a hold committed first must be
        // visible before either the churn CAS or daily nudge event is written.
        const decision = await this.prisma.$transaction(async (tx) => {
          const authority = await this.lockSubscriptionMoneyAuthority(tx, candidate as SubWithRelations);
          if (!authority.collectionAllowed || authority.status !== 'SUSPENDED') return null;
          const sub = await tx.subscription.findUnique({
            where: { id: candidate.id },
            include: {
              rider: { select: { userId: true } },
              driver: { select: { userId: true } },
              vendor: { select: { id: true, owner: { select: { userId: true } } } },
            },
          });
          if (!sub || sub.status !== 'SUSPENDED' || await this.subscriptionHasConfirmationHold(tx, sub.id, undefined, now)) return null;
          // [PROD-PATH] No live way to pay: nobody is nudged to pay or
          // churned for not paying; their dunning clock is paused for the
          // span (mmg-pause.ts).
          if (await feePauseHoldsBilling(tx, sub.id)) return null;
          const suspendedSince = sub.suspendedAt ?? sub.updatedAt;
          const clock = await currentDunningClock(tx, sub.id, now);
          const elapsed = activeOverdueMs(clock, now);
          if (clock.churnAtMs !== null && elapsed >= Number(clock.churnAtMs)) {
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
              sms: `Swift: your subscription was closed after 30 days unpaid. You can rejoin anytime. ${payLine} ${FEE_RESTORE_LINE}`,
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
          if (clock.nudgeAtMs !== null && elapsed < Number(clock.nudgeAtMs)) return null;
          const stage = clock.nudgeAtMs ?? BigInt(elapsed);
          const noticeKey = `nudge:${sub.id}:${clock.epoch}:${stage}`;
          // Missed wall-clock days are never replayed as a burst after a pause.
          await tx.billingDunningClock.update({ where: { subscriptionId: sub.id }, data: { nudgeAtMs: BigInt(elapsed + FEE_RETRY_MS) } });
          // [AX349] What is owed is what the fee screen says is due, from the
          // same helper: a request already issued at 8,000 is owed at 8,000
          // after the rate moves to 6,000. The weekly fee is not named here.
          // [owner rule 2026-09-29] The MMG checkout sentence only while it is
          // live; never an agent, cash or a Swift Number.
          const owed = await amountDueNow(tx, sub);
          const nudgeLines = [`You owe $${owed.toLocaleString()} ${sub.currencyCode}.`, mmgLine, FEE_RESTORE_LINE].filter(Boolean).join(' ');
          const notice: BillingNotice = {
            noticeVersion: 1, target: 'payer', userId: this.payerUserId(sub), audience: this.payerAudience(sub),
            title: 'Suspended — pay to restore access',
            body: nudgeLines,
            sms: `Swift: your account is still suspended. ${nudgeLines}`,
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
          await deliverBillingNoticeByKey(this.prisma, this.notifications, decision.noticeKey, now);
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
      /** Trusted checkout ownership, checked against the payer in the credit transaction. */
      expectedTenantId?: string;
      /** The rail the money came by, when the caller names it (MMG_CHECKOUT). */
      channel?: string;
    },
  ) {
    if (input.amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Top-up must be positive');
    await lockSubscriptionPayer(tx, input.subscriptionId);
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
      expectedTenantId: input.expectedTenantId,
      note: input.reference
        ? `ref: ${input.reference} (by ${input.recordedBy})`
        : `recorded by ${input.recordedBy}`,
      channel: input.channel ?? (input.recordedBy.startsWith('agent-cash:')
        ? input.recordedBy.slice('agent-cash:'.length)
        : 'ADMIN_TOPUP'),
      mmgRef: input.reference,
    });
  }

  /** Finish an already credited checkout using wallet funds only. Its pause
   * stays durable until the paid period or bank-only disposition commits. */
  async recoverConfirmationSettlements(subscriptionId?: string, now = new Date()): Promise<number> {
    const pending = await this.prisma.paymentConfirmationHold.findMany({ where: {
      ...(subscriptionId ? { subscriptionId } : {}), status: 'SETTLEMENT_APPLY_PENDING', checkoutId: { not: null },
    }, orderBy: { beganAt: 'asc' }, take: 100 });
    const usd = await this.loadUsdPricing();
    let recovered = 0;
    for (const candidate of pending) {
      // One subscription's failure never kills the batch (or the billing cycle
      // that runs this first): its credit stays recorded and protected by its
      // SETTLEMENT_APPLY_PENDING hold, and the next pass retries it whole.
      let done = false;
      try {
      done = await this.prisma.$transaction(async (tx) => {
        const clock = await currentDunningClock(tx, candidate.subscriptionId, now);
        const hold = await tx.paymentConfirmationHold.findUnique({ where: { id: candidate.id } });
        if (hold?.status !== 'SETTLEMENT_APPLY_PENDING' || !hold.checkoutId) return false;
        const checkout = await tx.mmgCheckoutIntent.findUnique({ where: { id: hold.checkoutId } });
        if (!checkout || checkout.status !== 'CONFIRMED' || !checkout.providerPaymentId) return false;
        const proof = await verifiedCheckoutCredit(tx, checkout);
        if (!proof) return false;
        const identity = proof.identity;
        const sub = await tx.subscription.findUniqueOrThrow({ where: { id: hold.subscriptionId }, include: {
          rider: { select: { userId: true } }, driver: { select: { userId: true } },
          vendor: { select: { id: true, owner: { select: { userId: true } } } },
        } });
        const authority = await this.lockPaymentOutcomeAuthority(tx, sub);
        const evidence = { actor: 'checkout-settlement', reference: identity.id };
        if (!await billingEffectsReady(tx)) return false; // Credit is recorded; preserve application protection through cutover.
        if (clock.epoch > hold.sourceEpoch || authority.bankInsteadOfAdvance || sub.nextBillingDate > now) {
          await resolveConfirmationInTx(tx, sub.id, { checkoutId: checkout.id }, 'PAID', evidence, now);
          return true;
        }
        if (await hasConfirmationInTx(tx, sub.id, now, { checkoutId: checkout.id })) return false;
        const priced = await this.priceEligibleFor(sub, usd);
        const amount = sub.feeWaived ? 0 : Number(priced.amount);
        const balance = await tx.prepaidBalance.findUnique({ where: { subscriptionId: sub.id } });
        if (amount > 0 && (!balance || balance.currencyCode !== sub.currencyCode || Number(balance.balance) < amount)) return false;
        await resolveConfirmationInTx(tx, sub.id, { checkoutId: checkout.id }, 'PAID', evidence, now);
        const result = await this.applySuccessfulChargeInTx(tx, sub, amount, amount > 0 ? 'prepaid' : 'fee-waived', now,
          sub.nextBillingDate.toISOString().slice(0, 10), undefined, priced.usdTrio, amount);
        if (result !== 'advanced') throw new Error('Verified checkout balance was not applied');
        return true;
      });
      } catch (err) {
        log().error({ err, confirmationId: candidate.id, subscriptionId: candidate.subscriptionId },
          '[billing] a verified checkout settlement could not be applied yet; its hold stays and it is retried');
      }
      if (done) recovered += 1;
    }
    return recovered;
  }

  /** Post-commit effects for a durable top-up. A caller may safely retry this
   * method: it moves no money; the billing engine's own event keys make an
   * immediate re-bill idempotent. */
  async afterTopUpCommitted(subscriptionId: string, amount: number, opts: { notify?: boolean } = {}): Promise<void> {
    await this.recoverConfirmationSettlements(subscriptionId);
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
    });
    if (!sub) throw new NotFoundError('Subscription', subscriptionId);

    // A caller that tells the payer itself (the MMG checkout's own notice)
    // passes notify:false, so one payment is one notice.
    if (opts.notify !== false) {
      await this.notifications.send({
        userId: this.payerUserId(sub as SubWithRelations),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Top-up received',
        body: `$${amount.toLocaleString()} ${sub.currencyCode} added to your subscription balance.`,
        audience: this.payerAudience(sub),
        data: { kind: 'billing_topup', subscriptionId },
      });
    }

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
        // [I3] The reference IS the transfer. The same transaction credited by
        // another channel (agent cash, an MMG checkout) must not be credited
        // here again, so the command claims the one provider identity first.
        const payee = await tx.subscription.findUnique({ where: { id: input.subscriptionId }, select: { currencyCode: true } });
        if (!payee) throw new NotFoundError('Subscription', input.subscriptionId);
        await claimProviderPaymentInTx(tx, {
          provider: 'MMG',
          providerTxnId: input.reference,
          amount: input.amount,
          currencyCode: payee.currencyCode,
          subscriptionId: input.subscriptionId,
          // [F7] Filed under the payer's tenant, whoever runs the command.
          tenantId: await subscriptionTenantInTx(tx, input.subscriptionId),
          creditedBy: `topup:${input.adminId}:${input.idempotencyKey}`,
        });
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
      // [I3] The same answer whether an earlier top-up or another channel
      // (agent cash, an MMG checkout) already credited this transfer.
      if (isDuplicateOn(error, 'providerRef')
        || (error instanceof ProviderIdentityError && error.identityCode === 'PROVIDER_TXN_ALREADY_CREDITED')) {
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
    // [PROD-PATH] No live way to pay: the fee is paused, so "due soon" would
    // name a fee nobody can pay. Nothing is written, so the reminder still
    // goes out if a way to pay comes back before the due date.
    if (await feePauseSpanOpen(this.prisma)) return 0;
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
        const allowed = await this.prisma.$transaction(async (tx) => {
          if (!(await lockFeeCollectionAuthority(tx, sub.id)).allowed) return false;
          if (await feePauseHoldsBilling(tx, sub.id)) return false;
          await tx.billingEvent.create({
          data: {
            subscriptionId: sub.id,
            type: 'REMINDER',
            amount: this.amountFor(sub),
            currencyCode: sub.currencyCode,
            idempotencyKey: `reminder:${sub.id}:${periodKey}`,
          },
          });
          return true;
        });
        if (!allowed) continue;
      } catch (error) {
        if ((error as Prisma.PrismaClientKnownRequestError).code !== 'P2002') throw error; // existing stage may still need delivery
      }

      const mmgLine = await this.mmgLineIfOwed(sub);
      await this.notifications.send({
        userId: payerUserId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Subscription due soon',
        body: `Your weekly fee of $${Number(this.amountFor(sub)).toLocaleString()} ${sub.currencyCode} is due on ${sub.nextBillingDate.toISOString().slice(0, 10)}.${mmgLine ? ` ${mmgLine}` : ''}`,
        audience: this.payerAudience(sub),
        data: { kind: 'billing_reminder', subscriptionId: sub.id },
        feeStageKey: `upcoming:${periodKey}`,
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
      where: { OR: [{ riderId: { not: null } }, { driverId: { not: null } }], status: { in: RETIER_STATUSES } },
      select: { id: true },
    });
    let changed = 0;
    for (const candidate of moverSubs) {
      try {
        const moved = await this.prisma.$transaction(async (tx) => {
          const payer = await lockSubscriptionPayer(tx, candidate.id);
          const authority = await lockMoverFeeAuthority(tx, payer);
          if (!authority || authority.canonicalSubscriptionId !== candidate.id) return false;
          const sub = await tx.subscription.findUniqueOrThrow({ where: { id: candidate.id } });
          if (!RETIER_STATUSES.includes(sub.status) || sub.customRate !== null || sub.feeWaived) return false;
          const tariff = await moverFeeTariffSubject(tx, authority);
          const tiers = await this.countryConfig.getSubscriptionTiers(tariff.countryCode, tx);
          const target = this.retierTarget(sub.id, tiers, tariff.subject);
          if (!target || sub.weeklyRate.equals(target.rate)) return false;
          return this.applyTierChange(sub, target, `${tariff.subject.kind === 'DRIVER' ? 'taxi driver' : 'rider'} on ${tariff.subject.vehicleType} -> ${target.tier} tier`, tx);
        });
        if (moved) changed += 1;
      } catch (error) { this.holdTierChange(candidate.id, error); }
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
    transaction?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const from = Number(sub.weeklyRate);
    const apply = async (tx: Prisma.TransactionClient) => {
      await lockSubscriptionPayer(tx, sub.id);
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
    };
    return transaction ? apply(transaction) : this.prisma.$transaction(apply);
  }

  /**
   * Weekly tier check: vendor tier comes from catalogue size (active listing
   * count) and CountryConfig rates — NEVER from sales (zero-commission model).
   */
  async recalculateVendorTiers(): Promise<number> {
    const vendorSubs = await this.prisma.subscription.findMany({
      where: { vendorId: { not: null }, status: { in: RETIER_STATUSES } },
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

  /** [owner rule 2026-09-29 · DS287 S3] The paying sentence of every fee
   *  notice (fee-notice-copy.ts): the MMG checkout while it is live for the
   *  partner on every platform, for exactly what it would charge; otherwise
   *  the amount and when it is due. Never an agent, cash, a Swift Number or an
   *  account number. A failed read falls back to the due line: a notice never
   *  promises a way to pay it could not check. */
  private async feePayLine(sub: Subscription, due: Date | null): Promise<string> {
    try {
      const fee = await payInfo(this.prisma, sub);
      if (await mmgCheckoutLive(this.prisma, sub, 'unknown')) return mmgPayLine(checkoutAmountGyd(fee));
      return feeDueLine(fee.amountDueGyd > 0 ? fee.amountDueGyd : fee.weeklyFeeGyd, sub.currencyCode, due);
    } catch (err) {
      log().warn({ err, subscriptionId: sub.id }, 'fee notice: the paying sentence fell back to the due line');
      return feeDueLine(weeklyFeeAmount(sub), sub.currencyCode, due);
    }
  }

  /** The MMG sentence alone, only while the checkout is live and something is
   *  owed; '' otherwise (a wallet that already covers the fee is not a reason
   *  to pay again). */
  private async mmgLineIfOwed(sub: Subscription): Promise<string> {
    try {
      const fee = await payInfo(this.prisma, sub);
      if (!(fee.amountDueGyd > 0) || !(await mmgCheckoutLive(this.prisma, sub, 'unknown'))) return '';
      return mmgPayLine(checkoutAmountGyd(fee));
    } catch (err) {
      log().warn({ err, subscriptionId: sub.id }, 'fee reminder: sent without the MMG sentence');
      return '';
    }
  }
}
