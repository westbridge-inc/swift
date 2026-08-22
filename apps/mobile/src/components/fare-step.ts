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
