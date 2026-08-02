import { describe, it, expect } from 'vitest';
import { fitPadding, outsideBounds } from './rideCamera';

// The camera controller's pure math [rides spec 6.1]: sheet-aware asymmetric
// padding, and the approach-refit hysteresis that stops seasick re-fitting.

describe('fitPadding', () => {
  it('pads the bottom by the sheet height + 40 so nothing hides under it', () => {
    expect(fitPadding(300)).toEqual({ top: 80, left: 48, right: 48, bottom: 340 });
    expect(fitPadding(0).bottom).toBe(40); // floor — never negative space
  });
});

describe('outsideBounds (approach hysteresis)', () => {
  const bounds = {
    northEast: { latitude: 6.82, longitude: -58.14 },
    southWest: { latitude: 6.79, longitude: -58.17 },
  };
  it('a driver well inside the view does NOT trigger a re-fit', () => {
    expect(outsideBounds({ latitude: 6.805, longitude: -58.155 }, bounds)).toBe(false);
  });
  it('leaving the view (or grazing the margin) triggers one', () => {
    expect(outsideBounds({ latitude: 6.825, longitude: -58.155 }, bounds)).toBe(true);
    expect(outsideBounds({ latitude: 6.8199, longitude: -58.155 }, bounds)).toBe(true); // inside the 90m hysteresis band
  });
  it('no bounds yet → always fit (first frame)', () => {
    expect(outsideBounds({ latitude: 6.8, longitude: -58.15 }, null)).toBe(true);
  });
});
