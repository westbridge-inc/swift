import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STORE_PICK, STORE_PICKS_TITLE } from '../lib/storePick';

// ---------------------------------------------------------------------------
// [Triage rows 2 + 113 · GUARDRAILS §8 honesty] (1) An item's isPopular tick
// is the STORE's own choice, never measured: the customer sees "Store’s pick"
// / "Store’s picks", never "Popular" or "Recommended for you", and the partner
// ticks the same words. (2) ONE add "+" everywhere: Market uses the shared
// AddMorph circle, not its own copy.
// ---------------------------------------------------------------------------

const src = join(__dirname, '..');
const read = (path: string) => readFileSync(join(src, path), 'utf8');

describe('the store’s own tick says what it is', () => {
  it('uses the store-pick words', () => {
    expect(STORE_PICK).toBe('Store’s pick');
    expect(STORE_PICKS_TITLE).toBe('Store’s picks');
  });

  it('the item screen, the store screen and the partner editor name the tick "Store’s pick", never Popular/Recommended', () => {
    const item = read('modules/shop/screens/MenuItemScreen.tsx');
    expect(item).toMatch(/item\.isPopular \? \([\s\S]{0,300}\{STORE_PICK\}/);
    expect(item).not.toMatch(/^\s*Popular\s*$/m);
    const store = read('modules/shop/screens/RestaurantScreen.tsx');
    expect(store).toContain('<SectionHeader title={STORE_PICKS_TITLE}');
    expect(store).not.toContain('title="Recommended for you"');
    expect(read('modules/vendor/screens/VendorItemEditorScreen.tsx')).toContain('label={`★ ${STORE_PICK}`}');
  });
});

describe('one add "+" for every tile', () => {
  it('Market uses the shared AddMorph with the item named, not its own plus circle', () => {
    const market = read('modules/shop/screens/MarketScreen.tsx');
    expect(market).toMatch(/import \{\n {2}AddMorph,[\s\S]*?\} from '\.\.\/\.\.\/\.\.\/kit';/);
    expect(market).toContain('addLabel={`Add ${item.name} to cart`}');
    expect(market).not.toContain('<Feather name="plus"');
  });

  it('AddMorph says what the collapsed plus adds', () => {
    const morph = read('kit/add-morph.tsx');
    expect(morph).toContain("addLabel = 'Add to cart'");
    expect(morph).toContain('accessibilityLabel={addLabel}');
  });
});
