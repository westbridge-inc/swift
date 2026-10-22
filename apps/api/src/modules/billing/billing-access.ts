import type { Prisma } from '@prisma/client';

/**
 * [#1541 activation half] Serialize a vendor activation with fee settlement
 * before it reads any fee or writes any store: the payer's account row first,
 * then every subscription of the payer's stores in id order, the order
 * settlement takes (dunning-clock lockBillingAuthority: payer, then
 * subscription). A payment that commits first is seen; one that comes second
 * waits and then lifts the hold through restoreBillingAccess. The owner is
 * locked even with no subscription yet: the activation may create the first.
 * NO KEY UPDATE, the mode the console's activation and reinstate already take
 * on the same row; it still waits for settlement's FOR UPDATE. On the daily
 * belt's own projection transaction the person's row is already held FOR SHARE
 * (the deletion barrier, account-closure.ts accountErasedUnderLock), so the
 * activation waits there first and strengthens that lock here. Every
 * transaction that takes the barrier (the projection, subscription
 * withActivation) takes the identity-authority lock before it, so two such
 * upgrades of the same row never meet.
 */
export async function lockVendorActivationBilling(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR NO KEY UPDATE /* vendor-activation-fee-payer */`;
  await tx.$queryRaw`
    SELECT s."id" FROM "subscriptions" s
    JOIN "vendors" v ON v."id" = s."vendorId"
    JOIN "vendor_owners" o ON o."id" = v."ownerId"
    WHERE o."userId" = ${userId}
    ORDER BY s."id" FOR UPDATE OF s /* vendor-activation-fee-subscriptions */`;
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
 * [#1541 activation half · #1516 review S4] A store awaiting approval whose
 * weekly fee billing holds (SUSPENDED, or its later CHURNED stage: neither
 * operates, operate-gate.ts) goes live UNDER that hold when its documents
 * complete: SUSPENDED with source BILLING and intake closed, exactly the state
 * billing gives a live store whose fee went unpaid (billing.service
 * suspendAccessRows). Without it the activation opened the store, ACTIVE and
 * taking orders, while its fee was unpaid, and the owner's payment found no
 * billing hold to lift. A confirmed payment lifts this hold through
 * restoreBillingAccess like any other.
 *
 * Billing never holds a store awaiting approval itself (suspendAccessRows
 * touches open stores only), so the activation edge is the one place a
 * pending store takes billing's hold. The CAS decides against the live
 * subscription row at write time, inside the activation transaction, after the
 * caller took lockVendorActivationBilling. Returns true when it held the store.
 */
export async function holdActivationForUnpaidFee(tx: Prisma.TransactionClient, vendorId: string): Promise<boolean> {
  const held = await tx.vendor.updateMany({
    where: { id: vendorId, status: 'PENDING_APPROVAL', subscription: { is: { status: { in: ['SUSPENDED', 'CHURNED'] } } } },
    data: { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING' },
  });
  return held.count === 1;
}
