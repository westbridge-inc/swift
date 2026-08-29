import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { color } from '@swift/ui';

/**
 * A GROUND YOU CANNOT SEE IS NOT A QUIET GROUND — IT IS A MISSING ONE.
 *
 * Found by the Wave 3 audit of HomeScreen against reference 03. The screen
 * paints its page `color.surface.subtle` — the token file calls that one
 * "paper — the app background" — and then painted the seven non-flagship
 * service tiles with THE SAME TOKEN. So a deliberate design decision ("every
 * service sits on one quiet ground; Food alone wears the brand fill") rendered
 * as nothing at all: 56pt squares the exact colour of the paper behind them.
 *
 * The decision was right. The implementation silently did not deliver it, and
 * nothing failed, because a background painted in the background's own colour
 * is invisible rather than wrong-looking.
 *
 * The same slip sat on the hold-window track four hundred lines below: an
 * unfilled track at `subtle` on a white card is a 0.4% difference from the
 * card, so the window read as a floating maroon bar with no channel.
 *
 * `sunken` is the token for both — "grouped sections / tracks — 3% brand tint
 * on paper". This gate is scoped to the screen the audit covered rather than
 * the whole app: elsewhere `subtle` is often correctly a PAGE background, and a
 * blanket ban would be a rule nobody could keep.
 */

const SRC = join(process.cwd(), 'src');
const HOME = join(SRC, 'modules/shop/screens/HomeScreen.tsx');

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');
}

/** Relative luminance, for "can a person actually see this against that". */
function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

describe('a ground must be visible against the page', () => {
  // Graded as a RELATIONSHIP, never as literal hex: `scripts/ui-barrier.sh`
  // permanently forbids a brand hex outside packages/ui, and it is right to —
  // a literal here is how a second palette starts, test file or not. The
  // relationship is also the stronger assertion: pinning '#F7F5F3' would still
  // pass if someone edited it to the page colour, which is the exact bug this
  // file exists for.
  it('sunken is DARKER than the paper it sits on', () => {
    expect(luminance(color.surface.sunken)).toBeLessThan(luminance(color.surface.subtle));
  });

  it('and darker by enough to see', () => {
    // If these ever converge, every "quiet ground" in the app silently
    // disappears again and no test that merely named a token would notice.
    const delta = luminance(color.surface.subtle) - luminance(color.surface.sunken);
    expect(delta, 'a ground within rounding distance of the page is not a ground').toBeGreaterThan(0.005);
  });
});

describe('HomeScreen: a foreground is never painted in the page colour', () => {
  const src = code(HOME);

  it('the page still uses subtle — that is what it is for', () => {
    expect(src).toMatch(/flex: 1, backgroundColor: color\.surface\.subtle/);
  });

  it('the service tiles sit on sunken, so the ground renders', () => {
    expect(src).toMatch(/isFlagship \? color\.brand\[500\] : color\.surface\.sunken/);
    expect(
      src,
      'a tile ground at `subtle` is the page colour — the tile has no ground at all',
    ).not.toMatch(/isFlagship \? color\.brand\[500\] : color\.surface\.subtle/);
  });

  it('the hold-window track sits on sunken, so the channel renders', () => {
    expect(src).toMatch(/height: 4, borderRadius: 2, backgroundColor: color\.surface\.sunken/);
  });

  it('Food alone wears the brand fill [100x pass §5 — a founder decision]', () => {
    // NOT a drift to fix. The reference PNG predates it and the audit left it
    // alone: the grid used to give every service its own hue off the F-263
    // ramp, and the pass retired that deliberately. A rebuild that restored
    // the ramp would erase a recorded decision.
    expect(src).toMatch(/const isFlagship = item\.key === 'food';/);
    expect(src, 'exactly one tile is branded').toMatch(/isFlagship \? color\.brand\[500\]/);
  });

  it('the tile ramp stays retired — no per-vertical tint on the launcher', () => {
    expect(
      src,
      'vertical-tint is for surfaces that identify a vertical, not the Home grid [100x §5]',
    ).not.toMatch(/vertical-tint|verticalTint/);
  });
});
