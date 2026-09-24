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
    expect(src).toContain("onOrderLatest.current({ fulfillmentSelections: Object.fromEntries(storeIds.map((id) => [id, 'PICKUP'])) });");
  });

  it('money is committed only against a settled quote: priced for the current choices and not mid-refresh', () => {
    expect(src).toMatch(/const quoteSettled = !cart\.isFetching && !cart\.isPlaceholderData && !updateItem\.isPending && !removeItem\.isPending && !removePromo\.isPending && !applyPromo\.isPending;/);
    expect(src).toMatch(/disabled=\{!quoteSettled \|\| !c\.meetsMinimum/);
    expect(src).toMatch(/disabled=\{recovery\.recovering \|\| alreadyPlaced \|\| stillPlacing \|\| !quoteSettled \|\| \(confirmPickup && pickupQuote\.isFetching\)\}/);
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

describe('the applied promo code rides the one choices object to checkout (E01-B)', () => {
  const src = code();

  it('the order body sends promoCode exactly when one is applied — the same pricing object the quote was asked with', () => {
    expect(src).toContain('...(pricing.promoCode ? { promoCode: pricing.promoCode } : {}),');
    // The applied code is the quote's own echo of the stored promo, kept in
    // state like quoteBasis so it drops the moment a code is removed.
    expect(src).toContain('const [appliedPromo, setAppliedPromo] = useState<string | null>(null);');
    expect(src).toContain('const next = c?.promoCode?.code ?? null;');
    expect(src).toContain('promoCode: appliedPromo');
  });

  it('an applied code can be removed: the cart promo is cleared server-side and the quote re-prices', () => {
    expect(src).toContain('const removePromo = useRemoveCartPromo();');
    expect(src).toContain('removePromo.mutate();');
    expect(src).toContain('label="Remove"');
  });

  it('a checkout promo refusal is shown as the message checkout returned', () => {
    expect(src).toContain('? checkoutErrorMessage(placeOrder.error)');
  });
});

describe('the no-riders pickup retry shows the new total before placing (E01-B)', () => {
  const src = code();

  it('tapping asks for a pickup quote; only the Alert confirm places the order', () => {
    // The retry no longer places on one tap.
    expect(src).toContain('const retryAsPickup = () => {');
    expect(src).toContain('setConfirmPickup(true);');
    expect(src).not.toMatch(/retryAsPickup = \(\) => \{\s*[\s\S]*onOrder\(\{ fulfillmentSelections/);
    // The confirm step reads the NEW pickup total from its own quote.
    expect(src).toContain('const pickupTotal = Number(pickupQuote.data.totalAmount);');
    expect(src).toContain('`Your pickup total is ${money(pickupTotal)}. The order is only placed when you confirm.`');
    expect(src).toContain("text: 'Confirm pickup order'");
    expect(src).toContain('onOrderLatest.current({ fulfillmentSelections: Object.fromEntries(storeIds.map((id) => [id, \'PICKUP\'])) });');
    expect(src).toContain("Alert.alert('Couldn’t price pickup', 'Try again in a moment.');");
    expect(src).toContain('const pickupQuote = useCart<any>(latitude ?? undefined, longitude ?? undefined, retryPricing, confirmPickup);');
  });
});

describe('an unavailable line recovers on the phone (E07)', () => {
  const src = code();

  it('the cart re-quotes when the Cart tab regains focus', () => {
    expect(src).toContain('useFocusEffect(');
    expect(src).toContain('cartRefetchLatest.current = cart.refetch;');
    expect(src).toContain('cartRefetchLatest.current()');
  });

  it('a stale-cart checkout refusal re-quotes immediately, so the line marks itself unavailable', () => {
    expect(src).toContain('if (cartStaleCheckoutCode(err)) void cart.refetch();');
  });

  it('an unavailable line is one tap from recovery: Remove calls the existing remove-line mutation with that line’s id', () => {
    expect(src).toContain('removeItem.mutate(it.id, { onSuccess: () => placeOrder.reset() })');
    expect(src).toContain('label="Remove"');
  });

  it('checkout stays blocked while any unavailable line remains', () => {
    expect(src).toMatch(/disabled=\{!quoteSettled \|\| !c\.meetsMinimum \|\| c\.unavailableItemIds\?\.length > 0/);
  });
});
