import type { Prisma } from '@prisma/client';

/**
 * [Apple 5.1.1(v)] A mover or vendor can close their own account.
 *
 * They could not. `deleteAccount` refused every non-CUSTOMER role outright:
 *
 *   PARTNER_ACCOUNT — "Mover and vendor accounts are closed through Support,
 *   so payouts and listings are handled correctly."
 *
 * The app has a Delete account button, so a driver pressing it was told to
 * write an email. App Review guideline 5.1.1(v) requires that an app which
 * lets you CREATE an account lets you delete it IN the app, and states plainly
 * that pointing at support does not satisfy it. Swift creates mover and vendor
 * accounts, so this is not a nicety — it is a rejection, and the file already
 * said so in a comment while nothing acted on it.
 *
 * The refusal was not wrong about the risk, only about the remedy. A partner
 * genuinely does hold things a customer does not, and they divide cleanly:
 *
 *   MONEY IN FLIGHT — blocks. Cash they are holding on someone else's behalf,
 *   a settlement neither side has confirmed, earnings owed to them. Erasing
 *   over any of these either loses somebody's money or takes the person's own.
 *   Each is finite and ends on its own; none needs an email to Support.
 *
 *   EVERYTHING ELSE — winds down. A live storefront, staff with keys, an
 *   active subscription. These are consequences of leaving, not reasons to
 *   refuse, and the same file already winds down ad campaigns and vendor staff
 *   for exactly this reason (LAUNCH-2).
 *
 * The obligations are enumerated in the caller's transaction, under the same
 * user row lock as the safety holds, so a settlement opened concurrently with
 * a deletion is either seen or waits behind the lock.
 */

export const PARTNER_BLOCKERS = ['CASH_HELD', 'UNSETTLED_CASH', 'EARNINGS_OWED'] as const;
export type PartnerBlocker = (typeof PARTNER_BLOCKERS)[number];

export interface PartnerObligations {
  /** Vendor cash the mover is holding right now, in major units. */
  committedFloat: number;
  /** Cash handovers neither the rider nor the store has closed out. */
  unsettledCashCount: number;
  /** Earnings owed TO them: PENDING or AVAILABLE, never PAID_OUT. */
  earningsOwed: number;
}

export interface PartnerDeletionVerdict {
  blockers: PartnerBlocker[];
  /** Safe to erase — every blocker is clear. */
  clear: boolean;
}

/**
 * What still binds this partner.
 *
 * Deliberately narrow. Anything listed here refuses a person's erasure
 * request, and a refusal that is not about somebody's money is a refusal that
 * should have been a wind-down.
 */
export function verdictFor(o: PartnerObligations): PartnerDeletionVerdict {
  const blockers: PartnerBlocker[] = [];
  if (o.committedFloat > 0) blockers.push('CASH_HELD');
  if (o.unsettledCashCount > 0) blockers.push('UNSETTLED_CASH');
  if (o.earningsOwed > 0) blockers.push('EARNINGS_OWED');
  return { blockers, clear: blockers.length === 0 };
}

/**
 * What the person is told, and what they can DO about it.
 *
 * Every line names a next action they can take themselves. "Contact Support"
 * is the exact answer this whole module exists to stop giving — and a refusal
 * a person cannot act on is the same dead end wearing a different code.
 */
export const BLOCKER_MESSAGE: Record<PartnerBlocker, string> = {
  CASH_HELD:
    'You are holding vendor cash from a delivery that has not been settled. Hand it in — the account closes as soon as your float is back to zero.',
  UNSETTLED_CASH:
    'A cash handover is still open between you and a store. Confirm it in Settlements, and this closes on its own.',
  EARNINGS_OWED:
    'You have earnings that have not been paid out yet. Deleting now would forfeit them — request the payout first, and close the account once it lands.',
};

/** The whole refusal, as one sentence a person can act on. */
export function refusalMessage(blockers: PartnerBlocker[]): string {
  return blockers.map((b) => BLOCKER_MESSAGE[b]).join(' ');
}

/**
 * Read the obligations inside the caller's transaction.
 *
 * `rider` may be absent (a vendor-only partner) and that is not an obligation:
 * a person with no rider row holds no float and is owed no delivery earnings.
 */
