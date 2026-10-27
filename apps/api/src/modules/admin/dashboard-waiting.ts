import { capabilityMode, decideCapability, type AdminCapabilityMode } from './admin-authority';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S2-1] TODAY LISTS EVERY QUEUE THAT WAITS FOR A PERSON.
//
// The owner's sheet: "Today — everything waiting for you, in one place". The
// Needs-you panel counted three things (unassigned orders, past-due fees,
// pending stores) and said "All clear — no active alerts" while an ops page
// waited for acknowledgement, documents waited for review, a second signature
// was owed and a SAFETY ticket was open.
//
// Each queue here is counted by the server, by the same read its own page
// uses, and ONLY when the caller's live grant would let them open that page's
// read: a count is never a way round a refusal. A queue the grant does not
// open is named as not counted (never shown as zero), and a count that could
// not be read is null (never zero).
// ---------------------------------------------------------------------------

/** In the order Today lists them: SOS / ops pages and safety first. `reads` are the queue page's own
 *  admin reads (route-authority keys); every one must be open to the caller for the queue to be counted. */
export const WAITING_QUEUES = [
  // Ops alerts are the safety module's read, decided by the admin role the account holds (S-19 · M009).
  { key: 'opsAlerts', reads: [] },
  { key: 'supportSafety', reads: ['GET /support'] },
  { key: 'documents', reads: ['GET /verification/queue/counts'] },
  { key: 'approvals', reads: ['GET /approvals'] },
  { key: 'paymentConfirmations', reads: ['GET /billing/confirmations'] },
  { key: 'support', reads: ['GET /support'] },
  { key: 'catalogue', reads: ['GET /catalogue-review'] },
  { key: 'storeVat', reads: ['GET /store-vat/pending'] },
  { key: 'custody', reads: ['GET /custody-cases'] },
  { key: 'claimsToDecide', reads: ['GET /cash-rules/claims'] },
  { key: 'claimsToPay', reads: ['GET /cash-rules/claims'] },
  { key: 'returnsToDecide', reads: ['GET /returns'] },
  { key: 'refundsOwed', reads: ['GET /returns'] },
  { key: 'moderation', reads: ['GET /moderation/reports', 'GET /ratings/moderation'] },
] as const satisfies readonly { key: string; reads: readonly string[] }[];

export type WaitingKey = (typeof WAITING_QUEUES)[number]['key'];

export interface WaitingCounts {
  /** Every counted queue, in Today's order. `count: null` = it could not be read just now (not zero). */
  queues: { key: WaitingKey; count: number | null }[];
  /** Queues this account's grant does not open: not counted, and never shown as zero. */
  notCounted: WaitingKey[];
}

type Actor = { role?: string | null; permissions?: readonly string[] | null };

/** Would the admin capability hook serve this read to this actor? The hook's own rule: allowed, or (shadow
 *  mode only) a plain capability miss; a missing explicit grant or an unregistered route never. */
export function servesRead(actor: Actor, route: string, mode: AdminCapabilityMode = capabilityMode()): boolean {
  const space = route.indexOf(' ');
  const decision = decideCapability(actor, route.slice(0, space), route.slice(space + 1));
  return decision.allowed || (mode === 'shadow' && decision.reason === 'missing-capability');
}

/** Count the queues the actor may open, each on its own: one failed count is null, never zero, and never
 *  hides the others. */
export async function countWaiting(
  actor: Actor,
  counters: Readonly<Record<WaitingKey, () => Promise<number>>>,
  onError: (key: WaitingKey, error: unknown) => void,
  mode: AdminCapabilityMode = capabilityMode(),
): Promise<WaitingCounts> {
  const open = WAITING_QUEUES.filter((q) => q.reads.every((route) => servesRead(actor, route, mode)));
  const settled = await Promise.allSettled(open.map((q) => counters[q.key]()));
  return {
    queues: open.map((q, i) => {
      const r = settled[i]!;
      if (r.status === 'fulfilled' && Number.isSafeInteger(r.value) && r.value >= 0) return { key: q.key, count: r.value };
      onError(q.key, r.status === 'rejected' ? r.reason : new Error(`not a count: ${String(r.value)}`));
      return { key: q.key, count: null };
    }),
    notCounted: WAITING_QUEUES.filter((q) => !open.includes(q)).map((q) => q.key),
  };
}
