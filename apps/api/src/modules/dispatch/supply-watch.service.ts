import type { PrismaClient } from '@prisma/client';
import type { NotificationService } from '../notification/notification.service';
import type { DispatchService } from './dispatch.service';

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

  let notified = 0;
  for (const w of watches) {
    const supply = await dispatch.getAvailability(w.pool === 'RIDER' ? 'RIDER' : 'DRIVER', {
      lat: w.lat,
      lng: w.lng,
    });
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
