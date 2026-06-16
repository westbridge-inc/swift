import type { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Services vertical (spec §4.6). Trust is risk-tiered: verify hard where someone
// could be physically harmed. Every provider needs ID + police clearance; a
// trade qualification is an optional "Certified" badge. Providers without one
// can still join, shown transparently as "self-skilled".
// ---------------------------------------------------------------------------

/** Trades where bad work can cause physical harm — surfaced with a strong
 *  "choose a licensed provider" message; licensed providers are listed first. */
const HIGH_RISK_TRADES = new Set(['electrician', 'electrical', 'gas', 'gas_fitter', 'plumber', 'plumbing']);

export function tradeRiskTier(trade: string): 'HIGH' | 'LOW' {
  return HIGH_RISK_TRADES.has(trade.trim().toLowerCase()) ? 'HIGH' : 'LOW';
}

export function riskGuidance(trade: string): string {
  return tradeRiskTier(trade) === 'HIGH'
    ? 'Higher-risk work — we strongly recommend choosing a licensed (Certified) provider. Certified providers are shown first.'
    : 'Every provider is ID-verified and police-cleared — choose by ratings and reviews.';
}

/**
 * Government Electrical Inspectorate registry check (spec §3.4). The live GEI
 * registry is a CountryConfig verificationSource; here we accept a plausible
 * reference and otherwise leave the qualification for manual review.
 */
export function geiRegistryCheck(referenceNumber: string | undefined | null): boolean {
  return Boolean(referenceNumber && /^[A-Za-z0-9-]{5,}$/.test(referenceNumber));
}

/**
 * A provider may operate live only when ID + police clearance are approved
 * (the SERVICE_PROVIDER checklist). Mirrors the verification gate without
 * coupling to the vendor-oriented ChecklistRole type.
 */
export async function isProviderVerified(prisma: PrismaClient, userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true } });
  if (!user) return false;
  const config = await prisma.countryConfig.findUnique({ where: { code: user.countryCode } });
  const checklist = ((config?.documentChecklists as Record<string, string[]>) ?? {})['SERVICE_PROVIDER'] ?? [];
  if (checklist.length === 0) return false;

  const approved = await prisma.verificationDocument.findMany({
    where: {
      userId,
      docType: { in: checklist },
      status: 'APPROVED',
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { docType: true },
  });
  const have = new Set(approved.map((d) => d.docType));
  return checklist.every((docType) => have.has(docType));
}
