import type { OnAudit } from '../../lib/audit-writer';
import type { PrismaClient, AdRefundReason } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';
import { refundCalculator, refundCalculatorMinor, type RefundReason, type RefundOpts } from './refund-calculator';
import { majorDecimalToMinor, minorToMajorString } from './ads-money';
import { adRefundCounter, adRefundGauge } from '../../plugins/observability';

/**
 * [R045-ADS-01 · 02 · 03 · 08 · 09] The ad refund obligation is durable.
 *
 * Before: cancel, kill and auto-cancel terminalized the campaign and THEN
 * called an executor that mutated bookings and the invoice directly, in
 * major-unit floats, with a best-effort notice — under an empty catch on the
 * admin kill and after the transition on the cron. A refund could vanish
 * (the obligation existed only in a log line), duplicate (a retry re-ran the
 * plan), or be called "refunded" with no payment proof; a CREDIT item only
 * incremented a local total and was never persisted. The durable models
 * (intent, items, outbox) existed and nothing used them.
 *
 * Now the obligation is STAGED — an AdRefundIntent (PENDING), its items, and
 * its outbox row — inside the same transaction as the campaign's terminal
 * transition (the lifecycle's `within` hook), keyed by (campaign, reason,
 * event) so a second staging is the same intent. A leased outbox worker
 * EXECUTES each intent exactly once: REFUND items flip bookings and release
 * inventory, CREDIT items move the advertiser's credit balance once
 * (the intent's execution record), the invoice's refunded amount moves in one transaction with
 * the intent's status — all in integer minor units, converted only at the
 * Decimal column and the notice. The payout rail is MANUAL today (the
 * provider refund API is founder-gated): an executed intent waits in
 * MANUAL_REQUIRED for a human's payout reference, which is the evidence that
 * settles it (SUCCEEDED). A failed execution retries with backoff; exhausted
 * attempts dead-letter the row, FAIL the intent and page. Kill switch
 * AD_REFUND_EXECUTION_KILL=1 stops execution and preserves every intent.
 */
export interface RefundExecResult {
  planTotal: number;
  refundedTotal: number;
  creditedTotal: number;
  releasedSlots: number;
  intentId: string | null;
}

export interface StagedRefund {
  intentId: string;
  /** false = an intent for this (campaign, reason, event) already existed. */
  staged: boolean;
  totalMinor: bigint;
}

const CURRENCY_FALLBACK = 'GYD';
const major = (minor: bigint, currency: string) => Number(minorToMajorString(minor, currency));

export function adRefundExecutionKilled(env: Record<string, string | undefined> = process.env): boolean {
  return env['AD_REFUND_EXECUTION_KILL'] === '1';
}

/** Test seam: runs inside executeIntent's transaction before any money moves,
 *  so a proof can make one execution fail and watch the worker retry the SAME
 *  intent to exactly one settlement. Never set in routes. */
export interface AdRefundObserver {
  beforeExecute?: (intentId: string) => Promise<void>;
}

export class AdsRefundService {
  private notifications: NotificationService;
  observer: AdRefundObserver = {};
  constructor(private prisma: PrismaClient, private io: Server) {
    this.notifications = new NotificationService(prisma, io);
  }

  /** The refundable bookings and the exact (bigint) plan — the ONE input path
   *  shared by the preview and the staging, so the number the advertiser sees
   *  before cancelling is BY CONSTRUCTION the number that is owed. */
  private async planFor(db: Prisma.TransactionClient | PrismaClient, campaignId: string, reason: RefundReason, opts: Omit<RefundOpts, 'now'> & { now?: Date }) {
    const now = opts.now ?? new Date();
    const bookings = await db.adBooking.findMany({
      where: { campaignId, status: { in: ['CONFIRMED', 'RESERVED'] } },
      select: { id: true, weekStart: true, amount: true, placementId: true, city: true },
    });
    const currency = CURRENCY_FALLBACK;
    const plan = refundCalculatorMinor(
      bookings.map((b) => ({ id: b.id, weekStart: b.weekStart, amountMinor: majorDecimalToMinor(String(b.amount), currency) })),
      reason,
      { ...opts, now },
    );
    return { plan, bookings, now, currency };
  }

