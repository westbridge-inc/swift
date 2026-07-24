import { describe, it, expect } from 'vitest';
import { zMoneyMinor, MONEY_MAX_MINOR } from '../utils/money-schema';

// SWIFT-103: client-supplied money is integer MINOR UNITS. zMoneyMinor is the
// shared validator every money intake (checkout/cart tip, rider & driver fare)
// parses through, so its contract IS the money-input policy: no floats (drift),
// no negatives, no absurd/overflow, no non-numbers. Loosening it breaks here.

describe('zMoneyMinor — client money-input invariant (SWIFT-103)', () => {
  it('accepts a non-negative integer amount', () => {
    for (const v of [0, 1, 500, 12_000, MONEY_MAX_MINOR]) {
      expect(zMoneyMinor.safeParse(v).success).toBe(true);
    }
  });

  it('rejects a fractional amount — the float-money drift this exists to stop', () => {
    expect(zMoneyMinor.safeParse(5.5).success).toBe(false);
    expect(zMoneyMinor.safeParse(0.1).success).toBe(false);
    expect(zMoneyMinor.safeParse(500.0001).success).toBe(false);
  });

  it('rejects negative amounts', () => {
    expect(zMoneyMinor.safeParse(-1).success).toBe(false);
  });

  it('rejects absurd / overflow values above the ceiling', () => {
    expect(zMoneyMinor.safeParse(MONEY_MAX_MINOR + 1).success).toBe(false);
    expect(zMoneyMinor.safeParse(1e15).success).toBe(false);
  });

  it('rejects non-finite and non-number inputs', () => {
    expect(zMoneyMinor.safeParse(NaN).success).toBe(false);
    expect(zMoneyMinor.safeParse(Infinity).success).toBe(false);
    expect(zMoneyMinor.safeParse('500').success).toBe(false);
  });
});
