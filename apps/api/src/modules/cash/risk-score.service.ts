import type { PrismaClient } from '@prisma/client';

/**
 * Risk scoring (marketplace-mechanics spec §10): many signals → ONE number.
 * Every input already exists and is deterministic; the score is a pure read
 * computed on demand — no stored state to drift, no model, no vibes.
 *
 * SWIFT-160 — what this ACTUALLY does today: it is an ADVISORY signal. Its only
 * caller is the admin risk-lookup endpoint (admin.routes.ts) — a human reads the
 * tier. It throttles nothing automatically and it never auto-bans. Real
 * consequences live in the strike system's explicit thresholds (cash-rules),
 * written by a human. Turning a HIGH tier into an automatic consequence (claim
 * review, prepay-only, tighter dispatch) is a founder product decision,
 * deliberately NOT wired here (Q-FRAUD-160 in DECISIONS). Until it is, don't
 * cite this score as if it gates anything — it doesn't.
 *
 * Signals and weights (0–100 scale, capped):
 *   strikes (all time)            25 each  — the platform's strongest signal
 *   failed-delivery claims (90d)  15 each  — no-show/refused at the door
 *   customer cancels (30d)         5 each  — after the free window
 *   off-platform chat flags (30d)  3 each  — take-it-to-WhatsApp overtures
 */
export interface RiskBreakdown {
  score: number;
  tier: 'LOW' | 'MEDIUM' | 'HIGH';
  signals: {
    strikes: number;
    claims90d: number;
    cancels30d: number;
    offPlatform30d: number;
  };
}

const DAY = 24 * 3600 * 1000;

export async function riskScoreFor(prisma: PrismaClient, userId: string): Promise<RiskBreakdown> {
  const d30 = new Date(Date.now() - 30 * DAY);
  const d90 = new Date(Date.now() - 90 * DAY);

  const [strikes, claims90d, cancels30d, offPlatform30d] = await Promise.all([
    prisma.strike.count({ where: { userId } }),
    prisma.reimbursementClaim.count({ where: { customerId: userId, createdAt: { gte: d90 } } }),
    // Only cancels AFTER the free window count (the doc above always said so;
    // until lateCancelFeeDue existed the query couldn't tell them apart and
    // punished free cancels too). Marker recorded since 2026-07-21.
    prisma.order.count({
      where: { customerId: userId, status: 'CANCELLED', cancelledBy: userId, lateCancelFeeDue: { gt: 0 }, updatedAt: { gte: d30 } },
    }),
    prisma.chatMessage.count({ where: { senderId: userId, offPlatformFlag: true, createdAt: { gte: d30 } } }),
  ]);

  const score = Math.min(100, strikes * 25 + claims90d * 15 + cancels30d * 5 + offPlatform30d * 3);
  const tier = score >= 60 ? 'HIGH' : score >= 25 ? 'MEDIUM' : 'LOW';
  return { score, tier, signals: { strikes, claims90d, cancels30d, offPlatform30d } };
}
