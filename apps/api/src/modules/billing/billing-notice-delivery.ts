import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { NotificationAudience } from '../notification/notification.service';
import { NotificationService, notifyAdmins, tenantOfSubscription } from '../notification/notification.service';
import { enqueueFeeDemandInTx } from './fee-demand-delivery';
import { log } from '../../utils/logger';

/** BillingEvent is the committed delivery intent. Only notes bearing this
 * version enter the retry worker; older best-effort events cannot be safely
 * re-paged because they have no per-recipient dedupe key. No phone number,
 * provider token, provider response or document appears in this payload. */
export type BillingNotice = {
  noticeVersion: 1;
  target: 'payer' | 'admins';
  title: string;
  body: string;
  data: { kind: 'billing_suspended_nudge' | 'billing_churned' | 'reconcile_mismatch'; subscriptionId: string; paymentId?: string };
  evidenceKey?: string;
  userId?: string;
  audience?: NotificationAudience;
  sms?: string;
};

export function billingNoticeNote(notice: BillingNotice): string {
  return JSON.stringify(notice);
}

function parseBillingNotice(note: string | null, subscriptionId: string): BillingNotice | null {
  if (!note) return null;
  try {
    const value: unknown = JSON.parse(note);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const n = value as Partial<BillingNotice>;
    if (n.noticeVersion !== 1 || !['payer', 'admins'].includes(n.target ?? '')
      || typeof n.title !== 'string' || typeof n.body !== 'string'
      || !n.data || n.data.subscriptionId !== subscriptionId
      || !['billing_suspended_nudge', 'billing_churned', 'reconcile_mismatch'].includes(n.data.kind)) return null;
    if (n.target === 'payer' && (typeof n.userId !== 'string' || !n.userId)) return null;
    if (n.target === 'admins' && n.data.kind !== 'reconcile_mismatch') return null;
    if (n.target === 'payer' && n.data.kind === 'reconcile_mismatch') return null;
    return n as BillingNotice;
  } catch {
    return null;
  }
}

type NoticeRow = { id: string; subscriptionId: string; note: string | null; createdAt: Date; deliveredAt: Date | null };
/** The claim expired or another worker took it over: hand nothing off. */
class NoticeClaimLost extends Error {}

/** The committed event is historical authority, not a fresh balance/access
 * decision. Render both channels as history even on first delivery: payment,
 * cancellation or a hold can commit between any read and an external send.
 * Keep the original note untouched as the audit record of the decision. */
function historicalPayerNotice(notice: BillingNotice, event: NoticeRow): BillingNotice {
  if (notice.target !== 'payer') return notice;
  const state = notice.data.kind === 'billing_churned' ? 'closed' : 'suspended';
  const body = `Billing history recorded ${event.createdAt.toISOString()}. At the time, your subscription was ${state} because a weekly fee was unpaid. Check the app for your current subscription status.`;
  return { ...notice, title: 'Subscription billing history', body, sms: notice.sms ? `Swift: ${body}` : undefined };
}

/** Claim one committed intent before any external send. Lease checks fence
 * stale preparation work; process death leaves the row retryable on expiry,
 * and an attempt that does not complete leaves it due after a short cooldown,
 * so a persistently failing oldest row never starves the bounded drain.
 *
 * [#1393] A payer notice (suspended nudge, churn) is a weekly-fee demand. Its
 * intent completes in the same transaction that records it as a stage of the
 * fee-demand outbox (`event:<id>`), and only while this worker's claim is
 * still unexpired and its own; from then on the outbox alone delivers it,
 * through the shared confirmation fence: nothing while a payment is being
 * confirmed, nothing after its obligation was paid, cancelled or closed, and
 * an SMS whose handoff outcome is unknown is never blindly resent. The intent
 * is never retried after that handoff, so a superseded stage cannot keep a
 * drain slot. An admin page still completes only when every admin has it.
 * Neither path is an exactly-once provider-delivery promise. */
