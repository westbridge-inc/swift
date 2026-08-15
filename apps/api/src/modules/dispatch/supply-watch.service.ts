import type { PrismaClient } from '@prisma/client';
import type { NotificationService } from '../notification/notification.service';
import type { DispatchService } from './dispatch.service';
import { notSelfDeliveredFilter } from '../fulfillment/fulfillment-mode';

/**
 * Supply watcher scan (availability spec §5): customers who hit "no drivers
 * nearby" and asked to be told. Each scan checks unnotified, unexpired
 * watches against the SAME availability read dispatch uses; the first scan
 * that sees supply notifies ONCE and stamps. Capped per scan — this is a
 * courtesy loop, not a firehose.
 */
export async function scanSupplyWatches(
  prisma: PrismaClient,
  dispatch: DispatchService,
  notifications: NotificationService,
  cap = 50,
): Promise<number> {
  const watches = await prisma.supplyWatch.findMany({
    where: { notifiedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: cap,
  });

  // [E32 / danger #17] The watch row carries no tenant; its CUSTOMER does.
  // This worker runs without request tenant context, so an unscoped probe
  // counted EVERY operator's drivers — a customer could be told "drivers are
  // back" because a different operator's supply came online. Probe strictly
  // inside the watcher's own operator pool.
  const customers = await prisma.user.findMany({
    where: { id: { in: watches.map((w) => w.customerId) } },
    select: { id: true, tenantId: true },
  });
  const tenantByCustomer = new Map(customers.map((c) => [c.id, c.tenantId]));

  let notified = 0;
  for (const w of watches) {
    const tenantId = tenantByCustomer.get(w.customerId);
    if (!tenantId) continue;
    const supply = await dispatch.getAvailability(w.pool === 'RIDER' ? 'RIDER' : 'DRIVER', {
      lat: w.lat,
      lng: w.lng,
    }, 0, tenantId);
    if (supply.level === 'NONE') continue;

    // Stamp FIRST (CAS on notifiedAt null) so a racing scan can't double-send.
    const claimed = await prisma.supplyWatch.updateMany({
      where: { id: w.id, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    if (claimed.count === 0) continue;

    await notifications
      .send({
        userId: w.customerId,
        type: 'ORDER_UPDATE',
        title: '\u{1F695} Drivers are back near you',
        body:
          supply.nearestEtaMinutes != null
            ? `The nearest is about ${supply.nearestEtaMinutes} min away — request your ride now.`
            : 'Request your ride now.',
        audience: 'customer',
        data: { kind: 'supply_returned', pool: w.pool },
      })
      .catch(() => {});
    notified += 1;
  }
  return notified;
}


/**
 * Struggling-delivery options (availability spec §4.2 row 2): READY for
 * DELIVERY_ESCALATE_AFTER minutes with no rider bound — the customer gets the
 * options push ONCE (dedupe on the notification log): switch to pickup
 * (#242's conversion) or cancel; waiting stays possible but is not promised
 * as an active retry [REPORT-014 F-014-07: at terminal exhaustion nothing
 * auto-retries — the store's retry-dispatch or returning supply revives it;
 * a real customer "keep waiting" re-arm rides ENGINE-2].
 */
export async function scanStrugglingDeliveries(
  prisma: PrismaClient,
  notifications: NotificationService,
  escalateAfterMinutes = Number(process.env['DELIVERY_ESCALATE_AFTER_MIN'] ?? 5),
  cap = 50,
): Promise<number> {
  const cutoff = new Date(Date.now() - escalateAfterMinutes * 60_000);
  let prompted = 0;
  let cursor: { id: string } | undefined;
  // [REPORT-014 F-014-15] Page until CAP FRESH prompts (or candidates run
  // out): the old shape took the oldest 50 BEFORE the already-notified
  // dedupe, so 50 previously-prompted stragglers permanently hid the 51st.
  while (prompted < cap) {
    const struggling = await prisma.order.findMany({
      where: {
        status: 'READY_FOR_PICKUP',
        fulfillment: 'DELIVERY',
        riderId: null,
        readyAt: { lte: cutoff },
        vendorId: { not: null },
        orderType: { not: 'TAXI' },
        // [F-0026] Never tell a customer "no rider found — switch to pickup?" when
        // the vendor's own driver is the one bringing it.
        AND: [notSelfDeliveredFilter()],
      },
      select: { id: true, customerId: true, orderNumber: true },
      orderBy: [{ readyAt: 'asc' }, { id: 'asc' }],
      take: cap,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });
    if (struggling.length === 0) break;
    cursor = { id: struggling[struggling.length - 1]!.id };

    for (const o of struggling) {
      if (prompted >= cap) break;
      const already = await prisma.notification.findFirst({
        where: {
          userId: o.customerId,
          data: { path: ['orderId'], equals: o.id },
          AND: { data: { path: ['kind'], equals: 'delivery_options' } },
        },
        select: { id: true },
      });
      if (already) continue;

      await notifications
        .send({
          userId: o.customerId,
          type: 'ORDER_UPDATE',
          title: "We're having trouble finding a rider",
          body: `Order #${o.orderNumber} is ready and still waiting for a rider. You can switch to pickup or cancel — your call.`,
          data: { kind: 'delivery_options', orderId: o.id },
        })
        .catch(() => {});
      prompted += 1;
    }
    if (struggling.length < cap) break; // no more candidates behind the cursor
  }
  return prompted;
}
