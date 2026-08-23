/**
 * [F-027-08] How far one accessibility adjust action moves the fare.
 *
 * F-242 gave the slider an `adjustable` role and increment/decrement actions,
 * which made it reachable. It defined one action as 1% of the band — and the
 * offer card opens at the market maximum and allows lowering to 60%, so the
 * floor was roughly 100 decrement actions away, inside an offer whose server
 * authority expires in 20 seconds (12 on express).
 *
 * A sighted drag crosses that instantly. The assistive path could not traverse
 * it at all: the control was reachable and unusable, which is the harder
 * failure to notice, because every accessibility assertion still passed.
 *
 * Split out as a pure module so the "is it actually traversable" property can
 * be asserted without React Native — the same split as kit/text-scale.
 */

/** The most adjust gestures a person should need to cross the whole band. */
export const MAX_ACCESSIBLE_ACTIONS = 10;

/**
 * One tenth of the band, rounded to a legible money increment on large fares
 * so the spoken value stays readable. Never zero — the control must always
 * move when asked.
 */
export function fareStep(min: number, max: number): number {
  const raw = (max - min) / MAX_ACCESSIBLE_ACTIONS;
  if (raw <= 0) return 1;
  return Math.max(1, raw >= 100 ? Math.round(raw / 50) * 50 : Math.round(raw));
}

/**
 * [F-028-18] Can this offer's remaining authority actually be ADJUSTED, or
 * only accepted?
 *
 * The recovery endpoint hands back cards with as little as 4 seconds of
 * authority (Redis TTL 14 minus the 10-second worker tail). Ten adjust
 * gestures cannot traverse the band in 4 seconds — the slider becomes
 * reachable-but-untraversable again, this time only on recovered cards,
 * which is the exact failure F-027-08 closed for fresh ones.
 *
 * Accepting needs ONE gesture; adjusting needs up to MAX_ACCESSIBLE_ACTIONS
 * plus a moment to confirm the number. Derivation, not taste:
 * 10 gestures × ~0.8s each + 2s to read and commit = 10s. A fresh express
 * offer (12s) clears it; a short recovered card does not, and the card says
 * so instead of offering a control that cannot finish.
 */
export const MIN_ADJUST_SECONDS = 10;

export function canAdjustFare(expiresInSeconds: number | null | undefined): boolean {
  if (expiresInSeconds == null) return true; // no deadline known — do not degrade
  return expiresInSeconds >= MIN_ADJUST_SECONDS;
}