export async function deliverBillingNotice(
  prisma: PrismaClient,
  notifications: NotificationService,
  event: NoticeRow,
  _now = new Date(),
): Promise<boolean> {
  if (event.deliveredAt) return false;
  const parsed = parseBillingNotice(event.note, event.subscriptionId);
  if (!parsed) return false;
  const notice = historicalPayerNotice(parsed, event);
  const token = randomUUID();
  // Acquisition/renewal use the database wall clock, never a scheduler's old
  // batch time or a worker's potentially skewed host clock.
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "billing_events"
    SET "noticeLeaseToken" = ${token}, "noticeLeaseUntil" = clock_timestamp() + INTERVAL '120 seconds'
    WHERE "id" = ${event.id} AND "deliveredAt" IS NULL
      AND ("noticeLeaseUntil" IS NULL OR "noticeLeaseUntil" <= clock_timestamp())
    RETURNING "id"
  `;
  if (claimed.length !== 1) return false;

  const renew = async () => (await prisma.$executeRaw`
    UPDATE "billing_events"
    SET "noticeLeaseUntil" = clock_timestamp() + INTERVAL '120 seconds'
    WHERE "id" = ${event.id} AND "noticeLeaseToken" = ${token} AND "deliveredAt" IS NULL
      AND "noticeLeaseUntil" > clock_timestamp()
  `) === 1;

  try {
    if (notice.target === 'payer') {
      // The outbox re-checks the payer, the obligation and the pause itself;
      // a refused handoff (payer changed, payer lookup outage) rolls back and
      // leaves this intent due.
      const stage = await prisma.$transaction(async (tx) => {
        const demand = await enqueueFeeDemandInTx(tx, {
          userId: notice.userId!, type: 'SYSTEM_ANNOUNCEMENT', title: notice.title, body: notice.body,
          audience: notice.audience, data: notice.data, feeStageKey: `event:${event.id}`, feeSms: notice.sms,
        });
        const handedOff = await tx.$executeRaw`
          UPDATE "billing_events"
          SET "deliveredAt" = clock_timestamp(), "noticeLeaseToken" = NULL, "noticeLeaseUntil" = NULL
          WHERE "id" = ${event.id} AND "noticeLeaseToken" = ${token} AND "deliveredAt" IS NULL
            AND "noticeLeaseUntil" > clock_timestamp()
        `;
        // An expired or taken-over claim records nothing: a stage exists only
        // for an intent this claim handed off.
        if (handedOff !== 1) throw new NoticeClaimLost();
        return demand.id;
      }).catch((err: unknown) => {
        if (err instanceof NoticeClaimLost) return null;
        throw err;
      });
      if (!stage) return false;
      try {
        return !!await notifications.deliverFeeDemand(stage);
      } catch (err) {
        // The outbox holds the stage and every channel outcome (an UNKNOWN
        // handoff included); this intent's own duty is complete.
        log().warn({ err, eventId: event.id }, 'billing notice handed to the fee-demand outbox; its delivery outcome is held there');
        return false;
      }
    }

    const tenantId = await tenantOfSubscription(prisma, event.subscriptionId, true);
    if (!await renew()) return false;
    await notifyAdmins(prisma, notifications, {
      tenantId, title: notice.title, body: notice.body, data: notice.data,
      dedupeKey: `billing-notice:${event.id}`, requireAll: true,
    });
    const completed = await prisma.$executeRaw`
      UPDATE "billing_events"
      SET "deliveredAt" = clock_timestamp(), "noticeLeaseToken" = NULL, "noticeLeaseUntil" = NULL
      WHERE "id" = ${event.id} AND "noticeLeaseToken" = ${token} AND "deliveredAt" IS NULL
    `;
    return completed === 1;
  } finally {
    // Incomplete rows remain due, but a short cooldown lets newer rows pass
    // a persistently failing oldest row on the next bounded drain. A crashed
    // worker instead keeps its full claim lease until expiry.
    await prisma.$executeRaw`
      UPDATE "billing_events"
      SET "noticeLeaseToken" = NULL, "noticeLeaseUntil" = clock_timestamp() + INTERVAL '60 seconds'
      WHERE "id" = ${event.id} AND "noticeLeaseToken" = ${token} AND "deliveredAt" IS NULL
    `;
  }
}

export async function deliverBillingNoticeByKey(
  prisma: PrismaClient,
  notifications: NotificationService,
  idempotencyKey: string,
  now = new Date(),
): Promise<boolean> {
  const event = await prisma.billingEvent.findUnique({
    where: { idempotencyKey }, select: { id: true, subscriptionId: true, note: true, createdAt: true, deliveredAt: true },
  });
  return event ? deliverBillingNotice(prisma, notifications, event, now) : false;
}

/** Retry comes from BillingEvent, not the original SUSPENDED selector. Thus a
 * CHURNED row and a duplicate same-day event cannot erase an owed notice. */
export async function drainPendingBillingNotices(
  prisma: PrismaClient,
  notifications: NotificationService,
  now = new Date(),
): Promise<{ attempted: number; delivered: number }> {
  const rows = await prisma.$queryRaw<NoticeRow[]>`
    SELECT "id", "subscriptionId", "note", "createdAt", "deliveredAt"
    FROM "billing_events"
    WHERE "deliveredAt" IS NULL
      AND ("noticeLeaseUntil" IS NULL OR "noticeLeaseUntil" <= ${now})
      AND "note" LIKE '{"noticeVersion":1,%'
      AND ("idempotencyKey" LIKE 'nudge:%' OR "idempotencyKey" LIKE 'churned:%'
        OR "idempotencyKey" LIKE 'mismatch:%')
    ORDER BY COALESCE("noticeLeaseUntil", "createdAt") ASC, "id" ASC
    LIMIT 200
  `;
  let delivered = 0;
  for (const row of rows) {
    try {
      if (await deliverBillingNotice(prisma, notifications, row, now)) delivered += 1;
    } catch (err) {
      log().warn({ err, eventId: row.id }, 'billing notice delivery retry failed');
    }
  }
  return { attempted: rows.length, delivered };
}
