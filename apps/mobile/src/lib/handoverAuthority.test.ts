import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { doorCounters, doorFor, doorGuidanceFor, parseHandoverAuthority, recordDoorBlocked, recordDoorMismatch, resetDoorCountersForTests, DOOR_REFUSAL_CODES, HANDOVER_AUTHORITY_REQUIRED, HANDOVER_POLICY, type HandoverAuthority } from './handoverAuthority';

// ---------------------------------------------------------------------------
// [MOB-023] The door renders the SERVER's authority, never the payment
// method. Without an authority it derives the conservative answer: a
// mobile-money order is "already paid" only when its state is CAPTURED.
// ---------------------------------------------------------------------------

const authority = (over: Partial<HandoverAuthority> = {}): HandoverAuthority => ({
  policy: HANDOVER_POLICY, rail: 'MOBILE_MONEY', paymentState: 'CAPTURED', custodyState: 'ARRIVED', amount: 1250, currency: 'GYD', version: 'v-1', permitted: 'DELIVER_NO_CASH', blockReason: null, ...over,
});

beforeEach(() => resetDoorCountersForTests());

describe('the server’s authority is the door', () => {
  it('renders each permission as the door it is, with the version to echo', () => {
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', handover: authority() })).toEqual({ kind: 'no-cash', version: 'v-1', source: 'server' });
    expect(doorFor({ paymentMethod: 'CASH', paymentStatus: 'PENDING', handover: authority({ rail: 'CASH', paymentState: 'PENDING', permitted: 'COLLECT_CASH_THEN_DELIVER' }) })).toEqual({ kind: 'collect-cash', version: 'v-1', source: 'server' });
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', handover: authority({ paymentState: 'UNKNOWN', permitted: 'BLOCKED', blockReason: 'MOBILE_MONEY_UNKNOWN' }) }))
      .toEqual({ kind: 'blocked', reason: 'MOBILE_MONEY_UNKNOWN', version: 'v-1', source: 'server' });
  });
  it('the authority wins over the payload’s own method and state — the screen never second-guesses the server', () => {
    // method says MMG and state says CAPTURED, but the server says BLOCKED (a reversal the screen has not seen): blocked
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', handover: authority({ permitted: 'BLOCKED', blockReason: 'MOBILE_MONEY_REFUNDED' }) }).kind).toBe('blocked');
  });
  it('refuses a malformed authority and falls back to the derivation', () => {
    for (const bad of [null, undefined, 'paid', {}, { permitted: 'YES', version: 'v' }, { permitted: 'DELIVER_NO_CASH' }, { permitted: 'DELIVER_NO_CASH', version: 'v', rail: 'CARD' }, { permitted: 'DELIVER_NO_CASH', version: '', rail: 'CASH' }, { permitted: 'YES', version: 'v', rail: 'CASH' }, { permitted: 'deliver_no_cash', version: 'v', rail: 'CASH' }]) {
      expect(parseHandoverAuthority(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', handover: { permitted: 'YES' } as never })).toMatchObject({ kind: 'blocked', reason: HANDOVER_AUTHORITY_REQUIRED, source: 'derived' });
  });
});

describe('without an authority the derivation is conservative', () => {
  it('a mobile-money order is "already paid" ONLY when CAPTURED; every other state blocks; cash collects', () => {
    for (const state of ['PENDING', 'AUTHORIZED', 'FAILED', 'REFUNDED', 'UNKNOWN', 'EXPIRED', undefined, null]) {
      // [F-106-01] Every MMG state derives the SAME answer now: the client does
      // not hold the mismatch fact, so it does not get a vote.
      expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: state }), String(state)).toMatchObject({ kind: 'blocked', reason: HANDOVER_AUTHORITY_REQUIRED, version: null, source: 'derived' });
      expect(doorFor({ paymentMethod: 'CASH', paymentStatus: state }), String(state)).toMatchObject({ kind: 'collect-cash', source: 'derived' });
    }
    // [F-106-01] Codex's executed counterexample: this used to return no-cash.
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' })).toEqual({ kind: 'blocked', reason: HANDOVER_AUTHORITY_REQUIRED, version: null, source: 'derived' });
    // [DOC-INV-48 · F-103-01/F-106-01] CLAIMED alone NO LONGER opens the door here.
    // CAPTURED is provider evidence and this device may act on it. CLAIMED is
    // only the store's word about its own wallet, and whether the customer
    // disputes that word is a fact the device does not hold — it lives on the
    // order and reaches the screen ONLY through the server's authority. A
    // derivation that said "paid" from CLAIMED would independently reopen a
    // door the server had closed on a disputed payment.
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED' })).toEqual({ kind: 'blocked', reason: HANDOVER_AUTHORITY_REQUIRED, version: null, source: 'derived' });
    // The server's authority still opens it when the server says so.
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', handover: authority({ paymentState: 'CLAIMED' }) })).toEqual({ kind: 'no-cash', version: 'v-1', source: 'server' });
    // …and the server's BLOCKED on a disputed claim is what the screen renders.
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', handover: authority({ paymentState: 'CLAIMED', permitted: 'BLOCKED', blockReason: 'MMG_CLAIM_MISMATCH' }) }))
      .toEqual({ kind: 'blocked', reason: 'MMG_CLAIM_MISMATCH', version: 'v-1', source: 'server' });
    expect(doorFor({ paymentMethod: 'CASH', paymentStatus: 'CAPTURED' })).toEqual({ kind: 'no-cash', version: null, source: 'derived' });
    expect(doorFor(null)).toMatchObject({ kind: 'blocked', reason: 'UNKNOWN_RAIL_UNKNOWN' });
    expect(doorFor(undefined).kind).toBe('blocked');
  });
});

