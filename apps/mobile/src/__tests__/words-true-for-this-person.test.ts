import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Words a person acts on, read at the source. They carry no logic to run; the point is that a false sentence cannot come back.
const read = (...path: string[]) => readFileSync(join(__dirname, '..', ...path), 'utf8');

describe('[BUG-HUNT F25 · owner ruling 15 Oct 2026] a taxi car carries passengers only', () => {
  const screen = read('modules', 'mover', 'screens', 'MoverOnboardingScreen.tsx');
  it('the vehicle picker never promises deliveries or loads for a car', () => {
    expect(screen).not.toMatch(/hint: 'Taxi \+/);
    for (const key of ['CAR', 'WAGON_CAR']) {
      const row = screen.split('\n').find((line) => line.includes(`key: '${key}'`))!;
      expect(row, key).toContain('passengers only');
      expect(row, key).toContain('H plate');
    }
  });
});

describe('[BUG-HUNT F16] the FAQ says what is so', () => {
  const faq = read('modules', 'profile', 'screens', 'FaqScreen.tsx');
  it('names MMG to the store beside cash', () => {
    expect(faq).toMatch(/pay the store by MMG/);
  });
  it('no guarantee or evidence review a customer has no path to; a refund comes from the business', () => {
    expect(faq).not.toMatch(/guarantee policy|GPS and photo evidence/);
    expect(faq).toMatch(/Any refund is made by the business/);
  });
});
