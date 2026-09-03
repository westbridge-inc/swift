import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type Redis from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import type { FastifyBaseLogger } from 'fastify';
import { captureError, osrmOutcomeCounter } from '../plugins/observability';
import { AppError } from '../utils/errors';
import { closeResourcesBounded, idempotentAsync, positiveDurationMs } from '../utils/async-lifecycle';
import { runWithTenant } from '../plugins/tenant-context';
import {
  requireActiveDiscoveryTenant,
  runForActiveDiscoveryTenants,
} from '../modules/discovery/tenant-boundary';

export interface JobContext {
  prisma: PrismaClient;
  io: Server;
  redis: Redis;
  log: FastifyBaseLogger;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Decorated in server.ts when background queues are up */
    queues?: ReturnType<typeof createQueues>;
    /** False when RUN_WORKERS=0 — this process enqueues but never consumes
     *  (a dedicated worker process owns the queues). [SWIFT-AUD-D7-01] */
    workersActive?: boolean;
  }
}

const QUEUE_NAMES = {
  ORDER: 'order-jobs',
  SUBSCRIPTION: 'subscription-jobs',
  SETTLEMENT: 'settlement-jobs',
  NOTIFICATION: 'notification-jobs',
  VERIFICATION: 'verification-jobs',
  DISPATCH: 'dispatch-jobs',
  SEARCH: 'search-jobs',
} as const;

export { QUEUE_NAMES };

/**
 * SWIFT-007: BullMQ's connection must carry EVERYTHING REDIS_URL encodes — auth
 * (username/password), TLS, and the db index — not just host+port. The old
 * `{ host, port }` silently dropped the password and TLS (so jobs never connect
 * to a managed/authenticated Redis — they die on the floor) and the db suffix
 * (test jobs landed on db0 instead of the isolated db15). IORedis already parsed
 * the URL into `.options`; forward the connection-relevant fields to EVERY Queue
 * and Worker so a single source (REDIS_URL) configures them all.
 */
export function bullConnectionOpts(redis: Redis): ConnectionOptions {
  const o = redis.options;
  return {
    host: o.host,
    port: o.port,
    ...(o.username ? { username: o.username } : {}),
    ...(o.password ? { password: o.password } : {}),
    ...(o.db != null ? { db: o.db } : {}),
    ...(o.tls ? { tls: o.tls } : {}),
    ...(o.family ? { family: o.family } : {}),
  };
}

/** Bounded retry with exponential backoff on EVERY job. All jobs are idempotent
 *  — money jobs guard with DB-level uniqueness/CAS, the repeatable ticks
 *  recompute their window — so a transient blip (DB/Redis/provider hiccup) is
 *  retried in seconds instead of silently lost until the next scheduled tick or
 *  reconcile sweep. removeOnFail keeps the last failures for inspection only
 *  AFTER the attempts are exhausted. Env-tunable so ops can widen it without a
 *  deploy. Exported so a test can pin the policy without opening a Redis socket. */
/**
 * [C2 · WS-0.2] When OSRM is configured but a call times out, errors, or
 * returns no route, `OsrmMapsProvider` degrades to the straight-line estimate
 * and dispatch carries on. That is the right behaviour — a routing outage must
 * not stop deliveries — but it is INVISIBLE, and it is not a small error.
 *
 * Measured on the live Guyana extract, 2026-08-28, Stabroek Market to
 * Vreed-en-Hoop (across the Demerara, via the Harbour Bridge): the road route
 * is 19.07 km, the straight-line estimate 6.72 km. So a silent fallback prices
 * that delivery at about a THIRD of the distance the mover actually rides, and
 * the mover absorbs the difference on every cross-river job until someone
 * notices. Fares, ETAs and dispatch ranking all read from the same seam, so
 * they go wrong together.
 *
 * The Prometheus counter has always made the rate visible. Nothing PAGED on it,
 * and there is no metrics backend deployed yet, so "visible" meant visible to
 * nobody.
 */
export function osrmFallbackAlertPct(env: Record<string, string | undefined> = process.env): number {
  const raw = env['OSRM_FALLBACK_ALERT_PCT']?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return 25;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : 25;
}

/** Minimum calls in the window before a rate means anything. One fallback out
 *  of one call is 100% and pages nobody usefully. */
export function osrmFallbackMinCalls(env: Record<string, string | undefined> = process.env): number {
  const raw = env['OSRM_FALLBACK_ALERT_MIN_CALLS']?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return 20;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : 20;
}

/** Previous heartbeat's cumulative OSRM totals, so the alarm reads the RATE
 *  OVER THE LAST INTERVAL rather than since process start. A lifetime ratio
 *  stays high for days after a resolved outage and then means nothing. */
let lastOsrmTotals: { ok: number; fallback: number } | null = null;

/** How many dead letters must be sitting there before admins are paged.
 *  Default 1 — one dead money job is worth a page, and `opsPageOnce` already
 *  caps the noise at one page per 30 minutes. Total-parsed (REPORT-036): a
 *  non-numeric value falls back to the default rather than becoming NaN, which
 *  would make `total >= NaN` false forever and silently disable the alarm. */
