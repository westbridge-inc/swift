import React from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [Q3] The owner's Home screenshot, 09-24. Under each Popular card ONE line
// read "$1,500TEST-Kitchen-One · 41 mi": the price run straight into the store
// name, the line wider than its card and painting into the next one, whose own
// line was cut at the screen edge ("41 min" survived as "41 mi"). And every
// category tile without a photo carried two labels at once — the placeholder's
// centred caps "MENU" and the tile's own "Menu".
//
// Both are kit shapes, so they are pinned on the kit, rendered with
// react-native stubbed (see card.test.ts) and the kit's own function
// components expanded down to host elements: what is asserted is what would
// be drawn, not what a prop says.
// ---------------------------------------------------------------------------

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
// Inert placeholder palette: these tests assert structure and text, never
// colour (the UI barrier forbids real brand hex outside packages/ui).
vi.mock('@swift/ui', () => ({
  color: { text: { muted: '#010101' }, star: '#020202', white: '#030303', brand: { 50: '#040404', 500: '#050505', 600: '#060606' } },
  radius: { md: 12, lg: 16, full: 9999 },
  space: { xs: 4, sm: 8, md: 12, lg: 16 },
  withAlpha: (c: string) => c,
}));
vi.mock('../lib/images', () => ({ DARK_BLURHASH: '' }));
vi.mock('./card', () => ({ Card: 'Card' }));
vi.mock('./pictograms', () => ({ Pictogram: 'Pictogram' }));
vi.mock('./scrim', () => ({ Scrim: 'Scrim' }));
vi.mock('./controls', () => ({ HeartBadge: 'HeartBadge', Stars: 'Stars' }));
vi.mock('./button', () => ({ PillButton: 'PillButton' }));
vi.mock('./text', () => ({ T: 'T' }));

// photo-placeholder is deliberately NOT mocked: the second label came from
// inside it, so it has to render for real.
import { CategoryTile, FoodCard, RatingMeta } from './food';
import { Photo, PhotoPlaceholder } from './photo-placeholder';

interface Host {
  type: string;
  props: Record<string, any>;
}

/** Down to host elements: function components are called (none of these use
 *  hooks), Pressable render-props are opened unpressed, fragments flatten. */
function expand(node: any): any {
  if (node == null || typeof node === 'boolean') return null;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== 'object') return node;
  const el = node as React.ReactElement<Record<string, any>, any>;
  if (el.type === React.Fragment) return expand(el.props['children']);
  if (typeof el.type === 'function') return expand(el.type(el.props));
  const kids = el.props['children'];
  const children = typeof kids === 'function' ? kids({ pressed: false }) : kids;
  return { type: el.type, props: { ...el.props, children: expand(children) } } satisfies Host;
}

function walk(node: any, visit: (n: Host, ancestors: Host[]) => void, ancestors: Host[] = []): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit, ancestors));
    return;
  }
  visit(node, ancestors);
  walk(node.props.children, visit, [...ancestors, node]);
}

