import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (c)] "Bicycle" means a pedal bike. Any bike with a motor (an e-bike or an
// e-scooter) signs up as a motorbike, with a motorbike's documents. The picker says so beside each choice (source
// assertions: the screen loads native modules). The keys, labels and order stay: the website mirrors them.
// ---------------------------------------------------------------------------

const SCREEN = readFileSync(join(process.cwd(), 'src/modules/mover/screens/MoverOnboardingScreen.tsx'), 'utf8');
const hintOf = (key: string) => new RegExp(`\\{ key: '${key}', label: '([^']+)', icon: '[^']+', hint: '([^']+)' \\}`).exec(SCREEN);

describe('[CHECKLIST-LEGAL (c)] the vehicle picker', () => {
  it('the bicycle is a pedal bike, with no motor', () => {
    const m = hintOf('BICYCLE');
    expect(m?.[1]).toBe('Bicycle');
    expect(m?.[2]).toMatch(/pedal/i);
    expect(m?.[2]).toMatch(/no motor/i);
  });

  it('the motorbike takes e-bikes and e-scooters too', () => {
    const m = hintOf('MOTORCYCLE');
    expect(m?.[1]).toBe('Motorbike');
    expect(m?.[2]).toMatch(/e-bikes and e-scooters/);
  });
});
