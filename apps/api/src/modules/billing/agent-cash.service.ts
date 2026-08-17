import { Prisma, type PrismaClient } from '@prisma/client';
import type { BillingService } from './billing.service';
import { resolveSan } from './san.service';
import { validateSanShape } from './san';
import { captureMmgPayer } from '../integrity/capture-hooks';
import { log } from '../../utils/logger';

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
  const weekly = Number(sub.customRate ?? sub.weeklyRate);
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

    // 2. Cross-channel dedupe [spec 4.0/edge 2]: the same real-world payment
    //    arriving by webhook AND settlement file credits exactly once — the
    //    second arrival links to the first and moves no money.
    if (p.mmgTxnId) {
      const original = await this.prisma.mmgAgentPayment.findFirst({
        where: { mmgTxnId: p.mmgTxnId, id: { not: row.id }, status: { in: ['MATCHED', 'RESOLVED'] } },
        select: { id: true },
      });
      if (original) {
        await this.prisma.mmgAgentPayment.update({
          where: { id: row.id },
          data: { status: 'RECONCILED', note: `duplicate of ${original.id} (cross-channel)`, resolvedAt: new Date() },
        });
        return { status: 'reconciled', paymentId: row.id, originalPaymentId: original.id };
      }
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
          // second key merely because an admin selects another subscription.
          eventKey: `agent-cash:${paymentId}`,
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
      return { paymentId: payment.id, subscriptionId, credited: !legacy };
    });

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
   *  normal pipeline with the original payment linked. */
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
