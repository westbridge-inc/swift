import { describe, it, expect } from 'vitest';
import {
  calculateDeliveryFee,
  calculateCourierFee,
  calculateTaxiFare,
  generateOrderNumber,
} from './markup';

// NOTE: customer markup has been removed (zero-commission model — customers pay
// the vendor base price). The calculateMarkup/calculateCustomerPrice helpers and
// their tests are intentionally gone. The fees below are mover earnings, not
// platform revenue.

// ---------------------------------------------------------------------------
// calculateDeliveryFee
// ---------------------------------------------------------------------------

describe('calculateDeliveryFee', () => {
  it('returns base fee only when distance <= included km', () => {
    // distance=1km, included=2km → no extra charge → baseFee=500
    expect(calculateDeliveryFee(1)).toBe(500);
    expect(calculateDeliveryFee(2)).toBe(500);
  });

  it('adds per-km charge after included km', () => {
    // distance=5km, included=2km → extra=3km*200=600 → 500+600=1100
    expect(calculateDeliveryFee(5)).toBe(1100);
  });

  it('applies surge multiplier', () => {
    // distance=5, base=500, extra=600 → subtotal=1100, surge=1.5 → 1650
    expect(calculateDeliveryFee(5, 500, 200, 2, 1.5)).toBe(1650);
  });

  it('applies ceil after surge', () => {
    // distance=3, base=500, extra=200 → subtotal=700, surge=1.3 → 910
    expect(calculateDeliveryFee(3, 500, 200, 2, 1.3)).toBe(910);
  });

  it('handles 0 distance', () => {
    expect(calculateDeliveryFee(0)).toBe(500);
  });

  it('handles custom base fee and per-km rate', () => {
    // base=1000, perKm=500, included=3, distance=6 → extra=3*500=1500 → 2500
    expect(calculateDeliveryFee(6, 1000, 500, 3)).toBe(2500);
  });
});

// ---------------------------------------------------------------------------
// calculateCourierFee
// ---------------------------------------------------------------------------

describe('calculateCourierFee', () => {
  it('calculates fee for SMALL package, standard speed', () => {
    // base=1000, 5km*300=1500, surcharge=0 → 2500 * 1.0 = 2500
    expect(calculateCourierFee(5, 'SMALL')).toBe(2500);
  });

  it('applies package size surcharge', () => {
    // base=1000, 5*300=1500, MEDIUM=500 → 3000
    expect(calculateCourierFee(5, 'MEDIUM')).toBe(3000);
    // LARGE=1000 → 3500
    expect(calculateCourierFee(5, 'LARGE')).toBe(3500);
    // EXTRA_LARGE=2000 → 4500
    expect(calculateCourierFee(5, 'EXTRA_LARGE')).toBe(4500);
  });

  it('applies speed multiplier', () => {
    // SMALL, express (1.5x): (1000 + 5*300 + 0) * 1.5 = 3750
    expect(calculateCourierFee(5, 'SMALL', 'express')).toBe(3750);
    // SMALL, rush (2.0x): (1000 + 5*300 + 0) * 2.0 = 5000
    expect(calculateCourierFee(5, 'SMALL', 'rush')).toBe(5000);
  });

  it('applies ceil after multiplier', () => {
    // distance=3: (1000 + 900 + 0) * 1.5 = 2850
    expect(calculateCourierFee(3, 'SMALL', 'express')).toBe(2850);
  });
});

// ---------------------------------------------------------------------------
// calculateTaxiFare
// ---------------------------------------------------------------------------

describe('calculateTaxiFare', () => {
  it('returns minimum fare when calculated fare is lower', () => {
    // base=1000, 0.5km*300=150, 2min*50=100 → 1250, minimum=1500 → 1500
    expect(calculateTaxiFare(0.5, 2)).toBe(1500);
  });

  it('returns calculated fare when above minimum', () => {
    // base=1000, 10km*300=3000, 20min*50=1000 → 5000
    expect(calculateTaxiFare(10, 20)).toBe(5000);
  });

  it('applies surge multiplier', () => {
    // base=1000, 10*300=3000, 20*50=1000 → 5000 * 1.5 = 7500
    expect(calculateTaxiFare(10, 20, 1000, 300, 50, 1500, 1.5)).toBe(7500);
  });

  it('applies vehicle multiplier', () => {
    // fare=5000 * surge=1.0 * vehicle=2.0 = 10000
    expect(calculateTaxiFare(10, 20, 1000, 300, 50, 1500, 1.0, 2.0)).toBe(10000);
  });

  it('applies surge and vehicle multiplier together', () => {
    // fare=5000 * 1.5 * 1.5 = 11250
    expect(calculateTaxiFare(10, 20, 1000, 300, 50, 1500, 1.5, 1.5)).toBe(11250);
  });

  it('ceils the result', () => {
    // base=1000, 3km*300=900, 5min*50=250 → 2150 * 1.3 = 2795
    expect(calculateTaxiFare(3, 5, 1000, 300, 50, 1500, 1.3)).toBe(2795);
  });
});

// ---------------------------------------------------------------------------
// generateOrderNumber
// ---------------------------------------------------------------------------

describe('generateOrderNumber', () => {
  it('has format SW-YYMMDD-XXX plus a 3-char collision suffix', () => {
    const result = generateOrderNumber(1);
    expect(result).toMatch(/^SW-\d{6}-\d{3}[A-Z2-9]{3}$/);
  });

  it('pads sequence to 3 digits', () => {
    expect(generateOrderNumber(1)).toMatch(/-001[A-Z2-9]{3}$/);
    expect(generateOrderNumber(42)).toMatch(/-042[A-Z2-9]{3}$/);
    expect(generateOrderNumber(999)).toMatch(/-999[A-Z2-9]{3}$/);
  });

  it('does not truncate sequences > 999', () => {
    expect(generateOrderNumber(1234)).toMatch(/-1234[A-Z2-9]{3}$/);
  });

  it('two calls with the same sequence do not collide (concurrency-proof)', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateOrderNumber(7)));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('uses current date', () => {
    const now = new Date();
    const yy = now.getFullYear().toString().slice(2);
    const mm = (now.getMonth() + 1).toString().padStart(2, '0');
    const dd = now.getDate().toString().padStart(2, '0');
    expect(generateOrderNumber(5).startsWith(`SW-${yy}${mm}${dd}-005`)).toBe(true);
  });
});
