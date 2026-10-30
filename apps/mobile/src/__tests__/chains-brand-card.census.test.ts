import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [CHAINS PR3 · owner 29 Oct 2026] One brand card per chain, and the storefront lets the customer pick another
// branch. The server chooses which branch a brand card opens; the phone says it:
//  - every store card the lists draw reads the brand's name and its branch line (lib/brandCard), from the card's own
//    `brand` (home, nearby, category feed, recommended, search);
//  - the storefront asks with the customer's place (so a branch can say it delivers to them) and offers the brand's
//    other branches, each opening its own store page.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('[CHAINS] the brand card on every store list', () => {
  it('the kit cards read the brand title and line', () => {
    const kit = read('kit/food.tsx');
    expect(kit.match(/const title = brandTitle\(name, brand\);/g)?.length).toBe(3);
    expect(kit.match(/const branchLine = brandLine\(brand, place\);/g)?.length).toBe(3);
    // …and each card's title line draws that title (never the branch's own name) and the branch line under it.
    expect(kit.match(/>\n\s*\{title\}\n\s*<\/T>/g)?.length).toBe(3);
    expect(kit.match(/\{branchLine \? <T variant="(?:micro|caption)" tone="(?:muted|onBrand)" numberOfLines=\{1\}>\{branchLine\}<\/T> : null\}/g)?.length).toBe(3);
    const search = read('modules/shop/screens/SearchScreen.tsx');
    expect(search).toMatch(/const title = brandTitle\(name, brand\);/);
  });
  for (const [file, count] of [['HomeScreen.tsx', 5], ['SearchScreen.tsx', 2], ['CategoryFeedScreen.tsx', 1], ['NearbyScreen.tsx', 1], ['RecommendedScreen.tsx', 1]] as const) {
    it(`${file} hands every store card its brand`, () => {
      const text = read(`modules/shop/screens/${file}`);
      expect(text.match(/brand=\{v\.brand\}\n\s*place=\{v\.addressLine1 \?\? v\.city\}/g)?.length).toBe(count);
    });
  }
});

describe('[CHAINS] the storefront branch switcher', () => {
  const screen = read('modules/shop/screens/RestaurantScreen.tsx');
  it('asks with the customer\'s place, without changing the cache key the favourite toggle writes', () => {
    expect(screen).toMatch(/useVendor<any>\(vendorId, here \? \{ lat: here\.latitude, lng: here\.longitude \} : null\)/);
    expect(read('services/api.ts')).toMatch(/api\.get\(`\/customer\/vendors\/\$\{id\}`, point \? \{ params: \{ lat: point\.lat, lng: point\.lng \} \} : undefined\)/);
    expect(read('hooks/customer.ts')).toMatch(/queryKey: customerKeys\.vendor\(id\),\n\s*queryFn: \(\) => unwrap<T>\(customerApi\.getVendor\(id, point\)\)/);
  });
  it('offers the brand\'s branches, each opening its own store page', () => {
    expect(screen).toMatch(/\{showsBranchSwitcher\(v\.brand\) \? \(/);
    expect(screen).toMatch(/afterDismiss\(\(\) => navigation\.navigate\('Restaurant', \{ vendorId: b\.id \}\)\)/);
    expect(screen).toMatch(/\{branchFactsLine\(b\)\}/);
  });
});