export async function partnerObligations(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<PartnerObligations> {
  const rider = await tx.rider.findUnique({
    where: { userId },
    select: { id: true, committedFloat: true },
  });
  if (!rider) return { committedFloat: 0, unsettledCashCount: 0, earningsOwed: 0 };

  const [unsettled, owed] = await Promise.all([
    tx.deliveryCashSettlement.count({
      // SETTLED is the only terminal state. OWED, RIDER_CONFIRMED and
      // STORE_CONFIRMED all mean one side is still waiting on the other.
      where: { riderId: rider.id, status: { not: 'SETTLED' } },
    }),
    tx.earning.aggregate({
      // PAID_OUT is money that has already reached them. PENDING and AVAILABLE
      // are both still owed, and deleting over either forfeits it.
      where: { riderId: rider.id, status: { in: ['PENDING', 'AVAILABLE'] } },
      _sum: { amount: true },
    }),
  ]);

  return {
    committedFloat: Number(rider.committedFloat ?? 0),
    unsettledCashCount: unsettled,
    earningsOwed: Number(owed._sum.amount ?? 0),
  };
}

// ── Winding down what is not a blocker ─────────────────────────────────────

export interface WindDownResult {
  vendorsClosed: number;
  itemsWithdrawn: number;
  staffRevoked: number;
  subscriptionsCancelled: number;
}

/**
 * Close what leaving implies, in the purge phase so a re-sweep repairs it.
 *
 * A storefront is taken off sale rather than deleted: its orders, receipts and
 * sales history are financial records under the same legal-obligation basis as
 * everything else the erasure keeps. What must stop is a customer being able to
 * order from a business that no longer has an owner.
 *
 * Every step is idempotent and none of them moves money — the same rule the
 * advertiser wind-down follows, and for the same reason.
 */
export async function windDownPartner(
  prisma: Prisma.TransactionClient,
  userId: string,
): Promise<WindDownResult> {
  const owner = await prisma.vendorOwner.findUnique({ where: { userId }, select: { id: true } });
  const vendorIds = owner
    ? (await prisma.vendor.findMany({ where: { ownerId: owner.id }, select: { id: true } })).map((v) => v.id)
    : [];

  const [items, vendors, staff, subs] = await Promise.all([
    vendorIds.length
      ? prisma.item.updateMany({ where: { vendorId: { in: vendorIds }, isAvailable: true }, data: { isAvailable: false } })
      : Promise.resolve({ count: 0 }),
    vendorIds.length
      ? prisma.vendor.updateMany({
          where: { id: { in: vendorIds }, status: { not: 'SUSPENDED' } },
          data: { status: 'SUSPENDED', acceptingOrders: false, isCurrentlyOpen: false },
        })
      : Promise.resolve({ count: 0 }),
    vendorIds.length
      ? prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } })
      : Promise.resolve({ count: 0 }),
    // A subscription left running keeps billing a person who has left.
    //
    // It is NOT keyed on the user: Subscription hangs off riderId, driverId or
    // vendorId, one of which is set. A `where: { userId }` compiled to nothing
    // and would have cancelled nothing while reporting success — the type
    // checker caught it, which is the whole argument for resolving the ids
    // explicitly rather than assuming a shape.
    (async () => {
      const [rider, driver] = await Promise.all([
        prisma.rider.findUnique({ where: { userId }, select: { id: true } }),
        prisma.driver.findUnique({ where: { userId }, select: { id: true } }),
      ]);
      const links: Prisma.SubscriptionWhereInput[] = [];
      if (rider) links.push({ riderId: rider.id });
      if (driver) links.push({ driverId: driver.id });
      if (vendorIds.length) links.push({ vendorId: { in: vendorIds } });
      if (links.length === 0) return { count: 0 };
      return prisma.subscription.updateMany({
        // CHURNED and CANCELLED are already terminal; SUSPENDED still dunning.
        where: { OR: links, status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE', 'PAUSED', 'SUSPENDED'] } },
        data: { status: 'CANCELLED' },
      });
    })(),
  ]);

  return {
    vendorsClosed: vendors.count,
    itemsWithdrawn: items.count,
    staffRevoked: staff.count,
    subscriptionsCancelled: subs.count,
  };
}
