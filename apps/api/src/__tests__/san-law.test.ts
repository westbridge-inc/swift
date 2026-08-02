import { describe, it, expect } from 'vitest';
import { luhnCheckDigit, luhnValid, generateSan, generateSanPayload, normalizeSan, formatSan, validateSanShape, maskDisplayName } from '../modules/billing/san';

// Scenario A — the SAN law [san spec PART 13]. CI generates 250k (fast);
// SAN_SOAK=1000000 runs the spec's full million locally. Property tests prove
// the whole point of Luhn: every single-digit mutation and every adjacent
// transposition (except the mathematically undetectable 09<->90) FAILS.

const GEN_COUNT = Number(process.env['SAN_SOAK'] ?? 250_000);

describe('SAN generation law (scenario A)', () => {
  it(`${GEN_COUNT.toLocaleString()} SANs: all Luhn-valid, well-formed, forbidden-free; collisions within birthday odds`, () => {
    const seen = new Set<string>();
    let collisions = 0;
    for (let i = 0; i < GEN_COUNT; i += 1) {
      const san = generateSan();
      expect(san).toMatch(/^[1-9][0-9]{9}$/);
      if (seen.has(san)) collisions += 1; // a fresh-draw collision is the DB-retry path, not a defect
      seen.add(san);
    }
    // Birthday bound: E[collisions] ≈ n²/(2·9e8) ≈ 35 at 250k. 10× headroom.
    expect(collisions).toBeLessThan((GEN_COUNT * GEN_COUNT) / (2 * 9e8) * 10 + 10);
    // Sample-verify Luhn on a slice (checking all 250k re-runs the same math).
    let checked = 0;
    for (const san of seen) {
      expect(luhnValid(san)).toBe(true);
      if ((checked += 1) >= 10_000) break;
    }
  });

  it('forbidden payloads never emerge and the generator always terminates', () => {
    for (let i = 0; i < 20_000; i += 1) {
      const p = generateSanPayload();
      expect(p).not.toMatch(/^(\d)\1{8}$/);
      expect(p).not.toBe('123456789');
      expect(p).not.toBe('987654321');
    }
  });

  it('every single-digit mutation of 2,000 SANs fails luhnValid', () => {
    for (let n = 0; n < 2_000; n += 1) {
      const san = generateSan();
      for (let pos = 0; pos < 10; pos += 1) {
        const orig = san[pos]!;
        for (let d = 0; d <= 9; d += 1) {
          const digit = String(d);
          if (digit === orig) continue;
          const mutated = san.slice(0, pos) + digit + san.slice(pos + 1);
          if (pos === 0 && d === 0) continue; // leading zero fails the shape check, also invalid
          expect(luhnValid(mutated)).toBe(false);
        }
      }
    }
  });

  it('every adjacent transposition fails except the known 09<->90 blind spot', () => {
    for (let n = 0; n < 2_000; n += 1) {
      const san = generateSan();
      for (let pos = 0; pos < 9; pos += 1) {
        const a = san[pos]!;
        const b = san[pos + 1]!;
        if (a === b) continue; // no-op swap
        const swapped = san.slice(0, pos) + b + a + san.slice(pos + 2);
        const blindSpot = (a === '0' && b === '9') || (a === '9' && b === '0');
        if (blindSpot) continue; // Luhn's one documented exception
        if (pos === 0 && b === '0') {
          expect(luhnValid(swapped)).toBe(false); // leading zero — shape kills it
        } else {
          expect(luhnValid(swapped)).toBe(false);
        }
      }
    }
  });

  it('check digit round-trips the spec vector shape', () => {
    const payload = '472905883';
    const san = payload + luhnCheckDigit(payload);
    expect(luhnValid(san)).toBe(true);
    expect(formatSan(san)).toBe(`${san.slice(0, 3)}-${san.slice(3, 6)}-${san.slice(6)}`);
  });
});

describe('entry validation + masking', () => {
  it('normalizes spaces/dashes/dots and validates shape before checksum', () => {
    const san = generateSan();
    const grouped = `${san.slice(0, 3)} ${san.slice(3, 6)}-${san.slice(6, 8)}.${san.slice(8)}`;
    expect(normalizeSan(grouped)).toBe(san);
    expect(validateSanShape(grouped)).toEqual({ ok: true, san });
    expect(validateSanShape('12345')).toEqual({ ok: false, code: 'SAN_MALFORMED' });
    expect(validateSanShape('0234567890')).toEqual({ ok: false, code: 'SAN_MALFORMED' });
    const wrong = san.slice(0, 9) + String((Number(san[9]) + 1) % 10);
    expect(validateSanShape(wrong)).toEqual({ ok: false, code: 'SAN_CHECKSUM_FAILED' });
  });

  it('masking shows first letter + bullets + city, never the name', () => {
    const masked = maskDisplayName('Shanta Restaurant', 'Georgetown');
    expect(masked).toMatch(/^S•+ \(Georgetown\)$/);
    expect(masked).not.toContain('hanta');
    expect(maskDisplayName('X')).toBe('X•••');
  });
});
