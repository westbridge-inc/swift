import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { NotificationService } from '../notification/notification.service';
import { pageOps, resolveOpsPage, type PageOutcome } from '../ops/ops-page';

// ---------------------------------------------------------------------------
// [BUG-HUNT-2 G01] No silent three-day ride. A ride in progress whose driver is
// gone used to sit open with nobody told: the GPS page fires once, and only
// while the driver is flagged online. Every ten minutes the worker looks for a
// ride still in progress well past its estimate, and opens ONE platform page,
// closed when none is left. It is one page however many rides are overdue, and
// it is never an SOS. It closes nothing: a person looks, and ends the ride from
// the order if the driver is gone.
// ---------------------------------------------------------------------------

export const RIDE_OVERDUE_TITLE = 'Ride open far past its estimate';
export const RIDE_OVERDUE_KEY = 'ops_page:ride-overdue';
export const RIDE_OVERDUE_WINDOW_SECONDS = 6 * 3_600;
/** Past the ride's own estimate: traffic and a long stop are not a matter for support. */
export const RIDE_OVERDUE_AFTER_ETA_MS = 60 * 60_000;
/** A ride with no estimate on record. */
export const RIDE_OVERDUE_NO_ETA_MS = 3 * 3_600_000;
const BATCH = 500;

/** Pickup plus the estimate, the same deadline the guardian sets. A person looks, so a long multi-stop ride may page. */
function overdueAt(ride: { pickedUpAt: Date | null; placedAt: Date; taxiDuration: number | null }): number {
  const startedAt = (ride.pickedUpAt ?? ride.placedAt).getTime();
  return ride.taxiDuration === null
    ? startedAt + RIDE_OVERDUE_NO_ETA_MS
    : startedAt + ride.taxiDuration * 60_000 + RIDE_OVERDUE_AFTER_ETA_MS;
}

export async function watchOverdueRides(
  deps: { prisma: PrismaClient; redis: Redis; notifications: NotificationService; resolveRecipients?: () => Promise<string[]> },
  now: Date = new Date(),
): Promise<{ overdue: number; outcome: PageOutcome['status'] | 'quiet' }> {
  const rides = await deps.prisma.order.findMany({
    where: {
      orderType: 'TAXI',
      placedAt: { lt: new Date(now.getTime() - RIDE_OVERDUE_AFTER_ETA_MS) },
      // The same custody the close reads: a verified code with no Start is a person in a car.
      OR: [{ status: 'RIDE_IN_PROGRESS' }, { status: 'DRIVER_ARRIVED', OR: [{ ridePinVerified: true }, { ridePinVerifiedAt: { not: null } }] }],
    },
    select: { id: true, orderNumber: true, pickedUpAt: true, placedAt: true, taxiDuration: true },
    orderBy: { placedAt: 'asc' },
    take: BATCH,
  });
  const overdue = rides.filter((ride) => now.getTime() > overdueAt(ride));
  if (overdue.length === 0) {
    await resolveOpsPage(deps.prisma, RIDE_OVERDUE_TITLE, 'no-ride-overdue');
    // The page is closed, so its window goes with it: the next overdue ride pages at once.
    await deps.redis.del(RIDE_OVERDUE_KEY);
    return { overdue: 0, outcome: 'quiet' };
  }
  const page = await pageOps(deps, {
    key: RIDE_OVERDUE_KEY,
    windowSeconds: RIDE_OVERDUE_WINDOW_SECONDS,
    title: RIDE_OVERDUE_TITLE,
    body: `${overdue.length} ride(s) open far past the estimate, oldest ${overdue[0]!.orderNumber}. Call both sides. If the driver is gone, end it from the order.`,
    data: { kind: 'ops_ride_overdue', overdue: overdue.length, orderIds: overdue.slice(0, 10).map((ride) => ride.id) },
  });
  return { overdue: overdue.length, outcome: page.status };
}