  /** §14.4 — the exact refund shown BEFORE the advertiser confirms a cancel.
   *  Same assembly, same calculator, zero mutation; major units for display. */
  async preview(campaignId: string, reason: RefundReason, opts: Omit<RefundOpts, 'now'> & { now?: Date } = {}) {
    const campaign = await this.prisma.adCampaign.findUnique({ where: { id: campaignId }, select: { id: true } });
    if (!campaign) throw new NotFoundError('AdCampaign', campaignId);
    const bookings = await this.prisma.adBooking.findMany({ where: { campaignId, status: { in: ['CONFIRMED', 'RESERVED'] } }, select: { id: true, weekStart: true, amount: true } });
    return refundCalculator(bookings.map((b) => ({ id: b.id, weekStart: b.weekStart, amount: Number(b.amount) })), reason, { ...opts, now: opts.now ?? new Date() });
  }

  /** Stage the obligation INSIDE the caller's transaction (the lifecycle's
   *  `within` hook): the intent, its items and its outbox row, keyed so the
   *  same (campaign, reason, event) is one intent. Returns null when nothing
   *  is owed (no refundable booking, or no paid invoice to refund against). */
  async stage(
    tx: Prisma.TransactionClient,
    campaignId: string,
    reason: RefundReason,
    actor: string | null,
    opts: Omit<RefundOpts, 'now'> & { now?: Date; eventKey?: string } = {},
  ): Promise<StagedRefund | null> {
    const campaign = await tx.adCampaign.findUnique({ where: { id: campaignId }, select: { id: true, tenantId: true, advertiserId: true } });
    if (!campaign) throw new NotFoundError('AdCampaign', campaignId);
    const idempotencyKey = `ad-refund:${campaignId}:${reason}:${opts.eventKey ?? 'v1'}`;
    const existing = await tx.adRefundIntent.findUnique({ where: { idempotencyKey }, select: { id: true, amountMinor: true } });
    if (existing) return { intentId: existing.id, staged: false, totalMinor: existing.amountMinor };
    const { plan, currency } = await this.planFor(tx, campaignId, reason, opts);
    if (plan.items.length === 0 || plan.totalMinor === 0n) return null;
    const invoice = await tx.adInvoice.findFirst({
      where: { campaignId, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
      orderBy: { paidAt: 'desc' },
      select: { id: true, currency: true, tenantId: true },
    });
    if (!invoice) return null; // nothing was paid — nothing to refund
    const intent = await tx.adRefundIntent.create({
      data: {
        tenantId: campaign.tenantId, invoiceId: invoice.id, campaignId, idempotencyKey, reason: reason as AdRefundReason,
        status: 'PENDING', amountMinor: plan.totalMinor, currency: invoice.currency ?? currency, payoutRail: 'MANUAL',
        correlationId: idempotencyKey, requestedByUserId: actor,
      },
      select: { id: true },
    });
    // The items and the outbox row carry their composite keys explicitly (the
    // relations are composite; a nested create cannot name the tenant).
    await tx.adRefundItem.createMany({ data: plan.items.map((i) => ({ tenantId: campaign.tenantId, refundIntentId: intent.id, campaignId, bookingId: i.bookingId, kind: i.kind, amountMinor: i.amountMinor })) });
    await tx.adRefundOutbox.create({ data: { tenantId: campaign.tenantId, refundIntentId: intent.id, dedupeKey: idempotencyKey, payload: { campaignId, reason, actor }, correlationId: idempotencyKey } });
    adRefundCounter.labels('staged').inc();
    return { intentId: intent.id, staged: true, totalMinor: plan.totalMinor };
  }

  /** Execute ONE intent exactly once, in one transaction: bookings, inventory,
   *  the advertiser's credit balance, the invoice, the intent's status and the
   *  audit row commit together. A replay of an executed intent is a no-op. */
  async executeIntent(intentId: string): Promise<{ executed: boolean; refundedMinor: bigint; creditedMinor: bigint; releasedSlots: number }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ad_refund_intents" WHERE "id" = ${intentId} FOR UPDATE`;
      const intent = await tx.adRefundIntent.findUnique({ where: { id: intentId }, include: { items: true, campaign: { select: { name: true, advertiserId: true } } } });
      if (!intent) throw new NotFoundError('AdRefundIntent', intentId);
      if (intent.status !== 'PENDING' && intent.status !== 'PROCESSING') {
        return { executed: false, refundedMinor: 0n, creditedMinor: 0n, releasedSlots: 0 };
      }
      await tx.adRefundIntent.update({ where: { id: intentId }, data: { status: 'PROCESSING', processingStartedAt: new Date() } });
      await this.observer.beforeExecute?.(intentId);
      // [R045-ADS-02] Items are immutable facts — the database refuses any
      // update to them — so "applied once" is the INTENT's own execution
      // record: the REFUND_EXECUTED audit row this transaction writes. A
      // forced replay (an operator re-queuing an executed intent) finds it
      // and moves no money twice; booking flips are count-checked besides.
      const executedBefore = (await tx.adsAuditLog.count({ where: { entityType: 'AdRefundIntent', entityId: intentId, action: 'REFUND_EXECUTED' } })) > 0;
      let refundedMinor = 0n; let creditedMinor = 0n; let releasedSlots = 0;
      for (const item of intent.items) {
        if (item.kind === 'REFUND') {
          const booking = await tx.adBooking.findUnique({ where: { id: item.bookingId }, select: { placementId: true, city: true, weekStart: true } });
          const moved = await tx.adBooking.updateMany({ where: { id: item.bookingId, status: { in: ['CONFIRMED', 'RESERVED'] } }, data: { status: 'REFUNDED' } });
          if (moved.count === 1) {
            if (booking) await tx.adInventoryWeek.updateMany({ where: { placementId: booking.placementId, city: booking.city, weekStart: booking.weekStart, booked: { gt: 0 } }, data: { booked: { decrement: 1 } } });
            releasedSlots += 1;
            // Counted only when THIS execution flipped the booking: a forced
            // replay (an operator re-queuing an executed intent) moves nothing twice.
            refundedMinor += item.amountMinor;
          } else if (!executedBefore && intent.reason === 'LATE_CAPTURE') {
            // [R045-ADS-05] A late-capture item's booking was RELEASED by the
            // expiry — nothing to flip, but the money is owed back in full, once.
            refundedMinor += item.amountMinor;
          }
        } else if (!executedBefore) {
          // [R045-ADS-02] The credit is a persisted liability: the balance moves once.
          await tx.advertiser.update({ where: { id: intent.campaign.advertiserId }, data: { creditBalance: { increment: new Prisma.Decimal(minorToMajorString(item.amountMinor, intent.currency || CURRENCY_FALLBACK)) } } });
          creditedMinor += item.amountMinor;
        }
      }
      if (refundedMinor > 0n) {
        const inv = await tx.adInvoice.findUnique({ where: { id: intent.invoiceId }, select: { id: true, amount: true, refundedAmount: true, currency: true } });
        if (inv) {
          const currency = inv.currency || intent.currency;
          const newRefundedMinor = majorDecimalToMinor(String(inv.refundedAmount), currency) + refundedMinor;
          const fully = newRefundedMinor >= majorDecimalToMinor(String(inv.amount), currency);
          await tx.adInvoice.update({ where: { id: inv.id }, data: { refundedAmount: new Prisma.Decimal(minorToMajorString(newRefundedMinor, currency)), status: fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
        }
      }
      // Executed: money is owed and recorded; the payout is a human's act
      // with a reference (settleManual) — MANUAL_REQUIRED until then.
      await tx.adRefundIntent.update({ where: { id: intentId }, data: { status: 'MANUAL_REQUIRED', payoutRail: 'MANUAL' } });
      await tx.adsAuditLog.create({
        data: {
          tenantId: intent.tenantId, actorUserId: intent.requestedByUserId ?? 'system:ad-refund-worker', action: 'REFUND_EXECUTED', entityType: 'AdRefundIntent', entityId: intentId,
          after: { reason: intent.reason, refundedMinor: refundedMinor.toString(), creditedMinor: creditedMinor.toString(), releasedSlots, items: intent.items.map((i) => ({ bookingId: i.bookingId, kind: i.kind, amountMinor: i.amountMinor.toString() })) } as never,
          reason: intent.reason,
        },
      });
      adRefundCounter.labels('executed').inc();
      if (creditedMinor > 0n) adRefundCounter.labels('credited').inc();
      return { executed: true, refundedMinor, creditedMinor, releasedSlots };
    });
  }

  /** [R045-ADS-05] Money that arrived after the hold expired: the full invoice
   *  amount becomes a refund obligation in the caller's transaction — one
   *  REFUND item per booking the expiry released (nothing to flip; the amount
   *  is owed) — keyed to the invoice so a replayed capture is the same intent. */
  async stageLateCapture(tx: Prisma.TransactionClient, campaignId: string, invoiceId: string, actor: string | null): Promise<StagedRefund> {
    const campaign = await tx.adCampaign.findUniqueOrThrow({ where: { id: campaignId }, select: { tenantId: true } });
    const invoice = await tx.adInvoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { amount: true, currency: true } });
    const idempotencyKey = `ad-refund:${campaignId}:LATE_CAPTURE:${invoiceId}`;
    const existing = await tx.adRefundIntent.findUnique({ where: { idempotencyKey }, select: { id: true, amountMinor: true } });
    if (existing) return { intentId: existing.id, staged: false, totalMinor: existing.amountMinor };
    const currency = invoice.currency || CURRENCY_FALLBACK;
    const bookings = await tx.adBooking.findMany({ where: { campaignId }, select: { id: true, amount: true } });
    const totalMinor = majorDecimalToMinor(String(invoice.amount), currency);
    const intent = await tx.adRefundIntent.create({
      data: {
        tenantId: campaign.tenantId, invoiceId, campaignId, idempotencyKey, reason: 'LATE_CAPTURE',
        status: 'PENDING', amountMinor: totalMinor, currency, payoutRail: 'MANUAL', correlationId: idempotencyKey, requestedByUserId: actor,
      },
      select: { id: true },
    });
    if (bookings.length > 0) {
      await tx.adRefundItem.createMany({ data: bookings.map((b) => ({ tenantId: campaign.tenantId, refundIntentId: intent.id, campaignId, bookingId: b.id, kind: 'REFUND' as const, amountMinor: majorDecimalToMinor(String(b.amount), currency) })) });
    }
    await tx.adRefundOutbox.create({ data: { tenantId: campaign.tenantId, refundIntentId: intent.id, dedupeKey: idempotencyKey, payload: { campaignId, reason: 'LATE_CAPTURE', invoiceId }, correlationId: idempotencyKey } });
    adRefundCounter.labels('staged').inc();
    return { intentId: intent.id, staged: true, totalMinor };
  }

  /** The human's payout reference is the evidence that settles an executed intent. */
  async settleManual(intentId: string, manualPayoutRef: string, actor: string, onAudit?: OnAudit): Promise<void> {
    const intent = await this.prisma.adRefundIntent.findUnique({ where: { id: intentId }, select: { id: true, status: true, tenantId: true, amountMinor: true, currency: true } });
    if (!intent) throw new NotFoundError('AdRefundIntent', intentId);
    if (intent.status === 'SUCCEEDED') return;
    if (intent.status !== 'MANUAL_REQUIRED') throw new AppError(409, 'REFUND_NOT_EXECUTED', `This refund is ${intent.status}; it can be settled once it has executed.`);
    await this.prisma.$transaction(async (tx) => {
      await tx.adRefundIntent.update({ where: { id: intentId }, data: { status: 'SUCCEEDED', manualPayoutRef, completedAt: new Date() } });
      await tx.adsAuditLog.create({ data: { tenantId: intent.tenantId, actorUserId: actor, action: 'REFUND_SETTLED', entityType: 'AdRefundIntent', entityId: intentId, after: { manualPayoutRef, amountMinor: intent.amountMinor.toString(), currency: intent.currency } as never } });
      // [ADM-002] The caller's audit row is the last statement of the settlement.
      await onAudit?.(tx, { manualPayoutRef, amountMinor: intent.amountMinor.toString(), currency: intent.currency });
    });
    adRefundCounter.labels('settled').inc();
  }

  /** Drain due outbox rows with a lease: each row executes its intent once;
   *  a failure backs off and retries; exhausted attempts dead-letter, FAIL the
   *  intent and page. The kill switch stops execution, never staging. */
  async drainOutbox(options: { limit?: number; leaseMs?: number; intentIds?: string[] } = {}): Promise<{ processed: number; failed: number; deadLettered: number }> {
    if (adRefundExecutionKilled()) return { processed: 0, failed: 0, deadLettered: 0 };
    const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
    const limit = Math.max(1, options.limit ?? 50);
    let processed = 0; let failed = 0; let deadLettered = 0;
    for (let i = 0; i < limit; i += 1) {
      const filter = options.intentIds?.length ? Prisma.sql`AND "refundIntentId" IN (${Prisma.join(options.intentIds)})` : Prisma.empty;
      const rows = await this.prisma.$queryRaw<Array<{ id: string; refundIntentId: string; attempts: number; maxAttempts: number; tenantId: string }>>(Prisma.sql`
        WITH candidate AS (
          SELECT "id" FROM "ad_refund_outbox"
          WHERE "processedAt" IS NULL AND "deadLetteredAt" IS NULL AND "availableAt" <= CURRENT_TIMESTAMP
            AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < CURRENT_TIMESTAMP) ${filter}
          ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE "ad_refund_outbox" AS o
        SET "leaseOwner" = 'worker', "leaseToken" = gen_random_uuid()::text, "leaseExpiresAt" = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'), "attempts" = o."attempts" + 1, "updatedAt" = CURRENT_TIMESTAMP
        FROM candidate WHERE o."id" = candidate."id"
        RETURNING o."id", o."refundIntentId", o."attempts", o."maxAttempts", o."tenantId"`);
      const row = rows[0];
      if (!row) break;
      try {
        const result = await this.executeIntent(row.refundIntentId);
        // The lease is a tuple the database guards (owner, token, expiry all set or all null); a terminal row holds no lease.
        await this.prisma.adRefundOutbox.update({ where: { id: row.id }, data: { processedAt: new Date(), leaseExpiresAt: null, leaseOwner: null, leaseToken: null, lastError: null } });
        processed += 1;
        if (result.executed) await this.payoutTask(row.refundIntentId, result).catch(() => {});
      } catch (err) {
        failed += 1;
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 2_000);
        const exhausted = row.attempts >= row.maxAttempts;
        await this.prisma.adRefundOutbox.update({
          where: { id: row.id },
          data: { leaseExpiresAt: null, leaseOwner: null, leaseToken: null, lastError: message, availableAt: new Date(Date.now() + Math.min(6 * 3_600_000, 30_000 * 2 ** Math.min(row.attempts, 10))), ...(exhausted ? { deadLetteredAt: new Date() } : {}) },
        }).catch(() => {});
        if (exhausted) {
          deadLettered += 1;
          await this.prisma.adRefundIntent.updateMany({ where: { id: row.refundIntentId, status: { in: ['PENDING', 'PROCESSING'] } }, data: { status: 'FAILED', failureCode: 'EXECUTION_EXHAUSTED', failureDetail: message } }).catch(() => {});
          adRefundCounter.labels('dead_letter').inc();
        }
        log().warn({ err, outboxId: row.id, intentId: row.refundIntentId, attempts: row.attempts, exhausted }, '[R045-ADS] ad refund execution failed — will retry');
      }
    }
    return { processed, failed, deadLettered };
  }

  /** The manual payout task — computed by the executor, paid by a human. */
  private async payoutTask(intentId: string, result: { refundedMinor: bigint; creditedMinor: bigint }): Promise<void> {
    const intent = await this.prisma.adRefundIntent.findUnique({ where: { id: intentId }, include: { campaign: { select: { name: true, advertiserId: true, tenantId: true } } } });
    if (!intent || result.refundedMinor + result.creditedMinor === 0n) return;
    const currency = intent.currency || CURRENCY_FALLBACK;
    await notifyAdmins(this.prisma, this.notifications, {
      tenantId: intent.campaign.tenantId ?? null,
      title: 'Ad refund — manual payout needed',
      body: `Campaign ${intent.campaign.name}: refund ${minorToMajorString(result.refundedMinor, currency)} ${currency} + credit ${minorToMajorString(result.creditedMinor, currency)} ${currency} (${intent.reason}). Pay the advertiser, then settle intent ${intentId} with the payout reference.`,
      data: { kind: 'ad_refund_payout_task', campaignId: intent.campaignId, advertiserId: intent.campaign.advertiserId, intentId, refundedMinor: result.refundedMinor.toString(), creditedMinor: result.creditedMinor.toString(), reason: intent.reason },
    });
  }

  /** Compatibility: stage in its own transaction, then execute now. Callers
   *  that own a transition use the lifecycle's `within` hook instead. */
  async execute(campaignId: string, reason: RefundReason, actorUserId: string, opts: Omit<RefundOpts, 'now'> & { now?: Date; eventKey?: string } = {}): Promise<RefundExecResult> {
    const staged = await this.prisma.$transaction((tx) => this.stage(tx, campaignId, reason, actorUserId, opts));
    if (!staged) return { planTotal: 0, refundedTotal: 0, creditedTotal: 0, releasedSlots: 0, intentId: null };
    return this.executeNow(staged.intentId);
  }

  /** Drain one staged intent right away (low latency); the tick retries it otherwise. */
  async executeNow(intentId: string): Promise<RefundExecResult> {
    await this.drainOutbox({ intentIds: [intentId], limit: 1 });
    const intent = await this.prisma.adRefundIntent.findUniqueOrThrow({ where: { id: intentId }, include: { items: true } });
    const currency = intent.currency || CURRENCY_FALLBACK;
    const refunded = intent.items.filter((i) => i.kind === 'REFUND').reduce((s, i) => s + i.amountMinor, 0n);
    const credited = intent.items.filter((i) => i.kind === 'CREDIT').reduce((s, i) => s + i.amountMinor, 0n);
    const executed = intent.status === 'MANUAL_REQUIRED' || intent.status === 'SUCCEEDED';
    return { planTotal: major(intent.amountMinor, currency), refundedTotal: executed ? major(refunded, currency) : 0, creditedTotal: executed ? major(credited, currency) : 0, releasedSlots: executed ? intent.items.filter((i) => i.kind === 'REFUND').length : 0, intentId };
  }
}

