import type { PrismaClient } from '@prisma/client';
import { runAsSystem } from '../../../plugins/tenant-context';

/**
 * [STG-DRILLS D7 · AX324 R7] The crash drill's durable evidence, read-only.
 *
 * The runner (scripts/livetest/crash-drill.ts) watches the drill order over
 * HTTP, but live polls only see moments: a job that ran twice between two polls
 * leaves no trace there. What it leaves is ROWS. deploy/drill-crash.sh runs this
 * read inside the worker container after the order is walked to the door
 * (node dist/boot/drill-evidence.js crash --order <id>), behind the same drill
 * guard, and hands the runner a JSON document; the runner's finalize phase
 * judges it (durableOnceOnly). Every row about the one order counts, so the
 * evidence covers the whole crash window — before the kill, during the outage
 * and after the restart — not just the instant a poll happened to land:
 *
 *   offers       alert_deliveries MOVER_OFFER rows — one per published offer attempt;
 *   offerPushes  the dispatch_offer notifications — one per attempt pushed;
 *   searches     the dispatch journal (dispatch_searches) for the order;
 *   statusLog    every order_status_logs transition.
 *
 * Ids, statuses and timestamps only: no names, phones, titles or bodies leave
 * the database. Nothing here writes.
 */

const CAPABILITY = 'staging-drills';

export interface CrashEvidence {
  version: 1;
  orderId: string;
  readAt: string;
  order: { tenantId: string; status: string; riderId: string | null } | null;
  offers: Array<{ attemptId: string | null; recipientId: string; sentAt: string; acknowledgedAt: string | null }>;
  offerPushes: Array<{ attemptId: string | null; userId: string; createdAt: string }>;
  searches: Array<{ id: string; status: string; wave: number; startedAt: string; assignedAt: string | null; assignedTo: string | null; deliveryAuthorityVersion: number | null }>;
  statusLog: Array<{ status: string; createdAt: string }>;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** An order id as the API issues them (cuid): the only shape this read accepts. */
export const ORDER_ID = /^[a-z0-9]{20,40}$/;

export async function readCrashEvidence(db: PrismaClient, orderId: string): Promise<CrashEvidence> {
  return runAsSystem(CAPABILITY, async () => {
    const order = await db.order.findUnique({ where: { id: orderId }, select: { tenantId: true, status: true, riderId: true } });
    const offers = await db.alertDelivery.findMany({
      where: { kind: 'MOVER_OFFER', subjectId: orderId },
      select: { offerAttemptId: true, recipientId: true, sentAt: true, acknowledgedAt: true },
      orderBy: { sentAt: 'asc' },
    });
    const notices = await db.notification.findMany({
      where: { data: { path: ['orderId'], equals: orderId } },
      select: { userId: true, data: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const searches = await db.dispatchSearch.findMany({
      where: { subjectId: orderId },
      select: { id: true, status: true, wave: true, startedAt: true, assignedAt: true, assignedTo: true, deliveryAuthorityVersion: true },
      orderBy: { startedAt: 'asc' },
    });
    const statusLog = await db.orderStatusLog.findMany({ where: { orderId }, select: { status: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
    return {
      version: 1,
      orderId,
      readAt: new Date().toISOString(),
      order: order ? { tenantId: order.tenantId, status: order.status, riderId: order.riderId } : null,
      offers: offers.map((o) => ({ attemptId: o.offerAttemptId, recipientId: o.recipientId, sentAt: o.sentAt.toISOString(), acknowledgedAt: iso(o.acknowledgedAt) })),
      offerPushes: notices
        .filter((n) => (n.data as Record<string, unknown> | null)?.['kind'] === 'dispatch_offer')
        .map((n) => {
          const attempt = (n.data as Record<string, unknown>)['offerAttemptId'];
          return { attemptId: typeof attempt === 'string' ? attempt : null, userId: n.userId, createdAt: n.createdAt.toISOString() };
        }),
      searches: searches.map((s) => ({ id: s.id, status: s.status, wave: s.wave, startedAt: s.startedAt.toISOString(), assignedAt: iso(s.assignedAt), assignedTo: s.assignedTo, deliveryAuthorityVersion: s.deliveryAuthorityVersion })),
      statusLog: statusLog.map((l) => ({ status: l.status, createdAt: l.createdAt.toISOString() })),
    };
  });
}
