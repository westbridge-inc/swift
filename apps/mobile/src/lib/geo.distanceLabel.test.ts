import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { distanceLabel } from './geo';

// ---------------------------------------------------------------------------
// [Q3] "Distances show as '41 mi'." They never did: no line of this app, the
// web app or the API writes miles. The Popular card's line was
// "TEST-Kitchen-One · 41 min" — an ETA — and it ran under the next card, which
// cut it to "41 mi" (the card fix is pinned in kit/food-card.fit.test.ts).
//
// What the search did turn up was two distance formatters that disagreed.
// Home had its own `kmLabel`: "<1 km" where Nearby, Search, the category feed
// and the store page printed the server's number ("0.4 km"), and
// `Number(null)` is 0, so a feed kept on screen from before the location fix
// (every distanceKm null) put "<1 km" on every store. One formatter now,
// metric, silent when the distance is unknown.
// ---------------------------------------------------------------------------

describe('distanceLabel — the one way a store distance is written', () => {
  it('is metric: kilometres, to the server’s 100 m', () => {
    expect(distanceLabel(0.4)).toBe('0.4 km');
    expect(distanceLabel(2.4)).toBe('2.4 km');
    expect(distanceLabel(2.36)).toBe('2.4 km');
    expect(distanceLabel(2)).toBe('2 km');
    expect(distanceLabel(41)).toBe('41 km');
  });

  it('says "<0.1 km" under 100 m — never "0 km"', () => {
    expect(distanceLabel(0)).toBe('<0.1 km');
    expect(distanceLabel(0.04)).toBe('<0.1 km');
    expect(distanceLabel(0.05)).toBe('0.1 km');
  });

  it('an unknown distance is silence — never "<1 km", never "0 km"', () => {
    for (const unknown of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, '2.4', {}, true]) {
      expect(distanceLabel(unknown), String(unknown)).toBeUndefined();
    }
  });
});

// Read as source: the screens pull in react-native, which Vitest cannot import.
const SRC = fileURLToPath(new URL('..', import.meta.url));
const SHOP = join(SRC, 'modules', 'shop');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('every store distance in the shop screens goes through it', () => {
  const files = sources(SHOP).map((f) => ({ rel: relative(SRC, f), code: strip(readFileSync(f, 'utf8')) }));

  it('the census actually reads the screens that show a distance', () => {
    // Without this, an empty walk would pass every rule below.
    const showing = files.filter((f) => /\bdistanceKm\b/.test(f.code)).map((f) => f.rel).sort();
    expect(showing).toEqual([
      'modules/shop/screens/CategoryFeedScreen.tsx',
      'modules/shop/screens/HomeScreen.tsx',
      'modules/shop/screens/NearbyScreen.tsx',
      'modules/shop/screens/RestaurantScreen.tsx',
      'modules/shop/screens/SearchScreen.tsx',
    ]);
  });

  it('every distanceKm a screen reads is handed straight to distanceLabel', () => {
    for (const { rel, code } of files) {
      const reads = code.match(/\bdistanceKm\b/g)?.length ?? 0;
      const formatted = code.match(/distanceLabel\(\s*[\w.?]*\bdistanceKm\s*\)/g)?.length ?? 0;
      expect(formatted, `${rel}: a store distance written without distanceLabel`).toBe(reads);
    }
  });

  it('no screen keeps a formatter of its own', () => {
    // (A provider's service radius — "within 5 km" — is a different quantity,
    // set by the provider, and already metric; this law is about how far a
    // store is from the customer.)
    for (const { rel, code } of files) {
      expect(code, rel).not.toMatch(/\bkmLabel\b/);
      expect(code, rel).not.toMatch(/distanceKm\s*\}\s*km\b|distanceKm\s*\)?\s*\+\s*['"`]\s*km/);
    }
  });
});

describe('nothing in the app writes miles', () => {
  it('no source line formats a distance in mi or miles', () => {
    const offenders = sources(SRC)
      .map((f) => ({ rel: relative(SRC, f), code: strip(readFileSync(f, 'utf8')) }))
      .filter(({ code }) => /[\d}]\s*mi\b|['"`]\s*mi['"`]|\bmiles?\b/i.test(code))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
