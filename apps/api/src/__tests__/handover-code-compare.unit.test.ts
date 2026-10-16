import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// [Row 207] Every handover code is compared in constant time, through ONE
// helper. The delivery/pickup path already hashed both sides to fixed-length
// digests and compared them with timingSafeEqual; the taxi ride PIN
// (driver.routes.ts verify-pin) still used a plain `!==`, whose run time
// depends on how many leading characters of a guess are right.
// ---------------------------------------------------------------------------

const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return {
    ...real,
    timingSafeEqual: (a: Parameters<typeof real.timingSafeEqual>[0], b: Parameters<typeof real.timingSafeEqual>[1]) => {
      calls.count += 1;
      return real.timingSafeEqual(a, b);
    },
  };
});

import { handoverCodeMatches } from '../modules/handover/handover-security';

const SRC = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('[Row 207] handoverCodeMatches', () => {
  beforeEach(() => { calls.count = 0; });

  it('matches only the exact code', () => {
    expect(handoverCodeMatches('482913', '482913')).toBe(true);
    expect(handoverCodeMatches('482913', '482914')).toBe(false);
    expect(handoverCodeMatches('482913', '48291')).toBe(false);
    expect(handoverCodeMatches('482913', '4829130')).toBe(false);
    expect(handoverCodeMatches('482913', '')).toBe(false);
  });

  it('a missing secret never matches (not even an empty guess)', () => {
    expect(handoverCodeMatches(null, '')).toBe(false);
    expect(handoverCodeMatches(undefined, '482913')).toBe(false);
    expect(handoverCodeMatches('', '')).toBe(false);
  });

  it('every comparison goes through timingSafeEqual, wrong lengths included (no early exit)', () => {
    handoverCodeMatches('482913', '482913');
    handoverCodeMatches('482913', '000000');
    handoverCodeMatches('482913', '4');
    handoverCodeMatches('482913', '48291300000');
    expect(calls.count).toBe(4);
  });
});

describe('[Row 207] both handover paths use the one helper', () => {
  it('the taxi ride-PIN verify compares through handoverCodeMatches, never a plain !== / ===', () => {
    const routes = read('modules/driver/driver.routes.ts');
    expect(routes).toMatch(/handoverCodeMatches\(current\.ridePin, pin\)/);
    expect(routes).not.toMatch(/ridePin\s*[!=]==\s*pin\b/);
    expect(routes).not.toMatch(/\bpin\s*[!=]==\s*current\.ridePin/);
  });

  it('the delivery/pickup decision uses the same helper and keeps no second comparison of its own', () => {
    const decision = read('modules/handover/handover-decision.ts');
    expect(decision).toMatch(/handoverCodeMatches\(secret, proof\.code\)/);
    expect(decision).not.toMatch(/timingSafeEqual/);
  });
});
