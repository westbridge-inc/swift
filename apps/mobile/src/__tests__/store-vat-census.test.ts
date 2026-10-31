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
    // [VAT-DOCS] the consent tick still gates every send (a first claim also waits for its number and price choice)
    expect(section).toContain('disabled={!consented || !claimReady}');
    expect(section).toContain('if (!consented || !claimReady || send.isPending) return;');
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

  // [VAT-DOCS · owner 30 Oct 2026] "Add VAT at checkout": one submission, the price before VAT, the optional Documents row.
  it('a first VAT claim sends the number and the price choice WITH the certificate (one submission)', () => {
    const section = read('modules/vendor/StoreVatSection.tsx');
    expect(section).toContain('...(firstClaim && mode ? { claim: { vatRegistrationNumber: number.trim(), mode } } : {})');
    expect(section).toContain('VAT_MODE_CHOICES.map');
    expect(section).not.toContain('not available yet');
    expect(read('hooks/storeVatCertificate.ts')).toContain('...(claim ?? {})');
  });

  it('the item editor edits the price before VAT of an item Swift adds VAT to (never the VAT-inclusive price)', () => {
    const editor = read('modules/vendor/screens/VendorItemEditorScreen.tsx');
    expect(editor).toContain('useState<string>(editablePrice(existing))');
    expect(editor).toContain('...itemPricePayload(existing, priceNum)');
    expect(editor).not.toMatch(/\bbasePrice: priceNum\b/);
  });

  // [VAT-DOCS · owner ruling 31 Oct 2026 · REVIEW-M #2256 N1] An approved store's change of choice waits for a person and the
  // store is told; the save never sends a built-in choice the store did not make.
  it('a change of price choice: the store is told a person checks it; the save sends only a choice the store made', () => {
    const section = read('modules/vendor/StoreVatSection.tsx');
    expect(section).toContain("{changeNeedsPerson ? <T variant=\"label\" tone=\"muted\" testID=\"store-vat-mode-review\">{MODE_CHANGE_REVIEW_NOTE}</T> : null}");
    expect(section).toContain('const waitingLine = modeRequestedLine(v.modeRequested);');
    expect(section).toContain('setMode(v.modeRequested ?? v.mode ?? null);');
    const hook = read('hooks/storeVat.ts');
    expect(hook).toContain('...(answer.mode ? { mode: answer.mode } : {})');
    expect(hook).not.toContain("?? 'PRICES_INCLUDE_VAT'");
  });

  it('[REVIEW-M #2255 S4-2 · REVIEW-F #2256 S4-3] new options carry the typed price; an option’s price says when VAT is in it', () => {
    const editor = read('modules/vendor/screens/VendorItemEditorScreen.tsx');
    expect(editor).toContain('data: { name, ...newOptionPrice(Number(d.price) || 0) },');
    expect(editor).toContain('{optionPriceLabel(o)}');
    expect(editor).toContain('{newItemBeforeVatHint(storeVat.data.ratePercent)}');
  });

  it('every store owner’s Documents list carries the optional VAT certificate row', () => {
    expect(read('modules/vendor/screens/BusinessSetup.tsx')).toContain("optionalExtra={myRole === 'OWNER' ? (withHeading) => <VatDocumentRow withHeading={withHeading} /> : undefined}");
    expect(read('modules/vendor/screens/VendorAccountScreen.tsx')).toContain('optionalExtra={(withHeading) => <VatDocumentRow withHeading={withHeading} inline={false} />}');
    expect(read('components/onboarding/DocumentChecklist.tsx')).toContain('optionalExtra?.(true)');
  });
});
