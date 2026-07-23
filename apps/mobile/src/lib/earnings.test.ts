import { describe, it, expect } from 'vitest';
import { moverJobsToday } from './earnings';

describe('moverJobsToday', () => {
  it('reads the rider server-truth field (deliveries)', () => {
    expect(moverJobsToday({ deliveries: 3 })).toBe(3);
  });

  it('reads the driver server-truth field (ridesCompleted)', () => {
    expect(moverJobsToday({ ridesCompleted: 5 })).toBe(5);
  });

  it('does NOT read the phantom key the old code used (regression for SWIFT-038)', () => {
    // `todayDeliveries` is a field no endpoint sends; it must not resolve.
    expect(moverJobsToday({ todayDeliveries: 4 })).toBe(0);
  });

  it('is 0 for empty, missing, or day-one payloads', () => {
    expect(moverJobsToday({ deliveries: 0 })).toBe(0);
    expect(moverJobsToday({})).toBe(0);
    expect(moverJobsToday(null)).toBe(0);
    expect(moverJobsToday(undefined)).toBe(0);
  });

  it('never renders a float or negative artifact', () => {
    expect(moverJobsToday({ deliveries: 2.9 })).toBe(2);
    expect(moverJobsToday({ deliveries: -1 })).toBe(0);
    expect(moverJobsToday({ deliveries: 'x' })).toBe(0);
  });
});
