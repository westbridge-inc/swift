import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { money, moneyIn, moneyOrDash } from './money';

// ---------------------------------------------------------------------------
// [UI-MONEY-1] One currency, one spelling.
//
// This is a DRIFT law, not a style preference. `AdvertiserHomeScreen` used to
// export its own `money()` — shared with three sibling screens — that rendered
// the same GYD amount as `G$ 2,500` while 27 other screens rendered `$2,500`.
// Nothing was broken; nothing failed; the app simply spelled its own currency
// two ways depending on which tab you were standing in.
//
// A second formatter is easy to write and impossible to notice in review, so
// the rule is enforced here where it cannot be forgotten.
// ---------------------------------------------------------------------------

const SRC = process.cwd().endsWith('apps/mobile')
  ? join(process.cwd(), 'src')
  : join(process.cwd(), 'apps', 'mobile', 'src');

/** The one blessed definition. Everything else must import from it. */
const CANONICAL = join('lib', 'money.ts');

/** Comments talk ABOUT money(); only code calls it. A rule that fires on prose
 *  is a rule people learn to ignore. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('[UI-MONEY-1] the app has exactly one money formatter', () => {
  it('no file outside lib/money.ts defines its own money()', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => {
        const rel = file.slice(SRC.length + 1);
        if (rel === CANONICAL) return false;
        const source = code(readFileSync(file, 'utf8'));
        // `export function money(` / `export const money =` / `function money(`
        return /(?:export\s+)?(?:function\s+money\s*\(|const\s+money\s*[:=])/.test(source);
      })
      .map((file) => file.slice(SRC.length + 1).replace(/\\/g, '/'));

    expect(
      offenders,
      'A second money formatter drifts the currency spelling across tabs. Import { money, moneyIn, moneyOrDash } from lib/money instead.',
    ).toEqual([]);
  });

  it('every screen that shows a price imports the canonical module', () => {
    const usesMoney = sourceFiles(SRC).filter((f) => /\bmoney(?:In|OrDash)?\s*\(/.test(code(readFileSync(f, 'utf8'))));
    const notImporting = usesMoney.filter((f) => {
      const rel = f.slice(SRC.length + 1);
      if (rel === CANONICAL) return false;
      const s = code(readFileSync(f, 'utf8'));
      // it either imports from lib/money, or re-exports something that does
      return !/from '[^']*lib\/money'/.test(s) && !/\bmoney\b/.test(s.split('\n').filter((l) => l.startsWith('import')).join('\n'));
    }).map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));

    expect(notImporting, 'These call money() without importing it from lib/money.').toEqual([]);
  });
});

describe('[UI-MONEY-1] the canonical formatter keeps every capability it absorbed', () => {
  // The 27 existing screens' behaviour is unchanged — pinned by money.test.ts
  // too, but restated here because absorbing the advertiser copy must not have
  // moved it.
  it('GYD is the bare local $, as 27 screens already render it', () => {
    expect(money(2500)).toMatch(/^\$2.?500$/);
    expect(moneyIn(2500)).toBe(money(2500));
    expect(moneyIn(2500, 'GYD')).toBe(money(2500));
  });

  // Absorbed from the advertiser copy: a foreign total must never wear a bare
  // "$", which in this app means GYD everywhere else.
  it('a non-local currency is spelled out, never a bare $', () => {
    expect(moneyIn(2500, 'USD')).toMatch(/^USD 2.?500$/);
    expect(moneyIn(2500, 'USD')).not.toContain('$');
  });

  // Absorbed from the advertiser copy: absence is a dash, not a confident zero.
  it('an absent amount is a dash, and a real zero is still zero', () => {
    expect(moneyOrDash(null)).toBe('—');
    expect(moneyOrDash(undefined)).toBe('—');
    expect(moneyOrDash(0)).toBe('$0');
  });

  it('money() itself still treats absence as $0 — 27 screens depend on it', () => {
    expect(money(null)).toBe('$0');
    expect(money(undefined)).toBe('$0');
  });

  it('rounds to whole units in every variant (GYD has no sub-unit)', () => {
    expect(moneyIn(2.6)).toBe('$3');
    expect(moneyOrDash(2.4)).toBe('$2');
    expect(moneyIn(2.6, 'USD')).toBe('USD 3');
  });
});
