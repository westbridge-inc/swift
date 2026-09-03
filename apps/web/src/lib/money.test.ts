import { describe, expect, it } from 'vitest';
import { MONEY_UNKNOWN, formatAmount, parseAmount, sumAmounts } from './money';
import { money } from './customer';
import { money as vendorMoney, toAmount } from './vendor-api';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [W-13] MONEY IS PARSED EXACTLY OR REFUSED.
//
// Two defects, one parser. The live one: a price the server never sent became
// ZERO — `Number(item.customerPrice ?? item.basePrice ?? 0)` — so a broken row
// rendered as free and could still be added to a cart and ordered, and
// `Math.round(n ?? 0)` printed "GY$0" for an absent price and "GY$NaN" for a
// malformed one. The latent one: Prisma sends `Decimal` columns as STRINGS,
// the cart typed them as `number`, and `serverSubtotal + deliveryFee` was one
// schema change from `"4000" + 500` — a total off by a thousand, displayed and
// submitted.
// ---------------------------------------------------------------------------

describe('[W-13] the parser is exact', () => {
  it.each([
    [0, 0],
    [4000, 4000],
    [-250, -250],
    [1234.56, 1234.56],
    ['0', 0],
    ['4000', 4000],
    ['4000.00', 4000],
    ['  4000.50  ', 4000.5],
    ['-250.25', -250.25],
  ])('reads %o as %o', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['   '],
    ['abc'],
    ['NaN'],
    ['Infinity'],
    ['1e5'],
    ['4,000'],
    ['$4000'],
    ['4000 GYD'],
    ['0x10'],
    [NaN],
    [Infinity],
    [-Infinity],
    [true],
    [false],
    [[]],
    [[4000]],
    [{}],
  ])('refuses %o', (input) => {
    expect(parseAmount(input as unknown)).toBeNull();
  });

  it('the two coercions JavaScript performs silently are both refused', () => {
    // Number('') === 0 and Number([]) === 0 — the invented zeros this exists to stop
    expect(Number('')).toBe(0);
    expect(Number([])).toBe(0);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount([])).toBeNull();
  });
});

describe('[W-13] a total is never built from a part that could not be read', () => {
  it('sums parsed parts, including strings from the wire', () => {
    expect(sumAmounts('4000', 500, -200, 100)).toBe(4400);
    expect(sumAmounts(0, 0)).toBe(0);
  });

  it('refuses the whole sum when ANY part is not money', () => {
    for (const bad of [undefined, null, '', 'abc', NaN, {}]) {
      expect(sumAmounts('4000', 500, bad as unknown), String(bad)).toBeNull();
    }
  });

  it('the defect it replaces: string concatenation produced a total 1000× too large', () => {
    // what the old line did with a Decimal string
    const naive = ('4000' as unknown as number) + 500 - 0 + 0;
    expect(naive).toBe(4000500);
    // what it does now
    expect(sumAmounts('4000', 500, -0, 0)).toBe(4500);
  });
});

describe('[W-13] formatting never invents a figure', () => {
  it('renders an em-dash for anything that is not money, and zero for a real zero', () => {
    expect(formatAmount(0, 'GY$')).toBe('GY$0');
    expect(formatAmount('4000', 'GY$')).toBe('GY$4,000');
    for (const bad of [undefined, null, '', 'abc', NaN]) {
      expect(formatAmount(bad, 'GY$'), String(bad)).toBe(MONEY_UNKNOWN);
    }
  });

  it('the customer formatter no longer prints GY$0 for an absent price, or GY$NaN for a broken one', () => {
    expect(money(undefined)).toBe(MONEY_UNKNOWN);
    expect(money(null)).toBe(MONEY_UNKNOWN);
    expect(money(NaN)).toBe(MONEY_UNKNOWN);
    expect(money(0)).toBe('GY$0'); // free is still free
    expect(money('4000.00')).toBe('GY$4,000');
  });

  it('the vendor formatter is the same parser, with its own prefix', () => {
    expect(vendorMoney(undefined)).toBe(MONEY_UNKNOWN);
    expect(vendorMoney('4500.00')).toBe('$4,500');
    expect(toAmount('4500.00')).toBe(4500);
    expect(toAmount('')).toBeNull();
  });
});

describe('[W-13] the surfaces that spent money use it', () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  it('the storefront refuses to price, and refuses to sell, an item whose price it cannot read', () => {
    const storefront = source('src/components/storefront/storefront-experience.tsx');
    // the old shape: a missing price coerced to zero
    expect(storefront).not.toMatch(/Number\(item\.customerPrice \?\? item\.basePrice \?\? 0\)/);
    expect(storefront).toMatch(/parseAmount\(item\.customerPrice \?\? item\.basePrice\)/);
    // and an unpriced item is not orderable
    expect(storefront).toMatch(/const priced = itemPrice\(item\) !== null;/);
    expect(storefront).toMatch(/&& priced;/);
    expect(storefront).toMatch(/Price unavailable/);
  });

  it('the cart computes its total from parsed parts and locks checkout when it cannot', () => {
    const cart = source('src/app/(app)/cart/page.tsx');
    // the old shape: raw arithmetic across wire values
    expect(cart).not.toMatch(/serverSubtotal \+ deliveryFee - discount \+ tip/);
    expect(cart).toMatch(/sumAmounts\(/);
    // the CONDITION, not the name: `const moneyUnreadable = false` satisfied a
    // looser pattern and left checkout open on a total that could not be read
    expect(cart).toMatch(/const moneyUnreadable = cart != null && totalParts === null;/);
    // both checkout buttons refuse
    expect(cart.match(/disabled=\{busy[^}]*moneyUnreadable/g) ?? []).toHaveLength(2);
    expect(cart).toMatch(/Checkout stays locked until the total is/);
  });

  it('there is ONE parser, not two that drift', () => {
    const vendor = source('src/lib/vendor-api.ts');
    const customer = source('src/lib/customer.ts');
    expect(vendor).toMatch(/return parseAmount\(value\);/);
    expect(customer).toMatch(/formatAmount\(n, 'GY\$'\)/);
    // the permissive one is gone — checked on CODE, not on the comment that
    // quotes it (a census that matches its own documentation proves nothing)
    const code = customer.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/Math\.round\(n \?\? 0\)/);
  });
});
