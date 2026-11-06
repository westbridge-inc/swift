import { describe, expect, it } from 'vitest';
import * as labels from './review-center';
describe('review copy', () => {
  it('uses one human label vocabulary for document, role and vehicle facts', () => {
    expect(labels.docLabel('owner_national_id')).toBe('National ID');
    // [CHECKLIST-LEGAL · COORD 1 Nov 2026 (d) — a DELIBERATE change] the GRA's own name for the licence
    expect(labels.docLabel('gra_restaurant_licence')).toBe('GRA Food Restaurant Licence');
    expect(labels.docLabel('drivers_licence')).toBe("Driver's licence");
    expect(labels.roleLabel('VENDOR_OWNER')).toBe('Business owner');
    expect(labels.roleLabel('MOVER')).toBe('Rider/Driver');
    expect(labels.vehicleLabel('CAR')).toBe('Car');
  });
  it('distinguishes failed and partial document reading from successful reading', () => {
    expect(labels.timelineLabel('EXTRACTED FAILED (NO_FIELDS)')).toBe('Document reading failed');
    expect(labels.timelineLabel('EXTRACTED PARTIAL')).toBe('Document reading partially completed');
    expect(labels.timelineLabel('EXTRACTED OK')).toBe('Document reading completed');
    expect(labels.timelineLabel('V_PLATE_CLASS WARN [blocking]')).toBe('Plate class check: needs attention — blocking');
    expect(labels.timelineLabel('DECIDED REQUEST_INFO')).toBe('More information requested');
  });
  it('never falls back to raw unknown timeline data', () => {
    expect(labels.timelineLabel('NEW_ACTION /api/internal secret-id')).toBe('Document activity recorded');
    expect(labels.timelineLabel('DECIDED REJECTED under UNREADABLE')).toBe('Rejected: Too blurry or dark to read');
    expect(labels.timelineLabel('V_PLATE_CLASS PASS [blocking]')).toBe('Plate class check: passed — blocking');
  });
});

// [Owner rulings 11 Oct 2026 — HIRE LICENCE and H-PLATE] the review screen says what to check on a taxi's papers.
describe('taxi reviewer hints', () => {
  it('never asks the reviewer to find an H class on the ordinary licence; the hire right is its own licence', async () => {
    const { reviewerHint } = await import('./review-center');
    expect(reviewerHint('drivers_licence')).toMatch(/Do not look for an H or hire class/);
    expect(reviewerHint('hire_car_driver_licence')).toMatch(/its own document/);
    expect(reviewerHint('vehicle_registration')).toMatch(/H-series \(e\.g\. HC 1234\)/);
    expect(reviewerHint('national_id')).toBeUndefined();
  });

  // [CARS-PLATES · owner 6 Nov 2026] the reviewer is the person who confirms the plate's letter: the hint says so, and
  // that a private (P) plate car is approved for deliveries only.
  it('the registration hint makes the reviewer match the plate and says a P car delivers only', async () => {
    const { reviewerHint } = await import('./review-center');
    expect(reviewerHint('vehicle_registration')).toMatch(/must match the plate the mover gave: its first letter decides the work/);
    expect(reviewerHint('vehicle_registration')).toMatch(/private \(P\) plate car may do deliveries only/);
    expect(reviewerHint('drivers_licence')).toMatch(/must cover motor cars, and so must a car delivery driver's/);
  });

  it('the review screen shows the hint under the document heading', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const page = readFileSync(join(process.cwd(), 'src/app/verification/page.tsx'), 'utf8');
    expect(page).toMatch(/reviewerHint\(selected\.docType\)/);
  });
});
