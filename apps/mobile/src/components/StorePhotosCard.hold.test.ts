import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [IMAGES-E2E #1909, C2 press census] The store-photo card sends ONE photo request at a time.
// While either slot uploads or removes, no press on the card (Change / Add photo / Remove,
// on either slot) sends another request. A second tap used to start a second upload on the
// other slot, or a second remove.

const state = vi.hoisted(() => ({
  pending: { upload: false, remove: false },
  calls: { upload: 0, remove: 0 },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const useState = (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined];
  return { ...actual, useState, default: { ...actual, useState } };
});
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('../kit', () => ({ Card: 'Card', LinkText: 'LinkText', T: 'T' }));
vi.mock('../services/api', () => ({ vendorApi: {} }));
vi.mock('../lib/images', () => ({ storePhotoUrl: (u: string | null) => u }));
vi.mock('../lib/uploadImage', () => ({ prepareUploadImage: vi.fn() }));
vi.mock('../hooks/useVendorMutation', () => {
  let n = 0;
  return {
    useVendorMutation: () => {
      // The card declares the upload first, then the remove.
      const which = n++ % 2 === 0 ? 'upload' : 'remove';
      return { isPending: state.pending[which], mutate: () => { state.calls[which]++; } };
    },
  };
});

import { StorePhotosCard } from './StorePhotosCard';

type El = React.ReactElement<Record<string, any>>;
function links(el: unknown, out: El[] = []): El[] {
  if (Array.isArray(el)) { el.forEach((c) => links(c, out)); return out; }
  if (!React.isValidElement(el)) return out;
  const e = el as El;
  if (e.type === 'LinkText') out.push(e);
  links(e.props['children'], out);
  return out;
}
function render() {
  const tree = (StorePhotosCard as (p: unknown) => El)({ store: { logoUrl: '/media/store/s1/logo.jpg', coverImageUrl: '/media/store/s1/cover.jpg' } });
  const all = links(tree);
  return { change: all.filter((l) => l.props['label'] !== 'Remove'), remove: all.filter((l) => l.props['label'] === 'Remove') };
}

describe('[IMAGES-E2E] StorePhotosCard: one photo request at a time', () => {
  beforeEach(() => {
    state.pending = { upload: false, remove: false };
    state.calls = { upload: 0, remove: 0 };
  });

  it('idle: both slots can be changed and removed', () => {
    const { change, remove } = render();
    expect(change).toHaveLength(2);
    expect(remove).toHaveLength(2);
    change.forEach((l) => expect(typeof l.props['onPress']).toBe('function'));
    [...change, ...remove].forEach((l) => expect(l.props['disabled'], `${String(l.props['label'])} looks live`).toBe(false));
    remove[0]!.props['onPress']();
    expect(state.calls.remove).toBe(1);
  });

  it.each(['upload', 'remove'] as const)('while a %s runs, no press on EITHER slot sends another request', (busy) => {
    state.pending[busy] = true;
    const { change, remove } = render();
    expect(change).toHaveLength(2);
    change.forEach((l) => expect(l.props['onPress'], `${String(l.props['label'])} stays held`).toBeUndefined());
    remove.forEach((l) => l.props['onPress']?.());
    expect(state.calls).toEqual({ upload: 0, remove: 0 });
  });

  // [REVIEW-G S4-1 on #1909 139351d5] A held link LOOKS held (greyed, read as disabled), Remove included,
  // and has no press at all, like the web card's disabled buttons.
  it.each(['upload', 'remove'] as const)('while a %s runs, every link on the card is shown disabled and has no press', (busy) => {
    state.pending[busy] = true;
    const { change, remove } = render();
    expect(remove).toHaveLength(2);
    [...change, ...remove].forEach((l) => {
      expect(l.props['disabled'], `${String(l.props['label'])} shown disabled`).toBe(true);
      expect(l.props['onPress'], `${String(l.props['label'])} has no press`).toBeUndefined();
    });
  });
});
