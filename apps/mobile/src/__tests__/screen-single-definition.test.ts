import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';

/**
 * [R2, generalised] One screen, one definition, and every screen file reachable.
 *
 * `VendorSwiftNumberScreen` was defined TWICE: a 19-line stub at the canonical,
 * obvious path `modules/vendor/screens/VendorSwiftNumberScreen.tsx`, imported by
 * nothing — and the real ~200-line screen defined inline inside
 * `VendorStack.tsx:1110`, which is the one actually routed.
 *
 * The shipped screen was the richer one. The stub had the tidy doc comment and
 * the obvious filename.
 *
 * This is the founder's stated hazard in its most dangerous form. A session told
 * to "rebuild the vendor Swift Number screen" opens the file at the canonical
 * path, does good work, runs the suite green, and **ships a change no user can
 * ever see** — while the real screen drifts further inside a 4,902-line file.
 * Nothing fails. Nothing warns. The work is simply lost.
 *
 * `SWIFT_UI_BUILD_FOR_REAL.md` §7.5 says to generalise the manual check it
 * prescribes ("confirm there is exactly ONE definition, and that the file you
 * are about to edit is the one the navigator actually routes"). This is that
 * check, run on every commit instead of remembered.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    // A test file naming the component it tests is not a second definition.
    if (/\.test\.tsx?$/.test(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const rel = (f: string) => f.slice(SRC.length + 1);
const source = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

/**
 * Screen files nothing imports. Each entry needs a written reason, and the list
 * is audited from BOTH sides below — an entry that is no longer orphaned fails,
 * so it cannot outlive its reason.
 */
const ALLOWED_ORPHANS: Array<{ file: string; reason: string }> = [
  {
    file: 'modules/onboarding/OnboardingScreen.tsx',
    // Residue R6. Its three first-run carousel slides are still stock
    // photographs — it is also the single exemption in stock-photo-gate.ts,
    // awaiting founder brand art. Ship it or delete it is a founder decision,
    // so it is recorded here rather than quietly removed.
    reason: 'R6 — FOUNDER DECISION PENDING: ship the first-run carousel or delete it (needs brand art)',
  },
];

describe('a screen is defined in exactly one place', () => {
  it('no screen component name is declared in two files', () => {
    const defs = new Map<string, string[]>();
    for (const [file, text] of source) {
      for (const m of text.matchAll(/(?:export\s+)?(?:function|const)\s+(\w+Screen)\b/g)) {
        const name = m[1]!;
        defs.set(name, [...(defs.get(name) ?? []), rel(file)]);
      }
    }
    const duplicated = [...defs.entries()]
      .filter(([, where]) => new Set(where).size > 1)
      .map(([name, where]) => `${name}: ${[...new Set(where)].join(' AND ')}`);

    expect(
      duplicated,
      'A screen defined twice means an edit to one copy ships nothing. Resolve the duplicate ' +
        'in its own PR before writing any UI for that screen.',
    ).toEqual([]);
  });

  it('the scan is actually finding screens (guards the guard)', () => {
    // A regex that matched nothing would make the assertion above vacuous.
    const found = files.filter((f) => /(?:function|const)\s+\w+Screen\b/.test(source.get(f)!));
    expect(found.length).toBeGreaterThan(30);
  });
});

describe('every screen file is reachable', () => {
  /** Does anything import this file? Anchored on the path separator, because
   *  `MoverOnboardingScreen` must NOT satisfy a search for `OnboardingScreen` —
   *  a substring match here reported a real orphan as reachable. */
  function isImported(file: string): boolean {
    const name = basename(file).replace(/\.tsx?$/, '');
    const pattern = new RegExp(`from\\s+['"][^'"]*\\/${name}['"]`);
    for (const [other, text] of source) {
      if (other === file) continue;
      if (pattern.test(text)) return true;
    }
    return false;
  }

  const screenFiles = files.filter((f) => /Screen\.tsx?$/.test(basename(f)));
  const exempt = new Set(ALLOWED_ORPHANS.map((o) => o.file));

  it('no unexplained orphan screen files', () => {
    const orphans = screenFiles.map(rel).filter((f) => !exempt.has(f) && !isImported(join(SRC, f)));
    expect(
      orphans,
      'A screen file nothing imports renders to nobody. It is either dead code that reads as a ' +
        'missing feature, or — worse — a decoy at the canonical path shadowing the screen that ' +
        'actually ships.',
    ).toEqual([]);
  });

  it('every exemption is still genuinely orphaned', () => {
    for (const { file } of ALLOWED_ORPHANS) {
      const full = join(SRC, file);
      expect(source.has(full), `${file} is exempt but no longer exists — remove the exemption`).toBe(true);
      expect(
        isImported(full),
        `${file} is exempt as an orphan but something imports it now — remove the exemption`,
      ).toBe(false);
    }
  });

  it('every exemption carries a written reason', () => {
    for (const { file, reason } of ALLOWED_ORPHANS) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(30);
    }
  });
});
