import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type Redis from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import type { FastifyBaseLogger } from 'fastify';
import { captureError } from '../plugins/observability';

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
export const DEFAULT_JOB_OPTIONS = {
  attempts: Math.max(1, Number(process.env['JOB_MAX_ATTEMPTS'] ?? 3)),
  backoff: { type: 'exponential' as const, delay: Math.max(100, Number(process.env['JOB_BACKOFF_MS'] ?? 5_000)) },
  removeOnComplete: 100,
  removeOnFail: 50,
};

export function createQueues(redis: Redis) {
  const connection = bullConnectionOpts(redis);
  const defaultJobOptions = DEFAULT_JOB_OPTIONS;

  return {
    orderQueue: new Queue(QUEUE_NAMES.ORDER, { connection, defaultJobOptions }),
    subscriptionQueue: new Queue(QUEUE_NAMES.SUBSCRIPTION, { connection, defaultJobOptions }),
    settlementQueue: new Queue(QUEUE_NAMES.SETTLEMENT, { connection, defaultJobOptions }),
    notificationQueue: new Queue(QUEUE_NAMES.NOTIFICATION, { connection, defaultJobOptions }),
    verificationQueue: new Queue(QUEUE_NAMES.VERIFICATION, { connection, defaultJobOptions }),
    dispatchQueue: new Queue(QUEUE_NAMES.DISPATCH, { connection, defaultJobOptions }),
    searchQueue: new Queue(QUEUE_NAMES.SEARCH, { connection, defaultJobOptions }),
  };
}

/** Weekly vendor settlement snapshot [SWIFT-AUD-D6-05 / D7-01].
 *  Exported so tests can drive it directly; the settlement worker delegates
 *  here. BullMQ single-delivery keeps the schedule from double-firing across
 *  instances — this function's own guard is what makes a RETRY or an operator
 *  requeue safe (see the covered-window check). */
export async function runWeeklySettlement(ctx: JobContext) {
  const now = new Date();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const vendors = await ctx.prisma.vendor.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
  });
  const activeIds = vendors.map((v) => v.id);
  if (activeIds.length === 0) return;

  // Idempotency guard [SWIFT-AUD-D7-01]: period bounds are wall-clock, so a
  // retry recomputes a shifted window and no unique key could dedupe it. A
  // vendor whose latest settlement already reaches into this window is
  // settled for the week and skipped; its tail (prior periodEnd → now) rolls
  // into the next weekly cycle rather than risking a double-created week.
  const covered = await ctx.prisma.settlement.findMany({
    where: { vendorId: { in: activeIds }, periodEnd: { gt: weekAgo } },
    select: { vendorId: true },
  });
  const alreadyCovered = new Set(covered.map((s) => s.vendorId));

  // SWIFT-AUD-D6-05: one grouped aggregate instead of a per-vendor
  // findMany+create loop (N+1 that grew linearly with the vendor count).
  //
  // SWIFT-022: window on the COMPLETED status-log entry, NOT deliveredAt. Only
  // delivery orders ever set deliveredAt, so filtering on it silently dropped
  // ALL takeaway (PICKUP) and appointment revenue from the digest. Every order
  // type reaches COMPLETED exactly once (delivery auto-completes), so its
  // COMPLETED log is the one universal, once-per-order completion marker — no
  // type is missed and nothing is counted in two weeks.
  const completed = await ctx.prisma.orderStatusLog.findMany({
    where: {
      status: 'COMPLETED',
      createdAt: { gte: weekAgo, lte: now },
      order: { vendorId: { in: activeIds } },
    },
    select: { orderId: true },
    distinct: ['orderId'],
  });
  const completedOrderIds = completed.map((c) => c.orderId);
  if (completedOrderIds.length === 0) return;

  const groups = await ctx.prisma.order.groupBy({
    by: ['vendorId'],
    where: {
      id: { in: completedOrderIds },
      // Exclude anything refunded/cancelled after it completed.
      status: { in: ['DELIVERED', 'COMPLETED'] },
    },
    _sum: { subtotalBase: true, subtotalMarkup: true },
    _count: { _all: true },
  });

  const settlements = groups
    .filter((g) => g.vendorId && g._count._all > 0 && !alreadyCovered.has(g.vendorId!))
    .map((g) => ({
      vendorId: g.vendorId!,
      periodStart: weekAgo,
      periodEnd: now,
      totalOrders: g._count._all,
      totalBase: Number(g._sum.subtotalBase ?? 0),
      totalMarkup: Number(g._sum.subtotalMarkup ?? 0),
      status: 'PENDING' as const,
    }));

  if (settlements.length > 0) {
    await ctx.prisma.settlement.createMany({ data: settlements });
  }
  ctx.log.info({ settlements: settlements.length }, 'Settlements created');
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
 *  directly; the order worker delegates here. A CAS single-winner cancel of an
 *  order that is STILL PENDING and no longer HELD — the vendor had the hold
 *  window plus the response SLA and never accepted. Restocks (goods were
 *  reserved at checkout; a PENDING order has no rider/float), notifies the
 *  customer honestly, and — crucially — leaves `cancelledBy` unset, so this
 *  NEVER counts against the customer's risk score (the vendor was silent, not
 *  the customer; the risk query requires cancelledBy === the customer). */
