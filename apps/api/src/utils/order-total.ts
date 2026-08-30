/**
 * [ALG-24] Order-total determinism — ONE calculator.
 *
 * The cart quote (customer.routes) and checkout (order.service) each carried
 * their own copy of the same arithmetic: line totals, the promo switch with
 * its cap, the tip, and `max(0, subtotal + fee + tip − discount)`. Two copies
 * of one formula is how a quote and a charge drift by a dollar with nobody
 * changing either on purpose. This is the single home; both import it.
 *
 * Laws:
 *   - rounding happens at the declared points below and nowhere else;
 *   - the same inputs produce the same output on every call, forever — the
 *     replay test stores inputs and asserts equality across the quote, the
 *     charge and a recompute;
 *   - the client never computes a total the server owns; it renders these;
 *   - every component is nameable on the receipt.
 *
 * Units are the stored money unit (whole GYD as the platform prices today —
 * Decimal(12,2) columns). serviceFee and tax have a SLOT and no producer:
 * founder decision F-A2 says whether Swift ever adds either; until then they
 * are zero at every call site, and a later obligation is a config change,
 * not a refactor.
 */

export interface TotalLine {
  unitPrice: number;
  quantity: number;
}

export interface PromoTerms {
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_DELIVERY' | (string & {});
  discountValue: unknown;
  maxDiscount?: unknown;
}

export interface OrderTotal {
  subtotal: number;
  deliveryFee: number;
  discount: number;
  tip: number;
  serviceFee: number;
  tax: number;
  total: number;
}

/** A line is priced at its own level: unit price (base + options) × quantity. */
export function lineTotal(unitPrice: number, quantity: number): number {
  return unitPrice * quantity;
}

export function subtotalOf(lines: readonly TotalLine[]): number {
  return lines.reduce((sum, l) => sum + lineTotal(l.unitPrice, l.quantity), 0);
}

/**
 * The promo switch — the one place the three discount shapes are defined.
 * PERCENTAGE rounds UP at the discount (a customer never loses a cent to
 * truncation); FIXED_AMOUNT is the stated value; FREE_DELIVERY is exactly the
 * fee on the basis it was judged against; every shape is capped by
 * maxDiscount when one is set. Unknown shapes discount nothing.
 */
export function promoDiscount(promo: PromoTerms, basis: { subtotal: number; deliveryFee: number }): number {
  let discount = 0;
  switch (promo.discountType) {
    case 'PERCENTAGE':
      discount = Math.ceil(basis.subtotal * (Number(promo.discountValue) / 100));
      break;
    case 'FIXED_AMOUNT':
      discount = Number(promo.discountValue);
      break;
    case 'FREE_DELIVERY':
      discount = basis.deliveryFee;
      break;
  }
  if (promo.maxDiscount) discount = Math.min(discount, Number(promo.maxDiscount));
  return discount;
}

/** The total, never below zero: a discount larger than the order is the order. */
export function orderTotal(parts: { subtotal: number; deliveryFee: number; tip: number; discount: number; serviceFee?: number; tax?: number }): number {
  return Math.max(0, parts.subtotal - parts.discount + parts.deliveryFee + (parts.serviceFee ?? 0) + (parts.tax ?? 0) + parts.tip);
}

/** The whole calculation for one order, pure, from resolved inputs. */
export function computeOrderTotal(input: {
  lines: readonly TotalLine[];
  deliveryFee: number;
  tip: number;
  promo?: PromoTerms | null;
  serviceFee?: number;
  tax?: number;
}): OrderTotal {
  const subtotal = subtotalOf(input.lines);
  const discount = input.promo ? promoDiscount(input.promo, { subtotal, deliveryFee: input.deliveryFee }) : 0;
  const tip = input.tip;
  const serviceFee = input.serviceFee ?? 0;
  const tax = input.tax ?? 0;
  return {
    subtotal, deliveryFee: input.deliveryFee, discount, tip, serviceFee, tax,
    total: orderTotal({ subtotal, deliveryFee: input.deliveryFee, tip, discount, serviceFee, tax }),
  };
}
