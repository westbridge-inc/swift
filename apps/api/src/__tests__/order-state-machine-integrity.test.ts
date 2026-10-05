import { describe, it, expect } from 'vitest';
import { ORDER_TRANSITIONS } from '../modules/order/order.service';
import { TaxiStopStatus, type OrderStatus } from '@prisma/client';
import {
  MOVER_HOLDING_STATUSES,
  TAXI_STOP_LAW,
  TAXI_STOP_PARENT_STATUS,
  TAXI_STOP_TRANSITIONS,
  custodyOf,
  isTaxiStopTransition,
  isTerminalOrderStatus,
} from '../modules/order/order-status';

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

// [TAXI multi-stop] A stop's own machine, in ORDER_TRANSITIONS' convention
// (key = target, value = the states it may be entered from). A stop is born
// PENDING; the driver arrives, then departs; or skips it, before arriving or
// after waiting. Nothing leaves DEPARTED or SKIPPED: a resolved stop is never
// re-opened, and the itinerary is frozen at request (the plan's ruling).
describe('[TAXI multi-stop] TAXI_STOP_TRANSITIONS — the stop machine is well-formed', () => {
  const STOPS = Object.values(TaxiStopStatus) as TaxiStopStatus[];
  const stopPreds = (s: TaxiStopStatus): readonly TaxiStopStatus[] => TAXI_STOP_TRANSITIONS[s];

  it('the edges are exactly arrive, depart, and skip (before arriving or after)', () => {
    expect(TAXI_STOP_TRANSITIONS).toEqual({
      PENDING: [],
      ARRIVED: ['PENDING'],
      DEPARTED: ['ARRIVED'],
      SKIPPED: ['PENDING', 'ARRIVED'],
    });
  });

  it('PENDING is the sole entry; every other stop state has a predecessor', () => {
    expect(stopPreds('PENDING')).toEqual([]);
    for (const s of STOPS.filter((x) => x !== 'PENDING')) {
      expect(stopPreds(s).length, `${s} is unreachable — no predecessors`).toBeGreaterThan(0);
    }
  });

  it('every predecessor is a stop state, and none is its own predecessor', () => {
    for (const s of STOPS) {
      for (const p of stopPreds(s)) expect(STOPS, `${s} names an unknown predecessor "${p}"`).toContain(p);
      expect(stopPreds(s), `${s} lists itself as a predecessor`).not.toContain(s);
    }
  });

  it('every stop state is reachable from PENDING', () => {
    const seen = new Set<TaxiStopStatus>(['PENDING']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of STOPS) {
        if (!seen.has(s) && stopPreds(s).some((p) => seen.has(p))) { seen.add(s); grew = true; }
      }
    }
    expect([...seen].sort()).toEqual([...STOPS].sort());
  });

  it('a RESOLVED stop is never a predecessor: DEPARTED and SKIPPED are final for the stop', () => {
    for (const s of STOPS) {
      for (const p of stopPreds(s)) expect(TAXI_STOP_LAW[p], `${p} → ${s} re-opens a resolved stop`).toBe('OPEN');
    }
  });

  it('every OPEN stop can still be resolved: no open state is a dead end', () => {
    for (const open of STOPS.filter((s) => TAXI_STOP_LAW[s] === 'OPEN')) {
      const exits = STOPS.filter((t) => stopPreds(t).includes(open));
      expect(exits.some((t) => TAXI_STOP_LAW[t] === 'RESOLVED'), `${open} has no way to be resolved`).toBe(true);
    }
  });

  it('the predicate agrees with the table for every pair', () => {
    for (const from of STOPS) {
      for (const to of STOPS) expect(isTaxiStopTransition(from, to)).toBe(stopPreds(to).includes(from));
    }
  });

  it('stops live INSIDE the ride: the parent is the taxi state with the passenger aboard, and every way out of it ends the ride', () => {
    expect(TAXI_STOP_PARENT_STATUS).toBe('RIDE_IN_PROGRESS');
    expect(custodyOf(TAXI_STOP_PARENT_STATUS)).toBe('MOVER_HOLDING');
    expect(MOVER_HOLDING_STATUSES).toContain(TAXI_STOP_PARENT_STATUS);
    // So an open stop cannot outlive its parent status: once the ride leaves
    // RIDE_IN_PROGRESS it is over, and the stops must be resolved before that.
    const exits = (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter((t) => ORDER_TRANSITIONS[t].includes(TAXI_STOP_PARENT_STATUS));
    expect(exits.length).toBeGreaterThan(0);
    expect(exits.filter((t) => !isTerminalOrderStatus(t))).toEqual([]);
  });
});
