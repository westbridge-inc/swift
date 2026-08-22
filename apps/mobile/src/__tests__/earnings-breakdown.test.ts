import { describe, expect, it } from 'vitest';
import { earningsSplit } from '../lib/earnings-breakdown';

describe('earningsSplit', () => {
  it('pulls today’s tips out of the by-type breakdown', () => {
    // The shape the API actually sends: a Record<EarningType, number>.
    expect(earningsSplit({ DELIVERY_FEE: 3600, TIP: 600 })).toEqual({ tips: 600, showTips: true });
    expect(earningsSplit({ TAXI_FARE: 5000, TIP: 250 })).toEqual({ tips: 250, showTips: true });
  });

  it('renders no tip line on a day with no tips', () => {
    expect(earningsSplit({ DELIVERY_FEE: 3600 }).showTips).toBe(false);
    expect(earningsSplit({ DELIVERY_FEE: 3600, TIP: 0 }).showTips).toBe(false);
    expect(earningsSplit({}).showTips).toBe(false);
  });

  it('degrades to no-tips rather than NaN under the day’s total', () => {
    // This sits directly beneath the mover's earnings figure. A malformed or
    // missing payload must never render "$NaN in tips" there.
    for (const junk of [null, undefined, 'nonsense', 42, [], [1, 2], { TIP: 'abc' }, { TIP: -100 }, { TIP: Infinity }]) {
      const s = earningsSplit(junk);
      expect(s.tips).toBe(0);
      expect(s.showTips).toBe(false);
    }
  });
});
