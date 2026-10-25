import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] TEXT GATE for the phone's VAT words.
//
// VAT Act s.90(2): a VAT-registered store's advertised price must include the VAT AND say so. The server decides which
// store and which item carry VAT (a person approved the store's GRA certificate); the phone only shows it. So:
//   1. every place the storefront or the item screen prints an item's price also asks lib/storeVat for its note;
//   2. no phone file computes VAT or carries a VAT rate: no 14% literal, no 0.14, no 14/114 or 7/57 next to "VAT";
//   3. the cart and the customer's order show the server's VAT through lib/storeVat, never a sum of their own;
//   4. the store's certificate upload carries the recorded document consent words and tick.
// ---------------------------------------------------------------------------

const SRC = process.cwd().endsWith('apps/mobile') ? join(process.cwd(), 'src') : join(process.cwd(), 'apps', 'mobile', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const count = (text: string, needle: string | RegExp) => (typeof needle === 'string' ? text.split(needle).length - 1 : [...text.matchAll(needle)].length);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('[O-5] the phone’s VAT words', () => {
  it('every storefront price of an item asks for its VAT note', () => {
    const store = read('modules/shop/screens/RestaurantScreen.tsx');
    const prices = count(store, 'item.customerPrice ?? item.basePrice');
    expect(prices).toBeGreaterThanOrEqual(4);
    // ProductTile and ServiceRow each name the note twice (test + text); FoodCard and MenuRow pass it once.
    expect(count(store, /itemVatNote\((storeVat|vat), item\)/g)).toBeGreaterThanOrEqual(prices);
    expect(store).toContain('priceNote={itemVatNote(storeVat, item)}');
    expect(store).toContain('storefrontVatLine(storeVat)');
    const detail = read('modules/shop/screens/MenuItemScreen.tsx');
    expect(detail).toContain('itemVatNote(storefrontVat(vendor.data?.vat), item)');
  });

  it('the cart and the customer’s order show the server’s VAT through lib/storeVat', () => {
    expect(read('modules/cart/screens/CartScreen.tsx')).toContain('cartVatRows(c)');
    expect(read('modules/cart/cartQuote.ts')).toContain('cartVatLine(cartVat(s.vat))');
    expect(read('modules/orders/screens/DeliveryScreen.tsx')).toContain('orderVatLine(o)');
  });

  it('no phone file computes VAT or carries a VAT rate', () => {
    const offenders: string[] = [];
    for (const path of files(SRC)) {
      const text = readFileSync(path, 'utf8');
      if (!/\bVAT\b|vat[A-Z]|storeVat/.test(text)) continue;
      const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      // Only lines that speak of VAT (an opacity of 0.14 is not a rate).
      const vatLines = code.split('\n').filter((line) => /vat/i.test(line)).join('\n');
      for (const [pattern, why] of [
        [/\b14\s*%/, 'a 14% literal'],
        [/\b0?\.14\b/, 'a 0.14 rate'],
        [/\b(14\s*\/\s*114|7\s*\/\s*57)\b/, 'a VAT fraction'],
        [/\b1400\b/, 'a 1400 bps rate'],
      ] as const) {
        if (pattern.test(vatLines)) offenders.push(`${relative(SRC, path)}: ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the certificate upload carries the recorded document consent words and tick', () => {
    const section = read('modules/vendor/StoreVatSection.tsx');
    expect(section).toContain('accessibilityLabel={DOCUMENT_CONSENT_TEXT}');
    expect(section).toContain('disabled={!consented}');
    const hooks = read('hooks/storeVatCertificate.ts');
    expect(hooks).toContain("consentTick: 'document_v1'");
    expect(hooks).toMatch(/const PRIVACY_NOTICE_VERSION = 'v1'/);
    expect(read('hooks/verification.ts')).toMatch(/const PRIVACY_NOTICE_VERSION = 'v1'/);
  });

  it('the item editor sends a VAT class only when the owner sees the choice (older behaviour otherwise)', () => {
    const editor = read('modules/vendor/screens/VendorItemEditorScreen.tsx');
    expect(editor).toContain('...(vatRate != null ? { vatClass } : {})');
    expect(editor).toContain("useStoreVat(myRole === 'OWNER' && !samplePreview)");
  });
});
