import { describe, it, expect } from 'vitest';
import { handoverAuthorityFor, handoverVersionFor, handoverVersionMatches, paymentRailOf, HANDOVER_POLICY } from '../modules/order/handover-authority';

// [MOB-023] The door's authority as a pure table: every rail × every payment state.
const base = { id: 'o1', status: 'ARRIVED', totalAmount: '1250.00', currencyCode: 'GYD', updatedAt: new Date('2026-09-02T10:00:00.000Z'), mmgClaimMismatchAt: null };
const STATES = ['PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'UNKNOWN', 'EXPIRED'];

describe('[MOB-023] handoverAuthorityFor', () => {
  it('only CAPTURED opens the no-cash door; cash collects; every other non-cash state is BLOCKED with its reason', () => {
    for (const paymentStatus of STATES) {
      const mmg = handoverAuthorityFor({ ...base, paymentMethod: 'MOBILE_MONEY', paymentStatus });
      const cash = handoverAuthorityFor({ ...base, paymentMethod: 'CASH', paymentStatus });
      if (paymentStatus === 'CAPTURED') {
        expect(mmg.permitted, paymentStatus).toBe('DELIVER_NO_CASH');
        expect(cash.permitted, paymentStatus).toBe('DELIVER_NO_CASH');
      } else {
        expect(mmg, paymentStatus).toMatchObject({ permitted: 'BLOCKED', blockReason: `MOBILE_MONEY_${paymentStatus}` });
        expect(cash, paymentStatus).toMatchObject({ permitted: 'COLLECT_CASH_THEN_DELIVER', blockReason: null });
      }
      expect(mmg).toMatchObject({ rail: 'MOBILE_MONEY', paymentState: paymentStatus, custodyState: 'ARRIVED', amount: 1250, currency: 'GYD' });
    }
    expect(paymentRailOf('CARD')).toBe('OTHER');
    expect(handoverAuthorityFor({ ...base, paymentMethod: 'CARD', paymentStatus: 'PENDING' })).toMatchObject({ permitted: 'BLOCKED', blockReason: 'OTHER_PENDING' });
  });

  it('the version changes with the custody state, the payment state and the last write, and never with anything else', () => {
    const a = handoverVersionFor({ ...base, paymentStatus: 'PENDING' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(handoverVersionFor({ ...base, paymentStatus: 'PENDING' })).toBe(a);
    expect(handoverVersionFor({ ...base, paymentStatus: 'CAPTURED' })).not.toBe(a);
    expect(handoverVersionFor({ ...base, status: 'EN_ROUTE_DELIVERY', paymentStatus: 'PENDING' })).not.toBe(a);
    expect(handoverVersionFor({ ...base, paymentStatus: 'PENDING', updatedAt: new Date('2026-09-02T10:00:01.000Z') })).not.toBe(a);
    expect(handoverVersionFor({ ...base, id: 'o2', paymentStatus: 'PENDING' })).not.toBe(a);
  });

  it('a missing echo is tolerated (an older client); a wrong one is not', () => {
    const order = { ...base, paymentStatus: 'CAPTURED' };
    expect(handoverVersionMatches(order, undefined)).toBe(true);
    expect(handoverVersionMatches(order, null)).toBe(true);
    expect(handoverVersionMatches(order, handoverVersionFor(order))).toBe(true);
    expect(handoverVersionMatches(order, 'deadbeefdeadbeef')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [DOC-INV-48 · F-103-01] THE DOOR OPENED ON A DISPUTED PAYMENT.
//
// Codex executed the real `handoverAuthorityFor` against a MOBILE_MONEY +
// CLAIMED + disputed order and captured the server's answer:
//
//   HANDOVER {"mismatchPresent":true,"authority":{...,"permitted":"DELIVER_NO_CASH","blockReason":null}}
//
// The server told the person standing at the customer's door to hand the goods
// over on a payment the customer says never happened. The canonical status
// write refuses afterwards — which is worth nothing, because software cannot
// un-hand food already given to someone.
//
// The mismatch is now read BEFORE the CLAIMED branch, and it is in the door's
// version, so a screen loaded before the dispute committed is refused on its
// own terms rather than on a timestamp that might not have moved.
// ---------------------------------------------------------------------------

const DISPUTED = new Date('2026-09-02T10:05:00.000Z');

describe('[F-103-01] a disputed MMG claim closes the door', () => {
  it('CLAIMED + disputed is BLOCKED, not DELIVER_NO_CASH — Codex’s exact counterexample', () => {
    const disputed = handoverAuthorityFor({ ...base, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgClaimMismatchAt: DISPUTED });
    expect(disputed.permitted).toBe('BLOCKED');
    expect(disputed.blockReason).toBe('MMG_CLAIM_MISMATCH');
  });

  it('the dispute outranks CAPTURED too — provider evidence does not settle a disagreement about it', () => {
    const disputed = handoverAuthorityFor({ ...base, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', mmgClaimMismatchAt: DISPUTED });
    expect(disputed.permitted).toBe('BLOCKED');
    expect(disputed.blockReason).toBe('MMG_CLAIM_MISMATCH');
  });

  it('an undisputed CLAIMED order still opens — the fix blocks disputes, not the rail', () => {
    expect(handoverAuthorityFor({ ...base, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgClaimMismatchAt: null }).permitted).toBe('DELIVER_NO_CASH');
  });

  it('a projection that forgot the column fails CLOSED and says so', () => {
    // The required field makes this a build error; this is the runtime's own
    // answer if one ever arrives through an `as never` or a JSON boundary.
    const forgotten = handoverAuthorityFor({ ...base, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgClaimMismatchAt: undefined as never });
    expect(forgotten.permitted).toBe('BLOCKED');
    expect(forgotten.blockReason).toBe('MMG_MISMATCH_UNKNOWN');
  });

  it('a cash order is untouched by the dispute column', () => {
    expect(handoverAuthorityFor({ ...base, paymentMethod: 'CASH', paymentStatus: 'PENDING', mmgClaimMismatchAt: null }).permitted).toBe('COLLECT_CASH_THEN_DELIVER');
  });

  it('the version is bound to the dispute generation, not to updatedAt as a proxy', () => {
    const clean = handoverVersionFor({ ...base, paymentStatus: 'CLAIMED', mmgClaimMismatchAt: null });
    const disputed = handoverVersionFor({ ...base, paymentStatus: 'CLAIMED', mmgClaimMismatchAt: DISPUTED });
    const later = handoverVersionFor({ ...base, paymentStatus: 'CLAIMED', mmgClaimMismatchAt: new Date('2026-09-02T10:06:00.000Z') });
    // Same order, same status, same updatedAt — only the dispute differs.
    expect(disputed).not.toBe(clean);
    expect(later).not.toBe(disputed);
  });

  it('a screen loaded before the dispute is refused by its own echoed version', () => {
    const beforeDispute = { ...base, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgClaimMismatchAt: null };
    const echoed = handoverVersionFor(beforeDispute);
    // The dispute commits. `updatedAt` is deliberately left UNCHANGED here, so
    // this can only pass if the generation is genuinely in the digest.
    const afterDispute = { ...beforeDispute, mmgClaimMismatchAt: DISPUTED };
    expect(handoverVersionMatches(afterDispute, echoed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [F-106-04] THE MISMATCH BRANCH WAS NOT RAIL-SCOPED.
//
// Codex ran it: a CASH order carrying a mismatch marker was refused with
// blockReason MMG_CLAIM_MISMATCH — a customer MMG dispute, on an order that
// has no MMG payment to dispute. The canonical fulfilment gate returns early
// for non-MMG orders (order.service.ts:241-243), so the two gates were saying
// different things about the same row, and the rider was being told a story
// they could not act on.
//
// A marker on a rail that cannot carry one is a CORRUPT state. Still refused —
// never hand over on a payment row that makes no sense — but named as what it
// is, and an UNPROJECTED column must not close a cash door that never depended
// on it.
// ---------------------------------------------------------------------------
describe('[F-106-04] the dispute reason belongs to the rail that can have one', () => {
  for (const paymentMethod of ['CASH', 'CARD'] as const) {
    it(`${paymentMethod}: a present marker is an inconsistent state, not a customer dispute`, () => {
      const a = handoverAuthorityFor({ ...base, paymentMethod, paymentStatus: 'PENDING', mmgClaimMismatchAt: DISPUTED });
      expect(a.permitted, 'still refused — the row makes no sense').toBe('BLOCKED');
      expect(a.blockReason).toBe('PAYMENT_STATE_INCONSISTENT');
    });

    it(`${paymentMethod}: an UNPROJECTED column does not close a door that never used it`, () => {
      const a = handoverAuthorityFor({ ...base, paymentMethod, paymentStatus: 'PENDING', mmgClaimMismatchAt: undefined as never });
      expect(a.permitted).toBe(paymentMethod === 'CASH' ? 'COLLECT_CASH_THEN_DELIVER' : 'BLOCKED');
      if (paymentMethod === 'CASH') expect(a.blockReason).toBeNull();
    });

    it(`${paymentMethod}: a null marker leaves the rail's own CLAIMED rule to decide`, () => {
      // Changed deliberately. This asserted 'CLAIMED is money landed on any
      // rail' — which is not what CLAIMED means: schema.prisma and DOC-1 §31.5
      // define it as the store's attestation about its own MOBILE-MONEY wallet.
      // On a cash rail it is a corrupt row, and the server was answering
      // DELIVER_NO_CASH for it while this change's own client blocked it.
      // This loop covers the non-MMG rails only.
      const a = handoverAuthorityFor({ ...base, paymentMethod, paymentStatus: 'CLAIMED', mmgClaimMismatchAt: null });
      expect(a.permitted, 'CLAIMED on a non-MMG rail is a state that should not exist').toBe('BLOCKED');
      expect(a.blockReason).toBe('PAYMENT_STATE_INCONSISTENT');
    });

    it(`${paymentMethod}: the MMG rail still opens on its own CLAIMED`, () => {
      // The other half of the rail-scoping, asserted once alongside it so the
      // change reads as a scoping and not as "CLAIMED stopped working".
      const a = handoverAuthorityFor({ ...base, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgClaimMismatchAt: null });
      expect(a.permitted).toBe('DELIVER_NO_CASH');
      expect(a.blockReason).toBeNull();
    });
  }

  it('MMG keeps its own reasons', () => {
    expect(handoverAuthorityFor({ ...base, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgClaimMismatchAt: DISPUTED }).blockReason).toBe('MMG_CLAIM_MISMATCH');
    expect(handoverAuthorityFor({ ...base, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgClaimMismatchAt: undefined as never }).blockReason).toBe('MMG_MISMATCH_UNKNOWN');
  });
});

describe('[F-106-01] the authority names the policy that produced it', () => {
  it('every answer carries the current policy, so a client can refuse an older one', () => {
    for (const paymentStatus of ['PENDING', 'CLAIMED', 'CAPTURED']) {
      for (const paymentMethod of ['CASH', 'MOBILE_MONEY', 'CARD']) {
        expect(handoverAuthorityFor({ ...base, paymentMethod, paymentStatus, mmgClaimMismatchAt: null }).policy).toBe(HANDOVER_POLICY);
      }
    }
    expect(handoverAuthorityFor({ ...base, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgClaimMismatchAt: DISPUTED }).policy).toBe(HANDOVER_POLICY);
  });
});
