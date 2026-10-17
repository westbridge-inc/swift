import { describe, it, expect } from 'vitest';
import { money, moneyIn } from './money';

describe('money', () => {
  // [AUD-1 row 53] This used to pin null/undefined as "$0": a fare, price or
  // total that had not arrived read as a confident "free". The intended
  // change: a missing amount is a dash; a real zero is still $0.
  it('shows a dash for a missing amount, never a confident $0 (and never NaN)', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(money(0)).toBe('$0');
  });

  it('shows a dash for anything that is not a finite amount, and reads a numeric string', () => {
    for (const notAnAmount of [NaN, Infinity, -Infinity, '', '   ', 'abc', true, {}, []]) {
      expect(money(notAnAmount as never), String(notAnAmount)).toBe('—');
      expect(moneyIn(notAnAmount as never, 'USD'), String(notAnAmount)).toBe('—');
    }
    expect(money('1250.00' as never)).toMatch(/^\$1.?250$/);
    expect(money('0' as never)).toBe('$0');
  });

  it('rounds to whole units (GYD has no sub-unit)', () => {
    expect(money(2.4)).toBe('$2');
    expect(money(2.6)).toBe('$3');
  });

  it('prefixes $ and groups thousands', () => {
    // thousands separator is locale-dependent, so allow "," or none
    expect(money(1234)).toMatch(/^\$1.?234$/);
    expect(money(2000)).toMatch(/^\$2.?000$/);
  });
});
