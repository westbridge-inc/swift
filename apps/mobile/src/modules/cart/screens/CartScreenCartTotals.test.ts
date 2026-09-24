import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [E01 · E09] The cart screen renders SERVER-owned totals for exactly what it
// submits.
//
// The screen used to compute the pickup total itself by subtracting the ONE
// quoted fee (`c.totalAmount - c.deliveryFee`) and swapping the tip — a third
// calculator the server never saw — and it submitted the pickup choice only for
// `c.vendor.id`, the store added last. A multi-store basket is several orders.
// The rules now live in ../cartQuote.ts (unit-tested); these pins hold the
// screen to them (there is no RN renderer in this vitest environment).
// ---------------------------------------------------------------------------

const FILE = join(process.cwd(), 'src/modules/cart/screens/CartScreen.tsx');

function code(): string {
  const out = readFileSync(FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (out.trim().length < 1000) throw new Error('comment stripper emptied the file — assertions would be vacuous');
  return out;
}

describe('the total on screen is the server’s (E01)', () => {
  const src = code();

  it('no client-side total: no fee subtraction, no tip swap, no express re-derivation', () => {
    expect(src).not.toContain('c.totalAmount - c.deliveryFee');
    expect(src).not.toMatch(/-\s*Number\(c\.tipAmount/);
    expect(src).not.toContain('c.expressTotal');
    expect(src).toContain('const displayedTotal = c ? Number(c.totalAmount) : 0;');
  });

  it('while a changed choice is re-priced, the total says so instead of showing the previous choice’s number', () => {
    expect(src).toContain("value={cart.isPlaceholderData ? 'Updating…' : money(displayedTotal)}");
  });
});

describe('the quote is priced for exactly what the order button submits (E01)', () => {
  const src = code();

  it('ONE pricing-choices object: the quote is requested with it, the order body is built from it', () => {
    expect(src).toContain('const cart = useCart<any>(latitude ?? undefined, longitude ?? undefined, pricing);');
    expect(src).toContain('...(pricing.express ? { express: true } : {}),');
    expect(src).toContain('...(pricing.fulfillmentSelections ? { fulfillmentSelections: pricing.fulfillmentSelections } : {}),');
    expect(src).toContain('const submittedTip = pickupRetry ? 0 : pricedTip(pricing, c);');
    // The old single-store pickup selection is gone, from the order and the retry.
    expect(src).not.toContain("{ [c.vendor.id]: 'PICKUP' }");
    expect(src).not.toMatch(/const vendorId = c\?\.vendor\?\.id;/);
    expect(src).toContain("onOrder({ fulfillmentSelections: Object.fromEntries(storeIds.map((id) => [id, 'PICKUP'])) });");
  });

  it('money is committed only against a settled quote: priced for the current choices and not mid-refresh', () => {
    expect(src).toMatch(/const quoteSettled = !cart\.isFetching && !cart\.isPlaceholderData && !updateItem\.isPending && !removeItem\.isPending;/);
    expect(src).toMatch(/disabled=\{!quoteSettled \|\| !c\.meetsMinimum/);
    expect(src).toMatch(/disabled=\{recovery\.recovering \|\| alreadyPlaced \|\| stillPlacing \|\| !quoteSettled\}/);
  });

  it('a multi-store basket shows one delivery row per store, from the server’s rows', () => {
    expect(src).toContain("feeRows?.kind === 'perStore'");
    expect(src).toContain('label={`${row.name} delivery`}');
    expect(src).toContain('const riderTip = quotedRiderTip(c, displayedTip);');
  });
});

describe('the minimum warning names each short store (E09)', () => {
  const src = code();

  it('one row per store below its own minimum, with the amount still to add', () => {
    expect(src).toContain('const short = shortStores(c);');
    expect(src).toContain('{store.name} has a minimum order of {money(store.minOrderAmount)} — add {money(store.amountToAdd)} more to order.');
  });
});
