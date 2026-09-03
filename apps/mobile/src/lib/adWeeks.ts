/**
 * [MOB-052] THE WEEKS YOU PICK ARE THE WEEKS YOU PAY FOR.
 *
 * The campaign builder let an advertiser tick any Mondays they liked, priced
 * the campaign as `weeklyPrice × selected.length`, and then submitted this:
 *
 *     startWeek: weeks[0],
 *     endWeek:   weeks[weeks.length - 1],
 *
 * The server books a RANGE — `weeksBetween(startWeek, endWeek)` — and invoices
 * `price × weeks × cities` over it. So picking the 1st, 3rd and 5th Monday
 * showed a price for three weeks and reserved five: the advertiser was charged
 * for, and their creative ran in, two weeks they never chose, and the number on
 * the review screen was not the number on the invoice.
 *
 * A range is what the platform sells. So a range is what the screen lets you
 * choose: a selection is a contiguous block, extended and shrunk by tapping,
 * and the price is computed with the SERVER's formula so the two cannot drift.
 */

/** A week the availability API offered, in the order it offered them. */
export interface AvailableWeek {
  /** ISO Monday, `YYYY-MM-DD`. */
  readonly iso: string;
  readonly soldOut: boolean;
}

export interface WeekSelectionResult {
  readonly weeks: string[];
  /** Set when the tap changed nothing, so the screen can say why. */
  readonly refused?: 'sold_out' | 'gap_has_sold_out_week';
}

const indexOfWeek = (available: readonly AvailableWeek[], iso: string): number =>
  available.findIndex((w) => w.iso === iso);

/**
 * The selection after tapping one week.
 *
 * The result is ALWAYS a contiguous run of offered weeks, because that is what
 * the server can book. Tapping:
 *   - nothing selected → that week alone;
 *   - an end of the block → shrink by one;
 *   - inside the block → keep the head, end there;
 *   - outside the block → extend to it, unless a sold-out week lies between,
 *     in which case nothing changes and the screen says why.
 */
export function toggleWeek(
  selected: readonly string[],
  iso: string,
  available: readonly AvailableWeek[],
): WeekSelectionResult {
  const target = indexOfWeek(available, iso);
  if (target < 0) return { weeks: [...selected] };
  if (available[target]!.soldOut) return { weeks: [...selected], refused: 'sold_out' };

  const chosen = selected.filter((w) => indexOfWeek(available, w) >= 0);
  if (chosen.length === 0) return { weeks: [iso] };

  const positions = chosen.map((w) => indexOfWeek(available, w)).sort((a, b) => a - b);
  const first = positions[0]!;
  const last = positions[positions.length - 1]!;

  // an end of the block: shrink it, down to nothing
  if (target === last && last > first) return { weeks: span(available, first, last - 1) };
  if (target === first && last > first) return { weeks: span(available, first + 1, last) };
  if (target === first && last === first) return { weeks: [] };

  // inside the block: the head stays, the block ends here
  if (target > first && target < last) return { weeks: span(available, first, target) };

  // outside: extend to it, if every week in between can actually be booked
  const from = Math.min(first, target);
  const to = Math.max(last, target);
  for (let i = from; i <= to; i += 1) {
    if (available[i]!.soldOut) return { weeks: [...selected], refused: 'gap_has_sold_out_week' };
  }
  return { weeks: span(available, from, to) };
}

function span(available: readonly AvailableWeek[], from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i += 1) out.push(available[i]!.iso);
  return out;
}

/**
 * Is this selection exactly what `startWeek`..`endWeek` would book?
 *
 * The submit path sends a range; this is the invariant that makes that honest.
 * It is checked before submitting, so a selection that could not be produced
 * by the picker (a restored draft, a future edit) can never be sent as a range
 * that means something else.
 */
export function selectionIsContiguous(selected: readonly string[], available: readonly AvailableWeek[]): boolean {
  if (selected.length === 0) return false;
  const positions = selected.map((w) => indexOfWeek(available, w));
  if (positions.some((p) => p < 0)) return false;
  positions.sort((a, b) => a - b);
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] !== positions[i - 1]! + 1) return false;
  }
  return positions.every((p) => !available[p]!.soldOut);
}

/**
 * The price, by the SERVER's formula: `weeklyPrice × weeks × cities`.
 *
 * The screen used to price `weeklyPrice × selected.length` and ignore cities
 * entirely, while the invoice multiplied by the booked range AND the city
 * count. One formula, in one place, so the review screen and the invoice
 * cannot disagree.
 */
export function quotedTotal(weeklyPrice: unknown, weekCount: number, cityCount: number): number {
  const price = Number(weeklyPrice);
  if (!Number.isFinite(price) || price < 0) return 0;
  if (!Number.isInteger(weekCount) || weekCount < 0) return 0;
  if (!Number.isInteger(cityCount) || cityCount < 1) return 0;
  return price * weekCount * cityCount;
}

/** The range the screen will submit — and, by the invariant above, exactly the
 *  weeks that were ticked. */
export function submittedRange(selected: readonly string[]): { startWeek: string; endWeek: string } | null {
  if (selected.length === 0) return null;
  const sorted = [...selected].sort();
  return { startWeek: sorted[0]!, endWeek: sorted[sorted.length - 1]! };
}
