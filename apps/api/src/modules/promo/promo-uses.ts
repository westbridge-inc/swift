import type { Prisma } from '@prisma/client';

/**
 * [Row 29 · DS109 S3] THE orders that use up one person's share of a promo
 * code (its `maxUsesPerUser`). `memberIds` is the person's identity cluster
 * (trial-integrity A5: the cap counts the human, not the account).
 *
 * - Every order placed with the code counts, whatever its status,
 * - except one cancelled by someone OTHER than the person (the store, Swift,
 *   the system: no rider, food too old, payment window): they did not choose
 *   to give it up, so the code is still theirs;
 * - and except a REFUNDED order (a refund is the store's or Swift's decision).
 *
 * Before this, every CANCELLED order was excluded, so cancelling and
 * re-ordering reset the cap as often as the customer liked.
 * Used by every per-person check (preview, cart, checkout lock); never
 * re-express it.
 */
export function promoUsesByPersonWhere(memberIds: string[], promoCodeId: string): Prisma.OrderWhereInput {
  return {
    customerId: { in: memberIds },
    promoCodeId,
    status: { not: 'REFUNDED' },
    OR: [
      { status: { not: 'CANCELLED' } },
      { cancelledBy: { in: memberIds } },
    ],
  };
}
