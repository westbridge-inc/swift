import type { Prisma } from '@prisma/client';

/** The subject of a closure request confirmed in the app. Support completes
 *  only these: a typed-in ticket is not a confirmed request. */
export const ACCOUNT_CLOSURE_SUBJECT = 'Account closure request';
/** The server-written text of that request (no personal data): the erasure keeps it. */
export const ACCOUNT_CLOSURE_MESSAGE = 'Please close my Swift account and de-identify my personal data after resolving outstanding business obligations. This request was confirmed in the app.';

/** [#1879 S3-3 · REVIEW-G R1] The deletion write barrier for activation writes: the person's users row, locked
 *  FOR UPDATE (the lock the erasure's cut-off commits under), reads as erased (the deleted:<id> marker or the
 *  erasure's DEACTIVATED status). Only the erasure writes either; SUSPENDED and BANNED are reversible. */
export async function accountErasedUnderLock(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ status: string; phone: string }>>`
    SELECT "status"::text AS "status", "phone" FROM "users" WHERE "id" = ${userId} FOR UPDATE /* activation-deletion-barrier */
  `;
  const person = rows[0];
  return !person || person.phone === `deleted:${userId}` || person.status === 'DEACTIVATED';
}
