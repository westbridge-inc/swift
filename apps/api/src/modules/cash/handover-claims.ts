/**
 * [DOC-1 §31.6 · DOC-INV-49 · P31-3] Both sides of every handover, always.
 *
 * When Swift holds no money, every money event is somebody's assertion. The fee the
 * store hands the rider at pickup is one such event, and `delivery_cash_settlement` is
 * its two-sided claim row: the rider says "I received it", the store says "we paid it",
 * each with the amount they attest. A one-sided record is how "the store said they
 * paid me and they didn't" becomes unresolvable — so the nightly reconciliation walks
 * every settlement older than the claim window and reports the UNMATCHED PAIRS: one
 * side only, or neither. An unmatched pair is a conversation, not a fault: it is
 * listed for the operator, counted, written to the audit trail once per run, and the
 * admins are told once a day — never auto-settled, never auto-failed.
 */
import type { PrismaClient } from '@prisma/client';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';

export const HANDOVER_CLAIM_WINDOW_HOURS = Number(process.env['HANDOVER_CLAIM_WINDOW_HOURS'] ?? 24);

export type UnmatchedReason = 'RIDER_ONLY' | 'STORE_ONLY' | 'NEITHER';
export interface UnmatchedPair { settlementId: string; orderId: string; riderId: string; vendorId: string; amount: string; ageHours: number; reason: UnmatchedReason }
export interface HandoverReconciliation { checked: number; matched: number; unmatched: UnmatchedPair[]; window: number; runAt: string }

export async function reconcileHandoverClaims(
  prisma: PrismaClient,
  opts: { now?: Date; windowHours?: number; notifications?: NotificationService } = {},
): Promise<HandoverReconciliation> {
  const now = opts.now ?? new Date();
  const windowHours = opts.windowHours ?? HANDOVER_CLAIM_WINDOW_HOURS;
  const cutoff = new Date(now.getTime() - windowHours * 3_600_000);
  const rows = await prisma.deliveryCashSettlement.findMany({
    where: { createdAt: { lte: cutoff } },
    select: { id: true, orderId: true, riderId: true, vendorId: true, amount: true, status: true, createdAt: true, riderConfirmedAt: true, storeConfirmedAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const unmatched: UnmatchedPair[] = [];
  for (const r of rows) {
    if (r.status === 'SETTLED') continue;
    const reason: UnmatchedReason = r.riderConfirmedAt && !r.storeConfirmedAt ? 'RIDER_ONLY' : r.storeConfirmedAt && !r.riderConfirmedAt ? 'STORE_ONLY' : 'NEITHER';
    unmatched.push({ settlementId: r.id, orderId: r.orderId, riderId: r.riderId, vendorId: r.vendorId, amount: String(r.amount), ageHours: Math.floor((now.getTime() - r.createdAt.getTime()) / 3_600_000), reason });
  }
  const report: HandoverReconciliation = { checked: rows.length, matched: rows.length - unmatched.length, unmatched, window: windowHours, runAt: now.toISOString() };
  // The run itself is an audited assertion: who found what, when.
  await prisma.auditLog.create({ data: {
    action: 'HANDOVER_CLAIMS_RECONCILED', entity: 'DeliveryCashSettlement', entityId: `nightly:${now.toISOString().slice(0, 10)}`,
    changes: { checked: report.checked, matched: report.matched, unmatched: unmatched.length, byReason: countBy(unmatched.map((u) => u.reason)), windowHours },
  } });
  if (unmatched.length > 0 && opts.notifications) {
    const today = now.toISOString().slice(0, 10);
    const already = await prisma.notification.findFirst({ where: { data: { path: ['kind'], equals: 'handover_claims_unmatched' }, createdAt: { gte: new Date(`${today}T00:00:00Z`) } }, select: { id: true } });
    if (!already) {
      await notifyAdmins(prisma, opts.notifications, {
        tenantId: null,
        title: `${unmatched.length} handover claim${unmatched.length === 1 ? '' : 's'} unmatched`,
        body: `Delivery-fee handovers older than ${windowHours} h with one side missing: ${describe(countBy(unmatched.map((u) => u.reason)))}. Each is a conversation between a store and a rider, not a fault — open the settlements ledger.`,
        data: { kind: 'handover_claims_unmatched', unmatched: unmatched.length, date: today },
      });
    }
  }
  return report;
}

function countBy(xs: string[]): Record<string, number> { return xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {}); }
function describe(c: Record<string, number>): string { return Object.entries(c).map(([k, v]) => `${v} ${k.toLowerCase().replace('_', ' ')}`).join(', ') || 'none'; }
