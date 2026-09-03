import { describe, it, expect } from 'vitest';
import { OrderStatus } from '@prisma/client';
import { ORDER_TRANSITIONS } from '../modules/order/order.service';
import { hasTaxiPassengerCustody } from '../modules/rides/passenger-custody';
import {
  TERMINAL_ORDER_STATUSES,
  LIVE_ORDER_STATUSES,
  RIDER_PRE_CUSTODY_STATUSES,
  DRIVER_PRE_CUSTODY_STATUSES,
  RIDER_IN_CUSTODY_STATUSES,
  MOVER_HOLDING_STATUSES,
  custodyOf,
  isPreCustody,
  isMoverHolding,
  isTerminalOrderStatus,
} from '../modules/order/order-status';

// ---------------------------------------------------------------------------
// CUSTODY — "has the mover taken the goods/passenger yet?" — used to be nine
// hand-written lists under five names. They are now derived from one classified
// Record. These tests grade the two things a Record alone cannot:
//
//   1. THE CLASSIFICATION IS THE ONE PRODUCTION ALREADY HAD. Every derived set
//      is pinned to the literal the copies carried, so the unification cannot
//      have quietly reclassified a state. Reclassifying PICKED_UP would let an
//      automatic release take goods off a rider who has already fronted the
//      vendor's cash — the exact accident the sets exist to prevent.
//
//   2. CUSTODY AND THE TRANSITION TABLE AGREE. They are two separate laws that
//      have to describe one machine. A state a mover is holding must not be
//      cancellable; a state a mover is merely assigned to must be. Nothing
//      checked that before, and the two could drift apart silently.
// ---------------------------------------------------------------------------

const ALL = Object.keys(OrderStatus) as OrderStatus[];

describe('order custody — one classification, pinned', () => {
  it('classifies every OrderStatus the database defines — a new enum value cannot slip through unclassified', () => {
    // The Record makes this a compile error too; this catches an enum value
    // added to the schema without regenerating expectations here.
    for (const s of ALL) {
      expect(['UNASSIGNED', 'ASSIGNED_NOT_HOLDING', 'MOVER_HOLDING', 'FINISHED']).toContain(custodyOf(s));
    }
    expect(ALL).toHaveLength(19);
  });

  it('the four custody classes partition the statuses — no state in two, none in none', () => {
    const buckets = {
      UNASSIGNED: ALL.filter((s) => custodyOf(s) === 'UNASSIGNED'),
      ASSIGNED_NOT_HOLDING: ALL.filter((s) => custodyOf(s) === 'ASSIGNED_NOT_HOLDING'),
      MOVER_HOLDING: ALL.filter((s) => custodyOf(s) === 'MOVER_HOLDING'),
      FINISHED: ALL.filter((s) => custodyOf(s) === 'FINISHED'),
    };
    const total = Object.values(buckets).reduce((n, b) => n + b.length, 0);
    expect(total).toBe(ALL.length);
    expect(new Set(Object.values(buckets).flat()).size).toBe(ALL.length);
  });

  it('the DELIVERY pre-custody set is exactly what mover-authority, rider.routes, the watchdog and the agent each declared', () => {
    expect([...RIDER_PRE_CUSTODY_STATUSES].sort()).toEqual(
      ['RIDER_ARRIVED_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP'],
    );
  });

  it('the TAXI pre-custody set is exactly what mover-authority, driver.routes, dispatch and liveness each declared', () => {
    expect([...DRIVER_PRE_CUSTODY_STATUSES].sort()).toEqual(
      ['DRIVER_ARRIVED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE'],
    );
  });

  it('the DELIVERY in-custody set is exactly what rider.routes and the watchdog declared', () => {
    expect([...RIDER_IN_CUSTODY_STATUSES].sort()).toEqual(['ARRIVED', 'EN_ROUTE_DELIVERY', 'PICKED_UP']);
  });

  it('mover-holding spans both legs and is order.service’s IN_TRANSIT set', () => {
    expect([...MOVER_HOLDING_STATUSES].sort()).toEqual(
      ['ARRIVED', 'EN_ROUTE_DELIVERY', 'PICKED_UP', 'RIDE_IN_PROGRESS'],
    );
  });

  it('the two legs are mirrored and disjoint — a state belongs to one mover role', () => {
    expect(RIDER_PRE_CUSTODY_STATUSES).toHaveLength(DRIVER_PRE_CUSTODY_STATUSES.length);
    const overlap = RIDER_PRE_CUSTODY_STATUSES.filter((s) => DRIVER_PRE_CUSTODY_STATUSES.includes(s));
    expect(overlap).toEqual([]);
  });

  it('pre-custody and holding are mutually exclusive — the predicates cannot both be true', () => {
    for (const s of ALL) {
      expect(isPreCustody(s) && isMoverHolding(s)).toBe(false);
    }
  });
});