export function dlqAlertThreshold(env: Record<string, string | undefined> = process.env): number {
  const raw = env['DLQ_ALERT_THRESHOLD']?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return 1;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

export const DEFAULT_JOB_OPTIONS = {
  attempts: Math.max(1, Number(process.env['JOB_MAX_ATTEMPTS'] ?? 3)),
  backoff: { type: 'exponential' as const, delay: Math.max(100, Number(process.env['JOB_BACKOFF_MS'] ?? 5_000)) },
  removeOnComplete: 100,
  removeOnFail: 50,
};

export type SwiftQueues = {
  orderQueue: Queue;
  subscriptionQueue: Queue;
  settlementQueue: Queue;
  notificationQueue: Queue;
  verificationQueue: Queue;
  dispatchQueue: Queue;
  searchQueue: Queue;
};

export function createQueues(
  redis: Redis,
  log?: Pick<FastifyBaseLogger, 'error'>,
): SwiftQueues {
  const connection = bullConnectionOpts(redis);
  const defaultJobOptions = DEFAULT_JOB_OPTIONS;
  const created: Queue[] = [];
  const build = (name: string): Queue => {
    const queue = new Queue(name, { connection, defaultJobOptions });
    // EventEmitter treats an unobserved `error` as fatal. Every shared producer
    // gets its listener at construction time, before its Redis connection can
    // fail asynchronously during boot or reconnect.
    queue.on('error', (err) => {
      log?.error({ queue: name, err }, 'BullMQ queue error');
      try {
        captureError(err, { queue: name, component: 'bullmq-producer' });
      } catch (captureFailure) {
        log?.error({ queue: name, err: captureFailure }, 'Failed to capture BullMQ queue error');
      }
    });
    created.push(queue);
    return queue;
  };

  try {
    return {
      orderQueue: build(QUEUE_NAMES.ORDER),
      subscriptionQueue: build(QUEUE_NAMES.SUBSCRIPTION),
      settlementQueue: build(QUEUE_NAMES.SETTLEMENT),
      notificationQueue: build(QUEUE_NAMES.NOTIFICATION),
      verificationQueue: build(QUEUE_NAMES.VERIFICATION),
      dispatchQueue: build(QUEUE_NAMES.DISPATCH),
      searchQueue: build(QUEUE_NAMES.SEARCH),
    };
  } catch (error) {
    // Constructors are synchronous, but their Redis clients may already be
    // connecting. Observe every close promise so partial construction cannot
    // surface a later unhandled rejection while the caller fails boot.
    void Promise.allSettled(created.map((queue) => Promise.resolve().then(() => queue.close())));
    throw error;
  }
}

export async function enqueueVendorAlertFollowup(
  queues: Pick<SwiftQueues, 'notificationQueue'>,
  orderId: string,
): Promise<void> {
  await queues.notificationQueue.add('vendor-alert-escalate', { orderId, level: 1 }, {
    // §A1: SMS at +75s total when loud (30+45); default stays 60+60.
    delay: process.env['ALERTS_LOUD'] === '1' ? 45_000 : 60_000,
    removeOnComplete: 100,
    removeOnFail: 50,
  });
}

/** Weekly vendor settlement snapshot [SWIFT-AUD-D6-05 / D7-01].
 *  Exported so tests can drive it directly; the settlement worker delegates
 *  here. BullMQ single-delivery keeps the schedule from double-firing across
 *  instances — this function's own guard is what makes a RETRY or an operator
 *  requeue safe (see the covered-window check). */
export async function runWeeklySettlement(ctx: JobContext) {
  // [M-27] The weekly SALES DIGEST on canonical calendar weeks — one row per
  // vendor and period, enforced by the database; every vendor that sold;
  // discounts allocated; then the ledger delta for the recent periods.
  const { generateSalesDigests, scanSalesDigestDelta } = await import('../modules/billing/sales-digest');
  const res = await generateSalesDigests(ctx.prisma);
  ctx.log.info({ settlements: res.created, periods: res.periods }, 'Sales digests created');
  const delta = await scanSalesDigestDelta(ctx.prisma);
  if (delta.length > 0) ctx.log.warn({ count: delta.length }, '[M-27] sales digests differ from the ledger — adjust them');
}

/** One ops page per condition per window [SWIFT-AUD-D7-02]: redis SET NX is
 *  the dedup, so N instances or repeated scans can never spam the admins.
 *  Fire-and-caught — paging must not fail the job that noticed the problem. */
export async function opsPageOnce(
  ctx: Pick<JobContext, 'redis'>,
  key: string,
  ttlSeconds: number,
  page: () => Promise<unknown>,
): Promise<boolean> {
  const redisKey = `ops_page:${key}`;
  // Claim FIRST so concurrent scans can't both page (the NX is the mutual
  // exclusion). But claiming before the page succeeds means a transient notify
  // failure would leave the key set and SILENTLY suppress this condition for the
  // whole window with no admin ever reached — worst on the highest-stakes alerts.
  let claimed: unknown;
  try {
    claimed = await ctx.redis.set(redisKey, '1', 'EX', ttlSeconds, 'NX');
  } catch {
    return false; // couldn't even claim — a later scan retries
  }
  if (claimed !== 'OK') return false;
  try {
    await page();
    return true;
  } catch {
    // The page failed — release the claim so the NEXT detection re-pages rather
    // than staying dark until the TTL expires. Best-effort; if this del also
    // fails, TTL expiry eventually reopens paging.
    await ctx.redis.del(redisKey).catch(() => {});
    return false;
  }
}

/** Vendor-no-response auto-cancel [SWIFT-021]. Exported so tests drive it
 *  directly; the order worker delegates here. The canonical locked transition
 *  revalidates that the order is STILL PENDING and no longer HELD, then commits
 *  cancellation, booking/search closure, restock, mover/float cleanup, and the
 *  immutable status log in one boundary. It leaves `cancelledBy` unset, so this
 *  NEVER counts against the customer's risk score (the vendor was silent, not
 *  the customer; the risk query requires cancelledBy === the customer). */
export async function autoCancelUnresponsiveOrder(ctx: JobContext, orderId: string): Promise<boolean> {
  const { OrderService } = await import('../modules/order/order.service');
  const reason = 'Auto-cancelled: vendor did not respond';
  // [REPORT-007-v4 F-02] Read the payment shape BEFORE the transition: an MMG
  // order's customer may have paid externally without the store attesting, so
  // the copy below must never claim "you were not charged" for MMG.
  const paymentPreview = await ctx.prisma.order.findUnique({
    where: { id: orderId },
    select: { paymentMethod: true, paymentStatus: true },
  });
  const mmgAmbiguous = paymentPreview?.paymentMethod === 'MOBILE_MONEY';
  let order: { vendorId: string | null; customerId: string; orderNumber: string };
  try {
    ({ order } = await new OrderService(ctx.prisma, ctx.io).transitionOrderAtomically({
      orderId,
      target: 'CANCELLED',
      allowedFrom: ['PENDING'],
      changedBy: null,
      note: reason,
      cancellation: { by: null, reason },
      requireHoldExpired: true,
      releaseStaleMoverPointer: true,
      invalidStatus: () => new AppError(409, 'AUTO_CANCEL_NOT_ELIGIBLE', 'Order is held or no longer pending'),
    }));
  } catch (error) {
    if (error instanceof AppError && (error.code === 'AUTO_CANCEL_NOT_ELIGIBLE' || error.code === 'NOT_FOUND')) {
      return false; // held, already accepted, already cancelled, or gone — no-op
    }
    // [REPORT-006 F-006-01] A vendor who confirmed the MMG payment landed HAS
    // responded — auto-cancelling would mint CANCELLED+CAPTURED with no refund
    // rail. The canonical seam refuses; treat it as a clean no-op, not a
    // BullMQ retry loop.
    if (error instanceof AppError && error.code === 'MMG_CANCEL_UNAVAILABLE') {
      return false;
    }
    throw error;
  }

  ctx.io.to(`order:${orderId}`).emit('order:status_changed', { orderId, status: 'CANCELLED' });
  if (order.vendorId) ctx.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', { orderId, status: 'CANCELLED' });

  const { NotificationService } = await import('../modules/notification/notification.service');
  const notifications = new NotificationService(ctx.prisma, ctx.io);
  await notifications.send({
    userId: order.customerId,
    type: 'ORDER_UPDATE',
    title: 'Order cancelled — no response',
    body: mmgAmbiguous
      ? `We're sorry — the store didn't respond to order ${order.orderNumber} in time, so it was cancelled. If you already sent the MMG payment, the store refunds you directly; please try another store.`
      : `We're sorry — the store didn't respond to order ${order.orderNumber} in time, so it was cancelled. You were not charged; please try another store.`,
    data: { orderId, status: 'CANCELLED' },
  });
  // [REPORT-007-v4 F-02 → REPORT-012 F-012-04] The store holds the only rail
  // that can make an already-paid MMG customer whole — every operational
  // cancellation flows through the ONE publication seam.
  if (mmgAmbiguous && order.vendorId) {
    const { publishUnattestedMmgCancellation } = await import('../modules/order/order.service');
    await publishUnattestedMmgCancellation(ctx.prisma, notifications, {
      orderId,
      orderNumber: order.orderNumber,
      vendorId: order.vendorId,
      storeBody: `Order ${order.orderNumber} was auto-cancelled (no response) before its MMG payment was confirmed. If the customer's transfer arrived in your MMG, refund them directly.`,
    });
  }
  ctx.log.info({ orderId }, 'Order auto-cancelled (vendor no-response)');
  return true;
}

/** Delivery-window auto-completion. COMPLETED and its immutable status log
 * share the canonical row-lock transaction; retries after a committed attempt
 * are a clean no-op, while an injected pre-commit failure leaves DELIVERED for
 * BullMQ to retry. */
export async function autoCompleteDeliveredOrder(ctx: JobContext, orderId: string): Promise<boolean> {
  const { OrderService } = await import('../modules/order/order.service');
  try {
    await new OrderService(ctx.prisma, ctx.io).transitionOrderAtomically({
      orderId,
      target: 'COMPLETED',
      allowedFrom: ['DELIVERED'],
      changedBy: null,
      note: 'Auto-completed after delivery window',
      invalidStatus: () => new AppError(409, 'AUTO_COMPLETE_NOT_ELIGIBLE', 'Order is not awaiting auto-completion'),
    });
  } catch (error) {
    if (error instanceof AppError && (error.code === 'AUTO_COMPLETE_NOT_ELIGIBLE' || error.code === 'NOT_FOUND')) {
      return false;
    }
    throw error;
  }

  try {
    ctx.log.info({ orderId }, 'Order auto-completed');
  } catch {
    // Logging cannot turn a committed terminal transition into a failed job.
  }
  return true;
}

/** SWIFT-164 — periodic vendor↔rider collusion affinity scan. Surfaces pairs
 *  with an unusual concentration of guarantee claims to admins for review (via
 *  opsPageOnce so a standing pattern pages once, not every run). Detection only;
 *  never an automatic money action. Exported so tests can drive it directly. */
export async function runCollusionAffinityScan(ctx: JobContext): Promise<{ flaggedPairs: number }> {
  const { scanVendorRiderClaimAffinity } = await import('../modules/cash/cash-rules.service');
  const pairs = await scanVendorRiderClaimAffinity(ctx.prisma);
  if (pairs.length > 0) {
    const { notifyAdmins, NotificationService } = await import('../modules/notification/notification.service');
    await opsPageOnce(ctx, 'vendor-rider-collusion', 6 * 3600, () =>
      notifyAdmins(ctx.prisma, new NotificationService(ctx.prisma, ctx.io), {
        // Platform-wide ops page: an aggregate scan or infra alarm, not one
        // tenant's event. Explicitly null so it reads as a decision [NOC-A F45].
        tenantId: null,
        title: 'Possible vendor–rider collusion',
        body: `${pairs.length} vendor–rider pair(s) show an unusual concentration of guarantee claims. Review the claims dashboard before the next settlement.`,
        data: { kind: 'ops_collusion_affinity', pairs: pairs.slice(0, 20) },
      }),
    );
  }
  ctx.log.info({ flaggedPairs: pairs.length }, 'Vendor–rider collusion affinity scan');
  return { flaggedPairs: pairs.length };
}

export async function createWorkers(ctx: JobContext, queues: SwiftQueues) {
  const connection = bullConnectionOpts(ctx.redis);
  const constructedWorkers: Worker[] = [];
  const buildWorker = (
    name: string,
    processor: (job: Job) => Promise<void>,
    options: { connection: ConnectionOptions; concurrency: number },
  ): Worker => {
    // Two-phase boot: constructing a Worker normally starts its processor
    // immediately. Keep every consumer dormant until all seven connections and
    // every recurring schedule are committed by initializeJobRuntime.
    const worker = new Worker(name, processor, { ...options, autorun: false });
    constructedWorkers.push(worker);
    worker.on('failed', (job, err) => {
      ctx.log.error({ queue: name, jobName: job?.name, jobId: job?.id, attempts: job?.attemptsMade, data: job?.data, err }, 'BullMQ job failed');
      try {
        captureError(err, { queue: name, jobName: job?.name, jobId: job?.id, attempts: job?.attemptsMade });
      } catch (captureFailure) {
        ctx.log.error({ queue: name, err: captureFailure }, 'Failed to capture BullMQ job failure');
      }
    });
    worker.on('error', (err) => {
      ctx.log.error({ queue: name, err }, 'BullMQ worker error');
      try {
        captureError(err, { queue: name });
      } catch (captureFailure) {
        ctx.log.error({ queue: name, err: captureFailure }, 'Failed to capture BullMQ worker error');
      }
    });
    return worker;
  };

  try {

  // ORDER JOBS: auto-cancel, auto-complete
  const orderWorker = buildWorker(
    QUEUE_NAMES.ORDER,
    async (job: Job) => {
      switch (job.name) {
        case 'auto-cancel': {
          await autoCancelUnresponsiveOrder(ctx, job.data.orderId);
          break;
        }
        case 'auto-complete': {
          await autoCompleteDeliveredOrder(ctx, job.data.orderId);
          break;
        }
      }
    },
    { connection, concurrency: 5 },
  );

  // (Removed [SWIFT-023]: the rider-assignment auto-sweep. It force-assigned
  // riders to orders WITHOUT the offer/consent cascade and WITHOUT committing
  // the rider's cash float — bypassing two invariants — and had no producer
  // (nothing ever seeded the queue), so it was dormant dead code that would
  // have been a booby-trap if ever triggered. Real assignment runs through the
  // offer cascade in dispatch.service. If a batch planner is ever wanted, wire
  // the still-present dispatch-planner into claimOrder deliberately.)

  // SUBSCRIPTION BILLING — idempotent BillingService, never wallets
  const subscriptionWorker = buildWorker(
    QUEUE_NAMES.SUBSCRIPTION,
    async (job: Job) => {
      const { BillingService } = await import('../modules/billing/billing.service');
      const { SubscriptionService } = await import('../modules/subscription/subscription.service');
      const { NotificationService } = await import('../modules/notification/notification.service');
      const { getPaymentProvider } = await import('../providers/payment/payment-provider');

      const billing = new BillingService(
        ctx.prisma,
        new NotificationService(ctx.prisma, ctx.io),
        getPaymentProvider(),
      );
      const subscriptions = new SubscriptionService(ctx.prisma);

      switch (job.name) {
        case 'process-billing': {
          const result = await billing.runBillingCycle();
          const reminders = await billing.sendUpcomingReminders();
          // §11 stages 6..N: daily reinstatement nudges for the suspended
          // (idempotent per day via the REMINDER event key) + CHURNED terminal
          // past SUSPENSION_MAX_DAYS so dunning — and the daily MMG
          // re-request — never runs forever against a dead account.
          const swept = await billing.sweepSuspended();
          // Trial first-payment funnel [san spec 21.4]: day-10 how-to-pay +
          // day-13 exact-amount education, each stage once per trial
          // (BillingEvent unique-key gate) — preloaded wallets make trial→
          // paid conversion seamless.
          const { sweepTrialFeeEducation } = await import('../modules/billing/trial-fee-education');
          const edu = await sweepTrialFeeEducation(ctx.prisma, new NotificationService(ctx.prisma, ctx.io));
          ctx.log.info({ ...result, reminders, ...swept, trialEdu: edu }, 'Billing cycle complete');
          // SWIFT-AUD-D7-02: billing failures must PAGE, not just log — a
          // broken rail silently suspends paying partners.
          const troubled = result.failed + result.errors + result.suspended;
          const threshold = Number(process.env['BILLING_FAILURE_ALERT_THRESHOLD'] ?? '3');
          if (troubled >= threshold) {
            const { notifyAdmins } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'billing-failures', 3600, () =>
              notifyAdmins(ctx.prisma, new NotificationService(ctx.prisma, ctx.io), {
                // Platform-wide ops page: an aggregate scan or infra alarm, not one
                // tenant's event. Explicitly null so it reads as a decision [NOC-A F45].
                tenantId: null,
                title: 'Billing failures spiking',
                body: `${troubled} subscriptions failed, errored, or suspended this cycle (threshold ${threshold}). Check the billing dashboard before partners start calling.`,
                data: { kind: 'ops_billing_failures', failed: result.failed, errors: result.errors, suspended: result.suspended },
              }),
            );
          }
          break;
        }
        case 'tier-recalc': {
          const changed = await billing.recalculateVendorTiers();
          // Movers re-tier on the same cadence: a vendor's basis is catalogue
          // size, a mover's is the vehicle they currently have registered.
          const moversChanged = await billing.recalculateMoverTiers();
          ctx.log.info({ changed, moversChanged }, 'Tier recalculation complete');
          break;
        }
        case 'convert-trials': {
          const converted = await subscriptions.convertExpiredTrials();
          ctx.log.info({ converted }, 'Expired trials converted to active');
          break;
        }
        case 'poll-mmg-billing': {
          // §13 MMG rail: settle in-flight merchant-initiated weekly-fee
          // requests (approved → period advances; declined/expired → dunning).
          const polled = await billing.pollPendingMmgCharges();
          if (polled.settled + polled.failed > 0) {
            ctx.log.info(polled, 'MMG billing poll settled pending charges');
          }
          // [M-04] The repair pass runs with every poll: a terminal payment
          // whose outcome never landed is applied now and counted.
          const repaired = await billing.reconcileTerminalWithoutOutcome();
          if (repaired.repaired > 0 || repaired.stillOpen > 0) {
            ctx.log.warn(repaired, '[M-04] terminal MMG payments without a recorded outcome — reconciled');
          }
          // [M-08] Top-up commands whose notice / re-bill tail is still owed
          // are drained here; historical unkeyed top-ups that look doubled are
          // reported for a person. Nothing is reversed automatically.
          const tails = await billing.drainTopUpTails();
          if (tails.retried > 0 || tails.pending > 0) {
            ctx.log.warn(tails, '[M-08] top-up tails owed — drained');
          }
          await billing.scanUnkeyedTopUpDuplicates();
          // [M-20] Settlement imports a person must see: unbalanced publications
          // and rejected files with a credited row. Reported, never reversed.
          const { scanSettlementImports } = await import('../modules/billing/settlement-import');
          const imports = await scanSettlementImports(ctx.prisma);
          if (imports.unbalanced.length + imports.rejectedButCredited.length > 0) {
            const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'settlement-imports-review', 24 * 3600, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: '📄 Settlement imports need a person',
                body: `${imports.unbalanced.length} published import(s) do not balance and ${imports.rejectedButCredited.length} rejected file(s) have a credited row. Reconcile against the MMG statement; nothing is reversed automatically.`,
                data: { kind: 'billing_invariants', alert: 'settlement-imports-review', ...imports },
              }),
            ).catch(() => {});
          }
          // [M-01 / M-02] Every UNKNOWN card intent is retrieved by its key and
          // settled, declined, re-sent under the same key, or expired — the
          // kill switch stops new instructions, never this.
          const cards = await billing.reconcileUnknownCardCharges();
          if (cards.settled + cards.declined + cards.reissued + cards.expired + cards.stillUnknown > 0) {
            ctx.log.warn(cards, '[M-01] unknown card charge intents reconciled');
          }
          // [M-18] The historical double credits: one provider transaction
          // credited by more than one channel before the identity existed.
          // Reported and paged for human reconciliation, never reversed here.
          const { scanDuplicateCredits } = await import('../modules/billing/agent-cash.service');
          const duplicates = await scanDuplicateCredits(ctx.prisma);
          if (duplicates.length > 0) {
            const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'agent-cash-duplicate-credits', 24 * 3600, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: '💵 MMG transactions credited more than once',
                body: `${duplicates.length} MMG transaction(s) hold more than one credited agent-cash record. Freeze them, reconcile against the MMG statement, and reverse only by hand — nothing is reversed automatically.`,
                data: { kind: 'billing_invariants', alert: 'agent-cash-duplicate-credits', count: duplicates.length },
              }),
            ).catch(() => {});
          }
          // [M-32] Promo funding invariants: active promos with invalid terms,
          // a discount with no named funder, a tip that was discounted.
          // Reported and paged; the money is never rewritten here.
          const { scanPromoFunding } = await import('../modules/promo/promo-terms');
          const promoScan = await scanPromoFunding(ctx.prisma);
          if (promoScan.invalidTerms > 0 || promoScan.discountWithoutFunder.sinceEnforced > 0 || promoScan.tipFundingGap.sinceEnforced > 0) {
            const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'promo-funding-invariants', 24 * 3600, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: '🏷️ Promo funding invariants broken',
                body: `${promoScan.invalidTerms} active promo(s) with invalid terms; ${promoScan.discountWithoutFunder.sinceEnforced} discounted order(s) since enforcement with no named funder; ${promoScan.tipFundingGap.sinceEnforced} order(s) since enforcement whose tip was discounted. Freeze the promo, then reconcile the orders.`,
                data: { kind: 'billing_invariants', alert: 'promo-funding-invariants', invalidTerms: promoScan.invalidTerms, discountWithoutFunder: promoScan.discountWithoutFunder.sinceEnforced, tipFundingGap: promoScan.tipFundingGap.sinceEnforced },
              }),
            ).catch(() => {});
          }
          // [M-33] Returns whose refund was inferred from the aggregate
          // discount (no snapshot) wait for a person: never settled on the
          // inferred number.
          const { scanInferredRefunds } = await import('../modules/order/refund-review');
          const refundReview = await scanInferredRefunds(ctx.prisma);
          if (refundReview.inferredOpen + refundReview.legacyOpen > 0) {
            const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'refunds-awaiting-review', 24 * 3600, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: '↩️ Returns with an inferred refund await review',
                body: `${refundReview.inferredOpen} open return(s) were computed by inference (no order snapshot) and ${refundReview.legacyOpen} legacy return(s) sit on discounted orders. Recompute each from the order's items and contact the store and customer before anything settles.`,
                data: { kind: 'billing_invariants', alert: 'refunds-awaiting-review', inferredOpen: refundReview.inferredOpen, legacyOpen: refundReview.legacyOpen },
              }),
            ).catch(() => {});
          }
          // [M-34] Quarantine ambiguity: active zones of one market that
          // overlap at the same priority. Pricing already resolves them
          // deterministically; a person decides which zone keeps the kerb.
          const { scanFareZones } = await import('../modules/rides/fare-zones');
          const zoneScan = await scanFareZones(ctx.prisma);
          if (zoneScan.ambiguousPairs.length > 0) {
            const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'fare-zone-ambiguity', 24 * 3600, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: '🗺️ Fare zones overlap at the same priority',
                body: `${zoneScan.ambiguousPairs.length} pair(s) of active fare zones overlap at equal priority in one market. Trips there price by the smallest zone until you give one of each pair a different priority or redraw it.`,
                data: { kind: 'billing_invariants', alert: 'fare-zone-ambiguity', pairs: zoneScan.ambiguousPairs.slice(0, 10) },
              }),
            ).catch(() => {});
          }
          // [M-35] Validate every country's pricing config; an invalid column
          // is already quarantined by the readers (last known good) — this
          // names it so a person fixes the column.
          const { scanPricingConfigs } = await import('../modules/country/pricing-config');
          const pricingScan = await scanPricingConfigs(ctx.prisma);
          if (pricingScan.invalid.length > 0) {
            const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'pricing-config-invalid', 24 * 3600, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: '💲 Pricing config is invalid',
                body: `${pricingScan.invalid.length} pricing column(s) fail the schema: ${pricingScan.invalid.map((i) => `${i.countryCode} ${i.kind}`).join(', ')}. Quotes there price from the last known good version until the column is fixed.`,
                data: { kind: 'billing_invariants', alert: 'pricing-config-invalid', invalid: pricingScan.invalid.slice(0, 10) },
              }),
            ).catch(() => {});
          }
          // [M-38] Recompute historical digests with versioned adjustments —
          // a bounded batch per tick; a legacy row is estimated until then.
          const { recomputeLegacyDigests } = await import('../modules/billing/sales-digest');
          await recomputeLegacyDigests(ctx.prisma, 50).catch(() => {});
          // [R045-ADS] Execute staged ad-refund obligations (leased, once each,
          // retried with backoff), then report what is outstanding and page
          // for failures or a terminal paid campaign with no intent.
          const { AdsRefundService, scanAdRefunds } = await import('../modules/ads/refund.service');
          await new AdsRefundService(ctx.prisma, ctx.io).drainOutbox({ limit: 50 }).catch(() => {});
          const adRefunds = await scanAdRefunds(ctx.prisma);
          if (adRefunds.failed > 0 || adRefunds.terminalWithoutIntent.length > 0) {
            const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'ad-refund-obligations', 6 * 3600, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: '📣 Ad refund obligations need a person',
                body: `${adRefunds.failed} refund intent(s) FAILED after every retry and ${adRefunds.terminalWithoutIntent.length} cancelled or killed paid campaign(s) have no refund intent (run the backfill). ${adRefunds.awaitingPayout.count} executed intent(s) await a payout reference.`,
                data: { kind: 'billing_invariants', alert: 'ad-refund-obligations', failed: adRefunds.failed, terminalWithoutIntent: adRefunds.terminalWithoutIntent.slice(0, 10), awaitingPayout: adRefunds.awaitingPayout.count },
              }),
            ).catch(() => {});
          }
          // [R045-ADS-04 · 05] The checkout aggregate's invariants: a paid
          // campaign with no confirmed inventory, or more than one active invoice.
          const { scanAdCheckout } = await import('../modules/ads/checkout-scan');
          const adCheckout = await scanAdCheckout(ctx.prisma);
          if (adCheckout.paidWithoutInventory.length > 0 || adCheckout.duplicateActiveInvoices.length > 0) {
            const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'ad-checkout-invariants', 6 * 3600, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: '📣 Ad checkout invariants broken',
                body: `${adCheckout.paidWithoutInventory.length} paid campaign(s) have no confirmed inventory (stop serving and refund or re-book) and ${adCheckout.duplicateActiveInvoices.length} campaign(s) hold more than one active invoice (freeze and reconcile).`,
                data: { kind: 'billing_invariants', alert: 'ad-checkout-invariants', paidWithoutInventory: adCheckout.paidWithoutInventory.slice(0, 10), duplicateActiveInvoices: adCheckout.duplicateActiveInvoices.slice(0, 10) },
              }),
            ).catch(() => {});
          }
          break;
        }
      }
    },
    { connection, concurrency: 1 },
  );

  // SETTLEMENT: weekly vendor payouts (logic lives in runWeeklySettlement so
  // tests can prove its idempotency without BullMQ plumbing)
  const settlementWorker = buildWorker(
    QUEUE_NAMES.SETTLEMENT,
    async (job: Job) => {
      if (job.name !== 'process-settlements') return;
      await runWeeklySettlement(ctx);
    },
    { connection, concurrency: 1 },
  );

  // VERIFICATION: daily expiry sweep + 30-day reminders
  const verificationWorker = buildWorker(
    QUEUE_NAMES.VERIFICATION,
    async (job: Job) => {
      // Backup freshness. Reads the heartbeat deploy/backup.sh writes after a
      // verified dump. Pages once a day at most — a missing backup is a
      // standing condition, not an event, and repeating it hourly would train
      // the founder to ignore it.
      if (job.name === 'backup-freshness') {
        const { checkBackupFreshness } = await import('../modules/ops/backup-freshness');
        const result = await checkBackupFreshness(ctx.prisma);
        if (result.stale) {
          const { notifyAdmins, NotificationService } = await import('../modules/notification/notification.service');
          await opsPageOnce(ctx, 'backup-freshness', 20 * 3600, () =>
            notifyAdmins(ctx.prisma, new NotificationService(ctx.prisma, ctx.io), {
              // Platform-wide infrastructure alarm, not one tenant's event.
              tenantId: null,
              title: 'Backups are not safe',
              body: result.reason,
              data: {
                kind: 'ops_backup_stale',
                ageHours: result.ageHours,
                offsite: result.offsite,
              },
            }),
          );
        }
        ctx.log.info({ ...result }, 'backup freshness checked');
        return;
      }

      // [DCR-1 CW] Commencement Watch: scan the Gazette/parliament sources,
      // dedupe alerts, notify the founder channels. Observes and alerts ONLY.
      if (job.name === 'cw-scan') {
        const cw = await import('../modules/compliance/commencement-watch');
        const { NotificationService } = await import('../modules/notification/notification.service');
        const notifications = new NotificationService(ctx.prisma, ctx.io);
        const summaries = await cw.runScan(ctx.prisma, globalThis.fetch as unknown as import('../modules/compliance/commencement-watch').FetchLike);
        const notified = await cw.notifyPending(
          ctx.prisma,
          cw.channelsFromEnv(
            async (title, body) => {
              const admins = await ctx.prisma.user.findMany({
                where: { roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
                select: { id: true },
              });
              let reached = 0;
              for (const a of admins) {
                try {
                  // [F-024-04] send() is best-effort and resolves '' when the
                  // inbox row failed to persist — only a truthy id is a human
                  // actually reachable. Counting bare resolution stamped
                  // notifiedAt on alerts that produced no inbox row.
                  const id = await notifications.send({ userId: a.id, type: 'SYSTEM_ANNOUNCEMENT', title, body: body.slice(0, 900) });
                  if (id) reached += 1;
                } catch { /* one failed admin must not hide the others */ }
              }
              return reached; // [F-022-03] delivery-proven, not assumed
            },
            // [F-024-04] per-cycle reachability probe: zero active admins and
            // no webhook must go RED even when no alerts are pending.
            () => ctx.prisma.user.count({
              where: { roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
            }),
          ),
          globalThis.fetch as unknown as import('../modules/compliance/commencement-watch').FetchLike,
        );
        ctx.log.info({ summaries, notified }, 'commencement watch scan complete');
        return;
      }
      // [DCR-1 NR-2] Daily retention sweep: enforce every enabled policy in
      // the registry and write receipts. Failures surface via the worker's
      // failed-handler like every other job.
      if (job.name === 'retention-sweep') {
        const { seedRetentionDefaults, runRetentionSweep } = await import('../modules/compliance/retention.service');
        await seedRetentionDefaults(ctx.prisma);
        const results = await runRetentionSweep(ctx.prisma);
        const enforced = results.filter((r) => !r.skipped);
        ctx.log.info(
          { enforced: enforced.map((r) => ({ c: r.dataClass, n: r.deleted })), skipped: results.filter((r) => r.skipped).length },
          'retention sweep complete',
        );
        return;
      }
      if (job.name === 'expiry-sweep') {
        const { VerificationService } = await import('../modules/verification/verification.service');
        const { NotificationService } = await import('../modules/notification/notification.service');
        const { getKycProvider } = await import('../providers/kyc/kyc-provider');

        const verification = new VerificationService(
          ctx.prisma,
          new NotificationService(ctx.prisma, ctx.io),
          getKycProvider(),
        );
        const expired = await verification.expireLapsedDocuments();
        const reminded = await verification.sendExpiryReminders();
        const purged = await verification.purgeExpiredDocuments();
        // Review-SLA watchdog: docs waiting >24h on a human get escalated.
        await verification.alertReviewSlaBreaches();

        // Liability shield: after enforcement, AUDIT — verify nobody is on the
        // road with a broken checklist, and leave an evidence row either way.
        const { ComplianceAuditService } = await import('../modules/verification/compliance-audit.service');
        const audit = new ComplianceAuditService(ctx.prisma, new NotificationService(ctx.prisma, ctx.io), verification);
        const run = await audit.runAudit('SCHEDULED');
        ctx.log.info(
          `Verification sweep: ${expired} expired, ${reminded} reminders sent, ${purged} purged; compliance audit: ${run.moversChecked} online movers checked, ${run.violations} violations`,
        );
      }

      if (job.name === 'compliance-sample') {
        const { VerificationService } = await import('../modules/verification/verification.service');
        const { ComplianceAuditService } = await import('../modules/verification/compliance-audit.service');
        const { NotificationService } = await import('../modules/notification/notification.service');
        const { getKycProvider } = await import('../providers/kyc/kyc-provider');
        const notifications = new NotificationService(ctx.prisma, ctx.io);
        const audit = new ComplianceAuditService(
          ctx.prisma,
          notifications,
          new VerificationService(ctx.prisma, notifications, getKycProvider()),
        );
        const sampled = await audit.sampleForReview(10);
        ctx.log.info(`Compliance re-verification sample: ${sampled} movers queued for manual review`);
      }

      if (job.name === 'flag-ratings') {
        const { RatingService } = await import('../modules/rating/rating.service');
        const svc = new RatingService(ctx.prisma);
        const flagged = await svc.flagSuspiciousRatings();
        // Double-blind window: a no-show counterpart must not hide feedback forever.
        const released = await svc.releaseDoubleBlind();
        ctx.log.info(`Rating sweep: ${flagged} flagged, ${released} double-blind released`);
      }

      if (job.name === 'collusion-affinity-scan') {
        await runCollusionAffinityScan(ctx);
      }

      if (job.name === 'evidence-retention') {
        // §9.4 — unsealed, case-less bundles past the retention window are
        // deleted; sealed bundles and legal holds are never touched (the DB
        // triggers refuse even if code tried).
        // [S-09 · operations] Held cases versus their evidence, first: repair
        // (extend, never release), perform the vault operations from the
        // outbox, and page any partial hold — the sweep below freezes itself
        // while one exists.
        const { repairLegalHolds, drainLegalHoldVault, scanLegalHolds } = await import('../modules/safety/legal-hold');
        await repairLegalHolds(ctx.prisma).catch((err) => ctx.log.error({ err }, '[S-09] legal hold repair failed'));
        await drainLegalHoldVault(ctx.prisma, { limit: 50 }).catch((err) => ctx.log.error({ err }, '[S-09] legal hold vault drain failed'));
        const holds = await scanLegalHolds(ctx.prisma).catch(() => null);
        if (holds && (holds.partial.length > 0 || holds.failedVault > 0)) {
          const { notifyAdmins: pageHold, NotificationService: HoldNS } = await import('../modules/notification/notification.service');
          await opsPageOnce(ctx, 'legal-hold-partial', 3600, () =>
            pageHold(ctx.prisma, new HoldNS(ctx.prisma, ctx.io), {
              tenantId: null,
              title: `Legal hold: ${holds.partial.length} partial hold(s), ${holds.failedVault} vault failure(s) — evidence deletion frozen`,
              body: 'A held case and its evidence disagree, or a vault manifest could not be written. Deletion stays frozen until every hold is whole.',
              data: { kind: 'legal_hold_partial', partial: holds.partial.slice(0, 10), failedVault: holds.failedVault },
            }),
          ).catch(() => {});
        }
        const { EvidenceService } = await import('../modules/safety/evidence.service');
        const swept = await new EvidenceService(ctx.prisma, ctx.io).retentionSweep();
        if (swept.frozen) ctx.log.error(swept, '[S-09] evidence retention frozen this tick');
        if (swept.deleted > 0) ctx.log.info(swept, 'evidence retention sweep');
      }

      if (job.name === 'incident-pattern-scan') {
        // §8.4 rule 2 (nightly): ≥3 distinct reporters on one subject in 365d.
        const { IncidentService } = await import('../modules/safety/incident.service');
        const flagged = await new IncidentService(ctx.prisma, ctx.io).crossReporterScan();
        if (flagged.length > 0) {
          ctx.log.warn({ flagged }, 'cross-reporter pattern flags');
          const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
          await opsPageOnce(ctx, 'incident-pattern-scan', 20 * 3600, () =>
            notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
              // Platform-wide ops page: an aggregate scan or infra alarm, not one
              // tenant's event. Explicitly null so it reads as a decision [NOC-A F45].
              tenantId: null,
              title: 'PATTERN — repeat-report subjects',
              body: `${flagged.length} subject(s) now have ≥3 distinct reporters inside 365 days. Review their case history before their next shift.`,
              data: { kind: 'incident_pattern_cross_reporter', flagged: flagged.slice(0, 10) },
            }),
          ).catch(() => {});
        }
      }

      if (job.name === 'incident-weekly-digest') {
        // §8.4 — the founder's Monday safety read.
        const { IncidentService } = await import('../modules/safety/incident.service');
        const digest = await new IncidentService(ctx.prisma, ctx.io).weeklyDigest();
        const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
        await notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
          // Platform-wide ops page: an aggregate scan or infra alarm, not one
          // tenant's event. Explicitly null so it reads as a decision [NOC-A F45].
          tenantId: null,
          title: '🛡️ Weekly safety digest',
          body: digest.lines.join(' · '),
          data: { kind: 'incident_weekly_digest', open: digest.open, breaches: digest.breaches, patterns: digest.patternsThisWeek },
        }).catch(() => {});
        ctx.log.info({ open: digest.open, breaches: digest.breaches }, 'weekly safety digest sent');
      }

      if (job.name === 'booking-reminders') {
        const { sendBookingReminders } = await import('../modules/services/services.service');
        const { NotificationService } = await import('../modules/notification/notification.service');
        const notifications = new NotificationService(ctx.prisma, ctx.io);
        const sent = await sendBookingReminders(ctx.prisma, async (n) => {
          await notifications.send({ ...n, type: 'ORDER_UPDATE' });
        });
        ctx.log.info(`Booking reminders: ${sent} sent`);
      }
    },
    { connection, concurrency: 1 },
  );

  // NOTIFICATIONS: vendor-alert escalation — re-alert, then SMS
  const notificationWorker = buildWorker(
    QUEUE_NAMES.NOTIFICATION,
    async (job: Job) => {
      if (job.name !== 'vendor-alert-escalate') return;
      const { escalateVendorAlert } = await import('../modules/notification/notification.service');
      const { getChannels } = await import('../providers/notifications/channels');

      const { orderId, level = 0 } = job.data;
      const outcome = await escalateVendorAlert(ctx.prisma, ctx.io, getChannels(), orderId, level);

      if (outcome === 'realerted') {
        await enqueueVendorAlertFollowup(queues, orderId);
      }
    },
    { connection, concurrency: 5 },
  );

  // DISPATCH: offer cascade — start offers, enforce the 20s timeout, retry
  // an exhausted order once, and sweep ghost movers off the online pool.
  const dispatchWorker = buildWorker(
    QUEUE_NAMES.DISPATCH,
    async (job: Job) => {
      const { DispatchService, sweepStaleMovers, reconcileStuckDispatch, recoverStrandedTaxiRides } = await import('../modules/dispatch/dispatch.service');
      const { getMapsProvider } = await import('../providers/maps/maps-provider');

      if (job.name === 'checkout-outbox') {
        // [S-13 · operations] Every not-my-driver decision owns its case and its
        // dispatch command; a decision lacking either is repaired now and paged.
        {
          const { scanNotMyDriverDecisions, repairNotMyDriverDecisions } = await import('../modules/safety/liveness.service');
          const gaps = await scanNotMyDriverDecisions(ctx.prisma).catch(() => null);
          if (gaps && (gaps.missingCase.length > 0 || gaps.missingDispatch.length > 0)) {
            const fixed = await repairNotMyDriverDecisions(ctx.prisma, ctx.io).catch(() => ({ repaired: [] as string[] }));
            const { notifyAdmins: pageNmd, NotificationService: NmdNS } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'not-my-driver-discrepancy', 1800, () =>
              pageNmd(ctx.prisma, new NmdNS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: `Not-my-driver: ${gaps.missingCase.length} decision(s) without a case, ${gaps.missingDispatch.length} without a dispatch command`,
                body: `Repaired ${fixed.repaired.length}. A passenger may have been left without a redispatch or a case — check the named rides now.`,
                data: { kind: 'not_my_driver_discrepancy', missingCase: gaps.missingCase.slice(0, 10), missingDispatch: gaps.missingDispatch.slice(0, 10), repaired: fixed.repaired.slice(0, 10) },
              }),
            ).catch(() => {});
          }
        }
        // [M-11] Publish whatever a request's immediate drain could not: a
        // queue outage, a crash after the commit, a lapsed lease.
        const { drainCheckoutOutbox } = await import('../modules/order/checkout-outbox');
        const result = await drainCheckoutOutbox({ prisma: ctx.prisma, queues, log: ctx.log }, { limit: 200 });
        if (result.processed + result.failed > 0) ctx.log.info(result, '[M-11] checkout outbox sweep');
        return;
      }
      if (job.name === 'mover-revocation-outbox') {
        const dispatch = new DispatchService(
          ctx.prisma,
          ctx.redis,
          ctx.io,
          getMapsProvider(),
          async (orderId, moverId, delayMs, attemptId) => {
            await queues.dispatchQueue.add('offer-timeout', { orderId, riderId: moverId, attemptId }, {
              delay: delayMs,
              removeOnComplete: 100,
              removeOnFail: 50,
            });
          },
          async (orderId, delayMs) => {
            await queues.dispatchQueue.add('dispatch-order', { orderId }, {
              delay: delayMs,
              removeOnComplete: 100,
              removeOnFail: 50,
            });
            return true;
          },
        );
        const { processMoverRevocationOutboxBatch } = await import('../modules/mover-revocation-outbox');
        const result = await processMoverRevocationOutboxBatch({ ...ctx, dispatch });
        if (result.processed + result.failed > 0) {
          ctx.log.info(result, 'mover revocation outbox sweep');
        }
        return;
      }

      if (job.name === 'scheduler-heartbeat') {
        // Liveness beacon for the job scheduler (launch-readiness Phase 6). If
        // this worker process dies, holds stop releasing, expiry sweeps stop,
        // settlements stop — silently. The heartbeat key's AGE (exposed as a
        // Prometheus gauge) makes that stall detectable and alertable.
        await ctx.redis.set('scheduler:heartbeat', String(Date.now()));
        // SWIFT-AUD-D7-02: pool saturation pages (dedup'd). Queries queueing
        // for a connection is the "API is about to brown-out" signal, and the
        // 60s heartbeat is the natural in-process sampling point.
        try {
          const m = await ctx.prisma.$metrics.json();
          const waiting = m.gauges.find((x: { key: string; value: number }) => x.key === 'prisma_client_queries_wait')?.value ?? 0;
          if (waiting >= Number(process.env['POOL_WAIT_ALERT_THRESHOLD'] ?? '5')) {
            const { notifyAdmins, NotificationService } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'db-pool-saturation', 1800, () =>
              notifyAdmins(ctx.prisma, new NotificationService(ctx.prisma, ctx.io), {
                // Platform-wide ops page: an aggregate scan or infra alarm, not one
                // tenant's event. Explicitly null so it reads as a decision [NOC-A F45].
                tenantId: null,
                title: 'Database pool saturated',
                body: `${waiting} queries are waiting for a database connection. Find the slow query or raise connection_limit.`,
                data: { kind: 'ops_pool_saturation', waiting },
              }),
            );
          }
        } catch {
          // metrics preview unavailable — the Prometheus gauge shares this guard
        }

        // [N4 / WS-8.1] Dead letters page. A job that exhausts its attempts
        // lands in BullMQ's failed set and stays there — and nothing has ever
        // told anyone it happened. The money jobs are in that set
        // (process-billing hourly, process-settlements Sunday 00:00,
        // poll-mmg-billing every 2 minutes, billing-invariants nightly), so a
        // silently dead job is a silently unbilled week that nobody notices
        // until a vendor asks why they were never charged.
        //
        // Deliberately counts the FAILED SET, not the worker's 'failed' event:
        // that event fires on every attempt, including ones a retry then
        // succeeds. Only a job that ran out of attempts is a dead letter.
        try {
          const failedByQueue: Array<{ queue: string; count: number }> = [];
          for (const [key, queue] of Object.entries(queues) as Array<[string, Queue]>) {
            const count = await queue.getFailedCount();
            if (count > 0) failedByQueue.push({ queue: key.replace(/Queue$/, ''), count });
          }
          const total = failedByQueue.reduce((sum, entry) => sum + entry.count, 0);
          if (total >= dlqAlertThreshold()) {
            const worst = [...failedByQueue].sort((a, b) => b.count - a.count);
            const { notifyAdmins, NotificationService } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'dlq-non-empty', 1800, () =>
              notifyAdmins(ctx.prisma, new NotificationService(ctx.prisma, ctx.io), {
                // Platform-wide, like the pool page above — not one tenant's event.
                tenantId: null,
                title: `${total} background job${total === 1 ? '' : 's'} died`,
                // Name the queues: "notification" failing is a different morning
                // from "settlement" failing, and the operator triages on that.
                body: `${worst.map((q) => `${q.count} ${q.queue}`).join(', ')}. Open Platform → Background jobs to retry or discard them.`,
                data: { kind: 'ops_dlq_non_empty', total, queues: worst },
              }),
            );
          }
        } catch (err) {
          // Unlike the metrics probe above, this one is NOT expected to fail —
          // it is plain Redis reads on queues this process owns. Log it, because
          // an alarm that silently stops alarming is the defect it exists to
          // prevent.
          ctx.log.warn({ err }, 'DLQ depth check failed — dead-letter paging is blind this cycle');
        }

        // [C2 / WS-0.2] Routing degradation page. See osrmFallbackAlertPct above
        // for why a silent fallback is expensive rather than merely suboptimal.
        try {
          const metric = await osrmOutcomeCounter.get();
          const totals = { ok: 0, fallback: 0 };
          for (const sample of metric.values) {
            const outcome = sample.labels['outcome'];
            if (outcome === 'ok') totals.ok += sample.value;
            else if (outcome === 'fallback') totals.fallback += sample.value;
          }
          const previous = lastOsrmTotals;
          lastOsrmTotals = totals;
          // A negative delta means the counter was reset (a restart, or a test).
          // Skip the cycle and re-baseline rather than reporting nonsense.
          if (previous && totals.ok >= previous.ok && totals.fallback >= previous.fallback) {
            const ok = totals.ok - previous.ok;
            const fallback = totals.fallback - previous.fallback;
            const calls = ok + fallback;
            const pct = calls > 0 ? Math.round((fallback / calls) * 100) : 0;
            if (calls >= osrmFallbackMinCalls() && pct >= osrmFallbackAlertPct()) {
              const { notifyAdmins, NotificationService } = await import('../modules/notification/notification.service');
              await opsPageOnce(ctx, 'osrm-fallback', 1800, () =>
                notifyAdmins(ctx.prisma, new NotificationService(ctx.prisma, ctx.io), {
                  tenantId: null,
                  title: 'Routing has fallen back to straight-line distance',
                  // Name the CONSEQUENCE, not the metric. An operator paged at
                  // 3am needs to know what is currently wrong for customers,
                  // not that a ratio crossed a threshold.
                  body: `${pct}% of the last ${calls} routing calls could not reach OSRM. Fares, ETAs and dispatch ranking are being computed from crow-flies distance right now — across the river that is about a third of the real distance. Check the OSRM host.`,
                  data: { kind: 'ops_osrm_fallback', pct, calls, fallback },
                }),
              );
            }
          }
        } catch (err) {
          ctx.log.warn({ err }, 'OSRM fallback-rate check failed — routing degradation paging is blind this cycle');
        }
        return;
      }

      if (job.name === 'promote-sos-grace') {
        // SOS grace-expiry backstop [F-0003 / safety spec §4.1]. The client
        // confirms the instant the grace bar completes (the happy path); this
        // fires when the app was KILLED mid-grace — a closed app must never stop
        // a life-safety escalation. The grace deadline is DB state and promotion
        // is compare-and-set, so this is idempotent, safe to overlap, and
        // catches up on any worker downtime. Loud: a backstop-promoted alert
        // means a client died mid-SOS, which ops should see.
        const { SosService } = await import('../modules/safety/sos.service');
        const promoted = await new SosService(ctx.prisma, ctx.io).promoteExpiredGrace();
        if (promoted.length > 0) {
          ctx.log.warn({ promoted, count: promoted.length }, 'SOS grace backstop promoted pending alerts to ACTIVE (client never confirmed)');
        }
        // [S-01] The escalation worker: drain what every ACTIVE alert owns
        // (leased, once each, retried), backfill live alerts with no rows,
        // and page the platform for any ACTIVE alert whose ops page is still
        // undelivered past the threshold — the watchdog.
        const { drainSosEscalations, backfillSosEscalations, scanSosEscalations, sosEscalationWorkerKilled } = await import('../modules/safety/sos-escalation');
        if (!sosEscalationWorkerKilled()) {
          const back = await backfillSosEscalations(ctx.prisma).catch(() => ({ backfilled: [] as string[] }));
          if (back.backfilled.length > 0) ctx.log.warn({ backfilled: back.backfilled }, '[S-01] live SOS alerts had no escalation rows — policy staged now');
          const drained = await drainSosEscalations(ctx.prisma, ctx.io, { limit: 200 }).catch(() => null);
          if (drained && (drained.failed > 0 || drained.deadLettered > 0)) ctx.log.error(drained, '[S-01] SOS escalation deliveries failed this tick');
        }
        const watchdog = await scanSosEscalations(ctx.prisma).catch(() => null);
        if (watchdog && watchdog.activeWithoutPage.length > 0) {
          const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
          for (const stuck of watchdog.activeWithoutPage.slice(0, 20)) {
            await opsPageOnce(ctx, `sos-active-without-page:${stuck.sosAlertId}`, 600, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: '🚨 SOS ACTIVE with no ops page delivered',
                body: `Alert ${stuck.sosAlertId} has been ACTIVE for ${stuck.ageSeconds}s and its ops page is still undelivered. Open the war room and respond now; the worker keeps retrying.`,
                data: { kind: 'sos_active', sosAlertId: stuck.sosAlertId, watchdog: true },
              }),
            ).catch(() => {});
          }
        }
        // [S-19 · operations] Ops alerts: read receipts become "seen", an alert
        // nobody acknowledged by its deadline escalates (re-push, on-call SMS,
        // platform page), drills run on schedule, and zero-ACK is the gauge.
        {
          const { syncOpsAlertReadReceipts, escalateOverdueOpsAlerts, scanOpsAlerts, runOpsAlertDrillIfDue } = await import('../modules/safety/ops-alert');
          const { NotificationService: OpsNS, notifyAdmins: pageOps } = await import('../modules/notification/notification.service');
          const { getChannels } = await import('../providers/notifications/channels');
          const opsNotifications = new OpsNS(ctx.prisma, ctx.io);
          await syncOpsAlertReadReceipts(ctx.prisma).catch(() => 0);
          const esc = await escalateOverdueOpsAlerts(ctx.prisma, opsNotifications, getChannels().sms).catch(() => ({ escalated: [] as string[], closed: [] as string[] }));
          for (const id of esc.escalated) {
            await opsPageOnce(ctx, `ops-alert-unacked:${id}`, 900, () =>
              pageOps(ctx.prisma, opsNotifications, { tenantId: null, title: '⏰ An ops alert has NO acknowledgement past its deadline', body: `Ops alert ${id} was escalated: nobody acknowledged the page. Open the alert list and acknowledge it.`, data: { kind: 'ops_alert_escalated', opsAlertId: id, platform: true } }),
            ).catch(() => {});
          }
          await scanOpsAlerts(ctx.prisma).catch(() => null);
          await runOpsAlertDrillIfDue(ctx.prisma, opsNotifications).catch(() => null);
        }
        // [S-16 · operations] Every legacy plaintext trip-share token is a live
        // exposure: rotate (revoke + null + tell the sharer) until none is left.
        {
          const { rotateLegacyTripShareTokens } = await import('../modules/safety/trip-share.service');
          const { NotificationService: ShareNS } = await import('../modules/notification/notification.service');
          const rot = await rotateLegacyTripShareTokens(ctx.prisma, new ShareNS(ctx.prisma, ctx.io)).catch(() => null);
          if (rot && rot.rotated > 0) ctx.log.warn(rot, '[S-16] legacy plaintext trip-share tokens rotated');
        }
        // [S-02] The retrigger log: import any legacy JSON history as rows,
        // then report lost sequences and oversized hot rows.
        const { importLegacyRetriggers, scanSosRetriggers } = await import('../modules/safety/sos-retrigger');
        await importLegacyRetriggers(ctx.prisma).catch((err) => ctx.log.error({ err }, '[S-02] legacy retrigger import failed'));
        await scanSosRetriggers(ctx.prisma).catch(() => null);
        // §9.1 live trail: the same life-safety tick appends the mover's
        // newest fix to every open alert's unsealed bundle — the war room
        // replays this later. Cheap no-op when no alert is open.
        const { EvidenceService } = await import('../modules/safety/evidence.service');
        await new EvidenceService(ctx.prisma, ctx.io).appendLiveFixes().catch(() => {});
        return;
      }

      if (job.name === 'ads-lifecycle') {
        // Ads campaign lifecycle tick [ads-platform spec §6.1]: auto-cancel
        // unapproved past the go-live cutoff (+ full refund), activate
        // scheduled weeks, complete finished runs. All via the ONE lifecycle
        // machine — CAS, idempotent, overlap-safe.
        const { AdsCronService } = await import('../modules/ads/cron.service');
        const res = await new AdsCronService(ctx.prisma, ctx.io).tick();
        if (res.autoCancelled + res.activated + res.completed > 0) ctx.log.info(res, 'ads: lifecycle tick');
        // §16 "review SLA at risk": reviewable creatives past 75% of the SLA
        // window page ops — once per creative per window (redis once-key),
        // same posture as incident-sla-watch.
        const { CreativeService } = await import('../modules/ads/creative.service');
        const settings = await ctx.prisma.adsSettings.findUnique({ where: { tenantId: 'swift-default' }, select: { reviewSlaHours: true } });
        const atRisk = await new CreativeService(ctx.prisma, ctx.io).reviewSlaAtRisk(settings?.reviewSlaHours ?? 24);
        if (atRisk.length > 0) {
          const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
          for (const cr of atRisk) {
            await opsPageOnce(ctx, `ads-review-sla:${cr.id}`, 6 * 3600, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                // Platform-wide ops page: an aggregate scan or infra alarm, not one
                // tenant's event. Explicitly null so it reads as a decision [NOC-A F45].
                tenantId: null,
                title: `⏰ Ad creative review SLA at risk — ${cr.campaign.name}`,
                body: 'A creative has been waiting for review for over 75% of the SLA window. Review it now.',
                data: { kind: 'ad_review_sla_risk', creativeId: cr.id, campaignId: cr.campaignId },
              }),
            ).catch(() => {});
          }
          ctx.log.warn({ count: atRisk.length }, 'ads: creative review SLA at risk');
        }
        return;
      }

      if (job.name === 'ads-release-expired') {
        // Ads reservation expiry [ads-platform spec §7.3]: expired RESERVED
        // holds go RELEASED and give the inventory back. CAS + guarded
        // decrement = idempotent and overlap-safe.
        const { BookingService } = await import('../modules/ads/booking.service');
        const bookingSvc = new BookingService(ctx.prisma);
        const res = await bookingSvc.releaseExpired();
        if (res.released + res.voided > 0) ctx.log.info(res, 'ads: expired reservations released');
        // §16 "reservation expiring" (5 minutes left): warn the advertiser
        // once per campaign hold (redis once-key outlives the 5-min window).
        const expiring = await bookingSvc.expiringSoon(5);
        if (expiring.length > 0) {
          const { notifyAdvertiserOwners } = await import('../modules/ads/ads-notify');
          const { NotificationService: NS } = await import('../modules/notification/notification.service');
          const notifications = new NS(ctx.prisma, ctx.io);
          for (const e of expiring) {
            await opsPageOnce(ctx, `ads-resv-warn:${e.campaignId}`, 30 * 60, () =>
              notifyAdvertiserOwners(ctx.prisma, notifications, e.advertiserId, {
                title: 'Your ad reservation expires in 5 minutes',
                body: 'Complete payment now to keep your booked weeks — the hold releases automatically when the timer runs out.',
                kind: 'ad_reservation_expiring',
                data: { campaignId: e.campaignId, reservedUntil: e.reservedUntil.toISOString() },
              }),
            ).catch(() => {});
          }
        }
        return;
      }

      if (job.name === 'ads-weekly-report') {
        // §16 weekly performance report: Monday-morning totals digest to every
        // advertiser that ran last week — same rollups the dashboard reads.
        const { AdsCronService } = await import('../modules/ads/cron.service');
        const res = await new AdsCronService(ctx.prisma, ctx.io).weeklyReport();
        if (res.campaigns > 0) ctx.log.info(res, 'ads: weekly reports sent');
        return;
      }

      if (job.name === 'billing-fx-notices') {
        // USD pricing Part 12: the >2% FX-change notice, ≥7 days before the
        // affected invoice, deduped per (subscription, rate) at the DB. A
        // no-op until usdPricingEnabled. Same conversion the charge will use.
        const { runFxChangeNotices, scanChargesWithoutDeliveredNotice } = await import('../modules/billing/fx-notices');
        const res = await runFxChangeNotices(ctx.prisma, ctx.io);
        if (res.notified > 0 || res.retried > 0) ctx.log.info(res, 'billing: fx change notices');
        // [M-14] The notice is a charge gate: an undelivered notice holds the
        // previous rate, and a charge that slipped through at a rate the payer
        // was not told about in time is found for a remediation review.
        if (res.undelivered > 0) ctx.log.warn(res, '[M-14] fx change notices undelivered — the charge gate holds the previous rate for these payers');
        await scanChargesWithoutDeliveredNotice(ctx.prisma);
        // Part 13 Mode B: sunset notices (T−30/T−7, data-guaranteed) + the
        // past-sunset flip with the missing-notice alert. No-op unless Mode B.
        const { sweepModeB } = await import('../modules/billing/usd-migration');
        const b = await sweepModeB(ctx.prisma, ctx.io);
        if (b.notices + b.flipped > 0) ctx.log.info(b, 'billing: usd migration Mode B sweep');
        // [M-15] A payer past sunset with notice proof missing stays pinned; the tenant's operators were paged.
        if (b.held > 0 || b.undelivered > 0) ctx.log.warn(b, '[M-15] usd migration Mode B: payers held / notices undelivered');
        return;
      }

      if (job.name === 'ads-stats-rollup') {
        // Ads stats rollup [ads-platform spec §12.3]: aggregate yesterday's
        // AdEvent rows into AdStatsDaily — the ONLY source the advertiser
        // dashboard reads. Delete+recompute per day = idempotent, so re-runs
        // and late events never double-count.
        const { AdStatsService } = await import('../modules/ads/stats.service');
        const yesterday = new Date(Date.now() - 86_400_000);
        const res = await new AdStatsService(ctx.prisma).rollupDay(yesterday);
        if (res.rows > 0) ctx.log.info(res, 'ads: stats rollup');
        return;
      }

      if (job.name === 'rating-stats-recompute') {
        // Movement R nightly (RAT-H's second leg): the full recompute must
        // land IDENTICAL to the incremental path — reconciliation is the law.
        const { RatingStatsService } = await import('../modules/rating/rating-stats.service');
        const n = await new RatingStatsService(ctx.prisma).recomputeAll();
        ctx.log.info({ subjects: n }, 'ratings: stats recomputed');
        return;
      }

      if (job.name === 'rating-actor-fold') {
        // Movement R daily fold (RAT-G): actor-facing aggregates advance once
        // a day so a fresh rating never identifies this morning's customer.
        const { runActorFold } = await import('../modules/rating/rating-standing');
        const n = await runActorFold(ctx.prisma);
        ctx.log.info({ stats: n }, 'ratings: actor fold stamped');
        return;
      }

      if (job.name === 'rating-reminder-sweep') {
        // Movement R10: ONE reminder for orders finished 24–48h ago and never
        // rated — deduped against its own notification row, flag-gated.
        const { runRatingReminderSweep } = await import('../modules/rating/rating-reminder');
        const { NotificationService } = await import('../modules/notification/notification.service');
        const n = await runRatingReminderSweep(ctx.prisma, new NotificationService(ctx.prisma, ctx.io));
        ctx.log.info({ sent: n }, 'ratings: reminders sent');
        return;
      }

      if (job.name === 'discovery-backfill') {
        // The backfill movement (#17 CAT-I): admin-triggered, once per tenant.
        // Idempotent — a re-run writes nothing new and never re-notifies.
        const { runCategoryBackfill } = await import('../modules/discovery/backfill');
        const { AiService } = await import('../modules/ai/ai.service');
        const { NotificationService } = await import('../modules/notification/notification.service');
        const notifications = new NotificationService(ctx.prisma, ctx.io);
        const tenantId = await requireActiveDiscoveryTenant(ctx.prisma, job.data);
        const report = await runWithTenant(tenantId, () =>
          runCategoryBackfill(ctx.prisma, new AiService(), {
            tenantId,
            notify: (userId) => notifications.send({
              userId,
              type: 'SYSTEM_ANNOUNCEMENT',
              title: 'Your menu just got easier to find',
              body: 'Review your categories — takes about 2 minutes.',
              data: { kind: 'category_backfill_review' },
            }).then(() => undefined),
          }),
        );
        ctx.log.info({ tenantId, ...report }, 'discovery: backfill movement complete');
        return;
      }

      if (job.name === 'discovery-ai-classify') {
        // Stage-B (category spec Part 4): budgeted AI pass over items Stage A
        // couldn't place. Budget exhausted or model down = silent wait.
        const { runAiClassifierBatch } = await import('../modules/discovery/ai-classifier');
        const { AiService } = await import('../modules/ai/ai.service');
        const results = await runForActiveDiscoveryTenants(ctx.prisma, (tenantId) =>
          runAiClassifierBatch(ctx.prisma, new AiService(), { tenantId }),
        );
        for (const { tenantId, result } of results) {
          if (result.scanned > 0) ctx.log.info({ tenantId, ...result }, 'discovery: AI classifier batch');
        }
        return;
      }

      if (job.name === 'discovery-derivation') {
        // Stage-C nightly (category spec Part 4): recompute DERIVED store
        // memberships from live-item tags; chosen rows untouchable.
        const { reconcileAllDerived } = await import('../modules/discovery/derivation');
        const results = await runForActiveDiscoveryTenants(ctx.prisma, (tenantId) =>
          reconcileAllDerived(ctx.prisma, tenantId),
        );
        for (const { tenantId, result } of results) {
          if (result.added + result.removed > 0) {
            ctx.log.info({ tenantId, ...result }, 'discovery: derived memberships reconciled');
          }
        }
        return;
      }

      if (job.name === 'qr-attribution-purge') {
        // Hourly hard-delete of expired install-attribution fingerprints —
        // ephemeral by design (DPA); claim receipts keep the funnel numbers.
        const { AttributionService } = await import('../modules/qr/attribution.service');
        const purged = await new AttributionService(ctx.prisma).purgeExpired();
        if (purged > 0) ctx.log.info({ purged }, 'qr: expired attribution fingerprints purged');
        return;
      }

      if (job.name === 'billing-invariants') {
        // Nightly proofs [san spec 24.2/16.3]: wallet balances re-derived from
        // the ledger, wrongful suspensions AUTO-HEALED (worst-harm invariant),
        // enforcement leaks + receipt gaps surfaced. Failures page.
        const { runBillingInvariants } = await import('../modules/billing/invariants');
        const report = await runBillingInvariants(ctx.prisma);
        const broken =
          report.walletMismatches.length + report.wrongfulSuspensions.length + report.enforcementLeaks.length +
          report.receiptGaps.length + report.ledgerWalletMismatches.length + (report.ledgerTrialImbalance ? 1 : 0);
        if (broken > 0) {
          const { notifyAdmins, NotificationService } = await import('../modules/notification/notification.service');
          await opsPageOnce(ctx, 'billing-invariants', 12 * 3600, () =>
            notifyAdmins(ctx.prisma, new NotificationService(ctx.prisma, ctx.io), {
              // Platform-wide ops page: an aggregate scan or infra alarm, not one
              // tenant's event. Explicitly null so it reads as a decision [NOC-A F45].
              tenantId: null,
              title: 'Billing invariant failures',
              body: `${report.walletMismatches.length} wallet mismatch(es), ${report.wrongfulSuspensions.length} wrongful suspension(s) auto-healed, ${report.enforcementLeaks.length} enforcement leak(s), ${report.receiptGaps.length} receipt gap(s), ${report.ledgerWalletMismatches.length} ledger-wallet drift(s)${report.ledgerTrialImbalance ? ', LEDGER TRIAL BALANCE BROKEN' : ''}.`,
              data: { kind: 'billing_invariants', report: { ...report, walletsChecked: report.walletsChecked } },
            }),
          );
        }
        ctx.log.info({ walletsChecked: report.walletsChecked, broken }, 'billing invariants run');
        return;
      }

      if (job.name === 'agent-cash-sla') {
        // Suspense SLA [san spec 4.6]: an unmatched agent payment older than
        // 24h is a paid-but-suspended person — page the founder, deduped per
        // 6h while the condition stands.
        const stale = await ctx.prisma.mmgAgentPayment.count({
          where: { status: 'UNMATCHED', createdAt: { lte: new Date(Date.now() - 24 * 3_600_000) } },
        });
        if (stale > 0) {
          const { notifyAdmins, NotificationService } = await import('../modules/notification/notification.service');
          await opsPageOnce(ctx, 'agent-cash-unmatched-sla', 6 * 3600, () =>
            notifyAdmins(ctx.prisma, new NotificationService(ctx.prisma, ctx.io), {
              // Platform-wide ops page: an aggregate scan or infra alarm, not one
              // tenant's event. Explicitly null so it reads as a decision [NOC-A F45].
              tenantId: null,
              title: 'Agent payment stuck unmatched > 24h',
              body: `${stale} cash payment(s) are sitting unresolved — someone may be paid but still paused. Command → Billing → Unmatched.`,
              data: { kind: 'agent_cash_sla', stale },
            }),
          );
        }
        // TOLLGATE LAW M-5 aging: an UNKNOWN intent older than 72h means money
        // MAY have moved and neither poller nor history has confirmed it —
        // a human resolves it (MMG portal check), never a guess. Page, deduped.
        const unknownAged = await ctx.prisma.subscriptionPayment.count({
          where: { status: 'UNKNOWN', createdAt: { lte: new Date(Date.now() - 72 * 3_600_000) } },
        });
        if (unknownAged > 0) {
          const { notifyAdmins, NotificationService } = await import('../modules/notification/notification.service');
          await opsPageOnce(ctx, 'billing-unknown-intents-sla', 6 * 3600, () =>
            notifyAdmins(ctx.prisma, new NotificationService(ctx.prisma, ctx.io), {
              // Platform-wide ops page: an aggregate scan or infra alarm, not one
              // tenant's event. Explicitly null so it reads as a decision [NOC-A F45].
              tenantId: null,
              title: 'UNKNOWN payment intents aging > 72h',
              body: `${unknownAged} MMG request(s) may have moved money without confirmation. Verify each in the MMG portal, then resolve from the billing intents queue.`,
              data: { kind: 'billing_unknown_intents_sla', unknownAged },
            }),
          );
        }
        return;
      }

      if (job.name === 'batching-shadow-scan') {
        // System 1 Part 8 — SHADOW mode: pairs the unassigned dispatchable
        // pool and records SHADOW_WOULD_BATCH evidence rows. Writes
        // BatchEvaluation and NOTHING else — zero dispatch behavior change.
        // The founder's ≥2-week go/no-go (acceptance #1) reads these rows.
        const { runShadowScan } = await import('../modules/batching/shadow-scan');
        const res = await runShadowScan(ctx.prisma);
        if (res.capped) ctx.log.warn(res, 'batching: shadow scan CAPPED');
        return;
      }

      if (job.name === 'route-match') {
        // [ALG-16] Map-match a completed delivery's trace ONCE and freeze the
        // actual distance beside the planned one. Idempotent; a missing trace
        // is recorded as no match, never as a straight line.
        const { matchOrderRoute } = await import('../modules/dispatch/route-match');
        const res = await matchOrderRoute({ prisma: ctx.prisma, redis: ctx.redis }, (job.data as { orderId: string }).orderId);
        if (res.outcome === 'matched' || res.outcome === 'unmatched') ctx.log.info(res, 'route-match');
        return;
      }

      if (job.name === 'eta-pad-weekly') {
        // [ALG-12] Relearn the lateness pads from four weeks of delivered
        // orders and write the founder's weekly "did we keep our promises" row.
        const { weeklyEtaCalibration } = await import('../modules/eta/promise');
        const r = await weeklyEtaCalibration(ctx.prisma);
        ctx.log.info({ realisedOnTimeRate: r.realisedOnTimeRate, delivered: r.delivered, learned: r.learned }, 'eta-promise: weekly calibration');
        return;
      }
      if (job.name === 'prep-stats-nightly') {
        // [ALG-03] The prep-time learner: recompute every vendor's acceptedAt →
        // readyAt distribution from the trailing 30 days.
        const { computePrepStats } = await import('../modules/prep/prep-time');
        ctx.log.info(await computePrepStats(ctx.prisma), 'prep-time: stats recomputed');
        return;
      }
      if (job.name === 'prep-shadow-grade') {
        // [ALG-03] Grade the shadow predictions against what actually happened
        // and record whether the promotion gate passed.
        const { gradeShadow } = await import('../modules/prep/prep-time');
        const r = await gradeShadow(ctx.prisma);
        ctx.log.info({ graded: r.graded, medianAbsErrorMinutes: r.medianAbsErrorMinutes, p80Coverage: r.p80Coverage, passes: r.gate.passes }, 'prep-time: shadow graded');
        return;
      }
      if (job.name === 'mmg-link-apply') {
        // [ALG-34 / ALG-INV-14] Staged MMG pay link changes go live only after
        // their cool-off passed with no cancellation from the owner.
        const { applyDueMmgLinkChanges, deliverPendingMoneySurfaceNotices } = await import('../modules/integrity/money-surface');
        const r = await applyDueMmgLinkChanges({ prisma: ctx.prisma, io: ctx.io });
        if (r.applied > 0) ctx.log.info(r, 'money-surface: MMG pay links applied after cool-off');
        // [R048-007] every committed owner-notice intent not yet delivered is retried here
        const n = await deliverPendingMoneySurfaceNotices({ prisma: ctx.prisma, io: ctx.io });
        if (n.delivered > 0 || n.pending > 0) ctx.log.info(n, 'money-surface: owner notices delivered from the outbox');
        return;
      }
      if (job.name === 'algo-decision-retention') {
        // [ALGO Band 0.3] The decision log's retention: shadow rows are
        // evidence for a promotion decision and expire at 90 days; rows that
        // affected a person or their money stay 400 days for appeals.
        const { purgeAlgoDecisions } = await import('../modules/algo/decisions');
        const purged = await purgeAlgoDecisions(ctx.prisma);
        if (purged.shadow + purged.live > 0) ctx.log.info(purged, 'algo: decision log retention');
        return;
      }

      if (job.name === 'guardian-sweep') {
        // Trip Guardian tick [safety spec §5]. Opens a session for every taxi
        // that went RIDE_IN_PROGRESS, runs the L1 detectors off the SAME
        // persisted driver fix dispatch reads, closes sessions whose ride
        // ended. All state is DB rows and every mutation is create-unique or
        // CAS — idempotent, overlap-safe, catches up after worker downtime.
        const { GuardianService } = await import('../modules/safety/guardian.service');
        const res = await new GuardianService(ctx.prisma, ctx.io).sweep();
        if (res.opened + res.closed + res.flagged + res.escalated > 0) {
          ctx.log.info(res, 'Trip Guardian sweep');
        }
        // [S-05 · operations] Page maximum due age and the poison population,
        // not processed counts: a sweep whose pass has stalled past the SLO,
        // or a row that keeps failing, is a human's problem now.
        // [S-06] The check-in delivery worker: drain what every ask owns,
        // backfill asks with no rows, and page per deadline that must not run.
        const { drainCheckinDeliveries, backfillCheckinDeliveries, scanCheckinDeliveries, checkinDeliveryKilled } = await import('../modules/safety/guardian-delivery');
        const { NotificationService: GuardianNS, notifyAdmins: pageAdmins } = await import('../modules/notification/notification.service');
        if (!checkinDeliveryKilled()) {
          const back = await backfillCheckinDeliveries(ctx.prisma).catch(() => ({ backfilled: [] as string[] }));
          if (back.backfilled.length > 0) ctx.log.warn({ backfilled: back.backfilled }, '[S-06] check-in asks had no delivery rows — staged now');
          const drained = await drainCheckinDeliveries(ctx.prisma, new GuardianNS(ctx.prisma, ctx.io), { limit: 200 }).catch(() => null);
          if (drained && (drained.failed > 0 || drained.deadLettered > 0)) ctx.log.error(drained, '[S-06] check-in deliveries failed this tick');
        }
        const deliveries = await scanCheckinDeliveries(ctx.prisma).catch(() => null);
        for (const held of (deliveries?.deadlineWithoutDelivery ?? []).slice(0, 20)) {
          await opsPageOnce(ctx, `guardian-undelivered:${held.sessionId}`, 600, () =>
            pageAdmins(ctx.prisma, new GuardianNS(ctx.prisma, ctx.io), {
              tenantId: held.tenantId,
              title: 'Guardian: hard check-in not delivered',
              body: `Session ${held.sessionId} has waited ${held.ageSeconds}s with its hard check-in ${held.state.toLowerCase()}. The deadline is held; please look at the trip.`,
              data: { kind: 'guardian_checkin_undelivered', sessionId: held.sessionId, delivery: held.state, watchdog: true },
            }),
          ).catch(() => {});
        }
        const { scanSweeps } = await import('../lib/sweep-cursor');
        const sweeps = await scanSweeps(ctx.prisma).catch(() => []);
        const trouble = sweeps.filter((w) => w.stalled || w.repeatPoison.length > 0);
        if (trouble.length > 0) {
          const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
          for (const w of trouble) {
            await opsPageOnce(ctx, `sweep-slo:${w.workType}`, 1800, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: `Safety sweep behind: ${w.workType}`,
                body: w.stalled
                  ? `The ${w.workType} sweep has not completed a pass for ${w.passAgeSeconds}s (current pass ${w.currentPassSeconds}s). Rows past the cursor are waiting.`
                  : `The ${w.workType} sweep has ${w.repeatPoison.length} row(s) failing on every pass — the first: ${w.repeatPoison[0]?.id} (${w.repeatPoison[0]?.lastError}).`,
                data: { kind: 'safety_sweep_slo', workType: w.workType, stalled: w.stalled, passAgeSeconds: w.passAgeSeconds, repeatPoison: w.repeatPoison.slice(0, 5).map((r) => r.id) },
              }),
            ).catch(() => {});
          }
        }
        return;
      }

      if (job.name === 'incident-sla-watch') {
        // [S-08 · operations] Likely duplicate intakes (pre-fingerprint cases)
        // are named for a human; enforcement they drove is paged, never
        // reversed automatically.
        {
          const { IncidentService: DupScan } = await import('../modules/safety/incident.service');
          const dup = await new DupScan(ctx.prisma, ctx.io).scanDuplicateIntakes().catch(() => ({ clusters: [] }));
          const enforced = dup.clusters.filter((c) => c.enforcementFromDuplicate);
          if (enforced.length > 0) {
            const { notifyAdmins: pageDup, NotificationService: DupNS } = await import('../modules/notification/notification.service');
            await opsPageOnce(ctx, 'incident-duplicate-intake', 6 * 3600, () =>
              pageDup(ctx.prisma, new DupNS(ctx.prisma, ctx.io), {
                tenantId: null,
                title: `Incident intake: ${enforced.length} likely duplicate cluster(s) drove enforcement`,
                body: 'Cases born from the same report within minutes carry an interim suspension or a pattern flag. Review and merge the duplicates; enforcement is reversed only by that review.',
                data: { kind: 'incident_duplicate_intake', clusters: enforced.slice(0, 10).map((c) => ({ survivor: c.survivorId, duplicates: c.duplicateIds })) },
              }),
            ).catch(() => {});
          }
        }
        // §8.2 — a blown SLA clock pages ops, and keeps re-paging every
        // window while the breach persists (an SLA that only whispers once
        // is a lie to the reporter). opsPageOnce is the dedup.
        const { IncidentService } = await import('../modules/safety/incident.service');
        const breaches = await new IncidentService(ctx.prisma, ctx.io).slaWatch();
        if (breaches.length > 0) {
          const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
          for (const b of breaches) {
            await opsPageOnce(ctx, `inc-sla:${b.id}:${b.kind}`, 6 * 3600, () =>
              notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
                // Platform-wide ops page: an aggregate scan or infra alarm, not one
                // tenant's event. Explicitly null so it reads as a decision [NOC-A F45].
                tenantId: null,
                title: `⏰ SLA breached — case ${b.caseNumber} (${b.severity})`,
                body: `The ${b.kind === 'ACK' ? 'acknowledge' : 'decide'} clock has blown. Work the case now.`,
                data: { kind: 'incident_sla_breach', caseId: b.id, breach: b.kind, severity: b.severity },
              }),
            ).catch(() => {});
          }
          ctx.log.warn({ count: breaches.length }, 'incident SLA breaches');
        }
        return;
      }

      if (job.name === 'liveness-midshift') {
        // §7.2 random mid-shift identity checks. Dormant unless
        // LIVENESS_REQUIRED=1; state is DB columns (prompt deadline), the
        // enforcement is CAS — idempotent, overlap-safe, restart-proof.
        const { LivenessService } = await import('../modules/safety/liveness.service');
        const sweepMs = Math.max(60_000, Number(process.env['LIVENESS_MIDSHIFT_SWEEP_MS']) || 300_000);
        const res = await new LivenessService(ctx.prisma, ctx.io).midshiftSweep(new Date(), sweepMs);
        if (res.prompted + res.enforced > 0) {
          ctx.log.info(res, 'Liveness mid-shift sweep');
        }
        return;
      }

      if (job.name === 'stale-movers') {
        const swept = await sweepStaleMovers(ctx.prisma, undefined, ctx.redis);
        if (swept.riders + swept.drivers > 0) {
          ctx.log.warn(swept, 'Stale-GPS movers forced offline');
        }
        // A stale-GPS driver may still be HOLDING a ride — the sweep only flips
        // isOnline, it never resolves the ride. Recover it so the customer isn't
        // stranded on a frozen map: release-and-re-dispatch before pickup, or
        // page ops + notify if the passenger is already aboard.
        const { recovered, flagged } = await recoverStrandedTaxiRides(ctx.prisma, ctx.redis, ctx.io, async (orderId) => {
          await queues.dispatchQueue.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
        });
        if (recovered.length + flagged.length > 0) {
          ctx.log.error({ recovered, flagged }, 'Stranded-taxi watchdog: released pre-pickup rides / flagged in-progress driver drops');
        }
        // [danger #32] The DELIVERY twin: a rider gone dark holding an
        // assignment. Pre-custody → release + float back + re-dispatch;
        // goods-in-hand → page ops + tell the customer, never auto-cancel.
        const { recoverStrandedDeliveries } = await import('../modules/dispatch/delivery-watchdog');
        const dw = await recoverStrandedDeliveries(ctx.prisma, ctx.redis, ctx.io, async (orderId) => {
          await queues.dispatchQueue.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
        });
        // [ALG-06 ②] Waiting, riderless orders past their vertical's food-age
        // cutoff go to a person, cancelled by the system, marking nobody.
        const { sweepFoodAge } = await import('../modules/dispatch/rescue');
        const { NotificationService } = await import('../modules/notification/notification.service');
        const aged = await sweepFoodAge({ prisma: ctx.prisma, redis: ctx.redis, io: ctx.io, notifications: new NotificationService(ctx.prisma, ctx.io) });
        if (aged.retired.length > 0) ctx.log.warn({ retired: aged.retired }, 'rescue: orders too old to deliver were cancelled and handed to a person');
        if (dw.recovered.length + dw.flagged.length > 0) {
          ctx.log.error({ recovered: dw.recovered, flagged: dw.flagged }, 'Stranded-delivery watchdog: released pre-pickup orders / flagged goods-in-hand rider drops');
        }
        return;
      }

      if (job.name === 'reconcile-dispatch') {
        // Recover orders stranded by lost Redis state (offer key + timeout job
        // both live only in Redis). Re-drives them through the normal path.
        const { recovered } = await reconcileStuckDispatch(ctx.prisma, ctx.redis, async (orderId) => {
          await queues.dispatchQueue.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
        });
        if (recovered.length > 0) {
          ctx.log.error({ recovered, count: recovered.length }, 'Dispatch reconciliation re-drove stranded orders — investigate Redis health');
        }
        return;
      }

      if (job.name === 'reconcile-earnings') {
        // [F-0028 / G-002] A mover who went unpaid is the one defect nobody but
        // the mover would ever notice — and they would notice it as "Swift
        // shorted me". Heal it, and page, because a non-zero count means an
        // upstream path lost an earnings write.
        const { OrderService, reconcileMissingEarnings } = await import('../modules/order/order.service');
        const { scanned, healed, taxiUnpaidDelivered, courierUnpaidDelivered } = await reconcileMissingEarnings(
          ctx.prisma,
          new OrderService(ctx.prisma, ctx.io),
        );
        // [M-29] A cash ride delivered with no captured fare after the fare
        // outcome became mandatory means a completion bypassed the terminal
        // authority — page, and keep paging while it persists.
        if (taxiUnpaidDelivered.sinceEnforced + courierUnpaidDelivered.sinceEnforced > 0) {
          const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
          await opsPageOnce(ctx, 'taxi-unpaid-earning', 6 * 3600, () =>
            notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
              tenantId: null,
              title: '🚕 Cash jobs completed without a recorded payment',
              body: `${taxiUnpaidDelivered.sinceEnforced} ride(s) and ${courierUnpaidDelivered.sinceEnforced} courier job(s) are delivered with no collected cash since the cash outcome became mandatory. A completion path is bypassing the cash step — review before a mover is paid for money nobody recorded.`,
              data: { kind: 'earnings_missing', variant: 'cash_unpaid_completion', taxi: taxiUnpaidDelivered.sinceEnforced, courier: courierUnpaidDelivered.sinceEnforced },
            }),
          ).catch(() => {});
        }
        if (healed.length > 0) {
          ctx.log.error({ healed, count: healed.length, scanned }, 'Earnings reconciliation paid movers a completion had missed — investigate the completion path');
          const { notifyAdmins, NotificationService: NS } = await import('../modules/notification/notification.service');
          await opsPageOnce(ctx, 'earnings-missing', 6 * 3600, () =>
            notifyAdmins(ctx.prisma, new NS(ctx.prisma, ctx.io), {
              // Platform-wide ops page: an aggregate scan or infra alarm, not one
              // tenant's event. Explicitly null so it reads as a decision [NOC-A F45].
              tenantId: null,
              title: '💸 Movers were paid late by the reconciler',
              body: `${healed.length} delivered order(s) had no earnings row and were healed. A completion path is losing the earnings write — investigate before a mover notices first.`,
              data: { kind: 'earnings_missing', count: healed.length },
            }),
          ).catch(() => {});
        }
        return;
      }

      if (job.name === 'agent-ops-scan') {
        // Ops agent (spec Part B): deterministic detection → model classifies
        // a PII-free snapshot → gated execution. Runs whenever a key is present
        // (AGENT_ENABLED=0 disables); sensitive actions wait for a human in assist mode.
        const { AgentService, agentEnabled } = await import('../modules/agent/agent.service');
        if (!agentEnabled()) return;
        const agent = new AgentService(ctx.prisma, ctx.io, async (orderId) => {
          await queues.dispatchQueue.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
        });
        const result = await agent.runOpsScan();
        if (result.scanned > 0) {
          ctx.log.info(result, 'Agent ops scan complete');
        }
        return;
      }

      if (job.name === 'release-held-orders') {
        // LIFECYCLE_V2 (spec Part A): held orders whose cancel window closed
        // become visible to the vendor + dispatchable. No-op while every order
        // is unheld (flag off ⇒ nothing ever matches).
        const { OrderService } = await import('../modules/order/order.service');
        const orders = new OrderService(ctx.prisma, ctx.io);
        const { released } = await orders.releaseDueHeldOrders(async (orderId) => {
          await queues.dispatchQueue.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
        });
        if (released.length > 0) {
          // A RELEASED order is the vendor's first sight of it — it deserves
          // the same escalation ladder a fresh checkout gets (re-alert, then
          // SMS). Previously only checkout enqueued this; a held order the
          // vendor slept through escalated nowhere.
          for (const orderId of released) {
            await queues.notificationQueue.add('vendor-alert-escalate', { orderId, level: 0 }, {
              delay: process.env['ALERTS_LOUD'] === '1' ? 30_000 : 60_000,
              removeOnComplete: 100,
              removeOnFail: 50,
            });
          }
          ctx.log.info({ count: released.length }, 'Held orders released to vendors/dispatch (+escalation ladders armed)');
        }
        return;
      }

      const dispatch = new DispatchService(
        ctx.prisma,
        ctx.redis,
        ctx.io,
        getMapsProvider(),
        async (orderId, riderId, delayMs, attemptId) => {
          await queues.dispatchQueue.add('offer-timeout', { orderId, riderId, attemptId }, {
            delay: delayMs,
            removeOnComplete: 100,
            removeOnFail: 50,
          });
        },
        async (orderId, delayMs) => {
          await queues.dispatchQueue.add('dispatch-order', { orderId }, {
            delay: delayMs,
            removeOnComplete: 100,
            removeOnFail: 50,
          });
          return true;
        },
      );

      if (job.name === 'dispatch-order') {
        await dispatch.dispatchOrder(job.data.orderId, job.data.tenantId);
      } else if (job.name === 'offer-timeout') {
        await dispatch.handleOfferTimeout(job.data.orderId, job.data.riderId, job.data.attemptId);
      } else if (job.name === 'supply-watch-scan') {
          // Availability spec §5: tell waiting customers when supply returns.
          const { scanSupplyWatches, scanStrugglingDeliveries } = await import('../modules/dispatch/supply-watch.service');
          const { NotificationService } = await import('../modules/notification/notification.service');
          const notifications = new NotificationService(ctx.prisma, ctx.io);
          const n = await scanSupplyWatches(ctx.prisma, dispatch, notifications);
          if (n > 0) ctx.log.info({ notified: n }, 'supply watch: customers told drivers are back');
          // Rides spec 5.5B: the queue rides the same cadence — expiry sweep +
          // FIFO auto-request through the real request core. Kill switch:
          // RIDE_QUEUE_DISABLED=1.
          {
            const { scanRideQueue } = await import('../modules/rides/queue.service');
            const { FareService } = await import('../modules/rides/fare.service');
            const q = await scanRideQueue({ prisma: ctx.prisma }, new FareService(ctx.prisma), dispatch, notifications);
            if (q.matched > 0 || q.expired > 0) {
              ctx.log.info(q, 'ride queue: scan results');
            }
          }
          // §4.2: ready-with-no-rider orders prompt the customer with options
          // (once). Flag-gated with the conversion it offers.
          if (process.env['DISPATCH_EXHAUSTION'] === '1') {
            const p = await scanStrugglingDeliveries(ctx.prisma, notifications);
            if (p > 0) ctx.log.info({ prompted: p }, 'struggling deliveries: options pushed');
          }
      }
    },
    { connection, concurrency: 5 },
  );

  // SEARCH: debounced per-vendor index sync [SWIFT-UG-SRCH-01]. Best-effort —
  // a failure logs and waits for the next write or the boot reconciler; it
  // must never crash a worker or spam retries against a down Meili.
  const searchWorker = buildWorker(
    QUEUE_NAMES.SEARCH,
    async (job: Job) => {
      if (job.name !== 'sync-vendor') return;
      const { vendorId } = job.data as { vendorId: string };
      try {
        const { SearchService } = await import('../modules/search/search.service');
        const svc = new SearchService(ctx.prisma);
        await svc.syncVendor(vendorId);
        const items = await svc.syncVendorItems(vendorId);
        ctx.log.info({ vendorId, items }, 'Search index synced for vendor');
      } catch (err) {
        ctx.log.warn({ err, vendorId }, 'Search sync failed — boot/manual reindex remains the reconciler');
      }
    },
    { connection, concurrency: 1 },
  );

  // Central collection drives readiness, activation, and bounded shutdown.
  // Failure/error listeners were attached at construction time, before Redis
  // connection activity can surface an EventEmitter `error`.
  const allWorkers: Record<string, Worker> = {
    order: orderWorker, subscription: subscriptionWorker,
    settlement: settlementWorker, verification: verificationWorker, dispatch: dispatchWorker,
    notification: notificationWorker, search: searchWorker,
  };

  const workerResources = Object.entries(allWorkers).map(([name, worker]) => ({
    name: `${name} worker`,
    close: () => worker.close(),
  }));
  let activated = false;
  let closing = false;
  let loopFailed = false;
  let startPromise: Promise<void> | undefined;
  const workerLoops: Promise<void>[] = [];

  const cleanup = idempotentAsync(async () => {
    closing = true;
    activated = false;
    await closeResourcesBounded(
      workerResources,
      positiveDurationMs(process.env['QUEUE_SHUTDOWN_TIMEOUT_MS'], 10_000),
    );
  });

  const start = (): Promise<void> => {
    startPromise ??= (async () => {
      if (closing) throw new Error('Cannot start BullMQ workers while closing');
      if (Object.values(allWorkers).some((worker) => worker.isRunning() || worker.isPaused())) {
        throw new Error('BullMQ worker activation preflight found an already active or paused worker');
      }

      // Calling run() enters each worker synchronously up to its first await.
      // Start every loop together only after the runtime's pre-commit checks.
      for (const [name, worker] of Object.entries(allWorkers)) {
        const loop = worker.run();
        workerLoops.push(loop);
        void loop.then(() => {
          if (closing) return;
          loopFailed = true;
          ctx.log.error({ queue: name }, 'BullMQ worker loop stopped unexpectedly');
        }).catch((err) => {
          if (closing) return;
          loopFailed = true;
          ctx.log.error({ queue: name, err }, 'BullMQ worker loop failed');
          try {
            captureError(err, { queue: name, component: 'bullmq-worker-loop' });
          } catch (captureFailure) {
            ctx.log.error({ queue: name, err: captureFailure }, 'Failed to capture BullMQ worker loop failure');
          }
        });
      }

      // Observe immediate run() rejections before declaring the commit live.
      await Promise.resolve();
      if (loopFailed || !Object.values(allWorkers).every((worker) => worker.isRunning())) {
        throw new Error('One or more BullMQ workers failed to enter the running state');
      }
      activated = true;
    })();
    return startPromise;
  };

  const checkReady = async (): Promise<boolean> => {
    if (!activated || closing || loopFailed) return false;
    if (!Object.values(allWorkers).every((worker) => worker.isRunning() && !worker.isPaused())) {
      return false;
    }

    try {
      await Promise.all(Object.values(allWorkers).map(async (worker) => {
        // Actively probe the worker's command connection. Its blocking client
        // may legitimately be inside BZPOPMIN, so sending PING there would sit
        // behind the blocking fetch and falsely mark an idle healthy worker
        // down. isRunning/isPaused plus the observed lifetime promise above is
        // the authoritative current-consumer state.
        const commandClient = await worker.client;
        if (commandClient.status !== 'ready') {
          throw new Error(`BullMQ worker ${worker.name} is ${commandClient.status}`);
        }
        const commandPong = await commandClient.ping();
        if (commandPong !== 'PONG') {
          throw new Error(`BullMQ worker ${worker.name} ping failed`);
        }
      }));
      return activated && !closing && !loopFailed;
    } catch {
      return false;
    }
  };

  return {
    orderWorker,
    subscriptionWorker,
    settlementWorker,
    verificationWorker,
    dispatchWorker,
    notificationWorker,
    searchWorker,
    waitUntilReady: () => Promise.all(Object.values(allWorkers).map((worker) => worker.waitUntilReady())),
    start,
    checkReady,
    cleanup,
  };
  } catch (error) {
    try {
      await closeResourcesBounded(
        constructedWorkers.map((worker, index) => ({
          name: `partially initialized worker ${index}`,
          close: () => worker.close(),
        })),
        positiveDurationMs(process.env['QUEUE_SHUTDOWN_TIMEOUT_MS'], 10_000),
      );
    } catch (cleanupError) {
      ctx.log.error({ err: cleanupError }, 'BullMQ partial worker construction cleanup failed');
    }
    throw error;
  }
}

