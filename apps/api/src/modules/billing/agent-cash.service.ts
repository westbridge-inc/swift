import { lockSubscriptionPayer } from '../subscription/mover-fee-authority';
import type { OnAudit } from '../../lib/audit-writer';
import { Prisma, type MmgAgentPayment, type ProviderPayment, type PrismaClient } from '@prisma/client';
import type { BillingService } from './billing.service';
import { resolveSan, subscriptionOwnerTenant } from './san.service';
import { validateSanShape } from './san';
import { captureMmgPayer } from '../integrity/capture-hooks';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';
import { agentCashDuplicateCreditsCounter, agentCashDuplicateCreditsGauge, agentCashProviderIdConflictsCounter, agentCashStrandedGauge } from '../../plugins/observability';
import { bindTenantTransaction } from '../../plugins/prisma';
import { getTenantId, runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import { log } from '../../utils/logger';
import { weeklyFeeAmount } from './subscription-fee';
import { amountDueNow } from './amount-due';

// Agent-cash ingestion [san spec PART 4] — three channels, ONE pipeline:
//   persist raw → idempotency → sanity → cross-channel dedupe → resolve SAN
//   → credit (recordTopUp = the existing conversion+reactivation machinery)
//   → identity-graph feed.
// SO-6 governs everything here: resolution failures RECORD the money as
// UNMATCHED with an honest diagnosis; the only rejects are genuinely
// malformed non-money (zero/negative amounts).

export const AGENT_CASH_LIMITS = {
  minPaymentGyd: 500,
  maxSinglePaymentGyd: 500_000,
};

// [MMG-RECV] STRANDED RECEIVED. An observation is saved RECEIVED first and
// judged after. When the delivery that saved it dies in between (a restart, a
// dropped connection, a credit that threw), it stays RECEIVED; every
// redelivery used to answer `duplicate` (the webhook tells MMG to stop, and a
// re-keyed receipt reads as done), and nothing looked at RECEIVED again: money
// on disk, never credited. Now:
//   1. a redelivery of an observation stranded RECEIVED finishes it, through
//      the same steps 2 to 5; one still inside its first delivery is left to it;
//   2. the repair pass of poll-mmg-billing finishes the rest, each in its own
//      tenant, and writes a system audit row with the credit;
//   3. FENCED: every verdict is a compare-and-set on RECEIVED (the credit
//      transaction claims the row first; suspense and reconciliation are
//      conditional), so of two finishers one decides and the other writes
//      nothing and is answered `duplicate`;
//   4. the DATABASE clock only: the age that makes an observation stranded is
//      stamped by the INSERT itself (the createdAt default), and a failed
//      attempt is stamped inside its own guarded statement;
//   5. FAIR: never tried first, then the least recently tried; one whose
//      attempt just failed waits out a backoff, and one that keeps failing
//      goes to the suspense queue for a person after the give-up age.
// A settlement-file row is not finished here: its own import resumes it,
// under the publication hold [G5-F6].

/** [MMG-RECV] Still RECEIVED this long after it was saved (database clock),
 *  an observation is stranded. Far above any live delivery, whose credit
 *  transaction times out within seconds. */
export const STRANDED_AFTER_MS = 2 * 60_000;
/** A stranded observation whose finish just failed is left alone this long. */
export const STRANDED_RETRY_BACKOFF_MS = 5 * 60_000;
/** Stranded this long, one that fails again goes to the suspense queue
 *  (UNMATCHED, UNFINISHED) for a person, and the operators are paged. */
export const STRANDED_GIVE_UP_AFTER_MS = 60 * 60_000;
const FINISHABLE_CHANNELS: readonly string[] = ['MMG_AGENT_WEBHOOK', 'MANUAL_ADMIN'];

/** [MMG-RECV] The database clock, for READS only (which observations look
 *  stranded): a sampled time can only make one look younger, never older.
 *  Every lease WRITE reads the clock inside its own statement. */
async function databaseNow(db: Pick<PrismaClient, '$queryRaw'>): Promise<Date> {
  const [row] = await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
  return row!.now;
}
/** The database clock as the UTC wall time the timestamp(3) columns hold. */
const DB_NOW = Prisma.sql`timezone('UTC'::text, clock_timestamp())`;
/** A verdict another finisher already wrote: this finisher lost the race. */
const LOST_RACE = new Set(['NOT_RECEIVED', 'PAYMENT_NOT_RECEIVED']);

/** [MMG-RECV · ADM-002] The repair pass is the actor when it credits a
 *  stranded observation: a system audit row (no user) joins the credit
 *  transaction and names the payment and, for a manual entry, the admin who
 *  keyed it (that admin's own audit row rolled back with the credit that
 *  failed). */
function strandedFinishAudit(p: { channel: string; raw: unknown }): OnAudit {
  const enteredBy = (p.raw as { enteredBy?: unknown } | null)?.enteredBy;
  return async (tx, facts) => {
    await tx.auditLog.create({
      data: {
        userId: null,
        action: 'AGENT_PAYMENT_STRANDED_FINISHED',
        entity: 'MmgAgentPayment',
        entityId: String(facts['paymentId']),
        changes: { ...facts, channel: p.channel, finishedBy: 'poll-mmg-billing', ...(typeof enteredBy === 'string' ? { enteredBy } : {}) },
      },
    });
  };
}

export interface InboundFeePayment {
  externalId: string;
  channel: 'MMG_AGENT_WEBHOOK' | 'MMG_SETTLEMENT_FILE' | 'MANUAL_ADMIN';
  sanRaw: string;
  amount: number; // GYD major units, exact (validated > 0 at the adapter)
  currencyCode: string;
  paidAt: Date;
  mmgTxnId?: string;
  agentRef?: string;
  payerMsisdn?: string;
  raw: unknown;
  recordedBy?: string; // MANUAL_ADMIN: the admin user id
}

export type IngestResult =
  | { status: 'accepted'; paymentId: string; subscriptionId: string }
  | { status: 'duplicate'; paymentId: string }
  | { status: 'reconciled'; paymentId: string; originalPaymentId: string }
  | { status: 'received_unmatched'; paymentId: string; failureCode: string };

/** Preserve the provider's raw spelling. Only mmg_txn_canon in PostgreSQL
 *  decides transaction equivalence; JavaScript case folding differs. */
export function providerTxnRaw(p: { mmgTxnId?: string | null; externalId: string; channel: string }): string {
  return p.mmgTxnId ?? (p.channel === 'MANUAL_ADMIN' ? p.externalId.replace(/^MANUAL:/, '') : p.externalId);
}
export const PROVIDER = 'MMG';

/** Channel-honest activation copy [spec 4.5 / SO-7]: the screen must state
 *  the LIVE channel's real latency — never "instant" in manual mode. */
const ACTIVATION_COPY: Record<string, string> = {
  MANUAL: 'Service resumes within 1 business day of paying.',
  SETTLEMENT_DAILY: 'Service resumes by the next morning after paying.',
  WEBHOOK: 'Service resumes within minutes of paying.',
};

/** The Pay-screen data block [spec 6.1] — spread into the partner's
 *  GET /subscription next to sanDisplay. One amount-due source of truth:
 *  amountDueNow (amount-due.ts), the same helper every notice that states an
 *  amount owed uses — the charge already issued for the week owed, at its own
 *  amount (AX332 F2: an 8,000 request still pending when the rate moved to
 *  6,000 is settled at 8,000, so that is what is due); with none outstanding,
 *  next week's fee minus the parked wallet balance, floored at 0 [3.4]. The
 *  weekly fee (weeklyFeeGyd) is the rate in force, reported beside it, never
 *  in its place.
 *  usdDisplay [usd spec Part 6, System 2 ③]: the dual-currency line — NULL
 *  until the founder enables usdPricingEnabled + displayDual for the tenant,
 *  so it ships dark and every consumer already handles absence. */
export async function payInfo(
  prisma: PrismaClient,
  sub: { id: string; type?: string; weeklyRate: unknown; customRate?: unknown | null; nextBillingDate: Date },
): Promise<{
  walletBalanceGyd: number; weeklyFeeGyd: number; amountDueGyd: number;
  activationCopy: string;
  usdDisplay: { amountUsd: number; rateUsed: number; line: string } | null;
}> {
  const [balanceRow, modeRow, amountDue] = await Promise.all([
    prisma.prepaidBalance.findUnique({ where: { subscriptionId: sub.id } }),
    prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_agent.ingestion_mode' } }),
    amountDueNow(prisma, sub),
  ]);
  const weekly = weeklyFeeAmount(sub);
  const balance = Number(balanceRow?.balance ?? 0);
  const mode = (modeRow?.value as string | null) ?? 'MANUAL';

  // Dual-display: USD is truth, local settles [System 2]. Grandfathered subs
  // (customRate = Mode B freeze) keep a single-currency line — their price is
  // deliberately NOT the USD book until sunset.
  let usdDisplay: { amountUsd: number; rateUsed: number; line: string } | null = null;
  if (sub.type && sub.customRate == null) {
    const tenant = await prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' } });
    if (tenant?.usdPricingEnabled && tenant.displayDual) {
      const { resolveRateForRun, dualDisplay } = await import('./fx');
      const role = { RESTAURANT: 'VENDOR', SUPERMARKET: 'VENDOR', RETAIL_STORE: 'VENDOR', SERVICE_PROVIDER: 'SERVICE', DELIVERY_RIDER: 'RIDER', COURIER_RIDER: 'RIDER', TAXI_DRIVER: 'DRIVER' }[sub.type] ?? 'VENDOR';
      const [entry, rate] = await Promise.all([
        prisma.priceBookEntry.findFirst({ where: { role, active: true }, orderBy: { effectiveFrom: 'desc' } }),
        resolveRateForRun(prisma, tenant.settlementCurrency),
      ]);
      if (entry && rate) {
        const amountUsd = Number(entry.amountUsd);
        usdDisplay = {
          amountUsd,
          rateUsed: Number(rate.rate),
          line: dualDisplay(amountUsd, weekly, tenant.settlementCurrency),
        };
      }
    }
  }

  return {
    walletBalanceGyd: balance,
    weeklyFeeGyd: weekly,
    amountDueGyd: amountDue,
    activationCopy: ACTIVATION_COPY[mode] ?? ACTIVATION_COPY['MANUAL']!,
    // No agent or cash steps (the owner, 29 Sep): partners pay the weekly fee
    // on the checkout page, with MMG. A build from before that page renders
    // any steps served here, so none are.
    usdDisplay,
  };
}

export class AgentCashService {
  constructor(
    private prisma: PrismaClient,
    private billing: BillingService,
    /** [M-18] Optional: with it, duplicate-credit attempts and provider-id
     *  conflicts page the operators as well as counting and logging. */
    private notifications?: NotificationService,
  ) {}

  async ingest(p: InboundFeePayment, onAudit?: OnAudit): Promise<IngestResult> {
    if (!(p.amount > 0)) throw new Error('ZERO_OR_NEGATIVE_AMOUNT'); // malformed, not money [edge 16]

    // Clock skew [edge 20/15]: a future paidAt clamps to now; the original
    // stays verbatim in raw.
    const paidAt = p.paidAt.getTime() > Date.now() ? new Date() : p.paidAt;

    // 1. Persist raw FIRST — the money exists on disk before any judgment.
    //    The (channel, externalId) unique is the replay guard [S-2].
    let row;
    try {
      row = await this.prisma.mmgAgentPayment.create({
        data: {
          channel: p.channel,
          externalId: p.externalId,
          mmgTxnId: p.mmgTxnId ?? null,
          sanRaw: p.sanRaw,
          sanNormalized: validateSanShape(p.sanRaw).ok ? (validateSanShape(p.sanRaw) as { san: string }).san : null,
          amount: p.amount,
          currencyCode: p.currencyCode.toUpperCase(),
          paidAt,
          agentRef: p.agentRef ?? null,
          payerMsisdn: p.payerMsisdn ?? null,
          status: 'RECEIVED',
          raw: p.raw as never,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.mmgAgentPayment.findUniqueOrThrow({
          where: { channel_externalId: { channel: p.channel, externalId: p.externalId } },
          select: { id: true, status: true, createdAt: true },
        });
        // [MMG-RECV] A redelivery of an observation stranded RECEIVED finishes
        // it: `duplicate` would leave money on disk that nothing credits. One
        // still inside its first delivery is left to that delivery.
        if (existing.status === 'RECEIVED' && FINISHABLE_CHANNELS.includes(p.channel)
          && existing.createdAt.getTime() < (await databaseNow(this.prisma)).getTime() - STRANDED_AFTER_MS) {
          return this.finishStranded(existing.id, onAudit);
        }
        return { status: 'duplicate', paymentId: existing.id };
      }
      throw e;
    }

    return this.judge(row, p, onAudit);
  }

  /** [G5-F6] Finish an observation that was persisted and never judged: the
   *  process died between step 1 (the raw row) and its verdict. The replay
   *  guard answers every later delivery of it `duplicate`, so without this
   *  the money on disk is never credited. Steps 2 to 5 run exactly as ingest
   *  runs them, and the credit compare-and-set still admits one winner. */
  async resumeReceived(paymentId: string, onAudit?: OnAudit): Promise<IngestResult> {
    const row = await this.prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: paymentId } });
    if (row.status !== 'RECEIVED') throw new Error('NOT_RECEIVED');
    return this.judge(row, {
      channel: row.channel,
      externalId: row.externalId,
      sanRaw: row.sanRaw,
      amount: Number(row.amount),
      payerMsisdn: row.payerMsisdn ?? undefined,
    }, onAudit);
  }

  /** Steps 2 to 5 for a persisted observation: identity, sanity, SAN, credit. */
  private async judge(
    row: MmgAgentPayment,
    p: { channel: string; externalId: string; sanRaw: string; amount: number; payerMsisdn?: string },
    onAudit?: OnAudit,
  ): Promise<IngestResult> {
    // 2. [M-18] The identity: one provider transaction, one lifecycle. This
    //    record is an immutable observation of it. Before, cross-channel
    //    dedupe looked for an already-MATCHED sibling — so two channels
    //    arriving together both saw none and both credited, and an unmatched
    //    first observation never blocked the second channel's credit nor its
    //    own later attach.
    const identity = await this.identityFor(row, p.channel);
    if (identity.conflict) return this.suspense(row.id, 'PROVIDER_ID_CONFLICT');
    if (identity.payment.status === 'CREDITED' && identity.payment.creditedPaymentId && identity.payment.creditedPaymentId !== row.id) {
      agentCashDuplicateCreditsCounter.labels(p.channel, 'observed').inc();
      return this.reconcileAgainst(row.id, identity.payment.creditedPaymentId, 'observed after credit');
    }

    // 3. Sanity gates → suspense, never rejection [S-10, edges 17/16].
    if (row.currencyCode !== 'GYD') return this.suspense(row.id, 'BAD_CURRENCY');
    if (p.amount < AGENT_CASH_LIMITS.minPaymentGyd || p.amount > AGENT_CASH_LIMITS.maxSinglePaymentGyd) {
      return this.suspense(row.id, 'AMOUNT_OUT_OF_RANGE');
    }

    // 4. Resolve the SAN platform-wide.
    const res = await resolveSan(this.prisma, p.sanRaw, { tenantId: row.tenantId }); // [AX363-F2] this tenant's accounts only
    if (!res.ok) return this.suspense(row.id, res.code);

    // 5. Credit through the SAME pipeline every rail uses.
    return this.credit(row.id, res.subscription.id, p, onAudit);
  }

  /** [M-18] Resolve (or mint) the provider-transaction identity for an
   *  observation and link the observation to it. Two channels racing to mint
   *  the same identity collapse on its unique key. An observation whose
   *  amount or currency disagrees with the identity is a CONFLICT: never
   *  credited, suspensed for a person, counted and paged. */
  private async identityFor(
    row: Pick<MmgAgentPayment, 'id' | 'tenantId' | 'channel' | 'externalId' | 'mmgTxnId' | 'amount' | 'currencyCode' | 'providerPaymentId' | 'status' | 'failureCode'>,
    channel: string,
  ): Promise<{ payment: { id: string; status: string; creditedPaymentId: string | null }; conflict: false } | { payment: ProviderPayment | null; conflict: true }> {
    const raw = providerTxnRaw(row);
    const resolved = await this.prisma.$transaction(async (tx) => {
      await bindTenantTransaction(tx);
      const readLive = () => tx.$queryRaw<ProviderPayment[]>`
        SELECT * FROM "provider_payments" WHERE "provider" = ${PROVIDER}
          AND mmg_txn_canon("providerTxnId") = mmg_txn_canon(${raw})
          AND "status" <> 'HELD_DUPLICATE'`;
      let payment: ProviderPayment | undefined;
      let historicalConflict = false;
      if (row.providerPaymentId) {
        // Never redirect a linked observation, including one the migration held.
        [payment] = await tx.$queryRaw<ProviderPayment[]>`SELECT * FROM "provider_payments" WHERE "id" = ${row.providerPaymentId}`;
      } else {
        // [SX394] A survivor may no longer store its old key. Permanent SQL
        // reservations include singletons and held/transitive siblings. They
        // are global even if this caller cannot read the target tenant's row.
        const [alias] = await tx.$queryRaw<Array<{ providerPaymentId: string }>>`
          SELECT "providerPaymentId" FROM "provider_payment_aliases"
           WHERE "provider" = ${PROVIDER} AND "aliasKey" = mmg_txn_canon(${raw})`;
        if (alias) {
          const [reserved] = await tx.$queryRaw<Array<ProviderPayment & { canonicalMatches: boolean }>>`
            SELECT p.*, mmg_txn_canon(p."providerTxnId") = mmg_txn_canon(${raw}) AS "canonicalMatches"
              FROM "provider_payments" p WHERE p."id" = ${alias.providerPaymentId}`;
          if (!reserved) return { payment: null, conflict: true as const };
          payment = reserved;
          historicalConflict = !reserved.canonicalMatches || reserved.status === 'HELD_DUPLICATE'
            || reserved.tenantId !== row.tenantId || Number(reserved.amount) !== Number(row.amount)
            || reserved.currencyCode !== row.currencyCode;
        } else {
          [payment] = await readLive();
        }
        if (!payment) {
          // Legacy JS keys sometimes collapsed several SQL spellings into one
          // identity. If the migration retained a different raw spelling, the
          // historical observation is evidence, never permission to mint again.
          [payment] = await tx.$queryRaw<ProviderPayment[]>`
            SELECT p.* FROM "provider_payments" p WHERE p."provider" = ${PROVIDER} AND (
              (p."status" = 'HELD_DUPLICATE' AND mmg_txn_canon(p."providerTxnId") = mmg_txn_canon(${raw})) OR
              (mmg_txn_canon(p."providerTxnId") <> mmg_txn_canon(${raw}) AND EXISTS (
                SELECT 1 FROM "mmg_agent_payments" m WHERE m."providerPaymentId" = p."id"
                  AND mmg_txn_canon(COALESCE(m."mmgTxnId", CASE WHEN m."channel" = 'MANUAL_ADMIN'
                    THEN regexp_replace(m."externalId", '^MANUAL:', '') ELSE m."externalId" END)) = mmg_txn_canon(${raw})
              ))) ORDER BY p."createdAt", p."id" LIMIT 1`;
          historicalConflict = !!payment;
        }
        if (!payment) {
          await tx.$executeRaw`
            INSERT INTO "provider_payments" ("id", "tenantId", "provider", "providerTxnId", "amount", "currencyCode", "updatedAt")
            VALUES (gen_random_uuid()::text, ${row.tenantId}, ${PROVIDER}, mmg_txn_canon(${raw}), ${row.amount}, ${row.currencyCode}, CURRENT_TIMESTAMP)
            ON CONFLICT ("provider", mmg_txn_canon("providerTxnId")) WHERE "status" <> 'HELD_DUPLICATE' DO NOTHING`;
          // A separate READ COMMITTED statement sees a concurrent winner that
          // committed after INSERT began. A single-statement CTE cannot.
          [payment] = await readLive();
        }
        if (!payment) throw new Error('PROVIDER_IDENTITY_MISSING');
        if (!historicalConflict) {
          const linked = await tx.$executeRaw`
            UPDATE "mmg_agent_payments" SET "providerPaymentId" = ${payment.id}
             WHERE "id" = ${row.id} AND "tenantId" = ${row.tenantId}
               AND "providerPaymentId" IS NULL AND "status" = ${row.status}
               AND "status" IN ('RECEIVED', 'UNMATCHED')
               AND "failureCode" IS DISTINCT FROM 'PROVIDER_ID_CONFLICT'`;
          if (linked !== 1) {
            const current = await tx.mmgAgentPayment.findUniqueOrThrow({ where: { id: row.id } });
            if (current.status !== row.status) throw new Error(row.status === 'UNMATCHED' ? 'NOT_UNMATCHED' : 'NOT_RECEIVED');
            if (current.failureCode === 'PROVIDER_ID_CONFLICT') return { payment, conflict: true as const };
            if (!current.providerPaymentId) throw new Error('PROVIDER_IDENTITY_MISSING');
            [payment] = await tx.$queryRaw<ProviderPayment[]>`SELECT * FROM "provider_payments" WHERE "id" = ${current.providerPaymentId}`;
          }
        }
      }
      if (!payment) throw new Error('PROVIDER_IDENTITY_MISSING');
      const [canonical] = await tx.$queryRaw<Array<{ matches: boolean }>>`
        SELECT mmg_txn_canon(${payment.providerTxnId}) = mmg_txn_canon(${raw}) AS matches`;
      const conflict = historicalConflict || row.failureCode === 'PROVIDER_ID_CONFLICT'
        || payment.status === 'HELD_DUPLICATE' || payment.provider !== PROVIDER
        || payment.tenantId !== row.tenantId || !canonical?.matches
        || Number(payment.amount) !== Number(row.amount) || payment.currencyCode !== row.currencyCode;
      return conflict ? { payment, conflict: true as const } : { payment, conflict: false as const };
    });
    if (resolved.conflict) {
      agentCashProviderIdConflictsCounter.labels(channel).inc();
      log().error({ paymentId: row.id },
        '[AX384] provider identity conflicts with this observation; held for finance review');
      await this.page('agent-cash-provider-id-conflict', 'Payment needs finance review',
        `Observation ${row.id} conflicts with its provider identity. No money was credited.`,
        { variant: 'provider_id_conflict', paymentId: row.id });
    }
    return resolved;
  }

  /** Mark an observation as a duplicate of the credit that already stands. */
  private async reconcileAgainst(paymentId: string, originalPaymentId: string, why: string): Promise<IngestResult> {
    // [MMG-RECV] Every verdict is a compare-and-set on RECEIVED: of two
    // finishers of one observation, the first decides and the second writes
    // nothing over it.
    const decided = await this.prisma.mmgAgentPayment.updateMany({
      where: { id: paymentId, status: 'RECEIVED' },
      data: { status: 'RECONCILED', note: `duplicate of ${originalPaymentId} (${why})`, resolvedAt: new Date() },
    });
    if (decided.count !== 1) throw new Error('NOT_RECEIVED');
    return { status: 'reconciled', paymentId, originalPaymentId };
  }

  private async page(key: string, title: string, body: string, data: Record<string, unknown>): Promise<void> {
    if (!this.notifications) return;
    await notifyAdmins(this.prisma, this.notifications, {
      tenantId: null,
      title,
      body,
      data: { kind: 'billing_invariants', alert: key, ...data },
    }).catch(() => {});
  }

  /** The shared credit tail — ingestion and suspense-resolution both end
   *  here, so an attached payment behaves exactly like a matched one. */
  async credit(paymentId: string, subscriptionId: string, p: { amount: number; channel: string; externalId: string; payerMsisdn?: string; recordedBy?: string }, onAudit?: OnAudit): Promise<IngestResult> {
    return this.creditAtomic(paymentId, subscriptionId, p, {
      expectedStatus: 'RECEIVED',
      finalStatus: 'MATCHED',
    }, onAudit);
  }

  private async creditAtomic(
    paymentId: string,
    requestedSubscriptionId: string,
    p: { amount: number; channel: string; externalId: string; payerMsisdn?: string; recordedBy?: string },
    resolution: {
      expectedStatus: 'RECEIVED' | 'UNMATCHED';
      finalStatus: 'MATCHED' | 'RESOLVED';
      adminId?: string;
    },
    onAudit?: OnAudit,
  ): Promise<IngestResult> {
    const committed = await this.prisma.$transaction(async (tx) => {
      await bindTenantTransaction(tx);
      await lockSubscriptionPayer(tx, requestedSubscriptionId);
      // A same-value compare-and-set acquires the row lock at the beginning of
      // the transaction. A concurrent attach waits, rechecks the predicate,
      // and gets count=0 after the winner commits — before it can move money.
      const claimed = await tx.mmgAgentPayment.updateMany({
        where: { id: paymentId, status: resolution.expectedStatus },
        data: { status: resolution.expectedStatus },
      });
      if (claimed.count !== 1) {
        throw new Error(resolution.expectedStatus === 'UNMATCHED' ? 'NOT_UNMATCHED' : 'PAYMENT_NOT_RECEIVED');
      }

      const payment = await tx.mmgAgentPayment.findUniqueOrThrow({ where: { id: paymentId } });

      // [AX363-F1] Every credit is the credit OF one provider transaction: its
      // identity must exist and agree with this observation, and the CAS
      // below is the one gate. Missing or disagreeing, nothing is credited
      // and the payment stays held for a person. There is no per-observation
      // fallback key that could credit the same cash a second time.
      const providerPaymentId = payment.providerPaymentId;
      if (!providerPaymentId) throw new Error('PROVIDER_IDENTITY_MISSING');
      // Re-read under the identity lock after claiming the observation. A
      // resolver's earlier read cannot authorize a credit after a hold.
      const [identity] = await tx.$queryRaw<Array<ProviderPayment & { canonicalMatches: boolean }>>`
        SELECT p.*, mmg_txn_canon(p."providerTxnId") = mmg_txn_canon(${providerTxnRaw(payment)}) AS "canonicalMatches"
          FROM "provider_payments" p WHERE p."id" = ${providerPaymentId} FOR UPDATE`;
      if (!identity) throw new Error('PROVIDER_IDENTITY_MISSING');
      if (payment.failureCode === 'PROVIDER_ID_CONFLICT' || identity.status === 'HELD_DUPLICATE') {
        await tx.mmgAgentPayment.update({ where: { id: paymentId }, data: { status: 'UNMATCHED', failureCode: 'PROVIDER_ID_CONFLICT' } });
        return { paymentId, subscriptionId: requestedSubscriptionId, credited: false, duplicateOf: null, conflict: true };
      }
      if (identity.provider !== PROVIDER || identity.tenantId !== payment.tenantId || !identity.canonicalMatches
        || Number(identity.amount) !== Number(payment.amount) || identity.currencyCode !== payment.currencyCode) {
        throw new Error('PROVIDER_ID_CONFLICT');
      }
      if (identity.status !== 'OPEN' && !(identity.status === 'CREDITED' && identity.creditedPaymentId)) {
        throw new Error('PROVIDER_ID_CONFLICT');
      }
      // [AX363-F2] The destination belongs to the observation's tenant, read
      // here whatever query extension the caller's client carries: money
      // never crosses a tenant.
      if ((await subscriptionOwnerTenant(tx, requestedSubscriptionId)) !== payment.tenantId) {
        throw new Error('DESTINATION_TENANT_MISMATCH');
      }

      // [M-18] THE single CAS: exactly one observation of a provider
      // transaction ever credits. A concurrent channel, or a later attach of
      // the unmatched original, waits on this row, re-reads the predicate
      // after the winner commits and gets count=0 — and becomes a reconciled
      // observation of the credit that won. No money moves for it.
      const won = await tx.providerPayment.updateMany({
        where: { id: providerPaymentId, status: 'OPEN' },
        data: { status: 'CREDITED', creditedPaymentId: paymentId, subscriptionId: requestedSubscriptionId, creditedAt: new Date() },
      });
      if (won.count !== 1) {
        const credited = await tx.providerPayment.findUniqueOrThrow({ where: { id: providerPaymentId } });
        if (credited.status !== 'CREDITED' || !credited.creditedPaymentId) throw new Error('PROVIDER_ID_CONFLICT');
        const original = credited.creditedPaymentId;
        await tx.mmgAgentPayment.updateMany({
          where: { id: paymentId, status: resolution.expectedStatus },
          data: { status: 'RECONCILED', note: `duplicate of ${original} (already credited)`, resolvedAt: new Date() },
        });
        // [ADM-002] The caller's audit row commits with the reconciliation.
        await onAudit?.(tx, { paymentId, subscriptionId: credited.subscriptionId ?? requestedSubscriptionId, credited: false, duplicateOf: original });
        return { paymentId, subscriptionId: credited.subscriptionId ?? requestedSubscriptionId, credited: false, duplicateOf: original };
      }

      // Heal the one legacy crash window from the pre-atomic implementation:
      // recordTopUp used this exact suffix and could commit before the payment
      // row advanced. Never credit a second destination if that evidence is
      // already present; link the payment to the proven original instead.
      const legacy = await tx.billingEvent.findFirst({
        where: {
          type: 'PREPAID_TOPUP',
          idempotencyKey: { endsWith: `:agent:${p.channel}:${p.externalId}` },
        },
        select: { subscriptionId: true },
      });
      const subscriptionId = legacy?.subscriptionId ?? requestedSubscriptionId;
      if (!legacy) {
        await this.billing.recordTopUpInTransaction(tx, {
          subscriptionId,
          amount: p.amount,
          recordedBy: `agent-cash:${p.channel}`,
          reference: `MMG agent payment ${p.externalId}`,
          // Destination-independent: the same real-world cash cannot acquire a
          // second key merely because an admin selects another subscription —
          // and [M-18] the key is the provider transaction's, so the ledger's
          // own uniqueness refuses a second credit even if the CAS were bypassed.
          // [AX363-F1] Always: there is no per-observation key any more.
          eventKey: `agent-cash:pp:${providerPaymentId}`,
        });
      }

      const finalized = await tx.mmgAgentPayment.updateMany({
        where: { id: paymentId, status: resolution.expectedStatus },
        data: {
          status: resolution.finalStatus,
          subscriptionId,
          ...(resolution.finalStatus === 'RESOLVED'
            ? { resolvedBy: resolution.adminId!, resolvedAt: new Date() }
            : {}),
        },
      });
      if (finalized.count !== 1) throw new Error('PAYMENT_FINALIZE_CONFLICT');
      if (subscriptionId !== requestedSubscriptionId) {
        await tx.providerPayment.update({ where: { id: providerPaymentId }, data: { subscriptionId } });
      }
      // [ADM-002] The caller's audit row is the last statement of the credit.
      await onAudit?.(tx, { paymentId: payment.id, subscriptionId, credited: !legacy, finalStatus: resolution.finalStatus });
      return { paymentId: payment.id, subscriptionId, credited: !legacy, duplicateOf: null as string | null };
    });

    if ('conflict' in committed && committed.conflict) {
      if (resolution.expectedStatus === 'UNMATCHED') throw new Error('PROVIDER_ID_CONFLICT');
      return { status: 'received_unmatched', paymentId, failureCode: 'PROVIDER_ID_CONFLICT' };
    }
    if (committed.duplicateOf) {
      // [M-18] A credit attempt on an already-credited transaction: the race
      // loser, or an admin attaching the unmatched original after the second
      // channel credited. Counted and paged — this is the double credit the
      // register names, refused.
      agentCashDuplicateCreditsCounter.labels(p.channel, 'credit').inc();
      log().warn({ paymentId, duplicateOf: committed.duplicateOf, channel: p.channel }, '[M-18] duplicate credit attempt refused — the provider transaction was already credited');
      await this.page('agent-cash-duplicate-credit', 'A second credit for one MMG transaction was refused', `Observation ${paymentId} (${p.channel}) tried to credit a transaction already credited by ${committed.duplicateOf}. Nothing moved; the record is marked reconciled.`, { variant: 'duplicate_credit_attempt', paymentId, originalPaymentId: committed.duplicateOf });
      return { status: 'reconciled', paymentId, originalPaymentId: committed.duplicateOf };
    }

    // Notification and immediate re-bill are intentionally post-commit: they
    // cannot roll back or duplicate the durable cash movement. A recurring
    // billing cycle remains the recovery path if this best-effort fast path
    // fails after the database commit.
    if (committed.credited) {
      await this.billing.afterTopUpCommitted(committed.subscriptionId, p.amount).catch((err) => {
        log().error({ err, paymentId, subscriptionId: committed.subscriptionId }, 'agent cash committed; post-top-up effects will retry through billing');
      });
    }

    // Signed/manual/CSV credit metadata does not authenticate the wallet owner.
    // Preserve it as advisory provenance; money settlement keeps its own checks.
    if (p.payerMsisdn) {
      const sub = await this.prisma.subscription.findUnique({
        where: { id: committed.subscriptionId },
        select: {
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          vendor: { select: { owner: { select: { userId: true } } } },
        },
      });
      const userId = sub?.rider?.userId ?? sub?.driver?.userId ?? sub?.vendor?.owner.userId;
      if (userId) await captureMmgPayer(this.prisma, { userId, role: sub?.vendor ? 'VENDOR' : sub?.driver ? 'DRIVER' : 'RIDER', payerMsisdn: p.payerMsisdn, observed: true, observationId: paymentId, subscriptionId: committed.subscriptionId }).catch((err) => log().error({ err }, 'advisory payer observation failed; money facts unchanged'));
    }
    return { status: 'accepted', paymentId: committed.paymentId, subscriptionId: committed.subscriptionId };
  }

  private async suspense(paymentId: string, failureCode: string): Promise<IngestResult> {
    const decided = await this.prisma.mmgAgentPayment.updateMany({
      where: { id: paymentId, status: 'RECEIVED' },
      data: { status: 'UNMATCHED', failureCode },
    });
    if (decided.count !== 1) throw new Error('NOT_RECEIVED'); // [MMG-RECV] another finisher decided it first
    log().warn({ paymentId, failureCode }, 'agent payment suspensed — money recorded, human resolution needed');
    return { status: 'received_unmatched', paymentId, failureCode };
  }

  /** [MMG-RECV] Finish an observation stranded RECEIVED, through the same
   *  steps 2 to 5, exactly once. A finisher that lost the race (another one
   *  decided it first, and every verdict is a compare-and-set on RECEIVED)
   *  writes nothing and is answered `duplicate`. */
  async finishStranded(paymentId: string, onAudit?: OnAudit): Promise<IngestResult> {
    try {
      return await this.resumeReceived(paymentId, onAudit);
    } catch (e) {
      if (!(e instanceof Error) || !LOST_RACE.has(e.message)) throw e;
      const now = await this.prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true } });
      if (now.status === 'RECEIVED') throw e; // not a lost race: nobody decided it
      return { status: 'duplicate', paymentId };
    }
  }

  /** [MMG-RECV] The repair pass (poll-mmg-billing). Every webhook or manual
   *  observation stranded RECEIVED is finished, each in its own tenant, with
   *  a system audit row joining its credit. FAIR: never tried first, then the
   *  least recently tried; one whose finish just failed waits out
   *  STRANDED_RETRY_BACKOFF_MS; one that fails again after
   *  STRANDED_GIVE_UP_AFTER_MS goes to the suspense queue for a person.
   *  `paymentIds` narrows the pass (tests, a drill). */
  async finishStrandedPayments(opts: { limit?: number; paymentIds?: string[] } = {}): Promise<{ finished: string[]; failed: string[]; suspensed: string[] }> {
    const out = { finished: [] as string[], failed: [] as string[], suspensed: [] as string[] };
    const now = await databaseNow(this.prisma);
    const strandedWhere = {
      status: 'RECEIVED',
      channel: { in: [...FINISHABLE_CHANNELS] },
      createdAt: { lt: new Date(now.getTime() - STRANDED_AFTER_MS) },
      ...(opts.paymentIds ? { id: { in: opts.paymentIds } } : {}),
    };
    const due = await runAsSystem('agent-cash-stranded-repair', () => this.prisma.mmgAgentPayment.findMany({
      where: { ...strandedWhere, OR: [{ finishAttemptAt: null }, { finishAttemptAt: { lt: new Date(now.getTime() - STRANDED_RETRY_BACKOFF_MS) } }] },
      orderBy: [{ finishAttemptAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, opts.limit ?? 20),
      select: { id: true, tenantId: true, channel: true, raw: true },
    }));
    for (const p of due) {
      await runWithTenant(p.tenantId, async () => {
        try {
          const res = await this.finishStranded(p.id, strandedFinishAudit(p));
          if (res.status !== 'duplicate') out.finished.push(p.id);
        } catch (err) {
          const left = await this.recordFailedFinish(p.id);
          if (left === 'UNMATCHED') {
            out.suspensed.push(p.id);
            await this.page('agent-cash-stranded-unfinished', 'A paid fee could not be credited', `Agent-cash payment ${p.id} (${p.channel}) was saved but never credited, and the repair pass has kept failing to finish it for over an hour. It is in the suspense queue as UNFINISHED: check it against the MMG statement and attach it to the right account.`, { variant: 'stranded_unfinished', paymentId: p.id });
          } else if (left === 'RECEIVED') {
            out.failed.push(p.id);
          }
          log().error({ err, paymentId: p.id, channel: p.channel, left }, '[MMG-RECV] a stranded agent-cash payment could not be finished — retried after the backoff, then a person');
        }
      });
    }
    // What is still stranded after the pass: money on disk nothing credited yet.
    agentCashStrandedGauge.set(await runAsSystem('agent-cash-stranded-repair', () => this.prisma.mmgAgentPayment.count({ where: strandedWhere })));
    return out;
  }

  /** [MMG-RECV · fenced] Record a failed finish in ONE guarded statement that
   *  reads the database clock itself, and only while the observation is
   *  still RECEIVED: a verdict another finisher wrote meanwhile is never
   *  overwritten. One that has failed before and is stranded past the
   *  give-up age goes to the suspense queue instead. Answers the status it
   *  left, or null when another finisher had decided it. */
  private async recordFailedFinish(paymentId: string): Promise<'RECEIVED' | 'UNMATCHED' | null> {
    const tenantId = getTenantId();
    const givingUp = Prisma.sql`("finishAttemptAt" IS NOT NULL AND "createdAt" < ${DB_NOW} - (${STRANDED_GIVE_UP_AFTER_MS} * interval '1 millisecond'))`;
    const [row] = await this.prisma.$transaction(async (tx) => {
      await bindTenantTransaction(tx);
      return tx.$queryRaw<Array<{ status: string }>>`
        UPDATE "mmg_agent_payments"
           SET "finishAttemptAt" = ${DB_NOW},
               "status" = CASE WHEN ${givingUp} THEN 'UNMATCHED' ELSE "status" END,
               "failureCode" = CASE WHEN ${givingUp} THEN 'UNFINISHED' ELSE "failureCode" END
         WHERE "id" = ${paymentId} ${tenantId ? Prisma.sql`AND "tenantId" = ${tenantId}` : Prisma.empty}
           AND "status" = 'RECEIVED'
        RETURNING "status"`;
    });
    return row ? (row.status as 'RECEIVED' | 'UNMATCHED') : null;
  }

  /** Suspense resolution [spec 4.6]: attach to an account — credits via the
   *  normal pipeline with the original payment linked. [M-18] If the
   *  transaction was credited by another channel meanwhile, the attach is
   *  answered `reconciled` and moves nothing. */
  async attach(paymentId: string, subscriptionId: string, adminId: string, onAudit?: OnAudit): Promise<IngestResult> {
    const row = await this.prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: paymentId } });
    if (row.status !== 'UNMATCHED') throw new Error('NOT_UNMATCHED');
    // [AX363-F1] The provider identity first, resolved (or minted) and
    // validated exactly as ingest does: a payment whose delivery died before
    // it was linked, and that the repair pass then gave up on, is credited
    // only THROUGH its identity. A conflict keeps it held for a person.
    const identity = await this.identityFor(row, row.channel);
    if (identity.conflict) throw new Error('PROVIDER_ID_CONFLICT');
    return this.creditAtomic(paymentId, subscriptionId, {
      amount: Number(row.amount),
      channel: row.channel,
      externalId: row.externalId,
      payerMsisdn: row.payerMsisdn ?? undefined,
      recordedBy: adminId,
    }, {
      expectedStatus: 'UNMATCHED',
      finalStatus: 'RESOLVED',
      adminId,
    }, onAudit);
  }

  /** The suspense queue with the Luhn diagnosis the founder reads [4.6]:
   *  checksum-fail = typo at the counter; valid-but-unknown = a mis-key that
   *  beat 1-in-10 odds, or a closed/tombstoned account. */
  async unmatchedQueue(limit = 100) {
    const rows = await this.prisma.mmgAgentPayment.findMany({
      where: { status: 'UNMATCHED' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    const now = Date.now();
    return rows.map((r) => ({
      ...r,
      amount: Number(r.amount),
      diagnosis:
        r.failureCode === 'SAN_CHECKSUM_FAILED' || r.failureCode === 'SAN_MALFORMED'
          ? 'typo at the counter (failed checksum — cannot belong to anyone)'
          : r.failureCode === 'SAN_UNKNOWN'
            ? 'valid checksum but nobody holds it (mis-key that beat the odds)'
            : r.failureCode === 'TOMBSTONED' || r.failureCode === 'ACCOUNT_CLOSED'
              ? 'paid to a closed account — refund flag likely'
              : r.failureCode === 'UNFINISHED'
                ? 'saved but never credited: the repair pass kept failing (check it against the MMG statement, then attach)'
                : r.failureCode ?? 'unknown',
      hoursOld: Math.round((now - r.createdAt.getTime()) / 3_600_000),
      breachesSla: now - r.createdAt.getTime() > 24 * 3_600_000,
    }));
  }
}

/** [M-18 · operations] The historical double credits: provider transactions
 *  that hold MORE than one credited observation (two channels credited before
 *  the identity existed). Reported and gauged for human reconciliation against
 *  the provider statement — never reversed automatically. */
export async function scanDuplicateCredits(prisma: PrismaClient): Promise<Array<{ providerTxnId: string; observations: number; subscriptionIds: string[]; amount: number }>> {
  const rows = await prisma.$queryRaw<Array<{ providerTxnId: string; observations: bigint; subscriptionIds: string[]; amount: Prisma.Decimal }>>(Prisma.sql`
    SELECT p."providerTxnId",
           count(m."id")::bigint AS "observations",
           array_agg(DISTINCT m."subscriptionId") FILTER (WHERE m."subscriptionId" IS NOT NULL) AS "subscriptionIds",
           p."amount"
    FROM "provider_payments" p
    JOIN "mmg_agent_payments" m ON m."providerPaymentId" = p."id" AND m."status" IN ('MATCHED', 'RESOLVED')
    GROUP BY p."id", p."providerTxnId", p."amount"
    HAVING count(m."id") > 1
    ORDER BY p."providerTxnId"
    LIMIT 200
  `);
  const found = rows.map((r) => ({ providerTxnId: r.providerTxnId, observations: Number(r.observations), subscriptionIds: r.subscriptionIds ?? [], amount: Number(r.amount) }));
  agentCashDuplicateCreditsGauge.set(found.length);
  if (found.length > 0) {
    log().error({ count: found.length, sample: found.slice(0, 10) }, '[M-18] provider transactions credited more than once — freeze, reconcile against the MMG statement, reverse only by hand');
  }
  return found;
}
