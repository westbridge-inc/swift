import type { Prisma, PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import { checkoutOutboxId } from '../order/checkout-outbox';

/**
 * [BUG-HUNT F18] What a finished delivery owes the rider who logged out with the goods: the suspension lifts.
 *
 * Its own durable row, written with the delivery in the one transition every door passes. It cannot ride on the
 * customer's handover notice: a parcel closes through the courier proof and has no such notice. The lift runs after
 * the commit because it takes the rider's User lock, and the transition already holds the Order lock.
 */
export const DELIVERY_LIFT_KIND = 'delivery-custody-lift';
/** Retried this long, then closed. The case is on the ops queue either way, so a person has it from there. */
export const DELIVERY_LIFT_WINDOW_MS = 24 * 60 * 60_000;

/** A suspension over these goods that no person has decided. */
export const heldOverGoods = (orderId: string, subjectUserId: string): Prisma.IncidentCaseWhereInput => ({
  orderId,
  subjectUserId,
  category: 'MOVER_SESSION_LOST_IN_CUSTODY',
  interimAction: 'SUSPENDED_PENDING_REVIEW',
  status: { in: ['OPEN', 'TRIAGED', 'INVESTIGATING'] },
});

/** Inside the delivery's transaction. A delivery with no suspension over it writes nothing. */
export async function persistDeliveryLift(tx: Prisma.TransactionClient, order: {
  id: string; tenantId: string; rider?: { userId: string } | null;
}): Promise<void> {
  if (!order.rider) return;
  if (await tx.incidentCase.count({ where: heldOverGoods(order.id, order.rider.userId) }) === 0) return;
  const dedupeKey = `order:${order.id}:${DELIVERY_LIFT_KIND}`;
  const id = checkoutOutboxId(dedupeKey);
  await tx.orderOutbox.upsert({ where: { id }, update: {}, create: {
    id, dedupeKey, orderId: order.id, tenantId: order.tenantId, kind: DELIVERY_LIFT_KIND, queue: 'notification', payload: { orderId: order.id },
  } });
}

export const liftAfterDelivery = (prisma: PrismaClient, io: Server) => async (orderId: string): Promise<void> => {
  const { IncidentService } = await import('./incident.service');
  await new IncidentService(prisma, io).liftAfterGoodsDelivered(orderId);
};

/** After the delivery's commit, and again from the worker's sweep. Lifting twice is a no-op. */
export async function drainDeliveryLifts(
  deps: { prisma: PrismaClient; lift: (orderId: string) => Promise<unknown>; now?: () => Date },
  options: { orderId?: string; limit?: number } = {},
): Promise<{ lifted: number; pending: number; expired: number }> {
  const system = <T>(fn: () => Promise<T>) => runAsSystem('delivery-lift-drain', fn);
  const clock = () => deps.now?.() ?? new Date();
  let lifted = 0;
  let pending = 0;
  let expired = 0;
  for (let i = 0; i < Math.min(200, Math.max(1, options.limit ?? 50)); i += 1) {
    const now = clock();
    const due = {
      kind: DELIVERY_LIFT_KIND, processedAt: null, availableAt: { lte: now },
      ...(options.orderId ? { orderId: options.orderId } : {}),
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - 60_000) } }],
    };
    const row = await system(() => deps.prisma.orderOutbox.findFirst({ where: due, orderBy: [{ availableAt: 'asc' }, { id: 'asc' }] }));
    if (!row) break;
    const claim = await system(() => deps.prisma.orderOutbox.updateMany({
      where: { ...due, id: row.id, attempts: row.attempts },
      data: { claimedAt: now, attempts: { increment: 1 } },
    }));
    if (claim.count !== 1) continue;
    const attempts = row.attempts + 1;
    if (now.getTime() - row.createdAt.getTime() >= DELIVERY_LIFT_WINDOW_MS) {
      await system(() => deps.prisma.orderOutbox.updateMany({
        where: { id: row.id, processedAt: null, attempts },
        data: { processedAt: clock(), claimedAt: null, lastError: 'Suspension not lifted within its window; the case stays with a person' },
      }));
      expired += 1;
      continue;
    }
    let done = false;
    try {
      await runWithTenant(row.tenantId, () => deps.lift(row.orderId));
      done = true;
    } catch { /* The row stays owed; the sweep retries it. */ }
    await system(() => deps.prisma.orderOutbox.updateMany({
      where: { id: row.id, processedAt: null, attempts },
      data: done ? { processedAt: clock(), claimedAt: null, lastError: null } : {
        claimedAt: null, lastError: 'Suspension lift failed',
        availableAt: new Date(clock().getTime() + Math.min(300_000, 2_000 * 2 ** Math.min(attempts, 8))),
      },
    }));
    if (done) lifted += 1; else pending += 1;
  }
  return { lifted, pending, expired };
}
