import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAR_PLATE_HINT, carPlateMessage, carWork, HIRE_CAR_NOTE, isHirePlate, needsHirePlate, PRIVATE_CAR_NOTE, taxiPlateMessage, TAXI_PLATE_ERROR, TAXI_PLATE_HINT } from './taxiPlate';

// [Owner ruling 11 Oct 2026 — H-PLATE: KEEP] The app says "taxi plates start with H" where the plate is
// typed, in the same words as the server, and never lets a taxi driver save a plate that cannot be approved.
describe('taxi plate rule in the app', () => {
  it('only cars and wagon cars are judged (delivery vehicles and hidden buses are not)', () => {
    expect(needsHirePlate('CAR')).toBe(true);
    expect(needsHirePlate('WAGON_CAR')).toBe(true);
    for (const kind of ['BICYCLE', 'MOTORCYCLE', 'BUS_9', 'BUS_15'] as const) expect(needsHirePlate(kind)).toBe(false);
  });

  it('reads the plate like the server: spacing and hyphens ignored, first letter H', () => {
    expect(isHirePlate('HC 1234')).toBe(true);
    expect(isHirePlate('hd-4321')).toBe(true);
    expect(isHirePlate('PLX4821')).toBe(false);
    expect(isHirePlate(' PAB 1234')).toBe(false);
  });

  it('shows the hint first, then the error once a non-H plate is typed', () => {
    expect(taxiPlateMessage('CAR', '')).toEqual({ text: TAXI_PLATE_HINT, error: false });
    expect(taxiPlateMessage('CAR', 'PLX4821')).toEqual({ text: TAXI_PLATE_ERROR, error: true });
    expect(taxiPlateMessage('WAGON_CAR', 'HC 1234')).toEqual({ text: TAXI_PLATE_HINT, error: false });
    expect(taxiPlateMessage('MOTORCYCLE', 'PAB 1234')).toBeNull();
  });

  it('the vehicle form blocks save on a non-H taxi plate and shows the words', () => {
    const screen = readFileSync(join(process.cwd(), 'src/modules/mover/screens/MoverOnboardingScreen.tsx'), 'utf8');
    expect(screen).toMatch(/carPlateMessage\(vt, plate, carsDeliver\)/);
    expect(screen).toMatch(/plateMessage\?\.error/);
  });

  it('says the same thing as the server', () => {
    const server = readFileSync(join(process.cwd(), '../api/src/modules/verification/hire-plate.ts'), 'utf8');
    expect(server).toContain('Taxi plates in Guyana start with H — e.g. HC 1234.');
  });
});

// [CARS-PLATES · owner 6 Nov 2026] P-plate (private) cars deliver only; H-plate (hire) cars drive taxi rides and deliver.
// While the server says private cars deliver, the plate decides the work and a P plate is never an error.
describe('cars by plate in the app', () => {
  it('private cars open: the plate says the work, never an error; closed: exactly the taxi rule', () => {
    expect(carPlateMessage('CAR', '', true)).toEqual({ text: CAR_PLATE_HINT, error: false });
    expect(carPlateMessage('CAR', 'PWX 4821', true)).toEqual({ text: PRIVATE_CAR_NOTE, error: false });
    expect(carPlateMessage('WAGON_CAR', 'hc-1234', true)).toEqual({ text: HIRE_CAR_NOTE, error: false });
    expect(carPlateMessage('MOTORCYCLE', 'PAB 1', true)).toBeNull();
    expect(carPlateMessage('CAR', 'PWX 4821', false)).toEqual({ text: TAXI_PLATE_ERROR, error: true });
    expect(carPlateMessage('CAR', '', false)).toEqual({ text: TAXI_PLATE_HINT, error: false });
  });

  it('the work: a P car delivers only while private cars are open; an H car is a taxi; bikes have none', () => {
    expect(carWork('CAR', 'PWX 1', true)).toBe('DELIVERY');
    expect(carWork('CAR', 'HC 1', true)).toBe('TAXI');
    expect(carWork('CAR', 'PWX 1', false)).toBe('TAXI');
    expect(carWork('MOTORCYCLE', 'PWX 1', true)).toBeNull();
  });

  it('says the same as the server about a private car', () => {
    const server = readFileSync(join(process.cwd(), '../api/src/modules/verification/hire-plate.ts'), 'utf8');
    expect(server).toContain(`'${PRIVATE_CAR_NOTE}'`);
  });
});
