import { Prisma, type PrismaClient } from '@prisma/client';
import type { BillingService } from './billing.service';
import { resolveSan } from './san.service';
import { validateSanShape } from './san';
import { captureMmgPayer } from '../integrity/capture-hooks';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';
import { agentCashDuplicateCreditsCounter, agentCashDuplicateCreditsGauge, agentCashProviderIdConflictsCounter } from '../../plugins/observability';
import { log } from '../../utils/logger';
import { weeklyFeeAmount } from './subscription-fee';

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

/** [M-18] One real-world provider transaction is ONE identity, whatever
 *  channel observed it. The key is the provider's transaction id — or, for a
 *  manual entry, the receipt reference the admin verified in the MMG portal,
 *  which is that same id — normalized so a spelling cannot mint a second one. */
export function providerTxnKey(p: { mmgTxnId?: string | null; externalId: string; channel: string }): string {
  const raw = p.mmgTxnId ?? (p.channel === 'MANUAL_ADMIN' ? p.externalId.replace(/^MANUAL:/, '') : p.externalId);
  return raw.trim().toUpperCase();
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
 *  GET /subscription next to sanDisplay. One amount-due source of truth
 *  [3.4]: next week's fee minus the parked wallet balance, floored at 0.
 *  usdDisplay [usd spec Part 6, System 2 ③]: the dual-currency line — NULL
 *  until the founder enables usdPricingEnabled + displayDual for the tenant,
 *  so it ships dark and every consumer already handles absence. */
export async function payInfo(
  prisma: PrismaClient,
  sub: { id: string; type?: string; weeklyRate: unknown; customRate?: unknown | null },
): Promise<{
  walletBalanceGyd: number; weeklyFeeGyd: number; amountDueGyd: number;
  activationCopy: string; payCashSteps: string[];
  usdDisplay: { amountUsd: number; rateUsed: number; line: string } | null;
}> {
  const [balanceRow, modeRow] = await Promise.all([
    prisma.prepaidBalance.findUnique({ where: { subscriptionId: sub.id } }),
    prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_agent.ingestion_mode' } }),
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
    amountDueGyd: Math.max(0, weekly - balance),
    activationCopy: ACTIVATION_COPY[mode] ?? ACTIVATION_COPY['MANUAL']!,
    payCashSteps: [
      'Visit any MMG agent',
      'Say you are paying a Swift bill and give your Swift Number',
      'Pay cash — keep the receipt',
    ],
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

  async ingest(p: InboundFeePayment): Promise<IngestResult> {
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
          select: { id: true },
        });
        return { status: 'duplicate', paymentId: existing.id };
      }
      throw e;
    }

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
    const res = await resolveSan(this.prisma, p.sanRaw);
    if (!res.ok) return this.suspense(row.id, res.code);

    // 5. Credit through the SAME pipeline every rail uses.
    return this.credit(row.id, res.subscription.id, p);
  }

  /** [M-18] Resolve (or mint) the provider-transaction identity for an
   *  observation and link the observation to it. Two channels racing to mint
   *  the same identity collapse on its unique key. An observation whose
   *  amount or currency disagrees with the identity is a CONFLICT: never
   *  credited, suspensed for a person, counted and paged. */
  private async identityFor(
    row: { id: string; tenantId: string; channel: string; externalId: string; mmgTxnId: string | null; amount: Prisma.Decimal; currencyCode: string },
    channel: string,
  ): Promise<{ payment: { id: string; status: string; creditedPaymentId: string | null }; conflict: boolean }> {
    const key = providerTxnKey(row);
    const where = { provider_providerTxnId: { provider: PROVIDER, providerTxnId: key } };
    let payment = await this.prisma.providerPayment.findUnique({ where });
    if (!payment) {
      try {
        payment = await this.prisma.providerPayment.create({
          data: { tenantId: row.tenantId, provider: PROVIDER, providerTxnId: key, amount: row.amount, currencyCode: row.currencyCode },
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        payment = await this.prisma.providerPayment.findUniqueOrThrow({ where });
      }
    }
    await this.prisma.mmgAgentPayment.update({ where: { id: row.id }, data: { providerPaymentId: payment.id } });
    const conflict = Number(payment.amount) !== Number(row.amount) || payment.currencyCode !== row.currencyCode;
    if (conflict) {
      agentCashProviderIdConflictsCounter.labels(channel).inc();
      log().error(
        { paymentId: row.id, providerPaymentId: payment.id, providerTxnId: key, observed: { amount: Number(row.amount), currency: row.currencyCode }, identity: { amount: Number(payment.amount), currency: payment.currencyCode } },
        '[M-18] provider transaction observed with a different amount — suspensed, never credited; a person must look',
      );
      await this.page('agent-cash-provider-id-conflict', 'One MMG transaction, two amounts', `Transaction ${key} arrived by ${channel} with a different amount than an earlier observation. It is parked in suspense — reconcile against the MMG statement before crediting anything.`, { variant: 'provider_id_conflict', paymentId: row.id, providerTxnId: key });
    }
    return { payment, conflict };
  }

  /** Mark an observation as a duplicate of the credit that already stands. */
  private async reconcileAgainst(paymentId: string, originalPaymentId: string, why: string): Promise<IngestResult> {
    await this.prisma.mmgAgentPayment.update({
      where: { id: paymentId },
      data: { status: 'RECONCILED', note: `duplicate of ${originalPaymentId} (${why})`, resolvedAt: new Date() },
    });
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
  async credit(paymentId: string, subscriptionId: string, p: { amount: number; channel: string; externalId: string; payerMsisdn?: string; recordedBy?: string }): Promise<IngestResult> {
    return this.creditAtomic(paymentId, subscriptionId, p, {
      expectedStatus: 'RECEIVED',
      finalStatus: 'MATCHED',
    });
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
  ): Promise<IngestResult> {
    const committed = await this.prisma.$transaction(async (tx) => {
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

      // [M-18] THE single CAS: exactly one observation of a provider
      // transaction ever credits. A concurrent channel, or a later attach of
      // the unmatched original, waits on this row, re-reads the predicate
      // after the winner commits and gets count=0 — and becomes a reconciled
      // observation of the credit that won. No money moves for it.
      if (payment.providerPaymentId) {
        const won = await tx.providerPayment.updateMany({
          where: { id: payment.providerPaymentId, status: 'OPEN' },
          data: { status: 'CREDITED', creditedPaymentId: paymentId, subscriptionId: requestedSubscriptionId, creditedAt: new Date() },
        });
        if (won.count !== 1) {
          const identity = await tx.providerPayment.findUniqueOrThrow({ where: { id: payment.providerPaymentId } });
          const original = identity.creditedPaymentId ?? 'unknown';
          await tx.mmgAgentPayment.updateMany({
            where: { id: paymentId, status: resolution.expectedStatus },
            data: { status: 'RECONCILED', note: `duplicate of ${original} (already credited)`, resolvedAt: new Date() },
          });
          return { paymentId, subscriptionId: identity.subscriptionId ?? requestedSubscriptionId, credited: false, duplicateOf: original };
        }
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
          eventKey: payment.providerPaymentId ? `agent-cash:pp:${payment.providerPaymentId}` : `agent-cash:${paymentId}`,
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
      if (payment.providerPaymentId && subscriptionId !== requestedSubscriptionId) {
        await tx.providerPayment.update({ where: { id: payment.providerPaymentId }, data: { subscriptionId } });
      }
      return { paymentId: payment.id, subscriptionId, credited: !legacy, duplicateOf: null as string | null };
    });

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

    // S-7: the payer's MSISDN feeds the identity graph — one phone cash-paying
    // fees for three "unrelated" trial vendors is a STRONG cluster edge.
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
      if (userId) captureMmgPayer(this.prisma, { userId, role: sub?.vendor ? 'VENDOR' : 'MOVER', payerMsisdn: p.payerMsisdn });
    }
    return { status: 'accepted', paymentId: committed.paymentId, subscriptionId: committed.subscriptionId };
  }

  private async suspense(paymentId: string, failureCode: string): Promise<IngestResult> {
    await this.prisma.mmgAgentPayment.update({
      where: { id: paymentId },
      data: { status: 'UNMATCHED', failureCode },
    });
    log().warn({ paymentId, failureCode }, 'agent payment suspensed — money recorded, human resolution needed');
    return { status: 'received_unmatched', paymentId, failureCode };
  }

  /** Suspense resolution [spec 4.6]: attach to an account — credits via the
   *  normal pipeline with the original payment linked. [M-18] If the
   *  transaction was credited by another channel meanwhile, the attach is
   *  answered `reconciled` and moves nothing. */
  async attach(paymentId: string, subscriptionId: string, adminId: string): Promise<IngestResult> {
    const row = await this.prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: paymentId } });
    if (row.status !== 'UNMATCHED') throw new Error('NOT_UNMATCHED');
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
    });
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

