import { describe, it, expect } from 'vitest';
import {
  noShowDecision,
  isNoShowEligible,
  evidenceStrength,
  NO_SHOW_GRACE_MIN,
  NO_SHOW_EVIDENCE_MAX_M,
  NO_SHOW_EVIDENCE_MAX_AGE_MS,
} from '../modules/order/cancel-policy';

// ---------------------------------------------------------------------------
// [AF-MOB-001] A customer can be struck and put on a money claim by one tap.
//
// Today `no_show` writes FAILED + Strike + ReimbursementClaim in one
// transaction with nothing in between. These tests hold the two things that
// were missing: a grace window, and evidence that decides whether the CUSTOMER
// is punished — never whether the mover is paid.
// ---------------------------------------------------------------------------

const T0 = new Date('2026-09-03T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const GRACE = NO_SHOW_GRACE_MIN * MIN;
const GOOD = { metres: 30, ageMs: 20_000 };

describe('[AF-MOB-001] the grace window', () => {
  it('a no-show in the same second as arriving is refused — the reported bug', () => {
    const d = noShowDecision({ arrivedAt: T0, fix: GOOD }, T0);
    expect(d.allowed).toBe(false);
    expect(d).toMatchObject({ reason: 'TOO_EARLY' });
  });

  it('tells the mover when they may try again, rather than just saying no', () => {
    const d = noShowDecision({ arrivedAt: T0, fix: GOOD }, at(MIN));
    expect(d).toMatchObject({ allowed: false, reason: 'TOO_EARLY', waitedMs: MIN });
    if (d.allowed === false && d.reason === 'TOO_EARLY') {
      expect(d.retryAt.toISOString()).toBe(at(GRACE).toISOString());
    }
  });

  it('opens exactly at the grace boundary, not a second before', () => {
    expect(isNoShowEligible({ arrivedAt: T0, fix: GOOD }, at(GRACE - 1))).toBe(false);
    expect(isNoShowEligible({ arrivedAt: T0, fix: GOOD }, at(GRACE))).toBe(true);
  });

  it('a mover who never reported arriving cannot declare a no-show at all', () => {
    expect(noShowDecision({ arrivedAt: null, fix: GOOD }, at(GRACE * 10)))
      .toEqual({ allowed: false, reason: 'NOT_ARRIVED' });
  });
});

describe('[AF-MOB-001] evidence gates the CUSTOMER, never the mover', () => {
  // The asymmetry is the design: Band F says never refuse a money outcome
  // outright, so the job always closes once grace has passed. It is the strike
  // that waits for proof.
  it.each([
    ['no fix at all', { metres: null, ageMs: null }, 'ABSENT'],
    ['a fix with no measurable distance', { metres: null, ageMs: 10_000 }, 'ABSENT'],
    ['a stale fix', { metres: 10, ageMs: NO_SHOW_EVIDENCE_MAX_AGE_MS + 1 }, 'WEAK'],
    ['a fix from far away', { metres: NO_SHOW_EVIDENCE_MAX_M + 1, ageMs: 10_000 }, 'WEAK'],
  ])('%s still ends the job, but does NOT strike the customer', (_label, fix, strength) => {
    const d = noShowDecision({ arrivedAt: T0, fix }, at(GRACE));
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.strikeCustomer).toBe(false);
      expect(d.evidence).toBe(strength);
    }
  });

  it('good evidence after a real wait strikes, as it does today', () => {
    const d = noShowDecision({ arrivedAt: T0, fix: GOOD }, at(GRACE));
    expect(d).toMatchObject({ allowed: true, strikeCustomer: true, evidence: 'STRONG' });
  });

  it('ABSENT and WEAK are distinguished — a review queue needs the difference', () => {
    expect(evidenceStrength({ metres: null, ageMs: null })).toBe('ABSENT');
    expect(evidenceStrength({ metres: 900, ageMs: 1_000 })).toBe('WEAK');
  });

  it('the distance boundary is inclusive, and one metre past it is weak', () => {
    expect(evidenceStrength({ metres: NO_SHOW_EVIDENCE_MAX_M, ageMs: 1_000 })).toBe('STRONG');
    expect(evidenceStrength({ metres: NO_SHOW_EVIDENCE_MAX_M + 1, ageMs: 1_000 })).toBe('WEAK');
  });

  it('the staleness boundary is inclusive, and one ms past it is weak', () => {
    expect(evidenceStrength({ metres: 10, ageMs: NO_SHOW_EVIDENCE_MAX_AGE_MS })).toBe('STRONG');
    expect(evidenceStrength({ metres: 10, ageMs: NO_SHOW_EVIDENCE_MAX_AGE_MS + 1 })).toBe('WEAK');
  });

  // Staleness must beat proximity: a fix taken an hour ago that happens to sit
  // on the doorstep says where the rider WAS, not where they are.
  it('a stale fix is weak even when the distance looks perfect', () => {
    expect(evidenceStrength({ metres: 0, ageMs: NO_SHOW_EVIDENCE_MAX_AGE_MS + 1 })).toBe('WEAK');
  });
});
