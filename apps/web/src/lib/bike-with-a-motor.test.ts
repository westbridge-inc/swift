import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BIKE_WITH_A_MOTOR, MOVER_VEHICLES } from '@/lib/signup-roles';

// [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (c)] "Bicycle" means a pedal bike; any bike with a motor (an e-bike or an
// e-scooter) signs up as a motorbike, with a motorbike's documents. Said where a rider picks a vehicle and on the
// riders' page. The vehicle names stay the app's (four-roles.test.tsx).
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\s+/g, ' ');

describe('[CHECKLIST-LEGAL (c)] a bicycle is a pedal bike', () => {
  it('the words', () => {
    expect(BIKE_WITH_A_MOTOR).toMatch(/^Bicycle means a pedal bike\./);
    expect(BIKE_WITH_A_MOTOR).toMatch(/e-bike or an e-scooter, signs up as a motorbike/);
    expect(BIKE_WITH_A_MOTOR).toMatch(/driver’s licence, the registration and insurance/);
    expect(MOVER_VEHICLES.RIDER.map((v) => v.label)).toEqual(['Motorbike', 'Bicycle']);
  });

  it('the rider\'s vehicle step shows them (the taxi step keeps its own words)', () => {
    const page = read('src/app/signup/page.tsx');
    const taxiBranch = page.indexOf('{mover === \'DRIVER\' ? (');
    const shown = page.indexOf('{BIKE_WITH_A_MOTOR}');
    expect(taxiBranch).toBeGreaterThan(-1);
    expect(shown).toBeGreaterThan(taxiBranch);
    expect(page.slice(taxiBranch, shown)).toContain(') : (');
  });

  it('the riders\' page says it too', () => {
    expect(read('src/app/(marketing)/drivers/page.tsx')).toContain('Riding a pedal bicycle? You will not be asked for a licence, registration or motor insurance. A bike with a motor, such as an e-bike or an e-scooter, signs up as a motorbike, with a motorbike&apos;s licence, registration and insurance.');
  });
});