export interface AdRefundScan {
  outstanding: { count: number; amountMinor: bigint; oldestMinutes: number };
  awaitingPayout: { count: number; amountMinor: bigint };
  failed: number;
  terminalWithoutIntent: Array<{ campaignId: string; status: string; invoiceId: string }>;
}

/** [operations] Outstanding amount and age, failures, and every terminal paid
 *  campaign that has no intent — the backfill's population and the page. */
export async function scanAdRefunds(prisma: PrismaClient): Promise<AdRefundScan> {
  const [agg] = await prisma.$queryRaw<Array<{ pending: bigint; pending_minor: bigint; oldest_minutes: number | null; manual: bigint; manual_minor: bigint; failed: bigint }>>`
    SELECT
      count(*) FILTER (WHERE "status" IN ('PENDING', 'PROCESSING'))::bigint AS pending,
      coalesce(sum("amountMinor") FILTER (WHERE "status" IN ('PENDING', 'PROCESSING')), 0)::bigint AS pending_minor,
      extract(epoch FROM (CURRENT_TIMESTAMP - min("createdAt") FILTER (WHERE "status" IN ('PENDING', 'PROCESSING')))) / 60 AS oldest_minutes,
      count(*) FILTER (WHERE "status" = 'MANUAL_REQUIRED')::bigint AS manual,
      coalesce(sum("amountMinor") FILTER (WHERE "status" = 'MANUAL_REQUIRED'), 0)::bigint AS manual_minor,
      count(*) FILTER (WHERE "status" = 'FAILED')::bigint AS failed
    FROM "ad_refund_intents"`;
  const orphans = await prisma.$queryRaw<Array<{ campaignId: string; status: string; invoiceId: string }>>`
    SELECT c."id" AS "campaignId", c."status"::text AS status, i."id" AS "invoiceId"
    FROM "ad_campaigns" c
    JOIN "ad_invoices" i ON i."campaignId" = c."id" AND i."status" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
    WHERE c."status" IN ('CANCELLED', 'REJECTED')
      AND NOT EXISTS (SELECT 1 FROM "ad_refund_intents" r WHERE r."campaignId" = c."id")
      AND EXISTS (SELECT 1 FROM "ad_bookings" b WHERE b."campaignId" = c."id" AND b."status" IN ('CONFIRMED', 'RESERVED', 'REFUNDED'))
    ORDER BY c."updatedAt" DESC LIMIT 200`;
  const scan: AdRefundScan = {
    outstanding: { count: Number(agg?.pending ?? 0), amountMinor: BigInt(agg?.pending_minor ?? 0), oldestMinutes: Math.max(0, Math.round(Number(agg?.oldest_minutes ?? 0))) },
    awaitingPayout: { count: Number(agg?.manual ?? 0), amountMinor: BigInt(agg?.manual_minor ?? 0) },
    failed: Number(agg?.failed ?? 0),
    terminalWithoutIntent: orphans,
  };
  adRefundGauge.labels('outstanding').set(scan.outstanding.count);
  adRefundGauge.labels('outstanding_minor').set(Number(scan.outstanding.amountMinor));
  adRefundGauge.labels('outstanding_oldest_minutes').set(scan.outstanding.oldestMinutes);
  adRefundGauge.labels('awaiting_payout').set(scan.awaitingPayout.count);
  adRefundGauge.labels('failed').set(scan.failed);
  adRefundGauge.labels('terminal_without_intent').set(scan.terminalWithoutIntent.length);
  return scan;
}

