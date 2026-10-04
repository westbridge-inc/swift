import type { Prisma, PrismaClient } from '@prisma/client';
import type { TaxiRates } from '../../modules/country/pricing-config';

/**
 * [PRICING-GY-OCT] Guyana's taxi card before the owner's October fare: base
 * 1000, 300 a km, 25 a minute, minimum 1500, and no included kilometres — a
 * config written before includedKm existed, as every live config was.
 *
 * The single-leg and multi-stop pins were derived from this card. Priced under
 * it, the formula with included kilometres must answer exactly the bytes they
 * pinned: that is the proof a config with no included kilometres prices as it
 * always did. The October fare itself is pinned in
 * fares-georgetown-defaults.test.ts.
 */
export const LEGACY_GY_TAXI_CARD: TaxiRates = { base: 1000, perKm: 300, perMin: 25, minimum: 1500 };

/**
 * Put the legacy card on the Guyana row for one suite. The returned function
 * puts the row's own card back and removes the versions the suite's reads
 * recorded, so the next suite finds Guyana exactly as seeded.
 */
export async function pinLegacyGuyanaTaxiCard(prisma: PrismaClient): Promise<() => Promise<void>> {
  const { taxiRates } = await prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' }, select: { taxiRates: true } });
  if (taxiRates === null) throw new Error('the seeded Guyana row carries no taxi card to restore');
  const before = await prisma.pricingConfigVersion.aggregate({ where: { countryCode: 'GY', kind: 'TAXI_RATES' }, _max: { version: true } });
  await prisma.countryConfig.update({ where: { code: 'GY' }, data: { taxiRates: LEGACY_GY_TAXI_CARD as unknown as Prisma.InputJsonValue } });
  return async () => {
    await prisma.countryConfig.update({ where: { code: 'GY' }, data: { taxiRates: taxiRates as Prisma.InputJsonValue } });
    await prisma.pricingConfigVersion.deleteMany({ where: { countryCode: 'GY', kind: 'TAXI_RATES', version: { gt: before._max.version ?? 0 } } });
  };
}
