/**
 * A poster can be measured without constructing the native video source. The
 * first positive intersection is the earliest useful pre-warm signal exposed
 * by the viewability hook; zero and invalid samples keep the player cold.
 */
export function shouldPrimeHeroVideo(visibleFraction: number): boolean {
  return Number.isFinite(visibleFraction) && visibleFraction > 0;
}
