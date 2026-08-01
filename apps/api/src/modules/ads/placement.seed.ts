import type { PrismaClient } from '@prisma/client';

// The three home-screen placements (ads-platform spec §2). Seeded per tenant,
// idempotent (upsert on the [tenantId, key] unique). Prices/slots/rotation are
// SEED DEFAULTS only — an operator tunes them by editing the AdPlacement row.
export const DEFAULT_PLACEMENTS = [
  { key: 'home_hero_video', name: 'Home Hero Video', tier: 1, mediaKind: 'VIDEO' as const, slotsPerWeek: 1, rotationSeconds: null, weeklyPrice: 50_000, freqCapPerUserPerDay: null },
  { key: 'home_top_card', name: 'Home Top Card', tier: 2, mediaKind: 'IMAGE' as const, slotsPerWeek: 1, rotationSeconds: null, weeklyPrice: 20_000, freqCapPerUserPerDay: null },
  { key: 'home_ad_bar', name: 'Home Ad Bar', tier: 3, mediaKind: 'IMAGE' as const, slotsPerWeek: 6, rotationSeconds: 6, weeklyPrice: 5_000, freqCapPerUserPerDay: null },
] as const;

/** Seed (or refresh names/defaults for) the three placements + AdsSettings for
 *  a tenant. Idempotent — safe to run on boot or from an admin action. Never
 *  overwrites price/slots once set by the operator: create-only for those. */
export async function seedAdPlacements(prisma: PrismaClient, tenantId = 'swift-default'): Promise<number> {
  let seeded = 0;
  for (const p of DEFAULT_PLACEMENTS) {
    const existing = await prisma.adPlacement.findUnique({ where: { tenantId_key: { tenantId, key: p.key } } });
    if (existing) continue; // operator owns the tunables after first create
    await prisma.adPlacement.create({
      data: {
        tenantId, key: p.key, name: p.name, tier: p.tier, mediaKind: p.mediaKind,
        slotsPerWeek: p.slotsPerWeek, rotationSeconds: p.rotationSeconds ?? null,
        weeklyPrice: p.weeklyPrice, freqCapPerUserPerDay: p.freqCapPerUserPerDay ?? null,
      },
    });
    seeded += 1;
  }
  await prisma.adsSettings.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
  return seeded;
}
