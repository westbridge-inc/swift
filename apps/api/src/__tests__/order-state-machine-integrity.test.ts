import { describe, it, expect } from 'vitest';
import { ORDER_TRANSITIONS } from '../modules/order/order.service';
import type { OrderStatus } from '@prisma/client';

// FUL (fulfillment prompt Part 3): "the table is generated into a test suite
// that asserts every legal transition works and every illegal one is refused."
// ORDER_TRANSITIONS[X] = the states X can be entered FROM. These assert the
// GRAPH is well-formed — one entry, no orphans, no typos, no self-loops, every
// state reachable, and the canonical delivery + taxi lifecycles legal end to
// end. Corrupting the table (a typo'd predecessor, an unreachable state, a
// broken chain) fails here instead of stranding a real order.

const STATES = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];
const preds = (s: OrderStatus): OrderStatus[] => ORDER_TRANSITIONS[s];

describe('ORDER_TRANSITIONS — state-machine integrity (fulfillment Part 3)', () => {
  it('PENDING is the sole entry (no predecessors); every other state has ≥1 (no orphans)', () => {
    expect(preds('PENDING')).toEqual([]);
    for (const s of STATES) {
      if (s === 'PENDING') continue;
      expect(preds(s).length, `${s} is unreachable — no predecessors`).toBeGreaterThan(0);
    }
  });

  it('every predecessor is a defined state — no typos / dangling references', () => {
    const known = new Set<OrderStatus>(STATES);
    for (const s of STATES) {
      for (const p of preds(s)) {
        expect(known.has(p), `${s} names an unknown predecessor "${p}"`).toBe(true);
      }
    }
  });

  it('no state is its own predecessor (no self-loops)', () => {
    for (const s of STATES) {
      expect(preds(s), `${s} lists itself as a predecessor`).not.toContain(s);
    }
  });

  it('every state is reachable from PENDING through the forward graph (no dead islands)', () => {
    const succ = new Map<OrderStatus, OrderStatus[]>(STATES.map((s) => [s, []]));
    for (const s of STATES) for (const p of preds(s)) succ.get(p)!.push(s);
    const seen = new Set<OrderStatus>(['PENDING']);
    const queue: OrderStatus[] = ['PENDING'];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const n of succ.get(cur)!) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    for (const s of STATES) expect(seen.has(s), `${s} is not reachable from PENDING`).toBe(true);
  });

  it('the canonical DELIVERY lifecycle is legal end to end', () => {
    const chain: OrderStatus[] = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED'];
    for (let i = 1; i < chain.length; i++) {
      expect(preds(chain[i]!), `${chain[i - 1]} → ${chain[i]} must be legal`).toContain(chain[i - 1]!);
    }
  });

  it('the canonical TAXI lifecycle is legal end to end', () => {
    const chain: OrderStatus[] = ['PENDING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS', 'DELIVERED'];
    for (let i = 1; i < chain.length; i++) {
      expect(preds(chain[i]!), `${chain[i - 1]} → ${chain[i]} must be legal`).toContain(chain[i - 1]!);
    }
  });

  it('FAILED is reachable ONLY from the handover states — the door, and [M-29] the ride’s destination (SWIFT-096 — matches the handover guard)', () => {
    expect([...preds('FAILED')].sort()).toEqual(['ARRIVED', 'EN_ROUTE_DELIVERY', 'PICKED_UP', 'RIDE_IN_PROGRESS']); // [M-28] + a courier's parcel in custody
  });
});
