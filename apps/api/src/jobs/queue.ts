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

const QUEUE_NAMES = {
  ORDER: 'order-jobs',
  RIDER_ASSIGNMENT: 'rider-assignment',
  SUBSCRIPTION: 'subscription-jobs',
  SETTLEMENT: 'settlement-jobs',
  NOTIFICATION: 'notification-jobs',
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

  // SUBSCRIPTION BILLING
  const subscriptionWorker = new Worker(
    QUEUE_NAMES.SUBSCRIPTION,
    async (job: Job) => {
      switch (job.name) {
        case 'process-billing': {
          const now = new Date();
          const dueSubscriptions = await ctx.prisma.subscription.findMany({
            where: {
              status: { in: ['ACTIVE', 'PAST_DUE'] },
              nextBillingDate: { lte: now },
              autoRenew: true,
            },
            include: {
              rider: { include: { user: { select: { id: true, walletBalance: true } } } },
              driver: { include: { user: { select: { id: true, walletBalance: true } } } },
              vendor: { include: { owner: { include: { user: { select: { id: true, walletBalance: true } } } } } },
            },
          });

          for (const sub of dueSubscriptions) {
            const user = sub.rider?.user || sub.driver?.user || sub.vendor?.owner?.user;
            if (!user) continue;

            const amount = sub.customRate ? Number(sub.customRate) : Number(sub.weeklyRate);
            const balance = Number(user.walletBalance);

            if (balance >= amount) {
              // Charge wallet
              await ctx.prisma.user.update({
                where: { id: user.id },
                data: { walletBalance: { decrement: amount } },
              });

              const newBalance = balance - amount;
              await ctx.prisma.transaction.create({
                data: {
                  userId: user.id,
                  type: 'SUBSCRIPTION_PAYMENT',
                  amount,
                  direction: 'out',
                  description: `Weekly subscription: ${sub.type}`,
                  reference: sub.id,
                  balanceAfter: newBalance,
                },
              });

              const periodStart = new Date();
              const periodEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

              await ctx.prisma.subscription.update({
                where: { id: sub.id },
                data: {
                  status: 'ACTIVE',
                  currentPeriodStart: periodStart,
                  currentPeriodEnd: periodEnd,
                  nextBillingDate: periodEnd,
                  lastPaymentDate: now,
                  failedAttempts: 0,
                  isInGracePeriod: false,
                },
              });

              await ctx.prisma.subscriptionPayment.create({
                data: {
                  subscriptionId: sub.id,
                  amount,
                  status: 'CAPTURED',
                  paymentMethod: 'WALLET',
                  periodStart,
                  periodEnd,
                  paidAt: now,
                },
              });

              ctx.log.info({ subscriptionId: sub.id, userId: user.id }, 'Subscription billed');
            } else {
              // Insufficient balance
              const newAttempts = sub.failedAttempts + 1;
              const gracePeriodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);

              await ctx.prisma.subscription.update({
                where: { id: sub.id },
                data: {
                  status: newAttempts >= 3 ? 'SUSPENDED' : 'PAST_DUE',
                  failedAttempts: newAttempts,
                  isInGracePeriod: newAttempts < 3,
                  gracePeriodEnd: newAttempts < 3 ? gracePeriodEnd : undefined,
                },
              });

              ctx.log.warn({ subscriptionId: sub.id, userId: user.id, attempts: newAttempts }, 'Subscription payment failed');
            }
          }
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

  return {
    orderWorker,
    riderAssignmentWorker,
    subscriptionWorker,
    settlementWorker,
    cleanup: async () => {
      await Promise.all([
        orderWorker.close(),
        riderAssignmentWorker.close(),
        subscriptionWorker.close(),
        settlementWorker.close(),
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
}
