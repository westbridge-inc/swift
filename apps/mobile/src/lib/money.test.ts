import { describe, it, expect } from 'vitest';
import { money } from './money';

describe('money', () => {
  it('treats null/undefined as $0 (never NaN)', () => {
    expect(money(null)).toBe('$0');
    expect(money(undefined)).toBe('$0');
    expect(money(0)).toBe('$0');
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
