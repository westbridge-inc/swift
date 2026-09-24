import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [Q3] The owner's Home screenshot, 09-24, lines drawn through: a Popular card
// line run into its neighbour, the "0% fees" body cut at the right edge, a
// stray "·" under the search bar, and two labels on every category tile.
//
// The card and the tile are kit components and are rendered in
// kit/food-card.fit.test.ts. What Home itself owns is pinned here, read as
// source (the screen pulls in react-native, which Vitest cannot import).
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const HOME = strip(readFileSync(new URL('./HomeScreen.tsx', import.meta.url), 'utf8'));

describe('the "0% fees" row wraps inside its band', () => {
  it('the body sits in a flex: 1 column beside the icon, and neither line is held to one line', () => {
    // The column takes exactly the width the row has left after the icon, and
    // the text wraps inside it. A numberOfLines here, or a column that sizes
    // to its text instead of to the row, is how a line runs off the screen.
    expect(HOME).toMatch(
      /flexDirection: 'row', alignItems: 'flex-start', gap: space\.sm \}\}>\s*<Feather name="check-circle"[^>]*\/>\s*<View style=\{\{ flex: 1 \}\}>\s*<T variant="bodyStrong">0% fees, always\.<\/T>\s*<T variant="caption" tone="muted" style=\{\{ marginTop: 2 \}\}>\s*Swift never marks up your order — pay cash when it arrives\.\s*<\/T>\s*<\/View>/,
    );
  });
});

describe('each category tile draws its name once', () => {
  const start = HOME.indexOf('title="Find by category"');
  const section = HOME.slice(start, HOME.indexOf('</>', start));

  it('the section is still on Home', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('the tiles are the kit CategoryTile — no hand-built photo with a second label on top', () => {
    expect(section).toMatch(/<CategoryTile\s+name=\{item\.name\}\s+image=\{categoryPhoto\(item\)\}/);
    // The old tile put a Photo (whose placeholder draws the name) under its
    // own white label. Neither may come back here.
    expect(section).not.toMatch(/<Photo\b/);
    expect(section).not.toMatch(/<T\b/);
  });
});

describe('a separator dot on Home is only ever drawn between two parts that say something', () => {
  it('every "·" is a filtered join — never interpolated beside a part that may be empty', () => {
    // `[a, b].filter(Boolean).join(' · ')` drops an empty part together with
    // its dot. An interpolated `${a} · ${b}` keeps the dot when a part is
    // empty — the shape of a stray "·".
    const dots = HOME.match(/·/g)?.length ?? 0;
    const joins = HOME.match(/\.filter\(Boolean\)\s*\.join\(' · '\)/g)?.length ?? 0;
    expect(dots).toBeGreaterThan(0);
    expect(joins).toBe(dots);
  });
});
