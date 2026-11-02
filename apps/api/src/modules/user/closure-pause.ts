import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// [WEB-DELETE · owner ruling 1 Nov 2026] A store owner's account closure request stops the stores' NEW orders AT
// ONCE: the request (website or app: both go through AccountService.closureTicket) pauses every store the person
// owns, in the request's own transaction. Orders already placed still finish; Swift's team then completes the
// closure (the support queue's "complete account closure", which winds the stores down for good).
//
// The pause is vendors."closurePausedAt" with acceptingOrders = false, and a database CHECK keeps intake off while it
// is set, so no writer reopens the store: not the owner's or a manager's "Resume orders", not a billing
// reinstatement, not an activation. Only two things lift it, each audited: Swift staff resolving the request in the
// support queue, or the owner cancelling the request. Lifting does not turn orders back on by itself; the owner
// resumes them with the usual switch, which still checks the store is live, verified and paid up.
// ---------------------------------------------------------------------------

/** The audit actions (entity SupportTicket, the closure request). */
export const CLOSURE_ORDERS_PAUSED = 'ACCOUNT_CLOSURE_ORDERS_PAUSED';
export const CLOSURE_ORDERS_PAUSE_LIFTED = 'ACCOUNT_CLOSURE_ORDERS_PAUSE_LIFTED';
export const ACCOUNT_CLOSURE_CANCELLED = 'ACCOUNT_CLOSURE_CANCELLED';

/** What a store's "Resume orders" answers while the request holds the pause. */
export const CLOSURE_PAUSE_REFUSAL = 'New orders are paused because you asked Swift to close your account. Cancel the closure request (Account, Request account closure) to take new orders again.';

/** What the owner's cancel answers once support has the request, or the account is already closed. */
export const CLOSURE_IN_PROGRESS_REFUSAL = 'Swift is already closing your account, so this request can no longer be cancelled here. Contact Swift support.';

type PauseDb = Pick<Prisma.TransactionClient, 'vendor' | 'auditLog'>;

/** Pause the NEW orders of every store this person owns, for this closure request. Idempotent: a store already
 *  paused keeps its first pause time. Returns the stores this call paused. */
export async function pauseStoresForClosure(tx: PauseDb, userId: string, ticketId: string): Promise<string[]> {
  const stores = await tx.vendor.findMany({ where: { owner: { userId }, closurePausedAt: null }, select: { id: true, acceptingOrders: true } });
  if (stores.length === 0) return [];
  const ids = stores.map((s) => s.id);
  await tx.vendor.updateMany({ where: { id: { in: ids }, closurePausedAt: null }, data: { acceptingOrders: false, closurePausedAt: new Date() } });
  await tx.auditLog.create({ data: {
    userId, action: CLOSURE_ORDERS_PAUSED, entity: 'SupportTicket', entityId: ticketId,
    changes: { stores: ids, wereTakingOrders: stores.filter((s) => s.acceptingOrders).map((s) => s.id) },
  } });
  return ids;
}

/** Lift the request's pause from this person's stores (the request was cancelled, or Swift staff resolved it).
 *  Order intake stays off until the owner resumes it. Returns the stores lifted. */
export async function liftClosurePause(
  tx: PauseDb, subjectUserId: string, ticketId: string, by: { kind: 'OWNER_CANCELLED' | 'STAFF_RESOLVED'; actorId: string },
): Promise<string[]> {
  const stores = await tx.vendor.findMany({ where: { owner: { userId: subjectUserId }, closurePausedAt: { not: null } }, select: { id: true } });
  if (stores.length === 0) return [];
  const ids = stores.map((s) => s.id);
  await tx.vendor.updateMany({ where: { id: { in: ids } }, data: { closurePausedAt: null } });
  await tx.auditLog.create({ data: {
    userId: by.actorId, action: CLOSURE_ORDERS_PAUSE_LIFTED, entity: 'SupportTicket', entityId: ticketId,
    changes: { stores: ids, by: by.kind, accountId: subjectUserId },
  } });
  return ids;
}
