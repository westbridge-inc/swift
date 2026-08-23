import { describe, it, expect } from 'vitest';
import { canAdjustFare, MIN_ADJUST_SECONDS, fareStep, MAX_ACCESSIBLE_ACTIONS } from './fare-step';

// ---------------------------------------------------------------------------
// [F-027-08] The accessible fare path has to be traversable before the offer
// expires.
//
// F-242 gave the slider an `adjustable` role and increment/decrement actions,
// which made it reachable. It defined one action as 1% of the band — and the
// offer card opens at the market maximum and allows lowering to 60%, so the
// floor was roughly 100 decrement actions away. Server authority expires in
// 20 seconds, or 12 on express.
//
// A sighted drag crosses that instantly. The assistive path could not traverse
// it at all. The control was reachable and unusable, which is the harder
// failure to notice: every accessibility assertion passed.
// ---------------------------------------------------------------------------

/** The real offer geometry: opens at market max, floors at 60% of it. */
const bandFor = (marketMax: number) => ({ min: Math.ceil(marketMax * 0.6), max: marketMax });

/** The tightest real deadline, from dispatch: express offers expire in 12s. */
const EXPRESS_SECONDS = 12;
/** A generous-to-the-product estimate of one screen-reader adjust gesture. */
const SECONDS_PER_ACTION = 0.6;

describe('fare slider step [F-027-08]', () => {
  it('crosses the whole band within the action budget, at every realistic fare', () => {
    for (const marketMax of [500, 1_000, 2_500, 5_000, 12_000, 40_000, 150_000]) {
      const { min, max } = bandFor(marketMax);
      const actions = Math.ceil((max - min) / fareStep(min, max));
      expect(actions, `GYD ${marketMax}: ${actions} actions to cross`).toBeLessThanOrEqual(MAX_ACCESSIBLE_ACTIONS);
    }
  });

  it('the old 1%-of-band step did NOT — this is the regression being fixed', () => {
    const { min, max } = bandFor(2_500);
    const oldStep = Math.max(1, Math.round((max - min) / 100));
    expect(Math.ceil((max - min) / oldStep)).toBeGreaterThan(90);
  });

  it('a full traverse fits inside an EXPRESS offer, not just a standard one', () => {
    for (const marketMax of [1_000, 5_000, 40_000]) {
      const { min, max } = bandFor(marketMax);
      const seconds = Math.ceil((max - min) / fareStep(min, max)) * SECONDS_PER_ACTION;
      expect(seconds, `GYD ${marketMax}`).toBeLessThan(EXPRESS_SECONDS);
    }
  });

  it('never returns a zero or negative step — the control must always move', () => {
    for (const [min, max] of [[0, 0], [100, 100], [0, 1], [999, 1_000]] as const) {
      expect(fareStep(min, max), `${min}..${max}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('rounds to a legible money increment on large bands, so the spoken value stays readable', () => {
    const { min, max } = bandFor(40_000);
    expect(fareStep(min, max) % 50).toBe(0);
  });
});

describe('[F-028-18] canAdjustFare — a control that cannot finish is not offered', () => {
  it('blocks adjustment on a short recovered card', () => {
    // The recovery endpoint hands back cards with as little as 4 seconds of
    // authority (TTL 14 minus the 10s worker tail). Ten gestures cannot
    // traverse the band in 4 seconds — reachable-but-untraversable, the exact
    // failure F-027-08 closed for fresh offers, reintroduced via recovery.
    expect(canAdjustFare(4)).toBe(false);
    expect(canAdjustFare(9)).toBe(false);
  });

  it('keeps adjustment on every fresh offer, including express', () => {
    // Derivation: 10 gestures × ~0.8s + 2s to confirm = 10s. Express fresh
    // cards carry 12s — the DESIGNED experience must survive the guard.
    expect(canAdjustFare(12)).toBe(true);
    expect(canAdjustFare(20)).toBe(true);
    expect(canAdjustFare(MIN_ADJUST_SECONDS)).toBe(true);
  });

  it('does not degrade when no deadline is known', () => {
    expect(canAdjustFare(null)).toBe(true);
    expect(canAdjustFare(undefined)).toBe(true);
  });
});
