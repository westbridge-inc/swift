import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// [POS-SYNC · REVIEW-M S3-2] The one lock that says "this store is applying a
// till file". A sync holds it EXCLUSIVELY for its whole apply; a checkout
// SHARES it without waiting. So a checkout is told "this store is updating its
// menu" only when a sync really holds it (or is about to), and checkouts at one
// store never refuse each other: they share it, and their wait for the store's
// row is unbounded, as it always was.
//
// Lock order everywhere: this key, then the store's row, then items by id.
// ---------------------------------------------------------------------------

const keyOf = (vendorId: string) => `pos-sync:${vendorId}`;

/** The till sync: held to commit. Waits for the checkouts already sharing it. */
export async function holdTillSyncLock(tx: Prisma.TransactionClient, vendorId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${keyOf(vendorId)}, 0))`;
}

/** A checkout: share the key for the rest of its transaction, never waiting.
 *  False = a till sync holds it, or is queued for it. */
export async function shareTillSyncLock(tx: Prisma.TransactionClient, vendorId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${keyOf(vendorId)}, 0)) AS ok`;
  return rows[0]?.ok === true;
}
