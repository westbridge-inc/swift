import type { Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// What a STORE may see of an order under the LIFECYCLE_V2 hold. A leaf with
// no imports of its own, so every store-facing reader — the board and its
// actions, the dashboard aggregates, the socket door — applies the same rule
// without pulling the order service in [Q12]. order.service re-exports it.
// ---------------------------------------------------------------------------

/** Prisma WHERE fragment: only orders a vendor/mover is allowed to see. */
export function notHeldFilter() {
  return { OR: [{ holdExpiresAt: null }, { holdExpiresAt: { lte: new Date() } }] };
}

/** [Q12] An order that died INSIDE its hold was never the store's: it was
 *  hidden while held and the release never ran. notHeldFilter alone reads a
 *  lapsed window as released, so once the dead window passed, a cancel made
 *  inside it surfaced on the store's board, its cancelled history, its detail
 *  route and its dashboard. One exception, MMG: the store was told at the
 *  cancel that the customer's money may be in its wallet, so it can open the
 *  order it may have to refund. */
export function cancelledWhileHeld(order: { holdExpiresAt: Date | null; cancelledAt: Date | null; paymentMethod: string | null }): boolean {
  return order.paymentMethod !== 'MOBILE_MONEY'
    && order.holdExpiresAt != null
    && order.cancelledAt != null
    && order.cancelledAt < order.holdExpiresAt;
}

/** Prisma WHERE fragment for every store-facing read: not held now, and not
 *  an order that died inside its hold (cancelledWhileHeld, as a column
 *  compare). */
export function vendorVisibleFilter(prisma: Pick<PrismaClient, 'order'>): Prisma.OrderWhereInput {
  return {
    AND: [
      notHeldFilter(),
      {
        OR: [
          { holdExpiresAt: null },
          { cancelledAt: null },
          { cancelledAt: { gte: prisma.order.fields.holdExpiresAt } },
          { paymentMethod: 'MOBILE_MONEY' },
        ],
      },
    ],
  };
}