export async function autoCancelUnresponsiveOrder(ctx: JobContext, orderId: string): Promise<boolean> {
  const cancelled = await ctx.prisma.order.updateMany({
    where: {
      id: orderId,
      status: 'PENDING',
      OR: [{ holdExpiresAt: null }, { holdExpiresAt: { lte: new Date() } }],
    },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Auto-cancelled: vendor did not respond' },
  });
  if (cancelled.count === 0) return false; // held, already accepted, or gone — no-op

  const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  await ctx.prisma.orderStatusLog.create({
    data: { orderId, status: 'CANCELLED', note: 'Auto-cancelled: vendor did not respond' },
  });

  const { OrderService } = await import('../modules/order/order.service');
  await new OrderService(ctx.prisma, ctx.io).applyCancellationSideEffects(
    { id: order.id, paymentMethod: order.paymentMethod, riderId: order.riderId, driverId: order.driverId, subtotalBase: Number(order.subtotalBase) },
    { restock: true },
  );

  ctx.io.to(`order:${orderId}`).emit('order:status_changed', { orderId, status: 'CANCELLED' });
  if (order.vendorId) ctx.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', { orderId, status: 'CANCELLED' });

  const { NotificationService } = await import('../modules/notification/notification.service');
  await new NotificationService(ctx.prisma, ctx.io).send({
    userId: order.customerId,
    type: 'ORDER_UPDATE',
    title: 'Order cancelled — no response',
    body: `We're sorry — the store didn't respond to order ${order.orderNumber} in time, so it was cancelled. You were not charged; please try another store.`,
    data: { orderId, status: 'CANCELLED' },
  });
  ctx.log.info({ orderId }, 'Order auto-cancelled (vendor no-response)');
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
        title: 'Possible vendor–rider collusion',
        body: `${pairs.length} vendor–rider pair(s) show an unusual concentration of guarantee claims. Review the claims dashboard before the next settlement.`,
        data: { kind: 'ops_collusion_affinity', pairs: pairs.slice(0, 20) },
      }),
    );
  }
  ctx.log.info({ flaggedPairs: pairs.length }, 'Vendor–rider collusion affinity scan');
  return { flaggedPairs: pairs.length };
}

