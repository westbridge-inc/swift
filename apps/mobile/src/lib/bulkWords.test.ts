import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BULK_WORDS } from './bulkWords';

// ---------------------------------------------------------------------------
// [Owner ruling 31 Oct 2026] A store order is never refused for its size, and an
// order holding a bulky or very bulky item goes to a motorbike at least (a car
// or van while cars deliver), never to a bicycle. The item editor's help words
// say exactly that, on the phone and on the website (one copy of the words).
// ---------------------------------------------------------------------------

const PHONE = readFileSync(join(process.cwd(), 'src', 'modules', 'vendor', 'screens', 'VendorItemEditorScreen.tsx'), 'utf8');
const WEB = readFileSync(join(process.cwd(), '..', 'web', 'src', 'app', 'dashboard', 'inventory', 'menu-tools.tsx'), 'utf8');

describe('the store’s bulk help says what Swift does with a bulky item', () => {
  it('bulky and very bulky items: never offered to a rider on a bicycle; an ordinary one says nothing about riders', () => {
    expect(BULK_WORDS).toEqual({
      normal: 'Fits in a delivery bag with room to spare.',
      bulky: 'Like a crate of drinks or a large box. An order with one is never offered to a rider on a bicycle.',
      very_bulky: 'Like a 20 kg bag of rice or a case of water. An order with one is never offered to a rider on a bicycle.',
    });
  });

  it('the phone and the website show these words, and the old promise is gone from both', () => {
    for (const [name, src] of [['phone', PHONE], ['web', WEB]] as const) {
      expect(src, name).toMatch(/import \{ BULK_WORDS \} from '[./]+(?:mobile\/src\/)?lib\/bulkWords';/);
      expect(src, name).not.toContain('Only riders with a bigger vehicle will be offered it.');
      expect(src, name).not.toContain('Like a 20 kg bag of rice');
    }
    expect(PHONE).toContain('{BULK_WORDS[bulk]}');
  });
});
