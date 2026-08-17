import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// [ELV-1 F-213] Source-level contract (the mobile Vitest harness has no RN
// renderer). The driver handover PIN is always 6 digits (ride-pin.ts
// randomInt(100000,1000000)); the Verify button must not enable on a
// truncated entry, or a driver burns handover attempts at the door.
const src = readFileSync(join(process.cwd(), 'src/modules/mover/screens/ActiveJobScreen.tsx'), 'utf8');

describe('driver PIN gate [F-213]', () => {
  it('gates Verify on the FULL code length, never a shorter magic number', () => {
    // The CodeInput declares the true length; the gate must reference it.
    expect(src).toMatch(/length=\{RIDE_PIN_LENGTH\}/);
    expect(src).toMatch(/pin\.length < RIDE_PIN_LENGTH/);
    // The old bug: a hardcoded < 4 (or any digit) against a 6-digit code.
    expect(src).not.toMatch(/pin\.length < \d/);
  });
});
