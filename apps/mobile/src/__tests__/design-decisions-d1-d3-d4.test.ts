import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { color, elevation, fontSize, lineHeight, shadow } from '@swift/ui';

/**
 * THE THREE DESIGN DRIFTS, DECIDED AND NAILED DOWN.
 *
 * `SWIFT_FIX_EVERYTHING.md` Part 7 carried D1/D3/D4 as open founder calls, and
 * Part 5 lists them as a hard gate on Wave 3 — the 50-screen rebuild — because
 * a screen built on an undecided token gets built twice. They are now decided.
 * This file is what keeps them decided: a drift that has been resolved once and
 * is not gated simply regrows, which is how each of these became a drift.
 *
 *   D1  card shadow  → elevation's 6/14 geometry with the platform's WARM ink
 *   D3  dark palette → derived from the functional tokens, never a second set
 *   D4  input 16px   → a NAMED step, because 16 is the mobile-Safari zoom floor
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Comments stripped — the standing hazard-matching rule. The comments in these
 *  files necessarily quote the very values being banned. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');
}

const files = walk(SRC);
const rel = (f: string) => f.slice(SRC.length + 1);

describe('D1 — the card shadow has ONE author', () => {
  it('web and native resolve to the same shadow', () => {
    // They disagreed: `shadow.card` was 1/3 pure black while `elevation.card`
    // was 6/14 cold black. A card looked different depending on which token a
    // surface reached for.
    expect(elevation.card.boxShadow).toBe(shadow.card);
  });

  it('uses the 6/14 geometry and the platform WARM ink', () => {
    // Pinned literally rather than derived — deriving it would make this test
    // agree with whatever someone typed into the token.
    expect(shadow.card).toBe('0px 6px 14px rgba(33,26,26,0.08)');
    // The warm ink is not a new colour: it IS the platform scrim's black.
    expect(color.scrim.startsWith('rgba(33,26,26')).toBe(true);
  });

  it('no screen or primitive hand-rolls a card-like shadow', () => {
    // The third author lived in kit/card.tsx as `0px 4px 12px rgba(33,26,26,0.06)`
    // and was the one that actually rendered. Any `boxShadow:` literal outside
    // the token layer is a fourth.
    const offenders = files.filter((f) => /boxShadow:\s*'/.test(code(f))).map(rel);
    expect(
      offenders,
      'import `elevation` from @swift/ui — a second shadow literal is how this drifted three ways',
    ).toEqual([]);
  });
});

describe('D3 — one palette, derived', () => {
  it('the earner surface derives every colour from the functional tokens', () => {
    // `dk` is a semantic ALIAS layer for the dark earner surfaces, not a second
    // palette — it must never introduce a raw colour of its own.
    const src = code(join(SRC, 'modules/mover/surface.tsx'));
    const hexes = src.match(/#[0-9A-Fa-f]{6}\b/g) ?? [];
    expect(hexes, 'surface.tsx must alias tokens, never mint colours').toEqual([]);
  });

  it('the kit holds no second palette', () => {
    const exempt = new Set(LITERAL_COLOUR_ALLOWED.map((r) => r.file));
    const offenders = files
      .filter((f) => rel(f).startsWith('kit/'))
      .filter((f) => !exempt.has(rel(f)))
      .filter((f) => /#[0-9A-Fa-f]{6}\b/.test(code(f)))
      .map(rel);
    expect(
      offenders,
      'raw hex in the kit — add it to `color.dark` / the tokens, or claim an exemption with a reason',
    ).toEqual([]);
  });

  it('the dark values live in ONE place', () => {
    // They were inlined in three kit files. Named once, they can be reviewed,
    // contrast-checked and changed together.
    expect(color.dark.field).toBeTruthy();
    expect(color.dark.pressed).toBeTruthy();
    for (const k of ['onBrandFill', 'onSuccessFill', 'onErrorFill', 'onWarningFill', 'onInfoFill'] as const) {
      expect(color.dark[k], `${k} must be a named token`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

/**
 * Files allowed to hold literal colours, each with a reason a reviewer can
 * check. These are not UI surfaces: they are artwork and a third-party render
 * format, where a "token" would be a fiction.
 */
const LITERAL_COLOUR_ALLOWED: Array<{ file: string; why: string }> = [
  {
    file: 'kit/vertical-tint.ts',
    why: 'the identity-colour vertical ramp — law 5 names it as the one sanctioned set of literal hues, one per vertical, and each is chosen against the maroon rather than derived from it',
  },
  {
    file: 'kit/vehicle-render.tsx',
    why: 'SVG vehicle ILLUSTRATION — silver body, glass, tyre rubber and the luminance-derived outline are drawing values, not interface colours; tokenising them would put artwork in the design system',
  },
  {
    file: 'kit/map-style.ts',
    why: "the Google Maps JSON style array — a third-party renderer's own format, consumed verbatim by the map SDK and never applied to a Swift surface",
  },
];

describe('the literal-colour exemptions are audited from both sides', () => {
  it('every exempt file still exists', () => {
    for (const { file } of LITERAL_COLOUR_ALLOWED) {
      expect(files.map(rel), `${file} is exempt but no longer exists`).toContain(file);
    }
  });

  it('every exemption carries a written reason', () => {
    for (const { file, why } of LITERAL_COLOUR_ALLOWED) {
      expect(why.length, `${file} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('an exemption that no longer holds literals must be removed', () => {
    for (const { file } of LITERAL_COLOUR_ALLOWED) {
      expect(
        /#[0-9A-Fa-f]{6}\b/.test(code(join(SRC, file))),
        `${file} no longer holds a literal colour — delete its exemption`,
      ).toBe(true);
    }
  });
});

describe('D4 — the input step is named', () => {
  it('16 is on the scale, with a line height to match', () => {
    // It was absent: the scale ran 15 → 17 straight past it, so the input's
    // hard-coded 16 looked like a mistake and invited "tidying" onto `base`.
    expect(fontSize.input).toBe(16);
    expect(lineHeight.input).toBeGreaterThanOrEqual(fontSize.input);
  });

  it('16 is BELOW nothing on the scale by accident — it sits between base and lg', () => {
    // Guards the reason it exists: 16 is the mobile-Safari zoom floor. If some
    // future edit drops `base` to 16 or raises it past 16, the named step has
    // silently stopped meaning anything.
    expect(fontSize.base).toBeLessThan(fontSize.input);
    expect(fontSize.input).toBeLessThan(fontSize.lg);
  });

  it('the input primitive uses the named step, not a bare 16', () => {
    const src = code(join(SRC, 'kit/input.tsx'));
    expect(src).toMatch(/fontSize:\s*fontSize\.input/);
    expect(src, 'a bare 16 here is the drift coming back').not.toMatch(/fontSize:\s*16\b/);
  });

  it('the wrapper owns the height — the two constraints no longer fight', () => {
    // `paddingVertical: 14` asked for 50 inside a `minHeight: 52` wrapper, so
    // the padding never won. One of them has to own it.
    const src = code(join(SRC, 'kit/input.tsx'));
    expect(src).toMatch(/minHeight:\s*52/);
    expect(src, 'the dead padding is gone; the wrapper centres its children').not.toMatch(/paddingVertical:\s*14/);
  });
});
