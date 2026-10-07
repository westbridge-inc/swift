import type { PrismaClient } from '@prisma/client';
import { runWithoutTenant } from '../../plugins/tenant-context';

/**
 * [ZONE-FARES] The Georgetown Central ↔ South fixed fare, as a SUITE-OWNED
 * fixture.
 *
 * The platform seed planted this pair at 2,000 GYD each way until October 2026,
 * and five suites used it as their example of a trip the zone table prices.
 * The seed no longer plants it (it contradicted the owner's formula; see
 * ops/platform-config), so each of those suites now puts the same two rows in
 * place for itself and takes away exactly the rows it put there. Every
 * assertion they make about the zone-table path is unchanged.
 *
 * A row that already exists (an older database seeded with the pair) is left
 * alone and kept afterwards: the suite then reads the very fare it always did.
 */
export const GEORGETOWN_PAIR_FARE = 2000;

export async function plantGeorgetownPair(prisma: PrismaClient): Promise<() => Promise<void>> {
  const created: string[] = [];
  await runWithoutTenant(async () => {
    for (const [fromZoneId, toZoneId] of [['georgetown-central', 'georgetown-south'], ['georgetown-south', 'georgetown-central']] as const) {
      const existing = await prisma.zoneFare.findUnique({ where: { fromZoneId_toZoneId: { fromZoneId, toZoneId } } });
      if (existing) {
        if (Number(existing.fare) !== GEORGETOWN_PAIR_FARE) {
          throw new Error(`zone-fare fixture: ${fromZoneId} → ${toZoneId} already exists at ${String(existing.fare)}, not ${GEORGETOWN_PAIR_FARE}; this suite's pins would not mean what they say`);
        }
        continue;
      }
      const row = await prisma.zoneFare.create({ data: { fromZoneId, toZoneId, fare: GEORGETOWN_PAIR_FARE, updatedBy: 'test-fixture:georgetown-pair' } });
      created.push(row.id);
    }
  }, 'test-fixture:georgetown-pair');
  return async () => {
    if (created.length === 0) return;
    await runWithoutTenant(() => prisma.zoneFare.deleteMany({ where: { id: { in: created } } }), 'test-cleanup:georgetown-pair');
    created.length = 0;
  };
}
