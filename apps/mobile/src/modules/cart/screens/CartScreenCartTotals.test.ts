import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [E01 · E09] The cart screen renders SERVER-owned totals.
//
// The screen used to recompute the pickup total itself by subtracting the
// single quoted fee (`c.totalAmount - c.deliveryFee`) — a third calculator the
// server never saw — and submitted the pickup choice only for `c.vendor.id`,
// the most recently added vendor. A multi-vendor basket is several orders:
// the screen must render the server's per-mode quote (fetched with the
// selection) and submit the pickup choice for EVERY vendor, and the minimum
// warning must name each short vendor. These pins hold those laws in the
// source (there is no RN renderer in the vitest environment).
// ---------------------------------------------------------------------------

const FILE = join(process.cwd(), 'src/modules/cart/screens/CartScreen.tsx');

function stripComments(src: string): string {
  const out = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (out.trim().length < 1000) throw new Error('comment stripper emptied the file — assertions would be vacuous');
  return out;
}

describe('cart totals are server-owned (E01)', () => {
  const src = stripComments(readFileSync(FILE, 'utf8'));

  it('the pickup total is never recomputed on the client', () => {
    // The old third calculator subtracted the single quoted delivery fee —
    // wrong the moment the cart spans vendors.
    expect(src).not.toContain('c.totalAmount - c.deliveryFee');
    // The rendered total is the server's number for the selected mode.
    expect(src).toMatch(/displayedTotal = c \? \(express \? c\.expressTotal : c\.totalAmount\)/);
  });

  it('the quote is fetched with the mode selection for every vendor', () => {
    // The selection is built from the items' own vendor ids, not cart.vendor.
    expect(src).not.toContain('{ [c.vendor.id]: \'PICKUP\' }');
    expect(src).toContain('pickupVendorIds.map((id) => [id, \'PICKUP\']');
    expect(src).toContain('fulfillment: fulfillmentSelections');
  });
});

describe('the minimum warning names each short vendor (E09)', () => {
  const src = stripComments(readFileSync(FILE, 'utf8'));

  it('one row per vendor below its own minimum, with the remaining amount', () => {
    expect(src).toContain('filter((v: any) => !v.meetsMinimum)');
    expect(src).toContain('has a minimum order of {money(v.minOrderAmount)}');
    expect(src).toContain('Math.max(0, Number(v.minOrderAmount) - Number(v.subtotal))');
  });
});
