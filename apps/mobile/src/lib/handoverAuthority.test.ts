import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { doorCounters, doorFor, parseHandoverAuthority, recordDoorBlocked, recordDoorMismatch, resetDoorCountersForTests, type HandoverAuthority } from './handoverAuthority';

// ---------------------------------------------------------------------------
// [MOB-023] The door renders the SERVER's authority, never the payment
// method. Without an authority it derives the conservative answer: a
// mobile-money order is "already paid" only when its state is CAPTURED.
// ---------------------------------------------------------------------------

const authority = (over: Partial<HandoverAuthority> = {}): HandoverAuthority => ({
  rail: 'MOBILE_MONEY', paymentState: 'CAPTURED', custodyState: 'ARRIVED', amount: 1250, currency: 'GYD', version: 'v-1', permitted: 'DELIVER_NO_CASH', blockReason: null, ...over,
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
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', handover: { permitted: 'YES' } as never })).toMatchObject({ kind: 'blocked', reason: 'MOBILE_MONEY_PENDING', source: 'derived' });
  });
});

describe('without an authority the derivation is conservative', () => {
  it('a mobile-money order is "already paid" ONLY when CAPTURED; every other state blocks; cash collects', () => {
    for (const state of ['PENDING', 'AUTHORIZED', 'FAILED', 'REFUNDED', 'UNKNOWN', 'EXPIRED', undefined, null]) {
      expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: state }), String(state)).toMatchObject({ kind: 'blocked', reason: `MOBILE_MONEY_${state ?? 'UNKNOWN'}`, version: null, source: 'derived' });
      expect(doorFor({ paymentMethod: 'CASH', paymentStatus: state }), String(state)).toMatchObject({ kind: 'collect-cash', source: 'derived' });
    }
    expect(doorFor({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' })).toEqual({ kind: 'no-cash', version: null, source: 'derived' });
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
    expect(STRIPPED).toContain('Payment not confirmed');
    expect(STRIPPED).toMatch(/doorBlocked \? \(/);
  });
  it('a refused hand-over (stale or not captured) refetches the job and is counted as a mismatch', () => {
    expect(STRIPPED).toContain("code === 'HANDOVER_STALE' || code === 'PAYMENT_NOT_CAPTURED' || code === 'MMG_PAYMENT_PENDING'");
    expect(STRIPPED).toContain('recordDoorMismatch(code);');
  });
});
