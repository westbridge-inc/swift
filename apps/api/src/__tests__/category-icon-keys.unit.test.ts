import { describe, expect, it } from 'vitest';
import { CATEGORY_ICON_KEYS as SHARED } from '@swift/types';
import { CATEGORY_ICON_KEYS, isCategoryIconKey } from '../modules/discovery/category-icon-keys';

// The API validates DiscoveryCategory.iconKey against its own copy of the
// shared icon list (it cannot load runtime values from @swift/types). The admin
// select offers the shared list, so a drift would refuse an icon the console
// offers, or accept one the app cannot draw.
describe('the API icon-key list is the shared one', () => {
  it('has the same keys in the same order', () => {
    expect([...CATEGORY_ICON_KEYS]).toEqual([...SHARED]);
  });
  it('accepts a listed key and refuses anything else', () => {
    expect(isCategoryIconKey('pizza')).toBe(true);
    for (const v of ['', 'not-a-glyph', '🍕', 'toString', null, 3]) expect(isCategoryIconKey(v)).toBe(false);
  });
});
