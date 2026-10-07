import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [WEB-REDESIGN · review S2] A two-column page (main + a fixed side column)
// may only split at a width where, beside the 280 px side rail and the page's
// gutters, the MAIN column still has real room. Splitting at 760 px left it
// 0 px wide (760 − 280 − 80 − 380 − gap < 0). This reads the layout from the
// source itself — the rail's width, the gutters, the breakpoint each page
// splits at, its side column and its gap — and does the arithmetic.
// ---------------------------------------------------------------------------

const WEB = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(WEB, path), 'utf8');
const MIN_MAIN = 360;
const REM = 16;

function railWidth(): number {
  const shell = read('src/components/customer-shell.tsx');
  const width = shell.match(/wide:w-\[(\d+)px\]/);
  expect(width, 'the side rail declares its width').not.toBeNull();
  return Number(width![1]);
}

function wideGutters(): number {
  const css = read('src/app/globals.css');
  const rule = css.match(/@media \(min-width: 47\.5rem\) \{\s*\.sw-page \{ padding: \d+px (\d+)px/);
  expect(rule, 'the page gutters from 760 px').not.toBeNull();
  return Number(rule![1]) * 2;
}

function breakpointPx(name: string): number {
  const css = read('src/app/globals.css');
  const value = css.match(new RegExp(`--breakpoint-${name}:\\s*([\\d.]+)rem`));
  expect(value, `--breakpoint-${name}`).not.toBeNull();
  return Number(value![1]) * REM;
}

/** Every @media (min-width: Xrem) block of a CSS module that sets a fixed side column. */
function cssSplits(path: string): Array<{ at: number; side: number; gap: number }> {
  const css = read(path);
  const baseGap = (() => {
    const page = css.match(/\n\.page \{([^}]*)\}/)?.[1] ?? '';
    const gap = page.match(/(?:^|\s)gap:\s*(\d+)px(?:\s+(\d+)px)?/);
    return gap ? Number(gap[2] ?? gap[1]) : 0;
  })();
  const out: Array<{ at: number; side: number; gap: number }> = [];
  for (const block of css.matchAll(/@media \(min-width: ([\d.]+)rem\) \{([\s\S]*?)\n\}/g)) {
    const side = block[2]!.match(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+(\d+)px/);
    if (!side) continue;
    const gap = block[2]!.match(/column-gap:\s*(\d+)px/);
    out.push({ at: Number(block[1]) * REM, side: Number(side[1]), gap: gap ? Number(gap[1]) : baseGap });
  }
  return out;
}

const mainColumn = (split: { at: number; side: number; gap: number }) => split.at - railWidth() - wideGutters() - split.side - split.gap;

describe('[WEB-REDESIGN] two-column pages split only where the main column has room', () => {
  it.each([
    ['the cart', 'src/app/(app)/cart/cart.module.css'],
    ['order tracking', 'src/app/(app)/orders/[id]/tracking.module.css'],
  ])('%s', (_name, path) => {
    const splits = cssSplits(path);
    expect(splits.length, 'the page has a two-column layout').toBeGreaterThan(0);
    for (const split of splits) expect(mainColumn(split), `split at ${split.at}px`).toBeGreaterThanOrEqual(MIN_MAIN);
  });

  it('Send (the courier page) splits its Tailwind grid only where the main column has room', () => {
    const page = read('src/app/(app)/courier/page.tsx');
    const grid = page.match(/className="([^"]*grid-cols-\[minmax\(0,1fr\)_(\d+)px\][^"]*)"/);
    expect(grid, 'Send has a two-column grid').not.toBeNull();
    const classes = grid![1]!.split(/\s+/);
    const split = classes.find((name) => /^[a-z]+:grid-cols-\[minmax\(0,1fr\)_\d+px\]$/.test(name));
    expect(split, 'the split is behind a named breakpoint').toBeDefined();
    const at = breakpointPx(split!.split(':')[0]!);
    const gapClass = classes.find((name) => /^gap-x-\d+$/.test(name));
    const gap = gapClass ? Number(gapClass.slice('gap-x-'.length)) * 4 : 0;
    expect(mainColumn({ at, side: Number(grid![2]), gap }), `split at ${at}px`).toBeGreaterThanOrEqual(MIN_MAIN);
    // The fee column only sticks once it sits beside the form.
    const sticky = page.match(/className="[^"]*\b([a-z]+):sticky\b/);
    expect(sticky?.[1], 'the side column sticks at the same breakpoint it splits at').toBe(split!.split(':')[0]);
  });

  it('the split breakpoint itself leaves room for a 380 px side column with a 48 px gap', () => {
    expect(mainColumn({ at: breakpointPx('split'), side: 380, gap: 48 })).toBeGreaterThanOrEqual(MIN_MAIN);
  });
});
