import { describe, it, expect } from 'vitest';
import {
  bearingBetween,
  clampInterval,
  isStale,
  normalizeBearing,
  planSweep,
  shortestArcDelta,
  staleAgeSeconds,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  STALE_AFTER_MS,
} from './interpolation';

// 6.3's pure core — every branch here is what separates "a car driving" from
// "a dot teleporting", so every branch gets a pin.

describe('clampInterval', () => {
  it('clamps the observed cadence into the spec window', () => {
    expect(clampInterval(500)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(4_200)).toBe(4_200);
    expect(clampInterval(30_000)).toBe(MAX_INTERVAL_MS);
  });
});

describe('shortestArcDelta (the car turns the short way)', () => {
  it('crosses north without the long spin', () => {
    expect(shortestArcDelta(350, 10)).toBe(20);
    expect(shortestArcDelta(10, 350)).toBe(-20);
  });
  it('handles plain turns, half turns, and negatives', () => {
    expect(shortestArcDelta(0, 90)).toBe(90);
    expect(shortestArcDelta(90, 0)).toBe(-90);
    expect(shortestArcDelta(0, 180)).toBe(180); // exactly opposite: one defined answer
    expect(shortestArcDelta(-10, 10)).toBe(20); // un-normalized input tolerated
  });
  it('normalizes wild inputs', () => {
    expect(normalizeBearing(-90)).toBe(270);
    expect(normalizeBearing(725)).toBe(5);
  });
});

describe('bearingBetween', () => {
  it('points roughly the right way on the compass', () => {
    const gt = { latitude: 6.8013, longitude: -58.1553 };
    const north = bearingBetween(gt, { latitude: 6.9, longitude: -58.1553 });
    const east = bearingBetween(gt, { latitude: 6.8013, longitude: -58.05 });
    expect(Math.abs(shortestArcDelta(north!, 0))).toBeLessThan(1);
    expect(Math.abs(shortestArcDelta(east!, 90))).toBeLessThan(1);
  });
  it('refuses to aim a parked car', () => {
    const p = { latitude: 6.8013, longitude: -58.1553 };
    expect(bearingBetween(p, { latitude: 6.8013001, longitude: -58.1553001 })).toBeNull();
  });
});

describe('planSweep', () => {
  const rendered = { latitude: 6.8, longitude: -58.16, bearing: 350 };

  it('uses the stream heading when present, via the shortest arc', () => {
    const plan = planSweep(rendered, { latitude: 6.81, longitude: -58.15, heading: 10, receivedAt: 1 }, 4_000);
    expect(plan.durationMs).toBe(4_000);
    expect(plan.bearingTarget).toBe(370); // 350 + 20: withTiming turns 20°, not −340°
  });

  it('falls back to travel bearing when the ping has none', () => {
    const plan = planSweep(rendered, { latitude: 6.9, longitude: -58.16, heading: null, receivedAt: 1 }, 4_000);
    // due north from rendered → target ≈ 350 + shortestArc(350→0) = 360
    expect(Math.abs(plan.bearingTarget! - 360)).toBeLessThan(1);
  });

  it('keeps the current bearing for a stationary duplicate fix', () => {
    const plan = planSweep(rendered, { latitude: 6.8, longitude: -58.16, heading: null, receivedAt: 1 }, 900);
    expect(plan.bearingTarget).toBeNull();
    expect(plan.durationMs).toBe(MIN_INTERVAL_MS);
  });
});

describe('staleness (honesty over gliding fiction)', () => {
  const ping = { latitude: 6.8, longitude: -58.16, receivedAt: 100_000 };
  it('flips exactly past the line and reports whole seconds', () => {
    expect(isStale(ping, 100_000 + STALE_AFTER_MS)).toBe(false);
    expect(isStale(ping, 100_000 + STALE_AFTER_MS + 1)).toBe(true);
    expect(isStale(null, 999_999)).toBe(false);
    expect(staleAgeSeconds(ping, 120_000)).toBe(20);
  });
});
