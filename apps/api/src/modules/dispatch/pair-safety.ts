import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';

type PairDb = Pick<Prisma.TransactionClient, 'user' | 'userBlock' | 'incidentCase' | 'driver' | 'rider'>;
type Pool = 'DRIVER' | 'RIDER';
const key = (customer: string, mover: string) => JSON.stringify([customer, mover]);

/** The same current pair policy serves discovery, boards and locked claims.
 * All reads are bounded to explicit user IDs, including worker calls with no
 * request tenant. No incident-count cap may silently admit a prohibited pair. */
async function excludedPairs(db: PairDb, customerIds: string[], moverIds: string[], pool: Pool): Promise<Set<string>> {
  const customers = [...new Set(customerIds)];
  const movers = [...new Set(moverIds)];
  const excluded = new Set<string>();
  if (!customers.length || !movers.length) return excluded;
  const c = new Set(customers); const m = new Set(movers);
  const add = (first: string | null, second: string | null) => {
    if (!first || !second) return;
    if (c.has(first) && m.has(second)) excluded.add(key(first, second));
    if (c.has(second) && m.has(first)) excluded.add(key(second, first));
  };
  const [blocks, incidents, enhanced] = await Promise.all([
    db.userBlock.findMany({ where: { unblockedAt: null, OR: [
      { blockerId: { in: customers }, blockedId: { in: movers } },
      { blockedId: { in: customers }, blockerId: { in: movers } },
    ] }, select: { blockerId: true, blockedId: true } }),
    db.incidentCase.findMany({ where: { createdAt: { gte: new Date(Date.now() - 365 * 86_400_000) }, OR: [
      { reporterUserId: { in: customers }, subjectUserId: { in: movers } },
      { subjectUserId: { in: customers }, reporterUserId: { in: movers } },
    ] }, select: { reporterUserId: true, subjectUserId: true } }),
    db.user.findMany({ where: { id: { in: customers }, enhancedSafetyMonitoring: true }, select: { id: true } }),
  ]);
  for (const block of blocks) add(block.blockerId, block.blockedId);
  for (const incident of incidents) add(incident.reporterUserId, incident.subjectUserId);
  if (enhanced.length) {
    const restricted = pool === 'DRIVER'
      ? await db.driver.findMany({ where: { userId: { in: movers }, safetyShadowRestrictedAt: { not: null } }, select: { userId: true } })
      : await db.rider.findMany({ where: { userId: { in: movers }, safetyShadowRestrictedAt: { not: null } }, select: { userId: true } });
    for (const customer of enhanced) for (const mover of restricted) excluded.add(key(customer.id, mover.userId));
  }
  return excluded;
}

export async function safetyExcludedMovers(db: PairDb, customerId: string, moverIds: string[], pool: Pool): Promise<Set<string>> {
  const pairs = await excludedPairs(db, [customerId], moverIds, pool);
  return new Set(moverIds.filter((id) => pairs.has(key(customerId, id))));
}

export async function safeBoardOrders<T extends { customerId: string }>(db: PairDb, orders: T[], moverUserId: string, pool: Pool): Promise<T[]> {
  const pairs = await excludedPairs(db, orders.map((o) => o.customerId), [moverUserId], pool);
  return orders.filter((order) => !pairs.has(key(order.customerId, moverUserId)));
}

/** Call after User → Order locks, before writing assignment or reserving float.
 * Block activation takes both User locks, so a committed block precedes a
 * refused claim, or waits for an already authorized assignment to commit. */
export async function assertDispatchPairEligible(db: PairDb, customerId: string, moverUserId: string, pool: Pool): Promise<void> {
  if ((await safetyExcludedMovers(db, customerId, [moverUserId], pool)).has(moverUserId)) {
    throw new AppError(409, 'JOB_UNAVAILABLE', 'This job is no longer available. Refresh to see other work.');
  }
}
