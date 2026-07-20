import { Queue, Worker, type Job } from 'bullmq';
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
  RIDER_ASSIGNMENT: 'rider-assignment',
  SUBSCRIPTION: 'subscription-jobs',
  SETTLEMENT: 'settlement-jobs',
  NOTIFICATION: 'notification-jobs',
  VERIFICATION: 'verification-jobs',
  DISPATCH: 'dispatch-jobs',
} as const;

export { QUEUE_NAMES };

export function createQueues(redis: Redis) {
  const connection = { host: redis.options.host, port: redis.options.port };

  return {
    orderQueue: new Queue(QUEUE_NAMES.ORDER, { connection }),
    riderAssignmentQueue: new Queue(QUEUE_NAMES.RIDER_ASSIGNMENT, { connection }),
    subscriptionQueue: new Queue(QUEUE_NAMES.SUBSCRIPTION, { connection }),
    settlementQueue: new Queue(QUEUE_NAMES.SETTLEMENT, { connection }),
    notificationQueue: new Queue(QUEUE_NAMES.NOTIFICATION, { connection }),
    verificationQueue: new Queue(QUEUE_NAMES.VERIFICATION, { connection }),
    dispatchQueue: new Queue(QUEUE_NAMES.DISPATCH, { connection }),
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
  const groups = await ctx.prisma.order.groupBy({
    by: ['vendorId'],
    where: {
      vendorId: { in: activeIds },
      status: { in: ['DELIVERED', 'COMPLETED'] },
      deliveredAt: { gte: weekAgo, lte: now },
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

export function createWorkers(ctx: JobContext) {
  const connection = { host: ctx.redis.options.host, port: ctx.redis.options.port };

  // ORDER JOBS: auto-cancel, auto-complete
  const orderWorker = new Worker(
    QUEUE_NAMES.ORDER,
    async (job: Job) => {
      switch (job.name) {
        case 'auto-cancel': {
          const { orderId } = job.data;
          const order = await ctx.prisma.order.findUnique({ where: { id: orderId } });
          if (order && order.status === 'PENDING') {
            await ctx.prisma.order.update({
              where: { id: orderId },
              data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Auto-cancelled: vendor did not respond' },
            });
            await ctx.prisma.orderStatusLog.create({
              data: { orderId, status: 'CANCELLED', note: 'Auto-cancelled after timeout' },
            });
            ctx.io.to(`order:${orderId}`).emit('order:status_changed', { orderId, status: 'CANCELLED' });
            if (order.vendorId) {
              ctx.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', { orderId, status: 'CANCELLED' });
            }
            ctx.log.info({ orderId }, 'Order auto-cancelled');
          }
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

  // RIDER ASSIGNMENT: plan the whole outstanding batch per trigger — greedy by
  // default; with DISPATCH_PLANNER=vroom the batch is solved globally (the
  // build kit's dispatch brain), so simultaneous orders never race for the
  // same nearest rider. Concurrency 1: one sweep at a time; CAS keeps any
  // stragglers safe anyway.
  const riderAssignmentWorker = new Worker(
    QUEUE_NAMES.RIDER_ASSIGNMENT,
    async (job: Job) => {
      const { orderId, vendorLat, vendorLng, attempt = 1 } = job.data;
      const { assignReadyRiders } = await import('./assign-riders');

      const result = await assignReadyRiders({ prisma: ctx.prisma, io: ctx.io }, orderId);
      if (result.assigned > 0) {
        ctx.log.info({ trigger: orderId, assigned: result.assigned }, 'Rider auto-assignment sweep');
      }

      if (!result.triggerAssigned && attempt < 6) {
        // Nobody suitable yet — retry this order in 30 seconds, as before.
        const queue = new Queue(QUEUE_NAMES.RIDER_ASSIGNMENT, { connection });
        await queue.add('assign-rider', { orderId, vendorLat, vendorLng, attempt: attempt + 1 }, { delay: 30000 });
        await queue.close();
      }
    },
    { connection, concurrency: 1 },
  );

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
          ctx.log.info({ ...result, reminders }, 'Billing cycle complete');
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
      const { DispatchService, sweepStaleMovers, reconcileStuckDispatch } = await import('../modules/dispatch/dispatch.service');
      const { getMapsProvider } = await import('../providers/maps/maps-provider');

      if (job.name === 'scheduler-heartbeat') {
        // Liveness beacon for the job scheduler (launch-readiness Phase 6). If
        // this worker process dies, holds stop releasing, expiry sweeps stop,
        // settlements stop — silently. The heartbeat key's AGE (exposed as a
        // Prometheus gauge) makes that stall detectable and alertable.
        await ctx.redis.set('scheduler:heartbeat', String(Date.now()));
        return;
      }

      if (job.name === 'stale-movers') {
        const swept = await sweepStaleMovers(ctx.prisma);
        if (swept.riders + swept.drivers > 0) {
          ctx.log.warn(swept, 'Stale-GPS movers forced offline');
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
        // a PII-free snapshot → gated execution. No-op unless AGENT_ENABLED=1
        // with a key; sensitive actions wait for a human in assist mode.
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

  // A worker that throws otherwise drops the job into the failed set with NO
  // log and NO alert — money jobs (billing, settlements) and dispatch could
  // fail invisibly. Surface every terminal failure and worker error loudly so
  // observability (Sentry, see server bootstrap) and ops actually see them.
  const allWorkers: Record<string, Worker> = {
    order: orderWorker, riderAssignment: riderAssignmentWorker, subscription: subscriptionWorker,
    settlement: settlementWorker, verification: verificationWorker, dispatch: dispatchWorker, notification: notificationWorker,
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
    riderAssignmentWorker,
    subscriptionWorker,
    settlementWorker,
    verificationWorker,
    dispatchWorker,
    notificationWorker,
    cleanup: async () => {
      await Promise.all([
        orderWorker.close(),
        riderAssignmentWorker.close(),
        subscriptionWorker.close(),
        settlementWorker.close(),
        verificationWorker.close(),
        dispatchWorker.close(),
        notificationWorker.close(),
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

  // Rating anti-manipulation sweep: daily at 04:00
  await queues.verificationQueue.add('flag-ratings', {}, {
    repeat: { pattern: '0 4 * * *' },
    removeOnComplete: 30,
    removeOnFail: 30,
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

  // Ops agent problem scan (spec Part B): every 60s; a no-op unless
  // AGENT_ENABLED=1 + ANTHROPIC_API_KEY. Detection is deterministic SQL —
  // the model only classifies; money actions wait in the approval queue.
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
}
