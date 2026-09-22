import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  categoryKindLabel,
  categoryTintKey,
} from '../modules/shop/category-presentation';

const SRC = join(process.cwd(), 'src');

function source(path: string): string {
  return readFileSync(join(SRC, path), 'utf8');
}

function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('Swift discovery category presentation', () => {
  it.each([
    ['CUISINE', 'Cuisine'],
    ['DISH', 'Dish'],
    ['DIETARY', 'Dietary'],
    ['AISLE', 'Grocery aisle'],
    ['RETAIL', 'Department'],
    ['UNKNOWN', 'Category'],
  ])('gives %s a truthful text label', (kind, expected) => {
    expect(categoryKindLabel(kind)).toBe(expected);
  });

  it('uses the existing vertical identity palette', () => {
    expect(categoryTintKey('FOOD')).toBe('food');
    expect(categoryTintKey('GROCERY')).toBe('groceries');
    expect(categoryTintKey('RETAIL')).toBe('shops');
    expect(categoryTintKey('UNKNOWN')).toBe('shops');
  });
});

describe('customer discovery presentation contract', () => {
  const customerSurfaces = [
    'modules/shop/CategoryRail.tsx',
    'modules/shop/screens/CategoryGridScreen.tsx',
    'modules/shop/screens/CategoryFeedScreen.tsx',
  ];

  it('does not render or route database emoji on customer category surfaces', () => {
    for (const path of customerSurfaces) {
      expect(code(path), path).not.toMatch(/\.emoji\b|\bemoji\s*[:=}]/);
    }
    expect(code('modules/shop/screens/HomeScreen.tsx')).not.toMatch(
      /CategoryFeed[^\n]*emoji/,
    );
  });

  it('requests each customer surface in its actual vertical', () => {
    const home = code('modules/shop/screens/HomeScreen.tsx');
    const grid = code('modules/shop/screens/CategoryGridScreen.tsx');
    const feed = code('modules/shop/screens/CategoryFeedScreen.tsx');
    const market = code('modules/shop/screens/MarketScreen.tsx');

    expect(home).toMatch(/useDiscoveryCategories\(\{\s*vertical: 'FOOD'/);
    expect(grid).toMatch(/useDiscoveryCategories\(\{\s*vertical: 'FOOD'/);
    expect(feed).toMatch(/useDiscoveryCategories\(\{\s*vertical: 'FOOD'/);
    expect(market).toMatch(/useDiscoveryCategories\(\{\s*vertical: 'RETAIL'/);
    expect(market).not.toMatch(/\.filter\(\(c\) => c\.vertical === 'RETAIL'\)/);
  });

  it('keys category queries by vertical as well as location', () => {
    const hooks = code('hooks/customer.ts');
    expect(hooks).toMatch(/queryKey: \['discovery', 'categories', vertical,/);
    expect(hooks).toMatch(/discoveryApi\.categories\(\{ vertical, lat, lng \}\)/);
  });

  it('uses one shared ticket on Home and the full directory', () => {
    expect(code('modules/shop/CategoryRail.tsx')).toMatch(/<DiscoveryCategoryCard\b/);
    expect(code('modules/shop/screens/CategoryGridScreen.tsx')).toMatch(/<DiscoveryCategoryCard\b/);
  });

  it('keeps repeated rail work bounded on long taxonomies', () => {
    const rail = code('modules/shop/CategoryRail.tsx');
    const card = code('modules/shop/DiscoveryCategoryCard.tsx');
    expect(rail).toMatch(/getItemLayout=/);
    expect(rail).toMatch(/removeClippedSubviews/);
    expect(card).toMatch(/memo\(function DiscoveryCategoryCard/);
  });

  it('announces the name and purpose without decorative/generated art', () => {
    const card = code('modules/shop/DiscoveryCategoryCard.tsx');
    expect(card).toMatch(/accessibilityLabel=\{category\.name\}/);
    expect(card).toMatch(/accessibilityHint={`Browse \$\{kind\.toLowerCase\(\)}`}/);
    expect(card).not.toMatch(/categoryMonogram|availableVendors/);
  });

  it('keeps an odd final grid card at the same two-column width', () => {
    const card = code('modules/shop/DiscoveryCategoryCard.tsx');
    expect(card).toMatch(/flexBasis: '47%', maxWidth: '47%', flexGrow: 0/);
  });

  it('uses canonical server copy when it is available and route copy only as fallback', () => {
    const feed = code('modules/shop/screens/CategoryFeedScreen.tsx');
    expect(feed).toMatch(/currentCategory\?\.name \?\? fallbackName \?\? 'Category'/);
    expect(feed).toMatch(/vertical: 'FOOD'/);
    expect(feed).toMatch(/<ScrollView\s+horizontal/);
  });
});
