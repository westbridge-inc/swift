// ---------------------------------------------------------------------------
// [DS110 #19 · G3-F1] Reimbursement claims are tenant-owned through EITHER
// mover leg, and every id list is batched.
//
// ReimbursementClaim predates tenant ownership: it carries loose riderId /
// driverId / orderId / customerId ids and no tenantId of its own, with a
// database XOR ("exactly one of riderId / driverId names the mover"). The
// admin child scope used to require `riderId IN (local riders)`, which a driver
// claim (driverId set, riderId NULL) can never satisfy — `NULL IN (...)` is
// false — so taxi guarantee claims were invisible and unpayable from launch.
//
// The same scope materialised every tenant id into one giant `IN (...)` list;
// PostgreSQL caps a statement at 65,535 bind parameters, so a tenant with tens
// of thousands of orders/users would eventually 500 the admin claims query.
// This module is the one author of both rules: a local rider leg OR a local
// driver leg, and no `IN` list larger than CLAIM_SCOPE_IN_BATCH.
// ---------------------------------------------------------------------------

/**
 * The largest `IN (...)` list this scope emits. PostgreSQL's statement ceiling
 * is 65,535 bind parameters and the claims query carries up to four lists, so
 * a 10,000-row batch keeps the worst case orders of magnitude under it while
 * the OR-of-batches union remains identical to one flat list.
 */
export const CLAIM_SCOPE_IN_BATCH = 10_000;

/** Split a list into batches of at most `batch` elements. */
export function batched<T>(items: readonly T[], batch = CLAIM_SCOPE_IN_BATCH): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batch) {
    batches.push(items.slice(i, i + batch));
  }
  return batches;
}

/** One `{ [field]: { in: [...] } }` predicate per batch. An empty list yields
 *  `in: []`, which matches nothing (NULL fails every `IN`), never Prisma's
 *  absent-OR semantics that would match everything. */
export const batchedIn = (field: string, ids: readonly string[]): Array<Record<string, unknown>> => {
  const batches = batched(ids);
  if (batches.length === 0) return [{ [field]: { in: [] } }];
  return batches.map((batch) => ({ [field]: { in: batch } }));
};

/**
 * The reimbursement-claim tenant boundary, as a Prisma where-predicate:
 *
 * - the mover leg resolves locally — a rider claim through `riderId`, a driver
 *   claim through `riderId IS NULL AND driverId` — and
 * - both loose ownership legs (the order, the customer) also resolve locally,
 *
 * with every id list batched under the bind-parameter ceiling. The predicate
 * is pure so the batching itself is unit-testable without a database.
 */
export function reimbursementClaimTenantScope(
  riderIds: readonly string[],
  driverIds: readonly string[],
  orderIds: readonly string[],
  customerIds: readonly string[],
): Record<string, unknown> {
  return {
    AND: [
      {
        OR: [
          ...batchedIn('riderId', riderIds),
          ...batchedIn('driverId', driverIds).map((leg) => ({ riderId: null, ...leg })),
        ],
      },
      { OR: batchedIn('orderId', orderIds) },
      { OR: batchedIn('customerId', customerIds) },
    ],
  };
}
