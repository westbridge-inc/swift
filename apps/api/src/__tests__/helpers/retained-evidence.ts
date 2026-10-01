/**
 * [SAFE-B · retained history] Suite teardown on a database that keeps evidence.
 *
 * CI runs every API suite serially against ONE database. A cash handover
 * filing, an issued handover photo and an MMG payer declaration are immutable
 * evidence: the database refuses to delete them, and refuses to delete the
 * order or subscription they belong to. A teardown therefore keeps that
 * evidence-bearing cohort, and every person, mover and store it names, and
 * removes only the scaffolding the schema allows. It never disables a trigger,
 * never swallows the refusal and never half-commits: the caller runs its
 * deletes on the ids this module returns, inside one transaction.
 *
 * What stays must not leak into another suite: a kept mover is taken offline
 * and loses its job pointers, a kept store is closed. Neither touches the
 * evidence, which froze the facts it needed at filing time.
 *
 * And what stays must not collide: a suite that keeps users puts them in a
 * phone namespace no other suite uses or purges, unique to the run
 * (`retainedPhonePrefix`).
 */
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export interface RetainedCohort {
  /** Orders the database will not let go: a filing or an issued photo names them. */
  orderIds: Set<string>;
  /** Users those orders name, as customer, rider, driver or store owner. */
  userIds: Set<string>;
  riderIds: Set<string>;
  driverIds: Set<string>;
  vendorIds: Set<string>;
  /** Subscriptions an MMG payer declaration names (the database will not let those go either). */
  subscriptionIds: Set<string>;
}

/**
 * A phone namespace for fixtures that outlive the suite. No other suite uses
 * or purges `+592099…`; the two-digit `code` separates suites (fixed width, so
 * no suite's prefix is another's) and four run digits separate runs, so a kept
 * user never collides with a later run or another suite's fixed numbers, and
 * no other suite's prefix purge can reach it. Append a three-digit sequence:
 * the whole number is 15 digits, the E.164 maximum.
 */
export function retainedPhonePrefix(code: string): string {
  if (!/^\d{2}$/.test(code)) throw new Error(`retainedPhonePrefix: a two-digit suite code, not "${code}"`);
  return `+592099${code}${String(Date.now()).slice(-4)}`;
}

/** The evidence-bearing cohort among `orderIds` and `subscriptionIds`, with everyone it names. */
export async function retainedCohort(
  db: Db,
  scope: { orderIds?: readonly string[]; subscriptionIds?: readonly string[] },
): Promise<RetainedCohort> {
  const orderIds = [...new Set(scope.orderIds ?? [])];
  const subscriptionIds = [...new Set(scope.subscriptionIds ?? [])];
  const [filings, photos, payerEvidence] = await Promise.all([
    orderIds.length ? db.cashHandoverEvidence.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true } }) : [],
    orderIds.length ? db.handoverPhotoProof.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true } }) : [],
    subscriptionIds.length ? db.mmgPayerEvidence.findMany({ where: { subscriptionId: { in: subscriptionIds } }, select: { subscriptionId: true, accountId: true } }) : [],
  ]);
  const kept = [...new Set([...filings, ...photos].map((r) => r.orderId))];
  const orders = kept.length
    ? await db.order.findMany({ where: { id: { in: kept } }, select: { customerId: true, riderId: true, driverId: true, vendorId: true } })
    : [];
  const riderIds = new Set(orders.map((o) => o.riderId).filter((v): v is string => !!v));
  const driverIds = new Set(orders.map((o) => o.driverId).filter((v): v is string => !!v));
  const vendorIds = new Set(orders.map((o) => o.vendorId).filter((v): v is string => !!v));
  const keptSubscriptions = new Set(payerEvidence.map((e) => e.subscriptionId).filter((v): v is string => !!v));
  const [riders, drivers, vendors, subscriptions] = await Promise.all([
    riderIds.size ? db.rider.findMany({ where: { id: { in: [...riderIds] } }, select: { userId: true } }) : [],
    driverIds.size ? db.driver.findMany({ where: { id: { in: [...driverIds] } }, select: { userId: true } }) : [],
    vendorIds.size ? db.vendor.findMany({ where: { id: { in: [...vendorIds] } }, select: { owner: { select: { userId: true } } } }) : [],
    keptSubscriptions.size ? db.subscription.findMany({ where: { id: { in: [...keptSubscriptions] } }, select: { riderId: true, driverId: true, vendorId: true } }) : [],
  ]);
  for (const s of subscriptions) {
    if (s.riderId) riderIds.add(s.riderId);
    if (s.driverId) driverIds.add(s.driverId);
    if (s.vendorId) vendorIds.add(s.vendorId);
  }
  const lateRiders = subscriptions.some((s) => s.riderId) ? await db.rider.findMany({ where: { id: { in: subscriptions.map((s) => s.riderId).filter((v): v is string => !!v) } }, select: { userId: true } }) : [];
  const lateDrivers = subscriptions.some((s) => s.driverId) ? await db.driver.findMany({ where: { id: { in: subscriptions.map((s) => s.driverId).filter((v): v is string => !!v) } }, select: { userId: true } }) : [];
  const lateVendors = subscriptions.some((s) => s.vendorId) ? await db.vendor.findMany({ where: { id: { in: subscriptions.map((s) => s.vendorId).filter((v): v is string => !!v) } }, select: { owner: { select: { userId: true } } } }) : [];
  const userIds = new Set<string>([
    ...orders.map((o) => o.customerId),
    ...[...riders, ...lateRiders].map((r) => r.userId),
    ...[...drivers, ...lateDrivers].map((d) => d.userId),
    ...[...vendors, ...lateVendors].map((v) => v.owner.userId),
    ...payerEvidence.map((e) => e.accountId),
  ]);
  return { orderIds: new Set(kept), userIds, riderIds, driverIds, vendorIds, subscriptionIds: keptSubscriptions };
}

/** `ids` without the kept ones. */
export const without = (ids: readonly string[], kept: Set<string>): string[] => ids.filter((id) => !kept.has(id));

/** Take what stays out of service: kept movers go offline with no job pointers, kept stores close, and kept
 *  subscriptions are cancelled without renewal, so no later billing cycle, sweep or offer ever reaches them. */
export async function retireKeptScaffolding(db: Db, cohort: RetainedCohort): Promise<void> {
  if (cohort.subscriptionIds.size) {
    await db.subscription.updateMany({ where: { id: { in: [...cohort.subscriptionIds] } }, data: { status: 'CANCELLED', autoRenew: false } });
  }
  if (cohort.riderIds.size) {
    await db.rider.updateMany({ where: { id: { in: [...cohort.riderIds] } }, data: { isOnline: false, isAvailable: false, currentOrderId: null } });
  }
  if (cohort.driverIds.size) {
    await db.driver.updateMany({ where: { id: { in: [...cohort.driverIds] } }, data: { isOnline: false, isAvailable: false, currentRideId: null } });
  }
  if (cohort.vendorIds.size) {
    await db.vendor.updateMany({ where: { id: { in: [...cohort.vendorIds] } }, data: { status: 'CLOSED', acceptingOrders: false, isCurrentlyOpen: false } });
  }
}
