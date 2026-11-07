// [CHAINS · REVIEW-M #2211] Staff see the weekly fee CHARGED: a custom rate (a chain deal) never above the tier rate.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chargedWeeklyFee } from './weekly-fee';

describe('chargedWeeklyFee (the biller\'s rule)', () => {
  it('the list rate when there is no custom rate', () => {
    expect(chargedWeeklyFee({ weeklyRate: 15000, customRate: null })).toBe(15000);
  });
  it('a custom rate under the list rate is charged', () => {
    expect(chargedWeeklyFee({ weeklyRate: 20000, customRate: '12000' })).toBe(12000);
  });
  it('a custom rate above the list rate is never shown as the fee: the lower list rate is charged', () => {
    expect(chargedWeeklyFee({ weeklyRate: '15000', customRate: 18000 })).toBe(15000);
  });
});

describe('census: no admin screen prints a custom rate as the fee', () => {
  const root = join(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  };
  walk(root);
  it('reads the fee through chargedWeeklyFee, never `customRate ?? weeklyRate`', () => {
    const offenders = files.filter((f) => /customRate\s*\?\?\s*\w*\.?weeklyRate/.test(readFileSync(f, 'utf8')));
    expect(files.length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
