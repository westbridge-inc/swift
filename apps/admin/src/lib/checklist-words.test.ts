import { describe, expect, it } from 'vitest';
import { docLabel, reviewerHint, reviewNote } from '@/lib/review-center';

// [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (c), COORD (d) delegated] What the reviewer reads beside a document.
describe('[CHECKLIST-LEGAL] the reviewer\'s words', () => {
  it('(c) a driver\'s licence must cover the vehicle: motorcycles for a motorbike rider, motor cars for a taxi driver', () => {
    const hint = reviewerHint('drivers_licence') ?? '';
    expect(hint).toMatch(/motorbike rider's licence must cover motorcycles/);
    expect(hint).toMatch(/e-bike or e-scooter counts as a motorbike/);
    expect(hint).toMatch(/taxi driver's must cover motor cars/);
    expect(hint).not.toMatch(/fitness/i);
    // the hire class stays the separate licence's (owner, 11 Oct)
    expect(hint).toMatch(/Do not look for an H or hire class/);
  });

  it('(d) the GRA Food Restaurant Licence, and the GRA Provisional Licence is accepted too', () => {
    expect(docLabel('gra_restaurant_licence')).toBe('GRA Food Restaurant Licence');
    const note = reviewNote('gra_restaurant_licence', 'VENDOR_OWNER') ?? '';
    expect(note).toMatch(/^GRA Food Restaurant Licence for this store\./);
    expect(note).toMatch(/A GRA Provisional Licence is accepted too\./);
    expect(note).toMatch(/checked again every January/);
  });
});
