import type { Prisma } from '@prisma/client';

/**
 * Give back what a BILLING suspension took from a store, and nothing more
 * [REPORT-013 F-013-07; SUSPENSION-HEAL, AUD-L8b-003]. The one restore used by
 * a real payment (BillingService.reinstateRows) and by the nightly
 * wrongful-suspension heal (invariants.ts), inside the caller's transaction.
 *
 * - The lifecycle CAS matches a billing-caused suspension only: an admin,
 *   safety or moderation suspension survives. A pre-migration suspension has
 *   a null source; the only automated suspender has always been billing, so a
 *   null source lifts too (an admin can always re-suspend, which stamps ADMIN).
 * - Order intake reopens only where the document truth (isVerified) still
 *   stands: a store whose documents died meanwhile comes back ACTIVE but
 *   closed, never a blind acceptingOrders=true.
 *
 * Returns true when this call lifted a billing suspension.
 */
export async function restoreBillingAccess(tx: Prisma.TransactionClient, vendorId: string): Promise<boolean> {
  const lifted = await tx.vendor.updateMany({
    where: { id: vendorId, status: 'SUSPENDED', OR: [{ suspensionSource: 'BILLING' }, { suspensionSource: null }] },
    data: { status: 'ACTIVE', suspensionSource: null },
  });
  await tx.vendor.updateMany({
    where: { id: vendorId, status: 'ACTIVE', isVerified: true },
    data: { acceptingOrders: true },
  });
  return lifted.count === 1;
}