export function createWorkers(ctx: JobContext) {
  const connection = bullConnectionOpts(ctx.redis);

  // ORDER JOBS: auto-cancel, auto-complete
  const orderWorker = new Worker(
    QUEUE_NAMES.ORDER,
    async (job: Job) => {
      switch (job.name) {
        case 'auto-cancel': {
          await autoCancelUnresponsiveOrder(ctx, job.data.orderId);
          break;
        }
        case 'auto-complete': {
          const { orderId } = job.data;
          const order = await ctx.prisma.order.findUnique({ where: { id: orderId } });
          if (order && order.status === 'DELIVERED') {
            await ctx.prisma.order.update({
              where: { id: orderId },
              data: { status: 'COMPLETED' },
            });
            await ctx.prisma.orderStatusLog.create({
              data: { orderId, status: 'COMPLETED', note: 'Auto-completed after delivery window' },
            });
            ctx.log.info({ orderId }, 'Order auto-completed');
          }
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
  const subscriptionWorker = new Worker(
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
          ctx.log.info({ changed }, 'Vendor tier recalculation complete');
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
          break;
        }
      }
    },
    { connection, concurrency: 1 },
  );

  // SETTLEMENT: weekly vendor payouts (logic lives in runWeeklySettlement so
  // tests can prove its idempotency without BullMQ plumbing)
  const settlementWorker = new Worker(
    QUEUE_NAMES.SETTLEMENT,
    async (job: Job) => {
      if (job.name !== 'process-settlements') return;
      await runWeeklySettlement(ctx);
    },
    { connection, concurrency: 1 },
  );

  // VERIFICATION: daily expiry sweep + 30-day reminders
  const verificationWorker = new Worker(
    QUEUE_NAMES.VERIFICATION,
    async (job: Job) => {
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
        const { EvidenceService } = await import('../modules/safety/evidence.service');
        const swept = await new EvidenceService(ctx.prisma, ctx.io).retentionSweep();
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
  const notificationWorker = new Worker(
    QUEUE_NAMES.NOTIFICATION,
    async (job: Job) => {
      if (job.name !== 'vendor-alert-escalate') return;
      const { escalateVendorAlert } = await import('../modules/notification/notification.service');
      const { getChannels } = await import('../providers/notifications/channels');

      const { orderId, level = 0 } = job.data;
      const outcome = await escalateVendorAlert(ctx.prisma, ctx.io, getChannels(), orderId, level);

      if (outcome === 'realerted') {
        const queue = new Queue(QUEUE_NAMES.NOTIFICATION, { connection });
        await queue.add('vendor-alert-escalate', { orderId, level: 1 }, {
          // §A1: SMS at +75s total when loud (30+45); default stays 60+60.
          delay: process.env['ALERTS_LOUD'] === '1' ? 45_000 : 60_000,
          removeOnComplete: 100,
          removeOnFail: 50,
        });
        await queue.close();
      }
    },
    { connection, concurrency: 5 },
  );

  // DISPATCH: offer cascade — start offers, enforce the 20s timeout, retry
  // an exhausted order once, and sweep ghost movers off the online pool.
  const dispatchWorker = new Worker(
    QUEUE_NAMES.DISPATCH,
    async (job: Job) => {
      const { DispatchService, sweepStaleMovers, reconcileStuckDispatch, recoverStrandedTaxiRides } = await import('../modules/dispatch/dispatch.service');
      const { getMapsProvider } = await import('../providers/maps/maps-provider');

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
                title: 'Database pool saturated',
                body: `${waiting} queries are waiting for a database connection. Find the slow query or raise connection_limit.`,
                data: { kind: 'ops_pool_saturation', waiting },
              }),
            );
          }
        } catch {
          // metrics preview unavailable — the Prometheus gauge shares this guard
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
        const { runFxChangeNotices } = await import('../modules/billing/fx-notices');
        const res = await runFxChangeNotices(ctx.prisma, ctx.io);
        if (res.notified > 0) ctx.log.info(res, 'billing: fx change notices');
        // Part 13 Mode B: sunset notices (T−30/T−7, data-guaranteed) + the
        // past-sunset flip with the missing-notice alert. No-op unless Mode B.
        const { sweepModeB } = await import('../modules/billing/usd-migration');
        const b = await sweepModeB(ctx.prisma, ctx.io);
        if (b.notices + b.flipped > 0) ctx.log.info(b, 'billing: usd migration Mode B sweep');
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

      if (job.name === 'discovery-backfill') {
        // The backfill movement (#17 CAT-I): admin-triggered, once per tenant.
        // Idempotent — a re-run writes nothing new and never re-notifies.
        const { runCategoryBackfill } = await import('../modules/discovery/backfill');
        const { AiService } = await import('../modules/ai/ai.service');
        const { NotificationService } = await import('../modules/notification/notification.service');
        const notifications = new NotificationService(ctx.prisma, ctx.io);
        const report = await runCategoryBackfill(ctx.prisma, new AiService(), {
          notify: (userId) => notifications.send({
            userId,
            type: 'SYSTEM_ANNOUNCEMENT',
            title: 'Your menu just got easier to find',
            body: 'Review your categories — takes about 2 minutes.',
            data: { kind: 'category_backfill_review' },
          }).then(() => undefined),
        });
        ctx.log.info(report, 'discovery: backfill movement complete');
        return;
      }

      if (job.name === 'discovery-ai-classify') {
        // Stage-B (category spec Part 4): budgeted AI pass over items Stage A
        // couldn't place. Budget exhausted or model down = silent wait.
        const { runAiClassifierBatch } = await import('../modules/discovery/ai-classifier');
        const { AiService } = await import('../modules/ai/ai.service');
        const r = await runAiClassifierBatch(ctx.prisma, new AiService());
        if (r.scanned > 0) ctx.log.info(r, 'discovery: AI classifier batch');
        return;
      }

      if (job.name === 'discovery-derivation') {
        // Stage-C nightly (category spec Part 4): recompute DERIVED store
        // memberships from live-item tags; chosen rows untouchable.
        const { reconcileAllDerived } = await import('../modules/discovery/derivation');
        const r = await reconcileAllDerived(ctx.prisma);
        if (r.added + r.removed > 0) ctx.log.info(r, 'discovery: derived memberships reconciled');
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
        const broken = report.walletMismatches.length + report.wrongfulSuspensions.length + report.enforcementLeaks.length + report.receiptGaps.length;
        if (broken > 0) {
          const { notifyAdmins, NotificationService } = await import('../modules/notification/notification.service');
          await opsPageOnce(ctx, 'billing-invariants', 12 * 3600, () =>
            notifyAdmins(ctx.prisma, new NotificationService(ctx.prisma, ctx.io), {
              title: 'Billing invariant failures',
              body: `${report.walletMismatches.length} wallet mismatch(es), ${report.wrongfulSuspensions.length} wrongful suspension(s) auto-healed, ${report.enforcementLeaks.length} enforcement leak(s), ${report.receiptGaps.length} receipt gap(s).`,
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
              title: 'Agent payment stuck unmatched > 24h',
              body: `${stale} cash payment(s) are sitting unresolved — someone may be paid but still paused. Command → Billing → Unmatched.`,
              data: { kind: 'agent_cash_sla', stale },
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
        return;
      }

      if (job.name === 'incident-sla-watch') {
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
        const watchQueue = new Queue(QUEUE_NAMES.DISPATCH, { connection });
        try {
          const { recovered, flagged } = await recoverStrandedTaxiRides(ctx.prisma, ctx.redis, ctx.io, async (orderId) => {
            await watchQueue.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
          });
          if (recovered.length + flagged.length > 0) {
            ctx.log.error({ recovered, flagged }, 'Stranded-taxi watchdog: released pre-pickup rides / flagged in-progress driver drops');
          }
        } finally {
          await watchQueue.close();
        }
        return;
      }

      if (job.name === 'reconcile-dispatch') {
        // Recover orders stranded by lost Redis state (offer key + timeout job
        // both live only in Redis). Re-drives them through the normal path.
        const reconcileQueue = new Queue(QUEUE_NAMES.DISPATCH, { connection });
        try {
          const { recovered } = await reconcileStuckDispatch(ctx.prisma, ctx.redis, async (orderId) => {
            await reconcileQueue.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
          });
          if (recovered.length > 0) {
            ctx.log.error({ recovered, count: recovered.length }, 'Dispatch reconciliation re-drove stranded orders — investigate Redis health');
          }
        } finally {
          await reconcileQueue.close();
        }
        return;
      }

      if (job.name === 'agent-ops-scan') {
        // Ops agent (spec Part B): deterministic detection → model classifies
        // a PII-free snapshot → gated execution. Runs whenever a key is present
        // (AGENT_ENABLED=0 disables); sensitive actions wait for a human in assist mode.
        const { AgentService, agentEnabled } = await import('../modules/agent/agent.service');
        if (!agentEnabled()) return;
        const agentQueue = new Queue(QUEUE_NAMES.DISPATCH, { connection });
        try {
          const agent = new AgentService(ctx.prisma, ctx.io, async (orderId) => {
            await agentQueue.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
          });
          const result = await agent.runOpsScan();
          if (result.scanned > 0) {
            ctx.log.info(result, 'Agent ops scan complete');
          }
        } finally {
          await agentQueue.close();
        }
        return;
      }

      if (job.name === 'release-held-orders') {
        // LIFECYCLE_V2 (spec Part A): held orders whose cancel window closed
        // become visible to the vendor + dispatchable. No-op while every order
        // is unheld (flag off ⇒ nothing ever matches).
        const { OrderService } = await import('../modules/order/order.service');
        const releaseQueue = new Queue(QUEUE_NAMES.DISPATCH, { connection });
        try {
          const orders = new OrderService(ctx.prisma, ctx.io);
          const { released } = await orders.releaseDueHeldOrders(async (orderId) => {
            await releaseQueue.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
          });
          if (released.length > 0) {
            // A RELEASED order is the vendor's first sight of it — it deserves
            // the same escalation ladder a fresh checkout gets (re-alert, then
            // SMS). Previously only checkout enqueued this; a held order the
            // vendor slept through escalated nowhere.
            const notifQueue = new Queue(QUEUE_NAMES.NOTIFICATION, { connection });
            try {
              for (const orderId of released) {
                await notifQueue.add('vendor-alert-escalate', { orderId, level: 0 }, {
                  delay: process.env['ALERTS_LOUD'] === '1' ? 30_000 : 60_000,
                  removeOnComplete: 100,
                  removeOnFail: 50,
                });
              }
            } finally {
              await notifQueue.close();
            }
            ctx.log.info({ count: released.length }, 'Held orders released to vendors/dispatch (+escalation ladders armed)');
          }
        } finally {
          await releaseQueue.close();
        }
        return;
      }

      const dispatchQueue = new Queue(QUEUE_NAMES.DISPATCH, { connection });
      const dispatch = new DispatchService(
        ctx.prisma,
        ctx.redis,
        ctx.io,
        getMapsProvider(),
        async (orderId, riderId, delayMs) => {
          await dispatchQueue.add('offer-timeout', { orderId, riderId }, {
            delay: delayMs,
            removeOnComplete: 100,
            removeOnFail: 50,
          });
        },
        async (orderId, delayMs) => {
          await dispatchQueue.add('dispatch-order', { orderId }, {
            delay: delayMs,
            removeOnComplete: 100,
            removeOnFail: 50,
          });
          return true;
        },
      );

      try {
        if (job.name === 'dispatch-order') {
          await dispatch.dispatchOrder(job.data.orderId);
        } else if (job.name === 'offer-timeout') {
          await dispatch.handleOfferTimeout(job.data.orderId, job.data.riderId);
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
      } finally {
        await dispatchQueue.close();
      }
    },
    { connection, concurrency: 5 },
  );

  // SEARCH: debounced per-vendor index sync [SWIFT-UG-SRCH-01]. Best-effort —
  // a failure logs and waits for the next write or the boot reconciler; it
  // must never crash a worker or spam retries against a down Meili.
  const searchWorker = new Worker(
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

  // A worker that throws otherwise drops the job into the failed set with NO
  // log and NO alert — money jobs (billing, settlements) and dispatch could
  // fail invisibly. Surface every terminal failure and worker error loudly so
  // observability (Sentry, see server bootstrap) and ops actually see them.
  // SWIFT-121: EVERY worker — including search, which was created after the old
  // loop and silently had no handlers — is attached here, after all are built.
  const allWorkers: Record<string, Worker> = {
    order: orderWorker, subscription: subscriptionWorker,
    settlement: settlementWorker, verification: verificationWorker, dispatch: dispatchWorker,
    notification: notificationWorker, search: searchWorker,
  };
  for (const [queue, worker] of Object.entries(allWorkers)) {
    worker.on('failed', (job, err) => {
      ctx.log.error({ queue, jobName: job?.name, jobId: job?.id, attempts: job?.attemptsMade, data: job?.data, err }, 'BullMQ job failed');
      captureError(err, { queue, jobName: job?.name, jobId: job?.id, attempts: job?.attemptsMade });
    });
    worker.on('error', (err) => {
      ctx.log.error({ queue, err }, 'BullMQ worker error');
      captureError(err, { queue });
    });
  }

  return {
    orderWorker,
    subscriptionWorker,
    settlementWorker,
    verificationWorker,
    dispatchWorker,
    notificationWorker,
    searchWorker,
    cleanup: async () => {
      await Promise.all([
        orderWorker.close(),
        subscriptionWorker.close(),
        settlementWorker.close(),
        verificationWorker.close(),
        dispatchWorker.close(),
        notificationWorker.close(),
        searchWorker.close(),
      ]);
    },
  };
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

  // Verification document expiry sweep + reminders: daily at 06:00
  await queues.verificationQueue.add('expiry-sweep', {}, {
    repeat: { pattern: '0 6 * * *' },
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

  // LIFECYCLE_V2 hold release: every 30s, flip held orders whose cancel window
  // closed to visible + dispatchable. The server clock owns the window — the
  // customer closing the app changes nothing. No-op while the flag is off.
  await queues.dispatchQueue.add('release-held-orders', {}, {
    repeat: { every: 30_000 },
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
