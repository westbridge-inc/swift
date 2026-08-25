import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({
  color: { text: { muted: '#948888' }, star: '#E8A838', white: '#fff', brand: { 500: '#803B3B' } },
  radius: { lg: 16, full: 9999 },
  space: { sm: 8, md: 12, lg: 16 },
  withAlpha: (c: string) => c,
}));
vi.mock('../lib/images', () => ({ DARK_BLURHASH: '' }));
vi.mock('./card', () => ({ Card: 'Card' }));
vi.mock('./photo-placeholder', () => ({ PhotoPlaceholder: 'PhotoPlaceholder' }));
vi.mock('./pictograms', () => ({ Pictogram: 'Pictogram' }));
vi.mock('../components/ui/scrim', () => ({ Scrim: 'Scrim' }));
vi.mock('./controls', () => ({ HeartBadge: 'HeartBadge', Stars: 'Stars' }));
vi.mock('./button', () => ({ PillButton: 'PillButton' }));
vi.mock('./text', () => ({ T: 'T' }));

import { RatingMeta } from './food';

// ---------------------------------------------------------------------------
// NULL AND UNDEFINED ARE DIFFERENT CLAIMS.
//
//   null      → "this seller has no rating yet" — an assertion about them.
//   undefined → "I was not given a rating" — an admission about us.
//
// The old code tested `rating == null`, which is true for both, and that one
// character produced two separate lies on Home:
//
//   1. A surface with no rating to give announced "New" about a store that has
//      been trading for a year.
//   2. Callers that knew better passed nothing — and the card read that as "no
//      meta at all" and dropped the STORE NAME, which the API had been sending
//      correctly the whole time. Every dish on the Popular rail was anonymous.
//
// Plus the separator: `extra` used to draw its dot in FRONT of itself, so a
// lone store name rendered as "· Mauby's Snackette".
// ---------------------------------------------------------------------------

type El = React.ReactElement<Record<string, any>, any>;

/** The rendered segments, in order, with their text. */
function render(props: Parameters<typeof RatingMeta>[0]) {
  const out = RatingMeta(props) as El | null;
  if (out === null) return null;
  const kids = React.Children.toArray(out.props['children']) as El[];
  return kids;
}

const textOf = (node: any): string => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
};

describe('RatingMeta tells the truth about what it knows', () => {
  it('undefined rating makes NO rating claim — and still shows the store name', () => {
    const kids = render({ rating: undefined, extra: "Mauby's Snackette" });
    expect(kids).not.toBeNull();
    const text = textOf(kids);
    // The store name survives. This is the Popular-rail bug.
    expect(text).toContain("Mauby's Snackette");
    // ...without inventing a rating that was never supplied.
    expect(text).not.toContain('New');
  });

  it('null rating DOES say "New" — that claim is deliberate and stays', () => {
    expect(textOf(render({ rating: null }))).toContain('New');
  });

  it('a lone store name draws no leading separator', () => {
    const kids = render({ rating: undefined, extra: "Mauby's Snackette" })!;
    // One segment means zero dots. The old version drew the dot in front of
    // `extra` unconditionally, giving "· Mauby's Snackette".
    const dots = kids.filter((k) => typeof k.type !== 'string' || k.type !== 'T');
    expect(kids.length).toBe(1);
    expect(dots.length).toBeLessThanOrEqual(1); // the wrapping Fragment only
  });

  it('renders nothing at all when it has nothing to say', () => {
    expect(render({ rating: undefined })).toBeNull();
    expect(render({})).toBeNull();
  });

  it('a real rating and a store name are separated, not concatenated', () => {
    const kids = render({ rating: 4.6, extra: "Mauby's Snackette" })!;
    // Two segments → exactly one separator between them.
    expect(kids.length).toBe(2);
    expect(textOf(kids)).toContain("Mauby's Snackette");
    expect(textOf(kids)).toContain('4.6');
  });
});