describe('order custody — terminality is derived from it, not declared twice', () => {
  it('terminal is exactly the FINISHED class, and exactly the five known end states', () => {
    expect([...TERMINAL_ORDER_STATUSES].sort()).toEqual(
      ['CANCELLED', 'COMPLETED', 'DELIVERED', 'FAILED', 'REFUNDED'],
    );
    expect([...TERMINAL_ORDER_STATUSES].sort()).toEqual(
      ALL.filter((s) => custodyOf(s) === 'FINISHED').sort(),
    );
  });

  it('live is the exact complement — every status is terminal or live, never both, never neither', () => {
    expect([...TERMINAL_ORDER_STATUSES, ...LIVE_ORDER_STATUSES].sort()).toEqual([...ALL].sort());
    expect(TERMINAL_ORDER_STATUSES.filter((s) => LIVE_ORDER_STATUSES.includes(s))).toEqual([]);
  });

  it('no live status is FINISHED and no terminal status has a custody holder', () => {
    for (const s of ALL) {
      expect(isTerminalOrderStatus(s)).toBe(custodyOf(s) === 'FINISHED');
      if (isTerminalOrderStatus(s)) expect(isMoverHolding(s)).toBe(false);
    }
  });
});

describe('order custody × ORDER_TRANSITIONS — two laws, one machine', () => {
  it('an order the mover is HOLDING can never be cancelled — the goods are in a bag or the passenger is in the car', () => {
    for (const s of MOVER_HOLDING_STATUSES) {
      expect(ORDER_TRANSITIONS.CANCELLED).not.toContain(s);
    }
  });

  it('an order a mover is only ASSIGNED to must always be cancellable — otherwise it strands with a mover nobody can release', () => {
    for (const s of [...RIDER_PRE_CUSTODY_STATUSES, ...DRIVER_PRE_CUSTODY_STATUSES]) {
      expect(ORDER_TRANSITIONS.CANCELLED).toContain(s);
    }
  });

  it('every state a mover is holding still has a way to finish — DELIVERED or FAILED', () => {
    for (const s of MOVER_HOLDING_STATUSES) {
      const exits = (Object.keys(ORDER_TRANSITIONS) as OrderStatus[])
        .filter((t) => ORDER_TRANSITIONS[t].includes(s));
      expect(exits.some((t) => isTerminalOrderStatus(t))).toBe(true);
    }
  });

  it('no terminal state is a predecessor of a live one — an order that ended cannot come back to life', () => {
    for (const target of Object.keys(ORDER_TRANSITIONS) as OrderStatus[]) {
      if (isTerminalOrderStatus(target)) continue;
      for (const from of ORDER_TRANSITIONS[target]) {
        expect(isTerminalOrderStatus(from)).toBe(false);
      }
    }
  });
});

describe('order custody × the taxi custody predicate — the passenger is aboard, said twice', () => {
  // `hasTaxiPassengerCustody` is the canonical taxi answer and names
  // RIDE_IN_PROGRESS directly, because it also accepts durable PIN evidence
  // that no status can express. It is deliberately NOT rewritten in terms of
  // this classification — a safety predicate that fails closed should not
  // acquire a dependency for tidiness. But the two do have to agree, and
  // nothing made them: a taxi state added as MOVER_HOLDING and forgotten in
  // the predicate would read as "passenger not aboard" to every release path.
  it('every taxi state classified as MOVER_HOLDING is passenger-custody to the predicate', () => {
    const taxiHolding = MOVER_HOLDING_STATUSES.filter((s) => s.startsWith('RIDE_') || s.startsWith('DRIVER_'));
    expect(taxiHolding.length).toBeGreaterThan(0);
    for (const status of taxiHolding) {
      expect(hasTaxiPassengerCustody({ status, ridePinVerified: false, ridePinVerifiedAt: null })).toBe(true);
    }
  });

  it('no taxi state classified as pre-custody is passenger-custody without PIN evidence', () => {
    for (const status of DRIVER_PRE_CUSTODY_STATUSES) {
      expect(hasTaxiPassengerCustody({ status, ridePinVerified: false, ridePinVerifiedAt: null })).toBe(false);
    }
  });
});
