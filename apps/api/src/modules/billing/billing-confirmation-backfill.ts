import type { PrismaClient, Prisma } from '@prisma/client';
import { BILLING_CUTOVER_KEY, BILLING_CUTOVER_VERSION, billingEffectsReady } from './billing-cutover';
import { currentDunningClock } from './dunning-clock';

/** Operational cutover only: uses the same resolver and source mapping as the
 * runtime. It imports no billing service or provider and performs no collection,
 * settlement, notice delivery, balance movement or entitlement restoration. */
export async function backfillBillingConfirmation(db: PrismaClient, options: {
  afterSubscription?: (completed: number, id: string) => Promise<void>;
} = {}) {
  const marker = await db.platformConfig.findUnique({ where: { key: BILLING_CUTOVER_KEY } });
  const gate = marker?.value as Prisma.JsonObject | undefined;
  if (gate?.['version'] !== BILLING_CUTOVER_VERSION) throw new Error('Billing cutover version is missing or different');
  if (await billingEffectsReady(db)) return { alreadyComplete: true, mapped: 0, coverageDigest: gate['coverageDigest'] };
  if (gate?.['state'] !== 'BLOCKED') throw new Error('Billing cutover state is invalid');

  // Validate the whole source census before classification. A malformed owner
  // cannot disappear because a paginated query happened not to join it.
  const invalid = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) FROM subscriptions s
    LEFT JOIN riders r ON r.id=s."riderId" LEFT JOIN drivers d ON d.id=s."driverId"
    LEFT JOIN vendors v ON v.id=s."vendorId" LEFT JOIN vendor_owners vo ON vo.id=v."ownerId"
    LEFT JOIN users u ON u.id=COALESCE(r."userId",d."userId",vo."userId")
    WHERE num_nonnulls(s."riderId",s."driverId",s."vendorId")<>1 OR u.id IS NULL
      OR (v.id IS NOT NULL AND v."tenantId" IS DISTINCT FROM u."tenantId")`;
  if (Number(invalid[0]?.count ?? 0) > 0) throw new Error('Billing cutover has invalid or orphan subscription owners; completion remains blocked');
  let cursor: string | undefined;
  let mapped = 0;
  for (;;) {
    const rows = await db.subscription.findMany({ where: cursor ? { id: { gt: cursor } } : {}, orderBy: { id: 'asc' }, take: 100, select: { id: true } });
    if (!rows.length) break;
    for (const row of rows) {
      await db.$transaction((tx) => currentDunningClock(tx, row.id));
      mapped += 1;
      await options.afterSubscription?.(mapped, row.id);
    }
    cursor = rows[rows.length - 1]!.id;
  }
  // The owner-only SQL boundary repeats full coverage checks and records an
  // immutable completion audit before making this exact version READY.
  const completed = await db.$queryRaw<Array<{ digest: string }>>`
    SELECT billing_complete_confirmation_backfill(${BILLING_CUTOVER_VERSION}) AS digest`;
  return { alreadyComplete: false, mapped, coverageDigest: completed[0]!.digest };
}
