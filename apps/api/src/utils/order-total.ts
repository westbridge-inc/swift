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

/** [M-32] Who funds a discount. PLATFORM = an admin-issued code (Swift pays
 *  for it); VENDOR = the store's own promotion (the store pays for it). */
export type PromoFunder = 'PLATFORM' | 'VENDOR' | (string & {});

export interface PromoTerms {
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_DELIVERY' | (string & {});
  discountValue: unknown;
  maxDiscount?: unknown;
  funder?: PromoFunder | null;
}

/** [M-32] The components a discount may be taken from, by funder. Goods
 *  first; the delivery fee only when the PLATFORM funds the code — a store's
 *  promotion is not the rider's fee to give away; the tip NEVER — a promised
 *  tip is the mover's, and no sponsor rail exists to fund it. */
export interface PromoAllocation {
  goods: number;
  delivery: number;
  tip: 0;
  total: number;
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
  // [M-32] An explicit zero cap is a cap of zero, not an absent cap: a promo
  // an operator has capped at 0 discounts nothing. Only null/undefined means
  // "uncapped". (Before, `if (promo.maxDiscount)` read 0 as absent.)
  if (promo.maxDiscount != null) discount = Math.min(discount, Number(promo.maxDiscount));
  return discount;
}

/** [M-32] How much of a basis a promo funded by `funder` is able to absorb:
 *  the goods, plus the delivery fee when the platform funds it. The tip is
 *  never part of the capacity. */
export function promoCapacity(funder: PromoFunder | null | undefined, basis: { subtotal: number; deliveryFee: number }, discountType?: string | null): number {
  const feeRoom = funder === 'VENDOR' ? 0 : Math.max(0, basis.deliveryFee);
  // A free-delivery code is a discount on the FEE component and nothing else.
  if (discountType === 'FREE_DELIVERY') return feeRoom;
  return Math.max(0, basis.subtotal) + feeRoom;
}

/** [M-32] Split a discount across the components it may touch, in order:
 *  goods, then (platform-funded only) the delivery fee. Whatever the basis
 *  cannot absorb is not taken — the tip is never discounted. The parts always
 *  sum to `total`, and `total <= discount`. */
export function allocatePromo(
  funder: PromoFunder | null | undefined,
  discount: number,
  basis: { subtotal: number; deliveryFee: number },
  discountType?: string | null,
): PromoAllocation {
  const wanted = Math.max(0, discount);
  const feeRoom = funder === 'VENDOR' ? 0 : Math.max(0, basis.deliveryFee);
  if (discountType === 'FREE_DELIVERY') {
    // The fee component and nothing else: booked against goods, a free
    // delivery would later be refunded as goods on a return.
    const delivery = Math.min(wanted, feeRoom);
    return { goods: 0, delivery, tip: 0, total: delivery };
  }
  const goods = Math.min(wanted, Math.max(0, basis.subtotal));
  const delivery = Math.min(wanted - goods, feeRoom);
  return { goods, delivery, tip: 0, total: goods + delivery };
}

/** [M-33] Split an amount across lines in proportion to their value so the
 *  shares sum EXACTLY to the amount (largest-remainder rounding): the goods
 *  discount a promo took is owned line by line from the moment the order is
 *  placed, and a return refunds each line's own share. Lines with no value,
 *  or an amount of zero, allocate zero. */
export function allocateAcrossLines(amount: number, lines: ReadonlyArray<{ id: string; amount: number }>): Array<{ id: string; share: number }> {
  const total = Math.max(0, Math.round(amount));
  const weight = lines.reduce((s, l) => s + Math.max(0, l.amount), 0);
  if (total === 0 || weight <= 0) return lines.map((l) => ({ id: l.id, share: 0 }));
  const exact = lines.map((l) => (total * Math.max(0, l.amount)) / weight);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = total - floors.reduce((s, f) => s + f, 0);
  const order = exact.map((x, i) => ({ i, frac: x - floors[i]! })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = floors[i]! + 1;
    remainder -= 1;
  }
  return lines.map((l, i) => ({ id: l.id, share: floors[i]! }));
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
