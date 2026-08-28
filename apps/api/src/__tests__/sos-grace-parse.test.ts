import { describe, expect, it } from 'vitest';
import { parseGraceSeconds } from '../modules/safety/sos.service';

// [REPORT-036 F036-06 · S1] A malformed SOS_CANCEL_GRACE_SECONDS used to make
// graceEndsAt an Invalid Date — Prisma rejects it, so ONE bad env var 5xx'd
// every normal SOS creation. The parse must be total: any input yields a
// finite value in [0, 5], and the VALID 0 (skip-grace) survives.
describe('SOS grace parse is total [F036-06]', () => {
  it('garbage selects the default instead of poisoning the timestamp', () => {
    expect(parseGraceSeconds('not-a-number')).toBe(3);
    expect(parseGraceSeconds('3s')).toBe(3);
    expect(parseGraceSeconds('')).toBe(0); // Number('') is 0 — a real, valid value
    expect(parseGraceSeconds(undefined)).toBe(3);
    expect(parseGraceSeconds('NaN')).toBe(3);
    expect(parseGraceSeconds('Infinity')).toBe(3);
  });

  it('valid values pass through, clamped to [0, 5]', () => {
    expect(parseGraceSeconds('0')).toBe(0); // 0 = skip grace, deliberately valid
    expect(parseGraceSeconds('2')).toBe(2);
    expect(parseGraceSeconds('5')).toBe(5);
    expect(parseGraceSeconds('10')).toBe(5);
    expect(parseGraceSeconds('-4')).toBe(0);
  });

  it('every possible output is a finite number a Date can carry', () => {
    for (const raw of ['x', '', '1e309', '-Infinity', '4.5', undefined]) {
      const n = parseGraceSeconds(raw);
      expect(Number.isFinite(n)).toBe(true);
      expect(Number.isFinite(new Date(Date.now() + n * 1000).getTime())).toBe(true);
    }
  });
});
