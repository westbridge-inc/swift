import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGE_TICK_LABEL } from './ageTickCopy';

// ---------------------------------------------------------------------------
// [Owner ruling 15 Oct 2026] The phone sign-up (build 12) carries a required, unticked "I am 18 or older"
// tick. The words are the ones the API anchors the consent-ledger row to, and the Register button stays
// off until it is ticked. Builds 9-11 have no tick; the server still admits them (no field sent).
// ---------------------------------------------------------------------------

const API_AGE = readFileSync(join(process.cwd(), '..', 'api', 'src', 'modules', 'auth', 'age-declaration.ts'), 'utf8');
const SCREEN = readFileSync(join(process.cwd(), 'src', 'screens', 'auth', 'RegisterScreen.tsx'), 'utf8');

describe('the phone sign-up 18+ tick', () => {
  it('says the words the API records, word for word', () => {
    expect(/export const AGE_DECLARATION_V1 = '([^']+)';/.exec(API_AGE)?.[1]).toBe(AGE_TICK_LABEL);
  });

  it('starts unticked, is shown with those words, and is sent as ticked', () => {
    expect(SCREEN).toMatch(/const \[adult, setAdult\] = useState\(false\);/);
    expect(SCREEN).toMatch(/\{AGE_TICK_LABEL\}/);
    expect(SCREEN).toMatch(/accessibilityRole="checkbox"\s+accessibilityState=\{\{ checked: adult \}\}/);
    expect(SCREEN).toMatch(/ageConfirmed: adult,/);
  });

  it('Register stays off until both ticks are given', () => {
    expect(SCREEN).toMatch(/const valid = [^\n]*&& agreed && adult;/);
  });
});
