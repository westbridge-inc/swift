import { describe, expect, it } from 'vitest';
import {
  CLAIM_SCOPE_IN_BATCH, batched, batchedIn, reimbursementClaimTenantScope,
} from '../modules/admin/claim-tenant-scope';

// [DS110 #19 · G3-F1] The scope predicate is pure, so its two rules — the
// driver leg and the bind-parameter batching — are graded without a database.

/** Every `in` array anywhere inside a predicate object. */
function inLists(node: unknown): unknown[][] {
  const found: unknown[][] = [];
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'in' && Array.isArray(child)) found.push(child as unknown[]);
      else walk(child);
    }
  };
  walk(node);
  return found;
}

describe('reimbursementClaimTenantScope', () => {
  it('matches a rider claim through the rider leg and a driver claim through riderId-null plus the driver leg', () => {
    expect(reimbursementClaimTenantScope(['rider-1'], ['driver-9'], ['order-1'], ['user-1'])).toEqual({
      AND: [
        {
          OR: [
            { riderId: { in: ['rider-1'] } },
            { riderId: null, driverId: { in: ['driver-9'] } },
          ],
        },
        { OR: [{ orderId: { in: ['order-1'] } }] },
        { OR: [{ customerId: { in: ['user-1'] } }] },
      ],
    });
  });

  it('emits no IN list larger than the batch ceiling, whatever the tenant size', () => {
    const riders = Array.from({ length: 25_001 }, (_, i) => `rider-${i}`);
    const drivers = Array.from({ length: 12_345 }, (_, i) => `driver-${i}`);
    const orders = Array.from({ length: 32_767 }, (_, i) => `order-${i}`);
    const customers = Array.from({ length: 32_767 }, (_, i) => `user-${i}`);

    const scope = reimbursementClaimTenantScope(riders, drivers, orders, customers);
    const lists = inLists(scope);

    // Batched, not one giant list per field.
    expect(lists.length).toBeGreaterThan(4);
    for (const list of lists) {
      expect(list.length).toBeLessThanOrEqual(CLAIM_SCOPE_IN_BATCH);
    }
    // Every id survives exactly once, in some batch.
    const riderIds = lists.flat().filter((id): id is string => typeof id === 'string' && id.startsWith('rider-'));
    expect(riderIds.sort()).toEqual([...riders].sort());
  });

  it('an empty tenant matches nothing rather than everything', () => {
    const scope = reimbursementClaimTenantScope([], [], [], []);
    expect(scope).toEqual({
      AND: [
        {
          OR: [
            { riderId: { in: [] } },
            { riderId: null, driverId: { in: [] } },
          ],
        },
        { OR: [{ orderId: { in: [] } }] },
        { OR: [{ customerId: { in: [] } }] },
      ],
    });
  });

  it('batchedIn never returns an empty predicate list (which Prisma would read as "no condition")', () => {
    expect(batchedIn('riderId', [])).toEqual([{ riderId: { in: [] } }]);
    expect(batched([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
});
