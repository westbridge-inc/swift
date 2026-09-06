/**
 * [DOC-1 §30 · DOC-INV-43] test_no_hardcoded_fx_rate — no GYD/USD constant exists in code.
 *
 * The G$209 figure in the spec is a dated observation, never a constant. Runtime conversions
 * read `CountryConfig.usdExchangeRate` (the row). The seed's single anchor comes from the
 * environment and production refuses to seed without it; the dev/test fallback is ONE marked
 * line, and this census is what keeps it one.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { desiredPlatformConfig, seedFxRate, SEED_FX_ENV } from '../modules/ops/platform-config';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('[DOC-INV-43] no hard-coded FX rate', () => {
  it('test_no_hardcoded_fx_rate: the only 209 in src is the marked dev/test fallback; nothing divides or multiplies by a rate literal', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/\b209(\.0+)?\b/.test(line) && !/DOC-INV-43 fallback/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${file.replace(root, 'src')}:${i + 1}: ${line.trim()}`);
        // An FX-shaped literal (150–999, the range a GYD-per-USD peg lives in) used as a divisor or multiplier
        // on a line that talks about USD/GYD/FX. Cent rounding (/ 100) and percentages are not pegs.
        const peg = /[/*]\s*(1[5-9]\d|[2-9]\d\d)(\.\d+)?\b/;
        if (peg.test(line) && /(usd|gyd|\bfx\b)/i.test(line) && !/DOC-INV-43 fallback/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${file.replace(root, 'src')}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the seed anchor comes from the environment: a positive number is used, garbage is refused, production without it is refused, dev falls back to the dated observation', () => {
    expect(seedFxRate({ [SEED_FX_ENV]: '215.5', NODE_ENV: 'production' })).toBe(215.5);
    expect(() => seedFxRate({ [SEED_FX_ENV]: 'two hundred', NODE_ENV: 'test' })).toThrow(/positive number/);
    expect(() => seedFxRate({ [SEED_FX_ENV]: '-1', NODE_ENV: 'test' })).toThrow(/positive number/);
    expect(() => seedFxRate({ NODE_ENV: 'production' })).toThrow(/required to seed production/);
    expect(seedFxRate({ NODE_ENV: 'test' })).toBe(209);
  });

  it('the launch market row records the anchor the seed used; every USD-pegged market derives from it, not from a literal', () => {
    const desired = desiredPlatformConfig();
    const gy = desired.countries.find((c) => c.code === 'GY')!;
    expect((gy.policy as { usdExchangeRate: number }).usdExchangeRate).toBe(seedFxRate());
    const tt = desired.countries.find((c) => c.code === 'TT')!;
    expect((tt.policy as { usdExchangeRate: number }).usdExchangeRate).toBe(6.77);
    const original = process.env[SEED_FX_ENV];
    process.env[SEED_FX_ENV] = '418'; // double the rate → every derived local figure halves for the pegged markets
    try {
      const doubled = desiredPlatformConfig();
      const before = (tt.policy as { floatL1: number }).floatL1;
      const after = (doubled.countries.find((c) => c.code === 'TT')!.policy as { floatL1: number }).floatL1;
      expect(after).toBeLessThan(before);
      expect((doubled.countries.find((c) => c.code === 'GY')!.policy as { usdExchangeRate: number }).usdExchangeRate).toBe(418);
    } finally {
      if (original === undefined) delete process.env[SEED_FX_ENV]; else process.env[SEED_FX_ENV] = original;
    }
  });
});
