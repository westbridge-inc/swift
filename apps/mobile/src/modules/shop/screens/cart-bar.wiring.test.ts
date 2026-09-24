import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [E09] A shopper deep in browse (Search, a category feed, Nearby, Recommended)
// must still be able to reach the Cart tab after adding items. The pinned
// "View cart" bar is ONE kit component — CartBar — and every one of those
// surfaces renders it, alongside the storefront that gave birth to it. The
// screens import react-native, which Vitest cannot load, so this reads them
// as source (the repo's screen-test pattern).
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => strip(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const SCREENS: Array<{ name: string; path: string; jsx: string }> = [
  { name: 'SearchScreen', path: './SearchScreen.tsx', jsx: '<CartBar />' },
  { name: 'CategoryFeedScreen', path: './CategoryFeedScreen.tsx', jsx: '<CartBar />' },
  { name: 'NearbyScreen', path: './NearbyScreen.tsx', jsx: '<CartBar />' },
  { name: 'RecommendedScreen', path: './RecommendedScreen.tsx', jsx: '<CartBar />' },
  { name: 'RestaurantScreen', path: './RestaurantScreen.tsx', jsx: '<CartBar vendorId={vendorId} />' },
];

describe('[E09] every browse list leaves room for the floating bar', () => {
  // The storefront keeps its own layout; the four browse lists add the bar's
  // clearance to their bottom padding so the last row scrolls clear of it.
  for (const { name, path } of SCREENS.filter((x) => x.name !== 'RestaurantScreen')) {
    it(`${name} adds the cart-bar clearance to its list's bottom padding`, () => {
      const src = read(path);
      expect(src).toMatch(/const cartClearance = useCartBarClearance\(\);/);
      expect(src).toMatch(/paddingBottom: space\['3xl'\] \+ cartClearance/);
    });
  }
});

describe('the pinned View cart bar is one implementation on every browse surface', () => {
  it('is exported from the kit barrel', () => {
    const index = read('../../../kit/index.ts');
    expect(index).toContain("export * from './cart-bar';");
  });

  for (const { name, path, jsx } of SCREENS) {
    it(`${name} renders the shared CartBar`, () => {
      const src = read(path);
      expect(src, `${name} must render the shared CartBar`).toContain(jsx);
      expect((src.match(/<CartBar/g) ?? []).length, `${name} must not mount a second cart bar`).toBe(1);
    });
  }

  it('every screen imports the shared component from the kit barrel, not a local copy', () => {
    for (const { name, path } of SCREENS) {
      const src = read(path);
      expect(
        src,
        `${name} must import CartBar from the kit barrel`,
      ).toMatch(/import\s*\{[^}]*CartBar[^}]*\}\s*from\s*'\.\.\/\.\.\/\.\.\/kit'/);
    }
  });

  it('the storefront no longer carries its own inline cart bar', () => {
    const src = read('./RestaurantScreen.tsx');
    expect(src).not.toContain('cartCount');
    expect(src).not.toContain('View cart');
  });
});
