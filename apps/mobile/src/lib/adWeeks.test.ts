import { describe, it, expect } from 'vitest';
import { quotedTotal, selectionIsContiguous, submittedRange, toggleWeek, type AvailableWeek } from './adWeeks';

// ---------------------------------------------------------------------------
// [MOB-052] THE WEEKS YOU PICK ARE THE WEEKS YOU PAY FOR.
//
// The campaign builder let an advertiser tick any Mondays they liked, priced
// the campaign as `weeklyPrice × selected.length`, and submitted:
//
//     startWeek: weeks[0], endWeek: weeks[weeks.length - 1]
//
// The server books a RANGE and invoices `price × weeksBetween × cities`. So
// picking the 1st, 3rd and 5th Monday showed a price for three weeks and
// reserved five: the advertiser paid for, and their creative ran in, two weeks
// they never chose — and the number on the review screen was not the number on
// the invoice.
// ---------------------------------------------------------------------------

const W = (iso: string, soldOut = false): AvailableWeek => ({ iso, soldOut });
const weeks8: AvailableWeek[] = [
  W('2026-09-07'), W('2026-09-14'), W('2026-09-21'), W('2026-09-28'),
  W('2026-10-05'), W('2026-10-12'), W('2026-10-19'), W('2026-10-26'),
];

describe('[MOB-052] a selection is a continuous run, because a range is what is booked', () => {
  it('the first tap picks one week', () => {
    expect(toggleWeek([], '2026-09-14', weeks8).weeks).toEqual(['2026-09-14']);
  });

  it('THE DEFECT: picking a week two apart no longer leaves a gap — it fills the run', () => {
    const first = toggleWeek([], '2026-09-07', weeks8).weeks;
    const skipped = toggleWeek(first, '2026-09-21', weeks8).weeks;
    // it used to be ['2026-09-07', '2026-09-21'] — priced as 2, reserved as 3
    expect(skipped).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
  });

  it('tapping an end of the run shrinks it by one; tapping the only week clears it', () => {
    const run = ['2026-09-07', '2026-09-14', '2026-09-21'];
    expect(toggleWeek(run, '2026-09-21', weeks8).weeks).toEqual(['2026-09-07', '2026-09-14']);
    expect(toggleWeek(run, '2026-09-07', weeks8).weeks).toEqual(['2026-09-14', '2026-09-21']);
    expect(toggleWeek(['2026-09-14'], '2026-09-14', weeks8).weeks).toEqual([]);
  });

  it('tapping inside the run ends it there, keeping the head', () => {
    const run = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'];
    expect(toggleWeek(run, '2026-09-14', weeks8).weeks).toEqual(['2026-09-07', '2026-09-14']);
  });

  it('extending backwards works the same way', () => {
    expect(toggleWeek(['2026-09-21'], '2026-09-07', weeks8).weeks)
      .toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
  });

  it('a sold-out week is never selected, and never bridged — the run cannot reach past it', () => {
    const withHole = [...weeks8];
    withHole[2] = W('2026-09-21', true);
    expect(toggleWeek([], '2026-09-21', withHole)).toMatchObject({ refused: 'sold_out', weeks: [] });

    const before = ['2026-09-07', '2026-09-14'];
    const attempt = toggleWeek(before, '2026-09-28', withHole);
    expect(attempt.refused).toBe('gap_has_sold_out_week');
    expect(attempt.weeks, 'nothing changes, and the screen says why').toEqual(before);
  });

  it('a week the availability API never offered is ignored', () => {
    expect(toggleWeek(['2026-09-07'], '2027-01-04', weeks8).weeks).toEqual(['2026-09-07']);
  });
});

describe('[MOB-052] what is submitted is exactly what was ticked', () => {
  it('the range covers the run and nothing more', () => {
    expect(submittedRange(['2026-09-07', '2026-09-14', '2026-09-21']))
      .toEqual({ startWeek: '2026-09-07', endWeek: '2026-09-21' });
    expect(submittedRange([])).toBeNull();
  });

  it('the invariant catches a selection a range would NOT reproduce — the defect, as a guard', () => {
    expect(selectionIsContiguous(['2026-09-07', '2026-09-14'], weeks8)).toBe(true);
    // the old picker could produce this; the range for it books three weeks
    expect(selectionIsContiguous(['2026-09-07', '2026-09-21'], weeks8)).toBe(false);
    expect(selectionIsContiguous([], weeks8)).toBe(false);
    expect(selectionIsContiguous(['2027-01-04'], weeks8)).toBe(false);
  });

  it('a run that contains a sold-out week is not contiguous for booking purposes', () => {
    const withHole = [...weeks8];
    withHole[1] = W('2026-09-14', true);
    expect(selectionIsContiguous(['2026-09-07', '2026-09-14', '2026-09-21'], withHole)).toBe(false);
  });

  it('order does not matter — the range is taken from the dates, not the tap order', () => {
    expect(submittedRange(['2026-09-21', '2026-09-07', '2026-09-14']))
      .toEqual({ startWeek: '2026-09-07', endWeek: '2026-09-21' });
  });
});

describe("[MOB-052] the price is the server's formula", () => {
  it('price x weeks x cities — the screen used to ignore cities entirely', () => {
    expect(quotedTotal(1000, 3, 1)).toBe(3000);
    expect(quotedTotal(1000, 3, 2)).toBe(6000);
    expect(quotedTotal('1000', 2, 1)).toBe(2000);
  });

  it('a missing or nonsense price is 0, never NaN on a review screen', () => {
    for (const price of [undefined, null, 'free', Number.NaN, -5]) {
      expect(quotedTotal(price, 3, 1), String(price)).toBe(0);
    }
  });

  it('a nonsense week or city count is 0 rather than a number nobody can pay', () => {
    expect(quotedTotal(1000, -1, 1)).toBe(0);
    expect(quotedTotal(1000, 1.5, 1)).toBe(0);
    expect(quotedTotal(1000, 3, 0)).toBe(0);
  });

  it('the quote for a run matches the count of weeks in the run — the two can no longer disagree', () => {
    const run = toggleWeek(toggleWeek([], '2026-09-07', weeks8).weeks, '2026-09-28', weeks8).weeks;
    expect(run).toHaveLength(4);
    expect(quotedTotal(500, run.length, 1)).toBe(2000);
  });
});
