/** Format a GYD amount for display. Guyanese dollars are whole-number; uses the
 *  local "$" convention (matches the rest of the consumer UI).
 *
 *  [UI-MONEY-1] THIS IS THE ONLY MONEY FORMATTER IN THE APP.
 *
 *  It did not used to be. `AdvertiserHomeScreen` carried a second, private
 *  `money()` — re-exported to three sibling screens — that rendered the SAME
 *  currency as `G$ 2,500` while these 27 screens rendered `$2,500`. Two
 *  spellings of one currency, decided by which tab you were standing in. That
 *  is the shape of drift: not a wrong colour, but a second source of truth
 *  that nobody chose and no test forbade.
 *
 *  The advertiser copy was not merely a duplicate — it knew two things this
 *  one did not, and both are kept below rather than thrown away: an absent
 *  amount is a dash (not a confident "$0"), and ad campaigns can settle in a
 *  currency that is not the local one. `money-single-source.test.ts` now fails
 *  the build if a second formatter appears anywhere.
 */

const whole = (n: number | null | undefined) => Math.round(Number(n ?? 0)).toLocaleString();

export const money = (n: number | null | undefined) => `$${whole(n)}`;

/**
 * The same amount, when the currency is not assumed. GYD keeps the bare "$"
 * every other screen uses; anything else is spelled out, because an unlabelled
 * "$" beside a foreign total is the one place this convention becomes a lie.
 */
export function moneyIn(n: number | null | undefined, currency: string = 'GYD'): string {
  return currency === 'GYD' ? money(n) : `${currency} ${whole(n)}`;
}

/**
 * For a figure that may genuinely not exist yet — a campaign with no spend, a
 * total still loading. "$0" asserts a fact; "—" admits there isn't one.
 */
export function moneyOrDash(n: number | null | undefined, currency: string = 'GYD'): string {
  return n == null ? '—' : moneyIn(n, currency);
}
