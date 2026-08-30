import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * §5.4 — THE GATE THAT STOPS IT DRIFTING BACK (first tranche).
 *
 * The build order asks for a design gate in CI: "nothing checks a built screen
 * against its design today, which is precisely how the drift happened the
 * first time." The full form is a storybook + pixel comparison, which needs a
 * simulator lane in CI (a registered infrastructure decision). This tranche is
 * the half that needs no renderer, in the suite's own static-gate idiom: the
 * two design laws Wave 3 just spent ~30 merges re-enforcing by hand are pinned
 * here so they cannot rot again, one file at a time, unnoticed.
 *
 *   LAW A — TOKENS, NOT RAW TYPE. No screen or module file names a font
 *   family or hardcodes a literal font size in a style: the kit and the
 *   tokens own type. (The burst found seven composers carrying 'Hanken'/15
 *   literals and one input with no family at all.)
 *
 *   LAW B — MONEY IS INK, NEVER BRAND. `<Money tone="brand">` dressed prices
 *   in maroon on five screens before the sweep. Maroon is spent on acts.
 *   One exemption, registered rather than silently decided: the Market tab,
 *   where the founder's reference (04-customer-market.png) draws the price in
 *   maroon — WS-3.6 makes that screenshot the binding spec, and the conflict
 *   with this law sits on the founder's board list until ruled.
 *
 * Grown here, not guessed: add new laws as sweeps close their violation
 * classes; never exempt a file without naming the register entry that owns
 * the conflict.
 */

const MODULES = join(process.cwd(), 'src/modules');

/** Every .tsx under src/modules, recursively. */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Comments stripped — they may quote the patterns under test. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');
}

const FILES = tsxFiles(MODULES);

describe('design drift gate [§5.4, tranche 1]', () => {
  it('scans a real tree', () => {
    // A gate that silently scanned nothing would pass forever.
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('LAW A — no raw font family or literal size outside the kit', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = code(f);
      // A quoted font family, or a hardcoded numeric fontSize, in any style.
      if (/fontFamily:\s*['"]/.test(src) || /fontSize:\s*\d/.test(src)) {
        offenders.push(f.slice(MODULES.length + 1));
      }
    }
    expect(
      offenders,
      'Raw type in a module file — use font.* / fontSize.* tokens (or a kit input). '
      + 'The kit and tokens own type; this is how the drift started last time.',
    ).toEqual([]);
  });

  it('LAW B — money is ink, never brand (Market exempt by register)', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      // The one registered exemption: the founder reference draws Market's
      // price in maroon (WS-3.6 binding screenshot; conflict on the board).
      if (f.endsWith('shop/screens/MarketScreen.tsx')) continue;
      const src = code(f);
      if (/<Money[^>]*tone="brand"/.test(src)) {
        offenders.push(f.slice(MODULES.length + 1));
      }
    }
    expect(
      offenders,
      '<Money tone="brand"> outside the registered Market exemption — money renders in ink; '
      + 'maroon is spent on acts (law 3). If a reference truly mandates it, register the '
      + 'conflict on the founder board before exempting the file here.',
    ).toEqual([]);
  });
});
