import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [IMAGES-E2E PR5 · COORD GO 21 Oct, owner rule "business pictures must reach customers"]
// A menu section's own photo shows above its name on the store's page. Only a photo Swift
// keeps is drawn, at a list width from the photo ladder; no photo, an outside address or a
// photo that fails to load is today's text header (no broken tile). Called as a function
// (no RN renderer), with useState as a small store, as in ProviderPortfolioCard.test.ts.

const h = vi.hoisted(() => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  return { state: [] as unknown[], at: 0 };
});
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const slot = h.at++;
    if (!(slot in h.state)) h.state[slot] = initial;
    return [h.state[slot], (next: unknown) => { h.state[slot] = next; }];
  },
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@swift/ui', () => ({ color: { surface: {} }, radius: {}, space: {} }));
vi.mock('../kit', () => ({ SectionHeader: 'SectionHeader' }));
// lib/images pulls native modules; its rules are pinned in images.test.ts.
vi.mock('../lib/images', () => ({
  LIST_PHOTO_WIDTH: 640,
  categoryPhoto: (c: { imageUrl?: string | null }, w: number) =>
    typeof c.imageUrl === 'string' && c.imageUrl !== '' && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(c.imageUrl) ? `door:${c.imageUrl}?w=${w}` : null,
}));

import { SectionPhotoHeader } from './SectionPhotoHeader';

function all(node: any, match: (n: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) all(n, match, out); return out; }
  if (match(node)) out.push(node);
  for (const child of [node.props?.children].flat(Infinity)) all(child, match, out);
  return out;
}
const ofType = (tree: any, type: string) => all(tree, (n) => n.type === type);
const STYLE = { paddingHorizontal: 24, marginTop: 24 };
const draw = (imageUrl: string | null | undefined) => { h.at = 0; return SectionPhotoHeader({ title: 'Mains', imageUrl, style: STYLE }) as any; };

beforeEach(() => { h.state = []; });

describe('a menu section header on the store page', () => {
  it('draws the section\'s kept photo at a list width from the ladder, above the name', () => {
    const tree = draw('items/v1/abcdefghijklmnop.jpg');
    const [image] = ofType(tree, 'Image');
    expect(image.props.source).toEqual({ uri: 'door:items/v1/abcdefghijklmnop.jpg?w=640' });
    expect(ofType(tree, 'SectionHeader').map((s) => s.props.title)).toEqual(['Mains']);
  });

  it('no photo or an outside address is today\'s text header, exactly', () => {
    for (const url of [null, undefined, '', 'https://elsewhere.example/section.jpg', '//elsewhere.example/x.jpg']) {
      const tree = draw(url);
      expect(tree.type, String(url)).toBe('SectionHeader');
      expect(tree.props).toEqual({ title: 'Mains', style: STYLE });
    }
  });

  it('a photo that fails to load collapses to the text header (no broken tile)', () => {
    const [image] = ofType(draw('items/v1/abcdefghijklmnop.jpg'), 'Image');
    image.props.onError();
    const tree = draw('items/v1/abcdefghijklmnop.jpg');
    expect(tree.type).toBe('SectionHeader');
    expect(ofType(tree, 'Image')).toEqual([]);
  });

  it('the store page draws every menu section through it', () => {
    const screen = readFileSync(join(process.cwd(), 'src/modules/shop/screens/RestaurantScreen.tsx'), 'utf8');
    expect(screen).toMatch(/<SectionPhotoHeader title=\{cat\.name\} imageUrl=\{cat\.imageUrl\} style=\{\{ paddingHorizontal: GUTTER, marginTop: space\['2xl'\] \}\} \/>/);
    expect(screen).not.toMatch(/<SectionHeader title=\{cat\.name\}/);
  });
});
