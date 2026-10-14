import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { documentLabel, isTaxiChecklist, taxiDocumentHint, TAXI_TWO_LICENCES } from './taxi-documents';

// [Owner ruling 11 Oct 2026 — HIRE LICENCE] two licences in plain words; no "H class" on the plastic licence.
const TAXI = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance', 'hire_car_driver_licence', 'hire_car_vehicle_licence', 'vehicle_exterior_photo', 'fitness_cert'];

describe('taxi documents on the website', () => {
  it('says both licences, the same words as the app', () => {
    const app = readFileSync(join(__dirname, '..', '..', '..', 'mobile', 'src', 'components', 'onboarding', 'taxiDocumentCopy.ts'), 'utf8');
    expect(app).toContain(TAXI_TWO_LICENCES);
    expect(TAXI_TWO_LICENCES).toMatch(/does not need to show a hire class/);
  });

  it('names and explains a taxi checklist only', () => {
    expect(documentLabel('hire_car_driver_licence')).toBe("Hire Car Driver's Licence");
    expect(documentLabel('road_service_licence')).toBe('Road Service Licence');
    expect(isTaxiChecklist(TAXI)).toBe(true);
    expect(taxiDocumentHint('drivers_licence', TAXI)).toMatch(/does not need to show a hire class/);
    expect(taxiDocumentHint('drivers_licence', ['drivers_licence', 'vehicle_registration'])).toBeUndefined();
  });

  it('sign-up, the documents page and the FAQ use it; the FAQ no longer asks a business for a TIN', () => {
    const read = (p: string) => readFileSync(join(__dirname, '..', 'app', p), 'utf8');
    expect(read('signup/page.tsx')).toMatch(/TAXI_TWO_LICENCES/);
    expect(read('portal/documents/page.tsx')).toMatch(/taxiDocumentHint\(docType/);
    const faq = read('(marketing)/faq/page.tsx');
    expect(faq).toMatch(/Hire Car Driver&apos;s Licence/);
    expect(faq).not.toMatch(/business registration, TIN/);
  });
});
