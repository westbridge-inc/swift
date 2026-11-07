import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BIKE_WITH_A_MOTOR } from '@/lib/bike-with-a-motor';
import { MOVER_VEHICLES } from '@/lib/signup-roles';
import { VEHICLE_DOCUMENTS } from '@/lib/vehicle-documents';

// [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (c)] "Bicycle" means a pedal bike; any bike with a motor (an e-bike or an
// e-scooter) signs up as a motorbike, with a motorbike's documents. Said where a rider picks a vehicle (four-roles.test
// renders it) and on the riders' page. The vehicle names stay the app's (four-roles.test.tsx).
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('[CHECKLIST-LEGAL (c)] a bicycle is a pedal bike', () => {
  it('the words', () => {
    expect(BIKE_WITH_A_MOTOR).toMatch(/^Bicycle means a pedal bike\./);
    expect(BIKE_WITH_A_MOTOR).toMatch(/e-bike or an e-scooter, signs up as a motorbike/);
    expect(BIKE_WITH_A_MOTOR).toMatch(/driver’s licence, the registration and insurance/);
    expect(MOVER_VEHICLES.RIDER.map((v) => v.label)).toEqual(['Motorbike', 'Bicycle']);
  });

  it('the riders\' page says it on the vehicle cards (lib/vehicle-documents)', () => {
    const note = (vehicle: string) => VEHICLE_DOCUMENTS.find((v) => v.vehicle === vehicle)?.note;
    expect(note('Bicycle rider')).toContain('Pedal bicycles only.');
    expect(note('Motorbike rider')).toContain('A bicycle with any kind of motor signs up as a motorbike.');
    expect(read('src/app/(marketing)/drivers/page.tsx')).toContain('{v.note}');
  });

  // The sign-up page's first load has no room (scripts/perf-budget.json), and only a rider ever reads this sentence.
  // signup-roles is in that first load, so the words live in their own file, which the on-demand vehicle step imports.
  it('the words ride in the on-demand partner steps, never in the sign-up page\'s first load', () => {
    const importers = ['src/app/signup/page.tsx', 'src/lib/signup-roles.ts'].map(read);
    for (const source of importers) expect(source).not.toMatch(/BIKE_WITH_A_MOTOR|Bicycle means a pedal bike/);
    expect(read('src/app/signup/partner-steps.tsx')).toContain("import { BIKE_WITH_A_MOTOR } from '@/lib/bike-with-a-motor';");
    expect(read('src/lib/bike-with-a-motor.ts').split('\n').filter((line) => /^import\s/.test(line))).toEqual([]);
  });
});
