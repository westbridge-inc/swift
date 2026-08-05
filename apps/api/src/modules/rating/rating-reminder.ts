// ---------------------------------------------------------------------------
// Movement R — R10: prompt once + ONE reminder, never more. The prompt is the
// existing delivered/completed notification; this module is the reminder — a
// daily sweep over orders finished 24–48h ago that the customer never rated.
// Idempotence is a DB fact, not a cadence hope: each send is deduped against
// the notification row it wrote (data.kind + data.orderId), so a re-run — or
// an overlapping window after downtime — can never nag twice (R10 law).
// Flag: PlatformConfig RATINGS_ENABLED — absent row = ON (ratings shipped live
// before the flag existed; the founder can set false to silence the system).
// ---------------------------------------------------------------------------

import type { PrismaClient } from '@prisma/client';
import type { NotificationService } from '../notification/notification.service';

export const RATINGS_FLAG = 'RATINGS_ENABLED';

export async function ratingsEnabled(prisma: PrismaClient): Promise<boolean> {
  const row = await prisma.platformConfig.findUnique({ where: { key: RATINGS_FLAG } });
  if (!row) return true;
  return !(row.value === false || row.value === 'false');
}

const HOUR = 3600_000;

export async function runRatingReminderSweep(
  prisma: PrismaClient,
  notifications: Pick<NotificationService, 'send'>,
  now = new Date(),
): Promise<number> {
  if (!(await ratingsEnabled(prisma))) return 0;

  const orders = await prisma.order.findMany({
    where: {
      status: { in: ['DELIVERED', 'COMPLETED'] },
      deliveredAt: { gte: new Date(now.getTime() - 48 * HOUR), lt: new Date(now.getTime() - 24 * HOUR) },
    },
    select: {
      id: true,
      customerId: true,
      orderType: true,
      vendor: { select: { name: true } },
      driver: { select: { user: { select: { firstName: true } } } },
    },
  });
  if (!orders.length) return 0;

  // Already-rated orders are done — one query for the batch.
  const rated = new Set(
    (
      await prisma.rating.findMany({
        where: { orderId: { in: orders.map((o) => o.id) } },
        select: { orderId: true, raterId: true },
      })
    )
      .filter((r) => orders.some((o) => o.id === r.orderId && o.customerId === r.raterId))
      .map((r) => r.orderId),
  );

  let sent = 0;
  for (const o of orders) {
    if (rated.has(o.id)) continue;
    // DB-fact dedupe: the reminder we previously wrote IS the guard.
    const already = await prisma.notification.findFirst({
      where: {
        userId: o.customerId,
        data: { path: ['kind'], equals: 'RATING_REMINDER' },
        AND: { data: { path: ['orderId'], equals: o.id } },
      },
      select: { id: true },
    });
    if (already) continue;

    const what =
      o.orderType === 'TAXI'
        ? `your ride${o.driver?.user?.firstName ? ` with ${o.driver.user.firstName}` : ''}`
        : `your order from ${o.vendor?.name ?? 'the store'}`;
    await notifications.send({
      userId: o.customerId,
      type: 'ORDER_UPDATE',
      title: 'Got a minute?',
      body: `Rate ${what}.`,
      data: { kind: 'RATING_REMINDER', orderId: o.id },
    });
    sent += 1;
  }
  return sent;
}
