import type { Prisma } from '@prisma/client';

/**
 * Give back what a BILLING suspension took from a store, and nothing more
 * [REPORT-013 F-013-07; SUSPENSION-HEAL, AUD-L8b-003]. The one restore used by
 * a real payment (BillingService.reinstateRows) and by the nightly
 * wrongful-suspension heal (invariants.ts), inside the caller's transaction.
 *
 * - The lifecycle CAS matches a suspension billing stamped (BILLING) only: an
 *   admin, safety, moderation or wind-down suspension survives, and so does
 *   one with no source [Fable #1481 S4-1].
 * - Order intake reopens only when THIS call lifted that suspension (billing
 *   closed it), and only where the document truth (isVerified) still stands.
 *   A store already ACTIVE keeps the intake its owner chose [Fable #1481 S4-2].
 *
 * Returns true when this call lifted a billing suspension.
 */
export async function restoreBillingAccess(tx: Prisma.TransactionClient, vendorId: string): Promise<boolean> {
  const lifted = await tx.vendor.updateMany({
    where: { id: vendorId, status: 'SUSPENDED', suspensionSource: 'BILLING' },
    data: { status: 'ACTIVE', suspensionSource: null },
  });
  if (lifted.count !== 1) return false;
  await tx.vendor.updateMany({
    where: { id: vendorId, status: 'ACTIVE', isVerified: true },
    data: { acceptingOrders: true },
  });
  return true;
}
