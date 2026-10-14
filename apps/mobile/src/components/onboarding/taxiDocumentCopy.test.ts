import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTaxiChecklist, taxiDocumentHint, TAXI_DOCUMENTS_FAQ, TAXI_TWO_LICENCES } from './taxiDocumentCopy';

// [Owner ruling 11 Oct 2026 — HIRE LICENCE] Two licences, said plainly: the normal driver's licence AND
// the separate GRA Hire Car Driver's Licence; no "H class" on the plastic licence. Supersedes the 8 Oct
// "licence must include the hire-car class" wording.
const TAXI = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance', 'hire_car_driver_licence', 'hire_car_vehicle_licence', 'vehicle_exterior_photo', 'fitness_cert'];
const MOTORBIKE = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'];

describe('taxi documents in plain words', () => {
  it('names both licences and says the normal licence needs no hire class', () => {
    expect(TAXI_TWO_LICENCES).toMatch(/two licences/);
    expect(TAXI_TWO_LICENCES).toMatch(/normal driver's licence/);
    expect(TAXI_TWO_LICENCES).toMatch(/Hire Car Driver's Licence/);
    expect(TAXI_TWO_LICENCES).toMatch(/does not need to show a hire class/);
  });

  it('hints appear on a taxi checklist only (a motorbike rider is not told about hire licences)', () => {
    expect(isTaxiChecklist(TAXI)).toBe(true);
    expect(isTaxiChecklist(MOTORBIKE)).toBe(false);
    expect(taxiDocumentHint('drivers_licence', TAXI)).toMatch(/does not need to show a hire class/);
    expect(taxiDocumentHint('hire_car_driver_licence', TAXI)).toMatch(/separate licence, not a class/);
    expect(taxiDocumentHint('vehicle_registration', TAXI)).toMatch(/start with H — e\.g\. HC 1234/);
    expect(taxiDocumentHint('drivers_licence', MOTORBIKE)).toBeUndefined();
  });

  it('help answers what a taxi driver needs, and never asks for an H class', () => {
    expect(TAXI_DOCUMENTS_FAQ.a).toMatch(/Hire Car Driver's Licence/);
    expect(TAXI_DOCUMENTS_FAQ.a).toMatch(/does not need to show a hire class/);
    expect(TAXI_DOCUMENTS_FAQ.a).not.toMatch(/must (include|show) (the |a )?(hire|H)[- ]?(car )?class/i);
  });

  it('sign-up, the checklist and the FAQ all use these words', () => {
    const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');
    expect(read('components/onboarding/DocumentChecklist.tsx')).toMatch(/TAXI_TWO_LICENCES/);
    expect(read('components/onboarding/DocumentChecklist.tsx')).toMatch(/hint=\{taxiDocumentHint\(docType, checklist\)\}/);
    expect(read('modules/mover/screens/MoverOnboardingScreen.tsx')).toMatch(/TAXI_TWO_LICENCES/);
    expect(read('modules/profile/screens/FaqScreen.tsx')).toMatch(/TAXI_DOCUMENTS_FAQ/);
  });
});
