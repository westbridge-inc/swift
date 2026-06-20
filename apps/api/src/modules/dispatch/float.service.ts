import { PrismaClient, Prisma, TrustLevel } from '@prisma/client';

type Tx = Prisma.TransactionClient | PrismaClient;

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
export class FloatService {
  constructor(private prisma: PrismaClient) {}

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

  /** Commit float when a rider claims a CASH order — increments committedFloat (atomic via tx). */
  async commit(tx: Tx, riderId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    await tx.rider.update({ where: { id: riderId }, data: { committedFloat: { increment: amount } } });
  }

  /** Release float on a terminal transition (delivered / cancelled / failed) — clamped ≥ 0. */
  async release(tx: Tx, riderId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    const rider = await tx.rider.findUnique({ where: { id: riderId }, select: { committedFloat: true } });
    if (!rider) return;
    const next = Math.max(0, Number(rider.committedFloat) - amount);
    await tx.rider.update({ where: { id: riderId }, data: { committedFloat: next } });
  }
}