/** [operations] Backfill: every terminal paid campaign without an intent gets
 *  one from its bookings and its audit trail — the legacy executor already
 *  moved the bookings and the invoice, so the intent is recorded as executed
 *  and awaiting the payout evidence (MANUAL_REQUIRED), never re-executed.
 *  Dry run lists what would be created; a tenant filter is the canary. */
export async function backfillAdRefundIntents(prisma: PrismaClient, opts: { dryRun: boolean; tenantId?: string; limit?: number; actor?: string; campaignIds?: string[] }): Promise<{ candidates: Array<{ campaignId: string; reason: string; amountMinor: string }>; created: number }> {
  const scan = await scanAdRefunds(prisma);
  const candidates: Array<{ campaignId: string; reason: string; amountMinor: string; invoiceId: string; tenantId: string; items: Array<{ bookingId: string; kind: 'REFUND' | 'CREDIT'; amountMinor: bigint }> }> = [];
  for (const orphan of scan.terminalWithoutIntent.filter((o) => !opts.campaignIds || opts.campaignIds.includes(o.campaignId)).slice(0, opts.limit ?? 100)) {
    const campaign = await prisma.adCampaign.findUnique({ where: { id: orphan.campaignId }, select: { id: true, tenantId: true } });
    if (!campaign || (opts.tenantId && campaign.tenantId !== opts.tenantId)) continue;
    const audit = await prisma.adsAuditLog.findFirst({ where: { entityId: orphan.campaignId, action: { in: ['CAMPAIGN_KILL', 'CAMPAIGN_CANCEL', 'CAMPAIGN_AUTO_CANCEL_UNAPPROVED'] } }, orderBy: { createdAt: 'desc' }, select: { action: true } });
    const reason = audit?.action === 'CAMPAIGN_KILL' ? 'ADMIN_KILL' : audit?.action === 'CAMPAIGN_AUTO_CANCEL_UNAPPROVED' ? 'AUTO_CANCEL_UNAPPROVED' : 'ADVERTISER_CANCEL';
    const refunded = await prisma.adBooking.findMany({ where: { campaignId: orphan.campaignId, status: 'REFUNDED' }, select: { id: true, amount: true } });
    const items = refunded.map((b) => ({ bookingId: b.id, kind: 'REFUND' as const, amountMinor: majorDecimalToMinor(String(b.amount), CURRENCY_FALLBACK) }));
    const amountMinor = items.reduce((s, i) => s + i.amountMinor, 0n);
    if (amountMinor === 0n) continue;
    candidates.push({ campaignId: orphan.campaignId, reason, amountMinor: amountMinor.toString(), invoiceId: orphan.invoiceId, tenantId: campaign.tenantId, items });
  }
  let created = 0;
  if (!opts.dryRun) {
    for (const c of candidates) {
      const idempotencyKey = `ad-refund:${c.campaignId}:${c.reason}:backfill`;
      const invoice = await prisma.adInvoice.findUnique({ where: { id: c.invoiceId }, select: { currency: true } });
      await prisma.$transaction(async (tx) => {
        const intent = await tx.adRefundIntent.create({
          data: {
            tenantId: c.tenantId, invoiceId: c.invoiceId, campaignId: c.campaignId, idempotencyKey, reason: c.reason as AdRefundReason,
            status: 'MANUAL_REQUIRED', amountMinor: BigInt(c.amountMinor), currency: invoice?.currency ?? CURRENCY_FALLBACK, payoutRail: 'MANUAL', provider: 'LEGACY_BACKFILL',
            correlationId: idempotencyKey, requestedByUserId: opts.actor ?? 'system:backfill',
          },
          select: { id: true },
        });
        await tx.adRefundItem.createMany({ data: c.items.map((i) => ({ tenantId: c.tenantId, refundIntentId: intent.id, campaignId: c.campaignId, bookingId: i.bookingId, kind: i.kind, amountMinor: i.amountMinor })) });
      }).then(() => { created += 1; }).catch((err: unknown) => log().warn({ err, campaignId: c.campaignId }, '[R045-ADS] backfill skipped one campaign'));
    }
  }
  return { candidates: candidates.map((c) => ({ campaignId: c.campaignId, reason: c.reason, amountMinor: c.amountMinor })), created };
}
