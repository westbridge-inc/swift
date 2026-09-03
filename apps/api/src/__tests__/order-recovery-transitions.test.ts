import { describe, it, expect } from 'vitest';
import { OrderStatus } from '@prisma/client';
import {
  ORDER_TRANSITIONS,
  RECOVERY_TRANSITIONS,
  RIDER_PRE_CUSTODY_STATUSES,
  DRIVER_PRE_CUSTODY_STATUSES,
  MOVER_HOLDING_STATUSES,
  isRecoveryTransition,
  assertRecoveryTransition,
  UndeclaredRecoveryError,
  releaseStageFor,
  isTerminalOrderStatus,
  custodyOf,
} from '../modules/order/order-status';

// ---------------------------------------------------------------------------
// A RELEASE runs the state machine BACKWARDS: a mover was assigned and then had
// to be dropped — they went dark, their session was revoked, they handed the
// job back, a passenger said "this isn't my driver" — so the order returns to
// the stage it was at before anyone was assigned.
//
// The forward table declared all twelve of those edges IMPOSSIBLE, and said so
// in a comment that was simply false: PENDING was documented as "entry state —
// never transitioned into" while four live paths transition orders into it.
//
// Recovery is now declared. These tests grade the two things that matter: that
// the declaration matches what the release code can actually PRODUCE, and that
// it can never reach an order somebody is holding.
// ---------------------------------------------------------------------------

const ALL = Object.keys(OrderStatus) as OrderStatus[];

/** Every shape of order a delivery release can be handed. */
const ORDER_SHAPES = (['FOOD_DELIVERY', 'GROCERY_DELIVERY', 'COURIER', null] as const).flatMap((orderType) =>
  [null, new Date()].flatMap((readyAt) =>
    [null, new Date()].map((preparingAt) => ({ orderType, readyAt, preparingAt })),
  ),
);

describe('recovery transitions — declared, and matching what a release can produce', () => {
  it('every stage a DELIVERY release can produce, from every pre-custody state, is a declared edge', () => {
    let checked = 0;
    for (const shape of ORDER_SHAPES) {
      const stage = releaseStageFor(shape);
      for (const from of RIDER_PRE_CUSTODY_STATUSES) {
        expect(isRecoveryTransition(from, stage), `${from} -> ${stage} (${shape.orderType})`).toBe(true);
        checked += 1;
      }
    }
    // The loop must have actually run — an empty matrix would pass vacuously.
    expect(checked).toBe(ORDER_SHAPES.length * RIDER_PRE_CUSTODY_STATUSES.length);
    expect(checked).toBeGreaterThan(30);
  });

  it('the TAXI release — four paths, all returning a ride to PENDING — is declared', () => {
    for (const from of DRIVER_PRE_CUSTODY_STATUSES) {
      expect(isRecoveryTransition(from, 'PENDING')).toBe(true);
    }
  });

  it('PENDING has no FORWARD predecessor but IS recoverable — the comment that used to be false', () => {
    expect(ORDER_TRANSITIONS.PENDING).toEqual([]);
    expect(RECOVERY_TRANSITIONS.PENDING.length).toBeGreaterThan(0);
  });

  it('no recovery edge starts from an order somebody is HOLDING', () => {
    for (const to of ALL) {
      for (const from of RECOVERY_TRANSITIONS[to]) {
        expect(MOVER_HOLDING_STATUSES, `${from} -> ${to}`).not.toContain(from);
      }
    }
  });

  it('every recovery SOURCE is a pre-custody state — a release only ever un-assigns', () => {
    for (const to of ALL) {
      for (const from of RECOVERY_TRANSITIONS[to]) {
        expect(custodyOf(from), `${from} -> ${to}`).toBe('ASSIGNED_NOT_HOLDING');
      }
    }
  });

  it('no recovery edge lands on a terminal state, or on one a mover is holding', () => {
    for (const to of ALL) {
      if (RECOVERY_TRANSITIONS[to].length === 0) continue;
      expect(isTerminalOrderStatus(to), to).toBe(false);
      expect(MOVER_HOLDING_STATUSES, to).not.toContain(to);
    }
  });

  it('recovery and forward are different authorities — no edge is declared in both', () => {
    const both: string[] = [];
    for (const to of ALL) {
      for (const from of RECOVERY_TRANSITIONS[to]) {
        if (ORDER_TRANSITIONS[to].includes(from)) both.push(`${from} -> ${to}`);
      }
    }
    expect(both).toEqual([]);
  });

  it('no recovery target is declared that no release can produce — no dead entries', () => {
    const producible = new Set<OrderStatus>(['PENDING']);
    for (const shape of ORDER_SHAPES) producible.add(releaseStageFor(shape));
    for (const to of ALL) {
      if (RECOVERY_TRANSITIONS[to].length > 0) expect([...producible], to).toContain(to);
    }
  });
});

