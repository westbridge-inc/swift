import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { statusClass } from './status';

// [FOLLOWUPS · brand colour, 30 Oct 2026] A pending status was a pill in the old bright red. Swift's brand is maroon
// (the @swift/ui brand token, the shipped app icon): the pill is now the admin's brand fill with its light text, readable on the dark
// admin (WCAG AA 4.5:1 for normal text). Red stays for bad/blocked statuses only.

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
// The admin does not depend on @swift/ui, so the brand maroon is read from the token authority's source (the one
// place a brand hex may live: scripts/ui-barrier.sh).
const tokens = readFileSync(join(process.cwd(), '../../packages/ui/src/tokens.ts'), 'utf8');
const BRAND_500 = /^\s*500: '(#[0-9A-Fa-f]{6})', \/\/ brand primary/m.exec(tokens)?.[1];
const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})\\s*;`).exec(css)?.[1];

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('statusClass: pending is the brand maroon, never the old bright red', () => {
  it('a pending status is the maroon brand fill with the light text', () => {
    for (const s of ['PENDING', 'PLACED', 'REVIEW', 'IN_REVIEW', 'UNVERIFIED']) {
      expect(statusClass(s)).toBe('bg-[var(--accent-deep)] text-[var(--text)]');
    }
  });

  it('those two tokens are the brand maroon and a light text that reads on it', () => {
    expect(BRAND_500).toMatch(/^#[0-9A-F]{6}$/);
    expect(token('accent-deep')).toBe(BRAND_500);
    expect(contrast(token('accent-deep')!, token('text')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('red stays for bad statuses, green for good ones', () => {
    expect(statusClass('FAILED')).toBe('bg-red-500/15 text-red-400');
    expect(statusClass('DELIVERED')).toBe('bg-green-500/15 text-green-400');
    expect(statusClass('anything else')).toBe('bg-white/10 text-[#8E8E93]');
  });
});
