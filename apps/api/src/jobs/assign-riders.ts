import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { getDispatchPlanner, type DispatchPlanner } from '../providers/dispatch/dispatch-planner';

// ---------------------------------------------------------------------------
// Rider auto-assignment sweep (queue fallback path). Each trigger message
// plans the WHOLE outstanding batch — with the VROOM planner configured, two
// simultaneous orders get the globally best pairing instead of racing for the
// same nearest rider. Application is compare-and-set on both rows, so racers
// (a rider accepting, another sweep) resolve to exactly one winner.
// ---------------------------------------------------------------------------

export interface AssignResult {
  assigned: number;
  /** Whether the order that triggered this sweep got a rider. */
  triggerAssigned: boolean;
}

export async function assignReadyRiders(
  deps: { prisma: PrismaClient; io: Server },
  triggerOrderId: string,
  planner: DispatchPlanner = getDispatchPlanner(),
): Promise<AssignResult> {
  const { prisma, io } = deps;

  // The whole outstanding batch, oldest first (fairness on scarce riders).
  const orders = await prisma.order.findMany({
    where: {
      status: 'READY_FOR_PICKUP',
      riderId: null,
      pickupLat: { not: null },
      pickupLng: { not: null },
    },
    select: { id: true, orderNumber: true, pickupLat: true, pickupLng: true },
    orderBy: { placedAt: 'asc' },
    take: 50,
  });
  if (orders.length === 0) return { assigned: 0, triggerAssigned: true };

  const riders = await prisma.rider.findMany({
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
    return { assigned: 0, triggerAssigned: !orders.some((o) => o.id === triggerOrderId) };
  }

  const plan = await planner.planAssignments(
    orders.map((o) => ({ orderId: o.id, lat: o.pickupLat!, lng: o.pickupLng! })),
    riders.map((r) => ({ riderId: r.id, lat: r.currentLat!, lng: r.currentLng! })),
  );

  const orderById = new Map(orders.map((o) => [o.id, o]));
  const riderById = new Map(riders.map((r) => [r.id, r]));
  let assigned = 0;
  let triggerAssigned = !orders.some((o) => o.id === triggerOrderId);

  for (const pair of plan) {
    const order = orderById.get(pair.orderId);
    const rider = riderById.get(pair.riderId);
    if (!order || !rider) continue;

    // CAS both sides: the rider may have taken something else meanwhile, the
    // order may have been claimed through the offer cascade.
    const gotRider = await prisma.rider.updateMany({
      where: { id: rider.id, isAvailable: true, currentOrderId: null },
      data: { isAvailable: false, currentOrderId: order.id },
    });
    if (gotRider.count === 0) continue;

    const gotOrder = await prisma.order.updateMany({
      where: { id: order.id, status: 'READY_FOR_PICKUP', riderId: null },
      data: { riderId: rider.id, status: 'RIDER_ASSIGNED' },
    });
    if (gotOrder.count === 0) {
      // Roll the rider back — the order was claimed under us.
      await prisma.rider.updateMany({
        where: { id: rider.id, currentOrderId: order.id },
        data: { isAvailable: true, currentOrderId: null },
      });
      continue;
    }

    await prisma.orderStatusLog.create({
      data: { orderId: order.id, status: 'RIDER_ASSIGNED', changedBy: rider.user.id, note: `Auto-assigned to ${rider.user.firstName}` },
    });
    io.to(`order:${order.id}`).emit('order:status_changed', { orderId: order.id, status: 'RIDER_ASSIGNED', riderId: rider.id });
    io.to(`user:${rider.user.id}`).emit('delivery:assigned', { orderId: order.id, orderNumber: order.orderNumber });

    assigned += 1;
    if (order.id === triggerOrderId) triggerAssigned = true;
  }

  return { assigned, triggerAssigned };
}