describe('the release kernel guards its own precondition', () => {
  it('refuses an order the rider is already holding — the case caller discipline used to cover', () => {
    for (const from of MOVER_HOLDING_STATUSES) {
      expect(() => assertRecoveryTransition(from, 'READY_FOR_PICKUP')).toThrow(UndeclaredRecoveryError);
    }
  });

  it('refuses a terminal order', () => {
    expect(() => assertRecoveryTransition('DELIVERED', 'ACCEPTED')).toThrow(UndeclaredRecoveryError);
    expect(() => assertRecoveryTransition('CANCELLED', 'PENDING')).toThrow(UndeclaredRecoveryError);
  });

  it('allows exactly the declared edges', () => {
    for (const from of RIDER_PRE_CUSTODY_STATUSES) {
      expect(() => assertRecoveryTransition(from, 'READY_FOR_PICKUP')).not.toThrow();
    }
    for (const from of DRIVER_PRE_CUSTODY_STATUSES) {
      expect(() => assertRecoveryTransition(from, 'PENDING')).not.toThrow();
    }
    // Crossed legs are not edges: a taxi never returns to a kitchen stage.
    for (const from of DRIVER_PRE_CUSTODY_STATUSES) {
      expect(() => assertRecoveryTransition(from, 'READY_FOR_PICKUP')).toThrow(UndeclaredRecoveryError);
    }
  });

  it('the error names both ends, so a stack trace says which edge was missing', () => {
    expect(() => assertRecoveryTransition('PICKED_UP', 'ACCEPTED'))
      .toThrow(/PICKED_UP to ACCEPTED/);
  });
});

describe('releaseStageFor — one answer, and it knows what a courier is', () => {
  it('a courier parcel is READY at creation: it never re-opens to a kitchen stage it has no kitchen for', () => {
    expect(releaseStageFor({ orderType: 'COURIER', readyAt: null, preparingAt: null })).toBe('READY_FOR_PICKUP');
    // This is the case the two old copies disagreed on. The kernel returned
    // ACCEPTED, and a COURIER order at ACCEPTED reads to the customer as
    // "Rider found" — while the rider had just been taken away.
    expect(releaseStageFor({ orderType: 'COURIER', readyAt: null, preparingAt: new Date() })).toBe('READY_FOR_PICKUP');
  });

  it('a store order keeps its furthest milestone — a release never rewinds the kitchen', () => {
    expect(releaseStageFor({ orderType: 'FOOD_DELIVERY', readyAt: new Date(), preparingAt: new Date() })).toBe('READY_FOR_PICKUP');
    expect(releaseStageFor({ orderType: 'FOOD_DELIVERY', readyAt: null, preparingAt: new Date() })).toBe('PREPARING');
    expect(releaseStageFor({ orderType: 'FOOD_DELIVERY', readyAt: null, preparingAt: null })).toBe('ACCEPTED');
  });

  it('never claims an unfinished order is ready', () => {
    for (const orderType of ['FOOD_DELIVERY', 'GROCERY_DELIVERY']) {
      expect(releaseStageFor({ orderType, readyAt: null, preparingAt: null })).not.toBe('READY_FOR_PICKUP');
    }
  });
});
