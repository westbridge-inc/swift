/**
 * [COORD 18 Oct, option S] The one partition of ratings a person received: whole groups of 5 final
 * ratings, in the order given. Everything a non-store ratee is shown is built from it.
 */
import { describe, expect, it } from 'vitest';
import { RATING_GROUP_SIZE, groupRatings } from '../modules/rating/rating-groups';

const now = new Date('2026-10-18T12:00:00Z');
const day = (d: number) => new Date(now.getTime() - d * 86_400_000);
const row = (score: number, ageDays: number, editable = false) => ({
  score, createdAt: day(ageDays), editableUntil: editable ? day(-1) : day(ageDays - 7),
});

describe('groupRatings', () => {
  it('cuts in the order given (not the order read) into whole groups of 5; the rest waits', () => {
    const rows = [row(5, 30), row(1, 29), row(4, 28), row(2, 27), row(3, 26), row(5, 25), row(5, 24)].reverse();
    const g = groupRatings(rows, now);
    expect(RATING_GROUP_SIZE).toBe(5);
    expect(g.groups).toEqual([{ from: day(30), to: day(26), count: 5, average: 3 }]);
    expect({ count: g.count, sum: g.sum, average: g.average }).toEqual({ count: 5, sum: 15, average: 3 });
  });

  it('nothing after the first rating still open to editing counts yet', () => {
    const rows = [row(5, 30), row(5, 29), row(5, 28), row(5, 27), row(1, 26, true), row(5, 20), row(5, 19)];
    expect(groupRatings(rows, now)).toEqual({ groups: [], count: 0, sum: 0, average: null });
  });

  it('an older rating with no edit window is final', () => {
    const rows = [1, 2, 3, 4, 5].map((s, i) => ({ score: s, createdAt: day(400 - i), editableUntil: null }));
    expect(groupRatings(rows, now).groups).toEqual([{ from: day(400), to: day(396), count: 5, average: 3 }]);
  });

  it('adding one rating never changes what is shown; the fifth adds one whole group', () => {
    const base = [3, 3, 3, 3, 3].map((s, i) => row(s, 40 - i));
    const shown = groupRatings(base, now);
    for (let extra = 1; extra < 5; extra++) {
      const more = [...base, ...Array.from({ length: extra }, (_, i) => row(1, 20 - i))];
      expect(groupRatings(more, now)).toEqual(shown);
    }
    const five = groupRatings([...base, ...[1, 1, 1, 1, 1].map((s, i) => row(s, 20 - i))], now);
    expect(five.groups).toEqual([shown.groups[0], { from: day(20), to: day(16), count: 5, average: 1 }]);
  });
});