export async function scheduleRecurringJobs(queues: ReturnType<typeof createQueues>) {
  // Subscription billing: check every hour
  await queues.subscriptionQueue.add('process-billing', {}, {
    repeat: { pattern: '0 * * * *' }, // every hour
    removeOnComplete: 100,
    removeOnFail: 50,
  });

  // Settlements: weekly on Sunday at midnight
  await queues.settlementQueue.add('process-settlements', {}, {
    repeat: { pattern: '0 0 * * 0' }, // Sunday midnight
    removeOnComplete: 10,
    removeOnFail: 10,
  });

  // Backup freshness: daily at 05:30, before the working day. Reads the
  // heartbeat deploy/backup.sh writes; pages when backups have quietly stopped
  // or are staying on the machine they protect.
  await queues.verificationQueue.add('backup-freshness', {}, {
    repeat: { pattern: '30 5 * * *' },
    removeOnComplete: 10,
    removeOnFail: 10,
  });

  // Verification document expiry sweep + reminders: daily at 06:00
  await queues.verificationQueue.add('expiry-sweep', {}, {
    repeat: { pattern: '0 6 * * *' },
    removeOnComplete: 30,
    removeOnFail: 30,
  });

  // [DCR-1 NR-2] Retention clocks: daily at 04:10, before the day starts.
  await queues.verificationQueue.add('retention-sweep', {}, {
    repeat: { pattern: '10 4 * * *' },
    removeOnComplete: 30,
    removeOnFail: 30,
  });

  // [DCR-1 CW] Commencement Watch: every 6 hours. Zero channels → RED.
  await queues.verificationQueue.add('cw-scan', {}, {
    repeat: { pattern: '0 */6 * * *' },
    removeOnComplete: 30,
    removeOnFail: 30,
  });

  // Random document re-verification sample (liability shield): monthly on the
  // 1st at 07:00 — a human re-reviews a random slice of active movers.
  await queues.verificationQueue.add('compliance-sample', {}, {
    repeat: { pattern: '0 7 1 * *' },
    removeOnComplete: 12,
    removeOnFail: 12,
  });

  // Supply watcher scan (availability §5): every 2 minutes, cheap no-op when
  // no watches exist.
  await queues.dispatchQueue.add('supply-watch-scan', {}, {
    repeat: { pattern: '*/2 * * * *' },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Ads reservation expiry [ads-platform spec §7.3]: every minute, release
  // RESERVED holds whose TTL lapsed so the inventory frees up for others.
  await queues.dispatchQueue.add('ads-release-expired', {}, {
    repeat: { pattern: '* * * * *' },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Ads campaign lifecycle [ads-platform spec §6.1]: hourly — auto-cancel
  // unapproved before go-live, activate scheduled weeks, complete finished runs.
  await queues.dispatchQueue.add('ads-lifecycle', {}, {
    repeat: { pattern: '0 * * * *' },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Ads stats rollup [ads-platform spec §12.3]: nightly at 02:00 — aggregate
  // yesterday's AdEvent rows into AdStatsDaily for the advertiser dashboard.
  await queues.dispatchQueue.add('ads-stats-rollup', {}, {
    repeat: { pattern: '0 2 * * *' },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Ads weekly performance report [§16]: Monday 09:00 Guyana (13:00 UTC —
  // Caribbean TZs are DST-free) — after the 02:00 rollup, so last week's
  // numbers are complete.
  await queues.dispatchQueue.add('ads-weekly-report', {}, {
    repeat: { pattern: '0 13 * * 1' },
    removeOnComplete: 12,
    removeOnFail: 12,
  });

  // USD pricing FX-change notices [System 2 Part 12]: daily 12:00 UTC (08:00
  // Guyana) — DB-deduped per rate change; no-op until the tenant flag is on.
  await queues.dispatchQueue.add('billing-fx-notices', {}, {
    repeat: { pattern: '0 12 * * *' },
    removeOnComplete: 12,
    removeOnFail: 12,
  });

  // Batching shadow scan: every 60s (pair dedup makes finer ticks pointless;
  // the LIVE add-on scanner, when it exists, runs on addonScanIntervalS).
  await queues.dispatchQueue.add('batching-shadow-scan', {}, {
    repeat: { every: 60_000 },
    removeOnComplete: 5,
    removeOnFail: 5,
  });

  // Algorithm decision log retention: daily, in the quiet hours.
  await queues.dispatchQueue.add('algo-decision-retention', {}, {
    repeat: { pattern: '40 3 * * *' },
    removeOnComplete: 5,
    removeOnFail: 5,
  });

  // [ALG-12] ETA promise: relearn the pads and report the realised rate, Mondays 03:40.
  await queues.dispatchQueue.add('eta-pad-weekly', {}, { repeat: { pattern: '40 3 * * 1' }, removeOnComplete: 5, removeOnFail: 5 });

  // [ALG-03] Prep-time learner: nightly stats at 03:10, the shadow grade at 03:25.
  await queues.dispatchQueue.add('prep-stats-nightly', {}, { repeat: { pattern: '10 3 * * *' }, removeOnComplete: 5, removeOnFail: 5 });
  await queues.dispatchQueue.add('prep-shadow-grade', {}, { repeat: { pattern: '25 3 * * *' }, removeOnComplete: 5, removeOnFail: 5 });

  // [ALG-34] MMG pay link cool-off: every five minutes, apply what is due.
  await queues.dispatchQueue.add('mmg-link-apply', {}, {
    repeat: { every: 5 * 60_000 },
    removeOnComplete: 5,
    removeOnFail: 5,
  });

  // Agent-cash suspense SLA: hourly (page dedup lives in opsPageOnce).
  await queues.dispatchQueue.add('agent-cash-sla', {}, {
    repeat: { pattern: '15 * * * *' },
    removeOnComplete: 5,
    removeOnFail: 5,
  });

  // Billing invariants: nightly 03:30 (after the 03:00 money jobs settle).
  await queues.dispatchQueue.add('billing-invariants', {}, {
    repeat: { pattern: '30 3 * * *' },
    removeOnComplete: 7,
    removeOnFail: 7,
  });

  // QR attribution: expired fingerprints hard-delete hourly (DPA — ephemeral
  // by design; ATTRIB_PURGE_CRON in the qr spec's config registry).
  await queues.dispatchQueue.add('qr-attribution-purge', {}, {
    repeat: { pattern: '0 * * * *' },
    removeOnComplete: 24,
    removeOnFail: 24,
  });

  // Category discovery Stage-C: nightly derived-membership reconcile (the
  // on-change path runs debounced in-process; this is the safety net).
  await queues.dispatchQueue.add('discovery-derivation', {}, {
    repeat: { pattern: '0 5 * * *' },
    removeOnComplete: 7,
    removeOnFail: 7,
  });

  // Stage-B AI classifier: hourly nibble at the un-placed backlog under the
  // daily budget (waits silently when spent — spec: nobody sees degradation).
  await queues.dispatchQueue.add('discovery-ai-classify', {}, {
    repeat: { pattern: '20 * * * *' },
    removeOnComplete: 24,
    removeOnFail: 24,
  });

  // Movement R: nightly full stats recompute (RAT-H reconciliation leg).
  await queues.dispatchQueue.add('rating-stats-recompute', {}, {
    repeat: { pattern: '30 4 * * *' },
    removeOnComplete: 7,
    removeOnFail: 7,
  });

  // Movement R: daily actor-facing fold (RAT-G anonymity) — after the 04:30
  // recompute so the folded view reads settled aggregates.
  await queues.dispatchQueue.add('rating-actor-fold', {}, {
    repeat: { pattern: '45 4 * * *' },
    removeOnComplete: 7,
    removeOnFail: 7,
  });

  // Movement R10: the one rating reminder — 22:00 UTC = 18:00 Guyana evening,
  // when people actually have the minute.
  await queues.dispatchQueue.add('rating-reminder-sweep', {}, {
    repeat: { pattern: '0 22 * * *' },
    removeOnComplete: 7,
    removeOnFail: 7,
  });

  // Rating anti-manipulation sweep: daily at 04:00
  await queues.verificationQueue.add('flag-ratings', {}, {
    repeat: { pattern: '0 4 * * *' },
    removeOnComplete: 30,
    removeOnFail: 30,
  });

  // Vendor↔rider collusion affinity scan (SWIFT-164): weekly, Monday 06:00 —
  // after tier-recalc (05:00), before the human's week starts.
  await queues.verificationQueue.add('collusion-affinity-scan', {}, {
    repeat: { pattern: '0 6 * * 1' },
    removeOnComplete: 10,
    removeOnFail: 10,
  });

  // Booking reminders (§4.3): hourly — each confirmed slot nudges both sides
  // once inside the 24h window (dedupe rides on the notification log).
  await queues.verificationQueue.add('booking-reminders', {}, {
    repeat: { pattern: '30 * * * *' },
    removeOnComplete: 50,
    removeOnFail: 30,
  });

  // Vendor tier recalculation from catalogue size: weekly, Monday 05:00
  await queues.subscriptionQueue.add('tier-recalc', {}, {
    repeat: { pattern: '0 5 * * 1' },
    removeOnComplete: 10,
    removeOnFail: 10,
  });

  // Convert expired trials → active (the hourly cycle then bills them): daily 03:00
  await queues.subscriptionQueue.add('convert-trials', {}, {
    repeat: { pattern: '0 3 * * *' },
    removeOnComplete: 30,
    removeOnFail: 30,
  });

  // §13 MMG billing rail: poll in-flight merchant-initiated requests every 2
  // minutes — the payer approves on their phone in seconds, not next hour.
  await queues.subscriptionQueue.add('poll-mmg-billing', {}, {
    repeat: { every: 120_000 },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Scheduler liveness heartbeat, every 60s (launch-readiness Phase 6). The
  // observability gauge reads its age; a stale beacon = the worker died and
  // every recurring job silently stopped.
  await queues.dispatchQueue.add('scheduler-heartbeat', {}, {
    repeat: { every: 60_000 },
    removeOnComplete: 5,
    removeOnFail: 5,
  });

  // Durable mover-session revocations: low-latency callers attempt delivery
  // immediately, while this sweep reclaims process-death leases and retries
  // Redis cleanup, online-hours closure, redispatch and realtime fan-out.
  // [M-11] The checkout outbox sweep: low-latency callers publish their own
  // rows immediately; this reclaims lapsed leases and retries failures.
  await queues.dispatchQueue.add('checkout-outbox', {}, {
    repeat: { every: Math.max(1_000, Number(process.env['ORDER_OUTBOX_SWEEP_MS']) || 10_000) },
    removeOnComplete: 20,
    removeOnFail: 20,
  });
  await queues.dispatchQueue.add('mover-revocation-outbox', {}, {
    repeat: {
      every: Math.max(1_000, Number(process.env['MOVER_REVOCATION_SWEEP_MS']) || 10_000),
    },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Ghost-mover sweep: force-offline anyone whose GPS went silent, every 5
  // minutes — dead phones must not keep swallowing dispatch offers.
  await queues.dispatchQueue.add('stale-movers', {}, {
    repeat: { pattern: '*/5 * * * *' },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Ops agent problem scan (spec Part B): every 60s; runs whenever
  // ANTHROPIC_API_KEY is set (AGENT_ENABLED=0 disables). Detection is
  // deterministic SQL — the model only classifies; money actions wait in the
  // approval queue.
  await queues.dispatchQueue.add('agent-ops-scan', {}, {
    repeat: { every: Number(process.env['AGENT_SCAN_INTERVAL_SECONDS'] ?? 60) * 1000 },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // LIFECYCLE_V2 hold release: flip held orders whose cancel window closed to
  // visible + dispatchable. The server clock owns the window — the customer
  // closing the app changes nothing. No-op while the flag is off.
  // [B18] 10s, not 30s: the sweep interval IS the release tail. At 30s an
  // order could sit released-but-invisible for up to 29s after its ring hit
  // 0:00 — a 24% overrun on the old 2-minute hold, and still 10% on the
  // designed 5. At 10s the worst case is a 3% tail on the 5-minute window.
  // (The precise fix — a per-order delayed job at holdExpiresAt — is noted in
  // the Total Audit; the sweep stays either way as the crash-proof backstop.)
  await queues.dispatchQueue.add('release-held-orders', {}, {
    repeat: { every: 10_000 },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Dispatch reconciliation: every 2 minutes, recover any order stranded by
  // lost Redis state (the offer key + timeout job vanish on a Redis restart).
  // This is the self-heal for the platform's most failure-sensitive path.
  await queues.dispatchQueue.add('reconcile-dispatch', {}, {
    repeat: { pattern: '*/2 * * * *' },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // [F-0028 / G-002] Earnings reconciliation. Every 15 minutes is enough: the
  // grace window is 10, and a mover cares that they are paid today, not within
  // seconds. Deliberately NOT tighter — a sweep that runs constantly makes its
  // own alert routine, and this one should be rare enough that a page means
  // something.
  await queues.dispatchQueue.add('reconcile-earnings', {}, {
    repeat: { pattern: '*/15 * * * *' },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // SOS grace-expiry backstop [F-0003 / safety spec §4.1]: promote any
  // TRIGGER_PENDING alert whose server-owned grace elapsed to ACTIVE. The client
  // promotes on the happy path (it confirms when the grace bar completes); this
  // is the app-kill-proof backstop — a closed app must never stop an escalation.
  // Tight cadence because it's life-safety and the query is a trivial,
  // highly-selective indexed lookup that returns nothing almost always. `|| `
  // (not `??`) so garbage/NaN/0 all fall back to the default; floored at 2s so a
  // misconfig can't turn it into pathological churn.
  await queues.dispatchQueue.add('promote-sos-grace', {}, {
    repeat: { every: Math.max(2_000, Number(process.env['SOS_GRACE_SWEEP_MS']) || 10_000) },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Trip Guardian tick [safety spec §5]: session open/close reconciliation +
  // the L1 detectors on every live taxi ride. 15s default is far inside every
  // detector budget (sustain 90s, stops 3–5 min, check-in deadline 120s);
  // floored at 5s — the tick reads a handful of indexed rows but a misconfig
  // must not turn it into a stampede. Same `||` discipline as above.
  await queues.dispatchQueue.add('guardian-sweep', {}, {
    repeat: { every: Math.max(5_000, Number(process.env['GUARDIAN_SWEEP_MS']) || 15_000) },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Random mid-shift identity checks [safety spec §7.2]. 5-minute cadence,
  // floored at 60s; the sweep itself no-ops unless LIVENESS_REQUIRED=1. The
  // SAME interval is passed into the sweep so the per-tick selection
  // probability keeps averaging LIVENESS_MIDSHIFT_PER_WEEK per mover.
  await queues.dispatchQueue.add('liveness-midshift', {}, {
    repeat: { every: Math.max(60_000, Number(process.env['LIVENESS_MIDSHIFT_SWEEP_MS']) || 300_000) },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Incident SLA watch [safety spec §8.2]: every 5 minutes — S0 acks are due
  // in 5, so the watch cadence IS the tightest clock it guards.
  await queues.dispatchQueue.add('incident-sla-watch', {}, {
    repeat: { every: Math.max(60_000, Number(process.env['INCIDENT_SLA_WATCH_MS']) || 300_000) },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  // Cross-reporter pattern scan [safety spec §8.4 rule 2]: nightly 05:00,
  // after the rating sweep (04:00) whose flags may feed tomorrow's cases.
  await queues.verificationQueue.add('incident-pattern-scan', {}, {
    repeat: { pattern: '0 5 * * *' },
    removeOnComplete: 30,
    removeOnFail: 30,
  });

  // Evidence retention [safety spec §9.4]: nightly 04:30 — unsealed
  // case-less bundles age out; sealed/legal-hold never (DB triggers agree).
  await queues.verificationQueue.add('evidence-retention', {}, {
    repeat: { pattern: '30 4 * * *' },
    removeOnComplete: 30,
    removeOnFail: 30,
  });

  // Weekly safety digest [safety spec §8.4]: Monday 06:30 — after the
  // collusion scan (06:00), so the founder's read includes it.
  await queues.verificationQueue.add('incident-weekly-digest', {}, {
    repeat: { pattern: '30 6 * * 1' },
    removeOnComplete: 10,
    removeOnFail: 10,
  });
}
