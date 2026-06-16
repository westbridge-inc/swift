import { Queue, Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import type { FastifyBaseLogger } from 'fastify';

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

  // RIDER ASSIGNMENT: find nearest available rider
  const riderAssignmentWorker = new Worker(
    QUEUE_NAMES.RIDER_ASSIGNMENT,
    async (job: Job) => {
      const { orderId, vendorLat, vendorLng, attempt = 1 } = job.data;
      const order = await ctx.prisma.order.findUnique({ where: { id: orderId } });
      if (!order || order.status !== 'READY_FOR_PICKUP' || order.riderId) return;

      // Find online, available, verified riders sorted by proximity
      const riders = await ctx.prisma.rider.findMany({
        where: {
          isOnline: true,
          isAvailable: true,
          documentsVerified: true,
          currentLat: { not: null },
          currentLng: { not: null },
        },
        include: { user: { select: { id: true, firstName: true } } },
      });

      if (riders.length === 0) {
        if (attempt < 6) {
          // Retry in 30 seconds
          const queue = new Queue(QUEUE_NAMES.RIDER_ASSIGNMENT, { connection });
          await queue.add('assign-rider', { orderId, vendorLat, vendorLng, attempt: attempt + 1 }, { delay: 30000 });
          await queue.close();
        }
        return;
      }

      // Sort by distance to vendor
      const sorted = riders
        .map((r) => {
          const dLat = (r.currentLat! - vendorLat) * Math.PI / 180;
          const dLng = (r.currentLng! - vendorLng) * Math.PI / 180;
          const a = Math.sin(dLat / 2) ** 2 + Math.cos(r.currentLat! * Math.PI / 180) * Math.cos(vendorLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
          const dist = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          return { ...r, distance: dist };
        })
        .sort((a, b) => a.distance - b.distance);

      const nearest = sorted[0];
      if (!nearest || nearest.distance > 10) {
        // No rider within 10km, retry
        if (attempt < 6) {
          const queue = new Queue(QUEUE_NAMES.RIDER_ASSIGNMENT, { connection });
          await queue.add('assign-rider', { orderId, vendorLat, vendorLng, attempt: attempt + 1 }, { delay: 30000 });
          await queue.close();
        }
        return;
      }

      // Assign rider
      await ctx.prisma.order.update({
        where: { id: orderId },
        data: { riderId: nearest.id, status: 'RIDER_ASSIGNED' },
      });
      await ctx.prisma.rider.update({
        where: { id: nearest.id },
        data: { isAvailable: false, currentOrderId: orderId },
      });
      await ctx.prisma.orderStatusLog.create({
        data: { orderId, status: 'RIDER_ASSIGNED', changedBy: nearest.user.id, note: `Auto-assigned to ${nearest.user.firstName}` },
      });

      ctx.io.to(`order:${orderId}`).emit('order:status_changed', { orderId, status: 'RIDER_ASSIGNED', riderId: nearest.id });
      // Notify rider
      ctx.io.to(`user:${nearest.user.id}`).emit('delivery:assigned', { orderId, orderNumber: order.orderNumber });

      ctx.log.info({ orderId, riderId: nearest.id, distance: nearest.distance.toFixed(1) }, 'Rider auto-assigned');
    },
    { connection, concurrency: 3 },
  );

  // SUBSCRIPTION BILLING — Step 5: idempotent BillingService, never wallets
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
      }
    },
    { connection, concurrency: 1 },
  );

  // SETTLEMENT: weekly vendor payouts
  const settlementWorker = new Worker(
    QUEUE_NAMES.SETTLEMENT,
    async (job: Job) => {
      if (job.name !== 'process-settlements') return;

      const now = new Date();
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const vendors = await ctx.prisma.vendor.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, ownerId: true },
      });

      for (const vendor of vendors) {
        const orders = await ctx.prisma.order.findMany({
          where: {
            vendorId: vendor.id,
            status: { in: ['DELIVERED', 'COMPLETED'] },
            deliveredAt: { gte: weekAgo, lte: now },
          },
          select: { subtotalBase: true, subtotalMarkup: true },
        });

        if (orders.length === 0) continue;

        const totalBase = orders.reduce((s, o) => s + Number(o.subtotalBase), 0);
        const totalMarkup = orders.reduce((s, o) => s + Number(o.subtotalMarkup), 0);

        await ctx.prisma.settlement.create({
          data: {
            vendorId: vendor.id,
            periodStart: weekAgo,
            periodEnd: now,
            totalOrders: orders.length,
            totalBase,
            totalMarkup,
            status: 'PENDING',
          },
        });

        ctx.log.info({ vendorId: vendor.id, totalBase, orders: orders.length }, 'Settlement created');
      }
    },
    { connection, concurrency: 1 },
  );

  // VERIFICATION: daily expiry sweep + 30-day reminders (Step 4)
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
        ctx.log.info(`Verification sweep: ${expired} expired, ${reminded} reminders sent, ${purged} purged`);
      }

      if (job.name === 'flag-ratings') {
        const { RatingService } = await import('../modules/rating/rating.service');
        const flagged = await new RatingService(ctx.prisma).flagSuspiciousRatings();
        ctx.log.info(`Rating anti-manipulation sweep: ${flagged} flagged`);
      }
    },
    { connection, concurrency: 1 },
  );

  // NOTIFICATIONS: Step 11 vendor-alert escalation — re-alert, then SMS
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
          delay: 60_000,
          removeOnComplete: 100,
          removeOnFail: 50,
        });
        await queue.close();
      }
    },
    { connection, concurrency: 5 },
  );

  // DISPATCH: Step 8 offer cascade — start offers and enforce the 20s timeout
  const dispatchWorker = new Worker(
    QUEUE_NAMES.DISPATCH,
    async (job: Job) => {
      const { DispatchService } = await import('../modules/dispatch/dispatch.service');
      const { getMapsProvider } = await import('../providers/maps/maps-provider');

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
      );

      try {
        if (job.name === 'dispatch-order') {
          await dispatch.dispatchOrder(job.data.orderId);
        } else if (job.name === 'offer-timeout') {
          await dispatch.handleOfferTimeout(job.data.orderId, job.data.riderId);
        }
      } finally {
        await dispatchQueue.close();
      }
    },
    { connection, concurrency: 5 },
  );

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

  // Rating anti-manipulation sweep: daily at 04:00
  await queues.verificationQueue.add('flag-ratings', {}, {
    repeat: { pattern: '0 4 * * *' },
    removeOnComplete: 30,
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
}
