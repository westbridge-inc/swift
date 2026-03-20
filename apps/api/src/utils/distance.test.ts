import { describe, it, expect } from 'vitest';
import {
  haversineDistance,
  estimateDrivingDistance,
  estimateDeliveryMinutes,
  isWithinRadius,
  sortByDistance,
} from './distance';

// ---------------------------------------------------------------------------
// Known coordinates
// ---------------------------------------------------------------------------

// Georgetown (city center) ~ 6.8013, -58.1551
const GEORGETOWN = { lat: 6.8013, lng: -58.1551 };
// Oasis Cafe (seed data) ~ 6.8013, -58.1551 — essentially same location
const OASIS_CAFE = { lat: 6.8013, lng: -58.1551 };
// Customer home (seed data) ~ 6.8045, -58.1553
const CUSTOMER_HOME = { lat: 6.8045, lng: -58.1553 };
// New Amsterdam ~ 6.2434, -57.5180
const NEW_AMSTERDAM = { lat: 6.2434, lng: -57.5180 };

// ---------------------------------------------------------------------------
// haversineDistance
// ---------------------------------------------------------------------------

describe('haversineDistance', () => {
  it('returns 0 for same point', () => {
    expect(haversineDistance(GEORGETOWN.lat, GEORGETOWN.lng, GEORGETOWN.lat, GEORGETOWN.lng)).toBe(0);
  });

  it('calculates Georgetown to Customer Home (~0.35 km)', () => {
    const dist = haversineDistance(
      GEORGETOWN.lat, GEORGETOWN.lng,
      CUSTOMER_HOME.lat, CUSTOMER_HOME.lng,
    );
    // Should be about 0.35km
    expect(dist).toBeGreaterThan(0.3);
    expect(dist).toBeLessThan(0.5);
  });

  it('calculates Georgetown to New Amsterdam (~100 km)', () => {
    const dist = haversineDistance(
      GEORGETOWN.lat, GEORGETOWN.lng,
      NEW_AMSTERDAM.lat, NEW_AMSTERDAM.lng,
    );
    // About 87-105 km as the crow flies
    expect(dist).toBeGreaterThan(80);
    expect(dist).toBeLessThan(120);
  });

  it('is symmetric', () => {
    const d1 = haversineDistance(GEORGETOWN.lat, GEORGETOWN.lng, NEW_AMSTERDAM.lat, NEW_AMSTERDAM.lng);
    const d2 = haversineDistance(NEW_AMSTERDAM.lat, NEW_AMSTERDAM.lng, GEORGETOWN.lat, GEORGETOWN.lng);
    expect(d1).toBeCloseTo(d2, 10);
  });
});

// ---------------------------------------------------------------------------
// estimateDrivingDistance
// ---------------------------------------------------------------------------

describe('estimateDrivingDistance', () => {
  it('returns haversine * 1.3 factor', () => {
    const haversine = haversineDistance(
      GEORGETOWN.lat, GEORGETOWN.lng,
      CUSTOMER_HOME.lat, CUSTOMER_HOME.lng,
    );
    const driving = estimateDrivingDistance(
      GEORGETOWN.lat, GEORGETOWN.lng,
      CUSTOMER_HOME.lat, CUSTOMER_HOME.lng,
    );
    expect(driving).toBeCloseTo(haversine * 1.3, 10);
  });

  it('returns 0 for same point', () => {
    expect(estimateDrivingDistance(GEORGETOWN.lat, GEORGETOWN.lng, GEORGETOWN.lat, GEORGETOWN.lng)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// estimateDeliveryMinutes
// ---------------------------------------------------------------------------

describe('estimateDeliveryMinutes', () => {
  it('returns ceil((distance/25)*60) + 5', () => {
    // 5km: ceil((5/25)*60) + 5 = ceil(12) + 5 = 17
    expect(estimateDeliveryMinutes(5)).toBe(17);
  });

  it('returns 6 for 0 km (ceil(0)+5=5)', () => {
    expect(estimateDeliveryMinutes(0)).toBe(5);
  });

  it('ceils the driving time component', () => {
    // 3km: (3/25)*60 = 7.2 → ceil = 8 → 8+5 = 13
    expect(estimateDeliveryMinutes(3)).toBe(13);
  });

  it('handles large distance', () => {
    // 25km: (25/25)*60=60, ceil(60)+5 = 65
    expect(estimateDeliveryMinutes(25)).toBe(65);
  });
});

// ---------------------------------------------------------------------------
// isWithinRadius
// ---------------------------------------------------------------------------

describe('isWithinRadius', () => {
  it('returns true for point inside radius', () => {
    // Georgetown to Customer Home is ~0.35km, radius 1km
    expect(isWithinRadius(GEORGETOWN.lat, GEORGETOWN.lng, CUSTOMER_HOME.lat, CUSTOMER_HOME.lng, 1)).toBe(true);
  });

  it('returns false for point outside radius', () => {
    // Georgetown to New Amsterdam is ~100km, radius 5km
    expect(isWithinRadius(GEORGETOWN.lat, GEORGETOWN.lng, NEW_AMSTERDAM.lat, NEW_AMSTERDAM.lng, 5)).toBe(false);
  });

  it('returns true for same point with 0 radius', () => {
    expect(isWithinRadius(GEORGETOWN.lat, GEORGETOWN.lng, GEORGETOWN.lat, GEORGETOWN.lng, 0)).toBe(true);
  });

  it('returns true when exactly on boundary', () => {
    const dist = haversineDistance(GEORGETOWN.lat, GEORGETOWN.lng, CUSTOMER_HOME.lat, CUSTOMER_HOME.lng);
    expect(isWithinRadius(GEORGETOWN.lat, GEORGETOWN.lng, CUSTOMER_HOME.lat, CUSTOMER_HOME.lng, dist)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sortByDistance
// ---------------------------------------------------------------------------

describe('sortByDistance', () => {
  const items = [
    { id: 'far', latitude: NEW_AMSTERDAM.lat, longitude: NEW_AMSTERDAM.lng },
    { id: 'close', latitude: CUSTOMER_HOME.lat, longitude: CUSTOMER_HOME.lng },
    { id: 'same', latitude: GEORGETOWN.lat, longitude: GEORGETOWN.lng },
  ];

  it('sorts from nearest to farthest', () => {
    const sorted = sortByDistance(items, GEORGETOWN.lat, GEORGETOWN.lng);
    expect(sorted[0]!.id).toBe('same');
    expect(sorted[1]!.id).toBe('close');
    expect(sorted[2]!.id).toBe('far');
  });

  it('adds distance property to each item', () => {
    const sorted = sortByDistance(items, GEORGETOWN.lat, GEORGETOWN.lng);
    for (const item of sorted) {
      expect(typeof item.distance).toBe('number');
      expect(item.distance).toBeGreaterThanOrEqual(0);
    }
  });

  it('preserves original item properties', () => {
    const sorted = sortByDistance(items, GEORGETOWN.lat, GEORGETOWN.lng);
    expect(sorted[0]).toHaveProperty('id');
    expect(sorted[0]).toHaveProperty('latitude');
    expect(sorted[0]).toHaveProperty('longitude');
  });

  it('returns empty array for empty input', () => {
    expect(sortByDistance([], GEORGETOWN.lat, GEORGETOWN.lng)).toEqual([]);
  });
});
