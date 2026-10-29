import type { PrismaClient } from '@prisma/client';
import { algoValue } from '../algo/algo-config';
import { waitingForRiderWhere, waitingSinceWhere, waitingGraceMinutes } from './delivery-capacity';

// ---------------------------------------------------------------------------
// [RIDER-SAFE 6 · COORD ruling 29 Oct 2026] ONE "RIDERS ARE SHORT" PAGE.
//
// A rider shortage used to reach operations as one page per stranded order —
// after each had already run out of riders. This scan (on the supply-watch
// cadence, every 2 minutes) measures the shortage itself, per tenant: orders
// waiting for a rider past the grace, and rider searches that ran out in the
// last 10 minutes. Crossing either threshold pages operations ONCE per window
// (opsPageOnce), with the numbers and what to do: call riders in, pause
// delivery in the console, or let stores switch orders to pickup.
// ---------------------------------------------------------------------------

export const RIDERS_SHORT_WINDOW_MINUTES = 10;
/** One page per tenant per this long, however long the shortage lasts. */
export const RIDERS_SHORT_PAGE_TTL_SECONDS = 30 * 60;

const clamp = (v: unknown, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(500, Math.max(1, Math.trunc(n))) : dflt;
};

export interface RidersShortReading {
  tenantId: string;
  waiting: number;
  exhaustedRecently: number;
  freeRiders: number;
  short: boolean;
}

/** Measure, per tenant with any waiting or exhausted order. Read-only. */
export async function measureRidersShort(prisma: PrismaClient, now = new Date()): Promise<RidersShortReading[]> {
  const since = new Date(now.getTime() - RIDERS_SHORT_WINDOW_MINUTES * 60_000);
  const exhausted = await prisma.dispatchSearch.findMany({
    where: { status: 'EXHAUSTED', vertical: { in: ['DELIVERY', 'COURIER'] }, exhaustedAt: { gte: since } },
    select: { subjectId: true },
    take: 2000,
  });
  const exhaustedOrders = exhausted.length === 0 ? [] : await prisma.order.findMany({
    where: { id: { in: [...new Set(exhausted.map((e) => e.subjectId))] } },
    select: { tenantId: true },
  });
  const tenants = new Set<string>(exhaustedOrders.map((o) => o.tenantId));
  const anyWaiting = await prisma.order.groupBy({
    by: ['tenantId'],
    where: waitingForRiderWhere(now),
    _count: { _all: true },
  });
  for (const row of anyWaiting) tenants.add(row.tenantId);

  const readings: RidersShortReading[] = [];
  for (const tenantId of tenants) {
    const grace = await waitingGraceMinutes(prisma, tenantId);
    const base = waitingForRiderWhere(now);
    const [waiting, freeRiders, waitingCap, exhaustCap] = await Promise.all([
      prisma.order.count({
        where: { ...base, tenantId, AND: [...(base.AND as object[]), waitingSinceWhere(new Date(now.getTime() - grace * 60_000))] },
      }),
      prisma.rider.count({ where: { isOnline: true, isAvailable: true, currentOrderId: null, user: { tenantId } } }),
      algoValue(prisma, 'delivery.ridersShortWaiting', tenantId),
      algoValue(prisma, 'delivery.ridersShortExhaustions', tenantId),
    ]);
    const exhaustedRecently = exhaustedOrders.filter((o) => o.tenantId === tenantId).length;
    readings.push({
      tenantId, waiting, exhaustedRecently, freeRiders,
      short: waiting >= clamp(waitingCap, 5) || exhaustedRecently >= clamp(exhaustCap, 3),
    });
  }
  return readings;
}

export interface RidersShortDeps {
  prisma: PrismaClient;
  /** opsPageOnce, bound to the job's redis. */
  pageOnce: (key: string, ttlSeconds: number, page: () => Promise<unknown>) => Promise<boolean>;
  /** notifyAdmins, bound to a NotificationService. */
  notifyAdmins: (input: { title: string; body: string; data: Record<string, unknown>; tenantId: string | null }) => Promise<unknown>;
}

/** Page operations once per tenant per window when riders are short. Returns the tenants paged now. */
export async function pageRidersShort(deps: RidersShortDeps, now = new Date()): Promise<string[]> {
  const paged: string[] = [];
  for (const r of await measureRidersShort(deps.prisma, now)) {
    if (!r.short) continue;
    const sent = await deps.pageOnce(`riders_short:${r.tenantId}`, RIDERS_SHORT_PAGE_TTL_SECONDS, () => deps.notifyAdmins({
      tenantId: r.tenantId,
      title: 'Riders are short',
      body: `${r.waiting} delivery order(s) are waiting for a rider and ${r.exhaustedRecently} search(es) ran out of riders in the last ${RIDERS_SHORT_WINDOW_MINUTES} min; ${r.freeRiders} rider(s) are free. Call riders in, or pause delivery in the console (pickup stays open).`,
      data: { kind: 'ops_riders_short', waiting: r.waiting, exhausted: r.exhaustedRecently, freeRiders: r.freeRiders },
    }));
    if (sent) paged.push(r.tenantId);
  }
  return paged;
}
