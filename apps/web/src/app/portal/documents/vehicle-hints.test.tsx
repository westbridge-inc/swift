import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentsPage from './page';
import { renderWithQuery } from '@/test/test-utils';
import * as moverApi from '@/lib/mover-api';
import { DELIVERY_INSURANCE, MOTORBIKE_LICENCE, TAXI_INSURANCE } from '@/lib/vehicle-document-hints';

// ---------------------------------------------------------------------------
// [WEB-ONBOARDING · R13 · owner 15 Oct 2026] A rider or taxi driver used to learn the insurance rule from a rejection:
// every motor vehicle's insurance must permit use for hire or reward, and a person refuses a private-use policy
// (verification.service V_INSURANCE_SCOPE, INSURANCE_NOT_HIRE). The Documents page now says it under the insurance
// row before anything is uploaded, in the server's terms: a taxi's cover is for passengers carried for hire, a
// delivery rider's for commercial use. A motorbike rider's licence must cover motorcycles. A bicycle rider's list
// (a national ID only) gets none of these. Synthetic values only.
// ---------------------------------------------------------------------------

const MOTOR = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'];
const TAXI = [...MOTOR, 'hire_car_driver_licence', 'hire_car_vehicle_licence', 'vehicle_exterior_photo', 'fitness_cert'];
const status = (checklist: string[]) => ({ roleKey: 'MOVER', checklist, documents: [], missing: checklist, roleVerified: false });

function open(vehicleType: string, checklist: string[]) {
  vi.spyOn(moverApi, 'getRiderProfile').mockResolvedValue({ vehicleType } as never);
  vi.spyOn(moverApi, 'getVerificationStatus').mockResolvedValue(status(checklist) as never);
  renderWithQuery(<DocumentsPage />);
}

/** The words under one checklist row (its card), or null. */
async function hintUnder(label: string) {
  const title = await screen.findByText(label);
  return title.closest('.sw-card')?.querySelector('p.mt-1')?.textContent ?? null;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('[WEB-ONBOARDING] the Documents page says what the reviewer checks, before the upload', () => {
  it('a motorbike rider: insurance for hire or reward (commercial use), a licence that covers motorcycles', async () => {
    open('MOTORCYCLE', MOTOR);
    expect(await hintUnder('Vehicle Insurance')).toBe(DELIVERY_INSURANCE);
    expect(await hintUnder("Driver's licence")).toBe(MOTORBIKE_LICENCE);
    expect(await hintUnder('Certificate of Registration')).toBeNull();
  });

  it('a taxi driver: insurance covering passengers carried for hire; the licence keeps the taxi words', async () => {
    open('CAR', TAXI);
    expect(await hintUnder('Vehicle Insurance')).toBe(TAXI_INSURANCE);
    expect(await hintUnder("Driver's licence")).toMatch(/does not need to show a hire class/);
  });

  it('a bicycle rider: nothing about licences or insurance', async () => {
    open('BICYCLE', ['national_id']);
    expect(await hintUnder('National ID or Digital ID card')).toBeNull();
    expect(document.body.textContent).not.toMatch(/hire or reward|cover motorcycles/);
  });
});

describe('[WEB-ONBOARDING] the words are the server’s rule', () => {
  const api = (path: string) => readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'api', 'src', path), 'utf8');

  it('the reviewer refuses a private-use policy for every motor vehicle, and the rejection says hire or reward', () => {
    const service = api('modules/verification/verification.service.ts');
    expect(service).toContain("INSURANCE_NOT_HIRE: 'This policy does not permit use for hire or reward. Taxi work needs cover for passengers carried for hire; deliveries need cover for commercial use.");
    expect(service).toMatch(/EVERY motor vehicle, not only a taxi, needs insurance whose\s*\/\/ "Limitations as to use" permit use for hire or reward/);
    for (const words of [TAXI_INSURANCE, DELIVERY_INSURANCE]) expect(words).toMatch(/hire or reward/);
    expect(TAXI_INSURANCE).toMatch(/passengers carried for hire/);
    expect(DELIVERY_INSURANCE).toMatch(/commercial use/);
  });

  it('[perf] the lines live apart from taxi-documents, which the sign-up page loads up front', () => {
    const web = (path: string) => readFileSync(join(__dirname, '..', '..', '..', path), 'utf8');
    expect(web('lib/taxi-documents.ts')).not.toMatch(/hire or reward|cover motorcycles/);
    expect(web('app/signup/page.tsx')).not.toMatch(/vehicle-document-hints/);
  });

  it('a motorbike is on the licence-and-insurance list, a bicycle is not; the law asks a licence for the class of vehicle', () => {
    const classes = api('config/vehicle-classes.ts');
    expect(classes).toMatch(/type: 'MOTORCYCLE'[^\n]*\n[^\n]*docProfiles: \['MOVER_MOTOR'\]/);
    expect(classes).toMatch(/type: 'BICYCLE'[^\n]*\n[^\n]*docProfiles: \['MOVER_NO_LICENCE'\]/);
    expect(api('modules/ops/platform-config.ts')).toContain("MOVER_MOTOR: ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'],");
    expect(api('modules/verification/doc-registry.ts')).toContain('drivers_licence: \'Driver’s licence for the class of machine you drive on a road\'');
  });
});
