import { PrismaClient, Prisma, TrustLevel } from '@prisma/client';

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * [G4] THE ONE READER of what a rider fronts for an order.
 *
 * The gate commits it at claim (`claimOffer` in dispatch.service, the board
 * grab in rider.routes), every terminal transition releases it (order.service,
 * delivery-watchdog, mover-authority), and the offer card SHOWS it as
 * `payToVendor` (`cashMathForOffer`). Before this helper the gate read
 * `subtotalBase` and the card read `subtotalCustomer` — equal only because
 * `chk_orders_zero_markup` forces markup to zero. Two readers of one amount is
 * how a rider gets told to hand over one number while being gated on another,
 * the day markup stops being zero. One reader, imported everywhere; a census
 * test (`float-one-reader.test.ts`) fails on any site that grows its own.
 *
 * `subtotalBase` is the goods at the STORE's price — what the rider actually
 * hands over at pickup. A non-CASH order fronts nothing.
 */
export function riderFloatForOrder(order: {
  paymentMethod: string;
  subtotalBase: number | string | null | undefined | { toString(): string };
}): number {
  if (order.paymentMethod !== 'CASH') return 0;
  const amount = Number(order.subtotalBase);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * D.3 rider float-limit gate.
 *
 * A rider may front at most `floatLimit` worth of vendor cash at any one time;
 * `committedFloat` is what's currently outstanding across their live CASH orders.
 * `availableFloat = floatLimit − committedFloat`, and dispatch only offers a CASH
 * delivery to riders whose availableFloat ≥ the order's `subtotalBase` (the goods
 * cost the rider pays the vendor at pickup). Limits come from CountryConfig per
 * the rider's `User.trustLevel`. Taxi drivers never front cash, so they are not
 * gated. Invariant: committedFloat ≥ 0; commit/release are atomic (accept a tx).
 */
/**
 * [ALG-26] The float, explained — a logistics aid, never an enforcement.
 *
 * The COD cash limit is built (floatLimit from trust level + country, the
 * guarded commit). What was missing was the sentence: a rider whose float
 * is spent stops receiving cash offers and, told nothing, assumes the app
 * is broken. `floatAdvice` turns the two numbers the profile already
 * carries into a level and one sentence the cockpit renders as-is.
 *
 * A correction to the algorithm document, recorded here: its "deposit
 * scheduling" assumes riders carry Swift's cash to an agent. On this rail
 * they never do — the float is the rider's OWN money fronted to a store
 * and recovered at the customer's door (money matrix row 1). So the advice
 * is about finishing deliveries, not depositing; there is nothing to drop
 * off and no agent network to route to.
 *
 *   ok       below the soft threshold — nothing to say
 *   soon     at or past the soft threshold (AlgoConfig `float.softPct`)
 *   blocked  nothing left — the gate is refusing cash work, and says so
 *
 * Never confiscates, never deducts, never treats a carrying rider as suspect.
 */
export type FloatAdviceLevel = 'ok' | 'soon' | 'blocked';
export interface FloatAdvice {
  level: FloatAdviceLevel;
  limit: number;
  committed: number;
  available: number;
  /** 0..1 of the limit currently fronted; 0 when the limit is 0. */
  usedPct: number;
  /** One sentence a rider would accept, or null when there is nothing to say. */
  sentence: string | null;
}

const gyd = (n: number) => `GY$${Math.round(n).toLocaleString('en-US')}`;

