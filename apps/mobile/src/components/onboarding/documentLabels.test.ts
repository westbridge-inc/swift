import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [Owner ruling 2026-10-01] A yellow car is NOT a requirement for a taxi; the H
// plate stays required. The document checklist is where a driver reads what the
// exterior photo must show, so its label asks for the plate and never a colour.
// Source assertions (the house pattern for component contracts). The names
// live in docLabels.ts (UI-SWEEP U73: moved out of DocumentUploadCard.tsx so a
// screen can name a document without loading the card's native modules).
// ---------------------------------------------------------------------------

const FILE = join(process.cwd(), 'src/components/onboarding/docLabels.ts');

function docLabels(): Record<string, string> {
  const src = readFileSync(FILE, 'utf8');
  const block = /const DOC_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error('DOC_LABELS not found in docLabels.ts');
  const labels = Object.fromEntries(
    [...block[1]!.matchAll(/^\s*([a-z_]+):\s*(['"])(.*)\2,\s*$/gm)].map((m) => [m[1]!, m[3]!]),
  );
  // a parse that found nothing would make every assertion below vacuous
  if (Object.keys(labels).length < 10) throw new Error('DOC_LABELS parse found too few labels');
  return labels;
}

describe('[owner ruling 2026-10-01] the exterior photo asks for the plate, never a colour', () => {
  // [VERIFY-DOCS · ruling 5, 6 Oct 2026] the one car photo replaces the separate plate photo
  it('reads "Car photo (plate clearly visible)"', () => {
    expect(docLabels()['vehicle_exterior_photo']).toBe('Car photo (plate clearly visible)');
  });

  it('[VERIFY-DOCS · ruling 4] the national ID label accepts the Digital ID card', () => {
    expect(docLabels()['national_id']).toBe('National ID or Digital ID card');
    expect(docLabels()['owner_national_id']).toBe('Owner National ID or Digital ID card');
  });

  it('[VERIFY-DOCS · ruling 8] the two licences that replace the hire-car permit are named for what the driver holds', () => {
    expect(docLabels()['hire_car_driver_licence']).toBe("Hire Car Driver's Licence");
    expect(docLabels()['hire_car_vehicle_licence']).toBe("Car's Hire Licence (yearly, shown on the car)");
  });

  it('no document label asks for a colour', () => {
    for (const [docType, label] of Object.entries(docLabels())) {
      expect(label, docType).not.toMatch(/yellow|colou?r/i);
    }
  });
});

describe('[TRADES · 13 Oct 2026; R15] service-trade documents read in plain words, never as a raw code', () => {
  it.each([
    ['pest_control_operator_licence', /Pest-Control Operator Licence/],
    ['pesticide_applicator_certificate', /Applicator Certificate/],
    ['eating_house_registration', /Eating-House Registration \(Georgetown\)/],
    ['gei_electrical_licence', /GEI Electrical Licence/],
  ])('%s', (docType, label) => {
    expect(docLabels()[docType]).toMatch(label);
  });

  // [R15] the held trades' documents (Town Clerk, ICAG, GRA practice, GCAA drone) are not asked for
  it.each(['chartered_accountant_practising_certificate', 'gra_practice_certificate', 'town_clerk_registration', 'town_clerk_shop_certificate', 'drone_authorisation'])('%s has no label of its own', (docType) => {
    expect(docLabels()[docType]).toBeUndefined();
  });
});