function textOf(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

const styleOf = (n: Host): Record<string, unknown> =>
  Object.assign({}, ...[n.props['style']].flat(Infinity).filter(Boolean));

/** Every visible piece of text: the T hosts that actually carry characters. */
function labels(tree: any): Host[] {
  const out: Host[] = [];
  walk(tree, (n) => {
    if (n.type === 'T' && textOf(n).trim() !== '') out.push(n);
  });
  return out;
}

/** The one T carrying exactly this text, with the hosts above it. */
function textNode(tree: any, text: string): { node: Host; ancestors: Host[] } {
  const found: { node: Host; ancestors: Host[] }[] = [];
  walk(tree, (n, ancestors) => {
    if (n.type === 'T' && textOf(n) === text) found.push({ node: n, ancestors });
  });
  expect(found, `"${text}" is drawn exactly once`).toHaveLength(1);
  return found[0]!;
}

const isRow = (n: Host) => styleOf(n)['flexDirection'] === 'row';

describe('FoodCard — every line of text stays inside its card [Q3]', () => {
  // The owner's card, as the Popular rail builds it. (It had no photo; the
  // footer does not depend on the photo, and with one the dish name is drawn
  // once, so each text below is unambiguous.)
  const popular = () =>
    expand(
      FoodCard({
        image: 'https://cdn.swift.test/r1-plate.jpg',
        name: 'R1 Plate',
        priceLabel: '$1,500',
        meta: 'TEST-Kitchen-One · 41 min',
        width: 172,
        onPress: () => {},
      }),
    );

  it('the price has its own line: it never shares a row with the store and ETA', () => {
    const card = popular();
    const price = textNode(card, '$1,500');
    const meta = textNode(card, 'TEST-Kitchen-One · 41 min');

    // The collision was a space-between ROW holding both: once the pair was
    // wider than the card, space-between had nothing to hand out and the price
    // ran into the store name. No row may hold the price now.
    expect(price.ancestors.some(isRow), 'the price sits in no row').toBe(false);
    for (const row of meta.ancestors.filter(isRow)) {
      expect(textOf(row)).not.toContain('$1,500');
    }
  });

  it('one line each: price and meta are single-line, and the meta ends in an ellipsis', () => {
    const card = popular();
    expect(textNode(card, 'R1 Plate').node.props['numberOfLines']).toBe(1);
    expect(textNode(card, '$1,500').node.props['numberOfLines']).toBe(1);
    const meta = textNode(card, 'TEST-Kitchen-One · 41 min').node;
    expect(meta.props['numberOfLines']).toBe(1);
    expect(meta.props['ellipsizeMode']).toBe('tail');
  });

  it('the meta gives way to the card: it shrinks, its row shrinks, and the card clips the text block', () => {
    const card = popular();
    const meta = textNode(card, 'TEST-Kitchen-One · 41 min');
    expect(styleOf(meta.node)['flexShrink']).toBe(1);

    const metaRow = meta.ancestors[meta.ancestors.length - 1]!;
    expect(styleOf(metaRow)).toMatchObject({ flexDirection: 'row', flexShrink: 1 });

    // The text block is the price's parent; it sits inside the card's fixed
    // width and clips to it, so nothing can paint into the next card.
    const price = textNode(card, '$1,500');
    const block = price.ancestors[price.ancestors.length - 1]!;
    expect(styleOf(block)['overflow']).toBe('hidden');
    expect(price.ancestors.some((a) => styleOf(a)['width'] === 172)).toBe(true);
  });

  it('a store card (rating and ETA, no price) keeps the same bounded meta line', () => {
    const card = expand(
      FoodCard({ image: 'https://cdn.swift.test/mauby.jpg', name: 'Mauby Snackette', rating: 4.6, meta: '35 min', width: 172 }),
    );
    const eta = textNode(card, '35 min');
    expect(eta.node.props['numberOfLines']).toBe(1);
    expect(styleOf(eta.node)['flexShrink']).toBe(1);
    // No price, so no price line: name, rating, ETA — and nothing else.
    expect(labels(card).map(textOf)).toEqual(['Mauby Snackette', '4.6', '35 min']);
  });
});

describe('RatingMeta — a separator only ever between two things that say something [Q3]', () => {
  /** The row's own children, flattened: segments and the dots between them. */
  const rowChildren = (out: any): Host[] => [out.props.children].flat(Infinity).filter(Boolean);

  it('a blank extra is not a segment: "New" stands alone, with no dot beside nothing', () => {
    const out = expand(RatingMeta({ rating: null, extra: '   ' }));
    const kids = rowChildren(out);
    expect(kids.map(textOf)).toEqual(['New']);
    expect(kids).toHaveLength(1);
  });

  it('with nothing but a blank extra, it renders nothing at all', () => {
    expect(RatingMeta({ rating: undefined, extra: ' ' })).toBeNull();
    expect(RatingMeta({ extra: '' })).toBeNull();
  });

  it('two real segments get exactly one dot, between them', () => {
    const kids = rowChildren(expand(RatingMeta({ rating: null, extra: '0.4 km' })));
    // [New] [dot] [0.4 km]: the dot is the one child that carries no text.
    expect(kids.map(textOf)).toEqual(['New', '', '0.4 km']);
  });
});

describe('Photo / PhotoPlaceholder — the name is drawn once [Q3]', () => {
  it('by default the placeholder still names the thing (the dish rails depend on it)', () => {
    expect(labels(expand(PhotoPlaceholder({ label: 'R1 Plate' }))).map(textOf)).toEqual(['R1 Plate']);
  });

  it('showLabel={false} keeps the picture and the screen-reader name, and draws no caption', () => {
    const out = expand(PhotoPlaceholder({ label: 'Menu', showLabel: false }));
    expect(labels(out)).toEqual([]);
    expect(out.props['accessibilityLabel']).toBe('Menu. No photo yet');
    let pictogram = false;
    walk(out, (n) => {
      if (n.type === 'Pictogram') pictogram = true;
    });
    expect(pictogram, 'still a picture: ground and pictogram').toBe(true);
  });

  it('Photo hands showLabel through to the placeholder it draws for a missing photo', () => {
    expect(labels(expand(Photo({ uri: null, label: 'Menu', showLabel: false })))).toEqual([]);
    expect(labels(expand(Photo({ uri: null, label: 'Menu' }))).map(textOf)).toEqual(['Menu']);
  });
});

describe('CategoryTile — exactly one label [Q3]', () => {
  it('with no photo: one label, the white one on the scrim', () => {
    const tile = expand(CategoryTile({ name: 'Menu', image: null, onPress: () => {} }));
    const drawn = labels(tile);
    expect(drawn.map(textOf)).toEqual(['Menu']);
    expect(drawn[0]!.props).toMatchObject({ tone: 'onBrand', numberOfLines: 1 });
  });

  it('with a photo: still one label', () => {
    const tile = expand(CategoryTile({ name: 'Imports', image: 'https://cdn.swift.test/imports.jpg', onPress: () => {} }));
    expect(labels(tile).map(textOf)).toEqual(['Imports']);
  });

  it('is one button, named for a screen reader, that opens on tap', () => {
    const onPress = vi.fn();
    const tile = CategoryTile({ name: 'Menu', image: null, onPress }) as React.ReactElement<Record<string, any>, string>;
    expect(tile.type).toBe('Pressable');
    expect(tile.props).toMatchObject({ accessibilityRole: 'button', accessibilityLabel: 'Menu' });
    (tile.props['onPress'] as () => void)();
    expect(onPress).toHaveBeenCalledOnce();
  });
});

describe('the store cover draws its name once [Q3]', () => {
  it('RestaurantScreen titles the cover itself, so its placeholder draws no second name', () => {
    const src = readFileSync(new URL('../modules/shop/screens/RestaurantScreen.tsx', import.meta.url), 'utf8');
    const start = src.indexOf('uri={vendorPhoto(v)}');
    expect(start, 'the cover photo is still here').toBeGreaterThan(-1);
    const cover = src.slice(start, src.indexOf('/>', start));
    expect(cover).toMatch(/showLabel=\{false\}/);
  });
});
