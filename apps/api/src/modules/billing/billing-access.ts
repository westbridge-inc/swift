import type { Prisma } from '@prisma/client';

/** Serialize document projection with settlement before any store write.
 * The payer comes first, then its vendor subscriptions in stable order, just
 * like billing. Lock even an owner without a subscription: activation may
 * create that first subscription in this transaction. */
export async function lockVendorActivationBilling(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
  await tx.$queryRaw`
    SELECT s.id FROM subscriptions s
    JOIN vendors v ON v.id = s."vendorId"
    JOIN vendor_owners o ON o.id = v."ownerId"
    WHERE o."userId" = ${userId}
    ORDER BY s.id FOR UPDATE OF s
  `;
}

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

/**
 * A store awaiting approval whose weekly fee billing holds (SUSPENDED, or its
 * later CHURNED stage) goes live under that hold when its documents complete
 * [#1516 review S4]: SUSPENDED with source BILLING and intake closed, the state
 * billing gives a live store whose fee went unpaid. Without it the activation
 * opened the store (ACTIVE and taking orders) while browse hid it and checkout
 * refused it, and the owner's payment found no billing hold to lift. A payment
 * lifts this one through restoreBillingAccess like any other.
 *
 * Billing never holds a store awaiting approval itself (billing.service
 * suspendAccessRows touches open stores only), so this is the one place a
 * pending store takes billing's hold: on its activation edge, after the caller
 * locks its payer and subscription before any vendor write, decided at write
 * time against the live subscription row, inside the activation transaction.
 * Returns true when the store was held.
 */
export async function holdActivationForUnpaidFee(tx: Prisma.TransactionClient, vendorId: string): Promise<boolean> {
  const held = await tx.vendor.updateMany({
    where: { id: vendorId, status: 'PENDING_APPROVAL', subscription: { is: { status: { in: ['SUSPENDED', 'CHURNED'] } } } },
    data: { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING' },
  });
  return held.count === 1;
}
