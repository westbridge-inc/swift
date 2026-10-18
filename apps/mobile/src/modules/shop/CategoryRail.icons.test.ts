import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// [OWNER 17 Oct] The customer category rail drew the seed's food emoji. Owner:
// draw categories with the app's own icon set, mapped in the app by slug,
// never from emoji in the data; unknown categories get a sensible default.

vi.mock('react-native', () => ({ FlatList: 'FlatList', Pressable: 'Pressable', View: 'View', ScrollView: 'ScrollView' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('../../kit', () => ({ T: 'T' }));

import { CategoryRail } from './CategoryRail';
import { CATEGORY_ICON, CATEGORY_ICON_DEFAULT, categoryIcon } from '../../lib/categoryIcon';
import { CATEGORY_ICON_KEYS } from '@swift/types';

type El = React.ReactElement<Record<string, any>>;
const isEmoji = (ch: string) => (/\p{Extended_Pictographic}/u.test(ch) && /\p{Emoji}/u.test(ch)) || ch === '️';

/** Expand function components and render-prop children into one host tree. */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!React.isValidElement(node)) return node;
  const el = node as El;
  if (typeof el.type === 'function') return expand((el.type as (p: unknown) => unknown)(el.props));
  let children = el.props['children'];
  if (typeof children === 'function') children = children({ pressed: false });
  return { type: el.type, props: { ...el.props, children: expand(children) } };
}
function collect(node: any, out: { icons: string[]; text: string[] }) {
  if (Array.isArray(node)) return node.forEach((n) => collect(n, out));
  if (node == null || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') return void out.text.push(String(node));
  if (node.type === 'MaterialCommunityIcons') out.icons.push(node.props.name);
  collect(node.props?.children, out);
}

const cat = (slug: string, name: string) => ({ slug, name, emoji: '🍲', iconKey: null, kind: 'CUISINE', vertical: 'FOOD', availableVendors: 3 });
const DATA = {
  enabled: true,
  categories: [cat('local-creole', 'Local & Creole'), cat('pizza', 'Pizza'), cat('pets', 'Pet Supplies'), cat('brand-new-thing', 'Brand New')],
} as any;

describe('customer category rail: the app icon set, never emoji', () => {
  const rail = CategoryRail({ data: DATA, loading: false, onChip: vi.fn(), onSeeAll: vi.fn() }) as El;
  const tiles = DATA.categories.map((item: any) => {
    const out = { icons: [] as string[], text: [] as string[] };
    collect(expand(rail.props['renderItem']({ item })), out);
    return out;
  });

  it('each tile draws the mapped icon, and an unknown category the default', () => {
    expect(tiles.map((t: any) => t.icons)).toEqual([['pot-steam-outline'], ['pizza'], ['paw'], [CATEGORY_ICON_DEFAULT]]);
  });

  it('no tile shows an emoji, even when the server still sends one', () => {
    for (const t of tiles) expect([...t.text.join('')].filter(isEmoji)).toEqual([]);
  });

  it('every seeded category has its own icon in the map', () => {
    const seed = readFileSync(join(process.cwd(), '../api/src/modules/discovery/taxonomy.seed.ts'), 'utf8');
    const slugs = [...seed.matchAll(/^\s*\['([a-z0-9-]+)', '[^']+', (?:'[A-Z]+', )?(?:'[^']*', )?\[/gm)].map((m) => m[1]!);
    expect(slugs.length).toBeGreaterThanOrEqual(41);
    expect(slugs.filter((s) => !(s in CATEGORY_ICON))).toEqual([]);
    expect(categoryIcon(undefined)).toBe(CATEGORY_ICON_DEFAULT);
    expect(categoryIcon('toString')).toBe(CATEGORY_ICON_DEFAULT);
  });
});

describe('the other category surfaces never print the category emoji', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');
  it.each([
    'modules/shop/screens/CategoryGridScreen.tsx',
    'modules/shop/screens/CategoryFeedScreen.tsx',
    'modules/shop/screens/HomeScreen.tsx',
    'modules/vendor/screens/VendorCategoryReviewScreen.tsx',
    'modules/shop/CategoryRail.tsx',
  ])('%s reads no .emoji field', (p) => {
    expect(read(p)).not.toMatch(/\.emoji\b|\{emoji\}|\bemoji\s*[:=,})]/);
  });
});

// [#1836 S4-1] An admin-created category carries DiscoveryCategory.iconKey,
// chosen from the shared list (@swift/types CATEGORY_ICON_OPTIONS). The app
// draws a known key, ignores an unknown one, and every key on the list is a
// real glyph in the installed icon font.
describe('a category the admin gave an icon draws that icon', () => {
  it('prefers a known iconKey over the slug map, and ignores an unknown one', () => {
    const withKey = { ...cat('brand-new-thing', 'Brand New'), iconKey: 'teddy-bear' };
    const bogus = { ...cat('pizza', 'Pizza'), iconKey: 'not-a-glyph' };
    const rail2 = CategoryRail({ data: { enabled: true, categories: [withKey, bogus, cat('pets', 'Pets'), cat('fish', 'Fish')] } as any, loading: false, onChip: vi.fn(), onSeeAll: vi.fn() }) as El;
    const icons = [withKey, bogus].map((item) => {
      const out = { icons: [] as string[], text: [] as string[] };
      collect(expand(rail2.props['renderItem']({ item })), out);
      return out.icons;
    });
    expect(icons).toEqual([['teddy-bear'], ['pizza']]);
    expect(categoryIcon('pizza', null)).toBe('pizza');
    expect(categoryIcon(null, 'toString')).toBe(CATEGORY_ICON_DEFAULT);
  });

  it('every icon on the admin list is a real glyph, and the list covers every slug-mapped icon', () => {
    const glyphs = JSON.parse(readFileSync(require.resolve('@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialCommunityIcons.json'), 'utf8')) as Record<string, number>;
    expect(CATEGORY_ICON_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(glyphs, k))).toEqual([]);
    expect(new Set(CATEGORY_ICON_KEYS).size).toBe(CATEGORY_ICON_KEYS.length);
    const keys = new Set<string>(CATEGORY_ICON_KEYS);
    expect([...new Set(Object.values(CATEGORY_ICON))].filter((v) => !keys.has(v))).toEqual([]);
    expect(keys.has(CATEGORY_ICON_DEFAULT)).toBe(true);
  });
});