export function floatAdvice(
  rider: { floatLimit: Prisma.Decimal | number; committedFloat: Prisma.Decimal | number },
  softPct = 0.7,
): FloatAdvice {
  const limit = Math.max(0, Number(rider.floatLimit));
  const committed = Math.max(0, Number(rider.committedFloat));
  const available = Math.max(0, limit - committed);
  const usedPct = limit > 0 ? Math.min(1, committed / limit) : 0;
  const soft = Math.min(1, Math.max(0.1, Number.isFinite(softPct) ? softPct : 0.7));
  if (limit <= 0) {
    return { level: 'ok', limit, committed, available, usedPct, sentence: null };
  }
  if (available <= 0) {
    return {
      level: 'blocked', limit, committed, available, usedPct,
      sentence: `Your cash float is fully in use — ${gyd(committed)} of ${gyd(limit)} is fronted to stores right now. Cash offers pause until a delivery is paid at the door; MMG-paid jobs still come through.`,
    };
  }
  if (usedPct >= soft) {
    return {
      level: 'soon', limit, committed, available, usedPct,
      sentence: `You're fronting ${gyd(committed)} of your ${gyd(limit)} cash float — ${gyd(available)} left. Finish a delivery before taking more cash work, or the next cash offer will pass you by.`,
    };
  }
  return { level: 'ok', limit, committed, available, usedPct, sentence: null };
}

export class FloatService {
  constructor(private prisma: Tx) {}

  /** The float limit for a country + trust level (local currency). */
  async floatLimitFor(countryCode: string, trustLevel: TrustLevel): Promise<number> {
    const cfg = await this.prisma.countryConfig.findUnique({
      where: { code: countryCode },
      select: { floatL1: true, floatL2: true, floatL3: true },
    });
    if (!cfg) return 0;
    const byLevel: Record<TrustLevel, Prisma.Decimal> = {
      L1: cfg.floatL1,
      L2: cfg.floatL2,
      L3: cfg.floatL3,
    };
    return Number(byLevel[trustLevel] ?? cfg.floatL1);
  }

  /** Recompute + persist a rider's floatLimit from their User.trustLevel + country. */
  async recomputeForUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { trustLevel: true, countryCode: true, rider: { select: { id: true } } },
    });
    if (!user?.rider) return;
    const limit = await this.floatLimitFor(user.countryCode, user.trustLevel);
    await this.prisma.rider.update({ where: { id: user.rider.id }, data: { floatLimit: limit } });
  }

  /** Headroom = limit − committed. */
  available(rider: { floatLimit: Prisma.Decimal | number; committedFloat: Prisma.Decimal | number }): number {
    return Number(rider.floatLimit) - Number(rider.committedFloat);
  }

  /** Commit float when a rider claims a CASH order. ATOMIC GUARDED increment
   *  [SWIFT-104]: succeeds only while headroom (floatLimit − committedFloat) still
   *  covers `amount`, so two concurrent claims by the SAME rider (two board-grabs
   *  or two offers of DIFFERENT orders) can't push committedFloat past the cap. A
   *  JS read-then-check can't guarantee this — both concurrent claims read the
   *  same committedFloat and both pass. Returns false when the cap would be
   *  exceeded; the caller must NOT proceed with the claim (release/revert). */
  async commit(tx: Tx, riderId: string, amount: number): Promise<boolean> {
    if (amount <= 0) return true;
    const rows = await tx.$executeRaw`
      UPDATE "riders"
      SET "committedFloat" = "committedFloat" + ${amount}
      WHERE "id" = ${riderId} AND ("floatLimit" - "committedFloat") >= ${amount}`;
    return rows === 1;
  }

  /** Release float on a terminal transition (delivered / cancelled / failed) —
   *  clamped ≥ 0. ATOMIC guarded decrement, never read-then-write: two terminal
   *  transitions for the SAME rider on DIFFERENT cash orders can race (callers
   *  don't share a tx), and a read-compute-write would lose one release —
   *  permanently inflating committedFloat and shrinking the rider's dispatchable
   *  float until an admin corrects it. */
  async release(tx: Tx, riderId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    // Enough committed → atomic decrement. The DB serializes concurrent
    // decrements, so two releases both apply (no lost update).
    const dec = await tx.rider.updateMany({
      where: { id: riderId, committedFloat: { gte: amount } },
      data: { committedFloat: { decrement: amount } },
    });
    if (dec.count === 0) {
      // Over-release (committedFloat < amount — shouldn't happen if commit/
      // release balance, but clamp defensively). Zero it ONLY while still short,
      // so a concurrent commit isn't wiped.
      await tx.rider.updateMany({
        where: { id: riderId, committedFloat: { lt: amount } },
        data: { committedFloat: 0 },
      });
    }
  }
}