describe('the counters', () => {
  it('count block reasons and server/client mismatches, reasons only', () => {
    recordDoorBlocked('MOBILE_MONEY_UNKNOWN'); recordDoorBlocked('MOBILE_MONEY_UNKNOWN'); recordDoorMismatch('HANDOVER_STALE');
    expect(doorCounters()).toEqual({ blocked: { MOBILE_MONEY_UNKNOWN: 2 }, mismatch: { HANDOVER_STALE: 1 } });
  });
});

describe('the screen renders the door, not the method', () => {
  const SRC = readFileSync(new URL('../modules/mover/screens/ActiveJobScreen.tsx', import.meta.url), 'utf8');
  const STRIPPED = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  it('derives "already paid" from doorFor, never from paymentMethod alone; echoes the version; holds the button when blocked', () => {
    expect(STRIPPED).toContain("from '../../../lib/handoverAuthority'");
    expect(STRIPPED).toContain('const door = doorFor(job);');
    expect(STRIPPED).not.toMatch(/const isMmgPaid = job\?\.paymentMethod === 'MOBILE_MONEY';/);
    expect(STRIPPED).toContain("const isMmgPaid = door.kind === 'no-cash' && job?.paymentMethod === 'MOBILE_MONEY';");
    expect(STRIPPED).toContain("const doorBlocked = door.kind === 'blocked';");
    expect(STRIPPED).toContain('handoverVersion: door.version ?? undefined');
    // [F-106-03] The screen no longer carries its own sentence. It renders the
    // guidance for THIS reason, so the copy is asserted where it can be asserted
    // by behaviour (below) rather than by grepping a string out of a component.
    expect(STRIPPED).toContain('doorGuidanceFor(door.reason).headline');
    expect(STRIPPED, 'the old one-size-fits-all sentence is gone').not.toContain('Ask the store to confirm the payment, then refresh.');
    expect(STRIPPED, 'and a reason whose only way out is a person gets a way to reach one').toContain("navigation.navigate('GetHelp'");
    expect(STRIPPED).toMatch(/doorBlocked \? \(/);
  });
  it('a refused hand-over refetches the job and is counted — including the dispute codes', () => {
    expect(STRIPPED).toContain('DOOR_REFUSAL_CODES.has(code)');
    expect(STRIPPED).toContain('recordDoorMismatch(code);');
    // [F-106-03] The codes that were missing are the ones worth counting.
    for (const code of ['MMG_CLAIM_MISMATCH', 'MMG_MISMATCH_UNKNOWN', 'PAYMENT_STATE_INCONSISTENT', 'HANDOVER_STALE', 'PAYMENT_NOT_CAPTURED', 'MMG_PAYMENT_PENDING']) {
      expect(DOOR_REFUSAL_CODES.has(code), code).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// [DOC-INV-48 · F-106-01] Codex refuted my first fix by RUNNING this function:
//
//   missing   {"kind":"no-cash","version":null,"source":"derived"}
//   malformed {"kind":"no-cash","version":null,"source":"derived"}
//
// on `{ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' }`. I had
// closed only the CLAIMED fallback, reasoning that CAPTURED is provider
// evidence the device may act on. But the SERVER blocks CAPTURED + mismatch —
// provider evidence does not settle a disagreement about that evidence — so
// the client was opening exactly the door the server closed.
// ---------------------------------------------------------------------------
describe('[F-106-01] a mobile-money door is never derived without the server', () => {
  const CASES = [
    ['authority missing entirely', undefined],
    ['authority null', null],
    ['authority malformed', { permitted: 'BLOCKED' }],
    ['authority from an older policy', { policy: 'legacy-0', rail: 'MOBILE_MONEY', paymentState: 'CAPTURED', custodyState: 'ARRIVED', amount: 1, currency: 'GYD', version: 'v-old', permitted: 'DELIVER_NO_CASH', blockReason: null }],
  ] as const;

  for (const state of ['CAPTURED', 'CLAIMED'] as const) {
    for (const [label, handover] of CASES) {
      it(`${state} + ${label} stays SHUT`, () => {
        expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: state, handover: handover as never }))
          .toEqual({ kind: 'blocked', reason: HANDOVER_AUTHORITY_REQUIRED, version: null, source: 'derived' });
      });
    }
  }

  it('a VALID, current-policy authority still opens an undisputed MMG order', () => {
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', handover: authority({ paymentState: 'CAPTURED' }) }))
      .toEqual({ kind: 'no-cash', version: 'v-1', source: 'server' });
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', handover: authority({ paymentState: 'CLAIMED' }) }))
      .toEqual({ kind: 'no-cash', version: 'v-1', source: 'server' });
  });

  it('an authority whose policy this client does not know is not an authority at all', () => {
    expect(parseHandoverAuthority({ ...authority(), policy: 'something-else' })).toBeNull();
    expect(parseHandoverAuthority({ ...authority(), policy: undefined })).toBeNull();
    expect(parseHandoverAuthority(authority())).not.toBeNull();
  });

  it('other rails keep the old conservative derivation — this is an MMG rule', () => {
    expect(doorFor({ paymentMethod: 'CASH', paymentStatus: 'PENDING' })).toMatchObject({ kind: 'collect-cash', source: 'derived' });
    expect(doorFor({ paymentMethod: 'CASH', paymentStatus: 'CAPTURED' })).toMatchObject({ kind: 'no-cash', source: 'derived' });
  });
});

describe('[F-106-03] the rider is told what is true, and given a way out that works', () => {
  it('a dispute cannot be refreshed away, so it does not offer refreshing', () => {
    const g = doorGuidanceFor('MMG_CLAIM_MISMATCH');
    expect(g.action, 'only a person clears a dispute').toBe('support');
    expect(g.headline).toContain('dispute');
    expect(g.headline, 'the old advice was false here: the store already confirmed').not.toContain('Ask the store to confirm');
  });

  it('an unverifiable door offers both a refresh and a person', () => {
    for (const reason of ['MMG_MISMATCH_UNKNOWN', HANDOVER_AUTHORITY_REQUIRED, 'PAYMENT_STATE_INCONSISTENT']) {
      const g = doorGuidanceFor(reason);
      expect(g.action, reason).toBe('both');
      expect(g.headline, reason).toContain('cannot verify');
    }
  });

  it('money that simply has not landed keeps the original advice, because there it is true', () => {
    const g = doorGuidanceFor('MOBILE_MONEY_PENDING');
    expect(g.action).toBe('refresh');
    expect(g.headline).toContain('Ask the store to confirm the payment');
  });
});
