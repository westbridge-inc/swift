import { describe, it, expect } from 'vitest';
import { calculateDeliveryFee, expressDeliveryFee, EXPRESS_DELIVERY_MULTIPLIER } from '../utils/markup';

// FUL-003 (fulfillment prompt Part 5B): the delivery fee is the number every
// money path hinges on — yet it had NO dedicated test. Lock the contract:
// server-side, deterministic, INTEGER minor units, computed from a
// base + distance-band + surge schedule, MONOTONIC in distance, with express
// derived FROM the standard fee (one source — SWIFT-070, so the quote can't
// drift from the charge).
//
// KNOWN Part-5B GAP (flagged, FUL register FUL-003b): checkout currently calls
// `calculateDeliveryFee(distanceKm)` with the function DEFAULTS (500/200/2),
// which happen to equal Georgetown's zone schedule but are NOT read from the
// order's zone / CountryConfig. Wiring the per-zone/per-tenant schedule is the
// follow-on; this test locks the engine's math so that wiring can't change it
// silently.

describe('delivery-fee engine (FUL-003, Part 5B)', () => {
  it('within the included distance, the fee is exactly the base fee', () => {
    expect(calculateDeliveryFee(0, 500, 200, 2)).toBe(500);
    expect(calculateDeliveryFee(2, 500, 200, 2)).toBe(500); // at the boundary
    expect(calculateDeliveryFee(1.5, 500, 200, 2)).toBe(500);
  });

  it('beyond the included distance, adds per-km for the EXCESS only', () => {
    // 5km, 2 included → 3 excess × 200 = 600, + base 500 = 1100
    expect(calculateDeliveryFee(5, 500, 200, 2)).toBe(1100);
  });

  it('is always an integer (money never carries a fraction)', () => {
    expect(Number.isInteger(calculateDeliveryFee(3.7, 500, 200, 2))).toBe(true);
    expect(Number.isInteger(calculateDeliveryFee(9.13, 500, 200, 2, 1.25))).toBe(true);
  });

  it('applies the surge multiplier and rounds UP (never under-charges)', () => {
    expect(calculateDeliveryFee(2, 500, 200, 2, 1.5)).toBe(750); // ceil(500 × 1.5)
    expect(calculateDeliveryFee(2, 501, 200, 2, 1.5)).toBe(Math.ceil(501 * 1.5)); // 752
  });

  it('is monotonic in distance — further is never cheaper', () => {
    let prev = -1;
    for (const km of [0, 1, 2, 3, 5, 10, 20]) {
      const f = calculateDeliveryFee(km, 500, 200, 2);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it('honours the schedule params (base / perKm / includedKm) — not a fixed constant', () => {
    // a different tenant/zone schedule must produce a different fee
    expect(calculateDeliveryFee(5, 1000, 300, 1)).toBe(1000 + (5 - 1) * 300); // 2200
    expect(calculateDeliveryFee(5, 1000, 300, 1)).not.toBe(calculateDeliveryFee(5, 500, 200, 2));
  });

  it('express is derived FROM the standard fee (one source) at ×1.5, strictly higher', () => {
    const standard = calculateDeliveryFee(5, 500, 200, 2); // 1100
    expect(EXPRESS_DELIVERY_MULTIPLIER).toBe(1.5);
    expect(expressDeliveryFee(standard)).toBe(Math.round(standard * EXPRESS_DELIVERY_MULTIPLIER)); // 1650
    expect(expressDeliveryFee(standard)).toBeGreaterThan(standard); // the premium is the rider's upside
  });
});
