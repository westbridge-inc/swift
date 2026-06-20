import { describe, it, expect } from 'vitest';
import { applyRideClass, RIDE_CLASSES } from './fare.service';

// Pure unit tests for the ride-class multiplier (no DB). The base (STANDARD)
// fare comes from the zone table / formula; each class is base × its multiplier,
// rounded to the nearest 100 (cash-friendly).
describe('ride-class fares', () => {
  it('STANDARD is the base fare unchanged', () => {
    expect(applyRideClass(2000, 'STANDARD')).toBe(2000);
    expect(applyRideClass(1500, 'STANDARD')).toBe(1500);
  });

  it('COMFORT is 1.5× the base, rounded to 100', () => {
    expect(applyRideClass(2000, 'COMFORT')).toBe(3000);
    expect(applyRideClass(1500, 'COMFORT')).toBe(2300); // 2250 → 2300
  });

  it('XL is 1.8× the base, rounded to 100', () => {
    expect(applyRideClass(2000, 'XL')).toBe(3600);
  });

  it('classes are strictly ordered cheapest → priciest', () => {
    const base = 2000;
    expect(applyRideClass(base, 'STANDARD')).toBeLessThan(applyRideClass(base, 'COMFORT'));
    expect(applyRideClass(base, 'COMFORT')).toBeLessThan(applyRideClass(base, 'XL'));
  });

  it('exposes the three classes', () => {
    expect(RIDE_CLASSES).toEqual(['STANDARD', 'COMFORT', 'XL']);
  });
});
