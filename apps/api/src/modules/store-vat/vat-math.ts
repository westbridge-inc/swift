/**
 * [STORE-VAT · owner O-5] The VAT arithmetic, pure, in ONE place. Checkout, the cart quote and every later
 * change to an order's goods (substitution, a removed line) call `orderVat`; nothing else computes VAT.
 *
 * Prices of a VAT-registered store INCLUDE the VAT (VAT Act s.90(1)-(2)); Swift never adds VAT on top of
 * a total, so the money an order charges is unchanged by this module: it only says how much of the goods
 * price is the store's VAT.
 *
 * Rule (vat-rate.ts): per ORDER, VAT = half-up to whole GYD of (the store's consideration for its standard-rated
 * goods) x 14/114: each standard line's amount less its share of a discount THE STORE gave (utils/order-total
 * allocateAcrossLines, the same split the promo redemption stores), floored at zero; a removed line counts nothing.
 * A discount Swift funds is paid to the store by Swift, so it never lowers the store's VAT (VAT Act s.2; the caller
 * passes only the store-funded discount: order-vat.ts vatDiscountFor). Zero-rated and exempt goods carry no VAT and are reported separately
 * (VAT Regulations reg. 10(d)). Delivery pay, tips, waiting charges and Swift's own fees are never goods
 * and never carry a store's VAT.
 *
 * Exact integer arithmetic (cents as BigInt): no float ever decides a rounding.
 */
import { allocateAcrossLines } from '../../utils/order-total';
import { STORE_VAT_RATE_BPS } from './vat-rate';

export const VAT_CLASSES = ['STANDARD', 'ZERO_RATED', 'EXEMPT'] as const;
export type VatClassName = (typeof VAT_CLASSES)[number];

export interface VatLineInput {
  id: string;
  /** What the line charges the customer (its totalCustomer), whole GYD. A removed line passes 0. */
  amount: number;
  vatClass: VatClassName;
}

export interface OrderVatResult {
  /** The VAT included in the goods, whole GYD. */
  vatAmount: number;
  /** Goods by class, as the lines charge them (before any discount). */
  standardGoods: number;
  zeroRatedGoods: number;
  exemptGoods: number;
  /** The standard-rated goods the VAT was taken from: after the goods discount. */
  vatBase: number;
  /** The rate the amount was computed at (1400 = 14%). */
  rateBps: number;
}

function cents(amount: number): bigint {
  if (!Number.isFinite(amount)) throw new RangeError('VAT: a money amount is not a finite number');
  return BigInt(Math.round(amount * 100));
}

/** Half-up of `num / den` for non-negative integers. */
function halfUp(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

/** VAT inside `baseCents` (a VAT-inclusive amount, in cents) at `rateBps`, half-up to whole GYD:
 *  the tax fraction R/(1+R) (Act s.2) = rateBps/(10000+rateBps), 1400/11400 = 7/57 at 14%. */
function vatInsideCents(baseCents: bigint, rateBps: number): bigint {
  if (!Number.isInteger(rateBps) || rateBps < 0) throw new RangeError('VAT: the rate is not a whole number of basis points');
  return halfUp(baseCents * BigInt(rateBps), BigInt(10_000 + rateBps) * 100n);
}

/** The VAT inside a VAT-inclusive standard-rated amount, half-up to whole GYD (amount x 14/114 at 14%). */
export function vatInsideWhole(grossStandard: number, rateBps: number = STORE_VAT_RATE_BPS): number {
  return Number(vatInsideCents(cents(Math.max(0, grossStandard)), rateBps));
}

/**
 * One order's VAT. `lineGoodsDiscounts` are the per-line goods discount shares (orderItemId -> share); when
 * absent they are derived from `goodsDiscount` with the same largest-remainder split the redemption stores.
 */
export function orderVat(input: {
  lines: readonly VatLineInput[];
  goodsDiscount?: number;
  lineGoodsDiscounts?: ReadonlyMap<string, number>;
  /** The rate the order froze; today's rate when absent (a new order). */
  rateBps?: number;
}): OrderVatResult {
  const rateBps = input.rateBps ?? STORE_VAT_RATE_BPS;
  const shares = input.lineGoodsDiscounts
    ?? new Map(allocateAcrossLines(Math.max(0, input.goodsDiscount ?? 0), input.lines.map((l) => ({ id: l.id, amount: Math.max(0, l.amount) })))
      .map((a) => [a.id, a.share] as const));
  let standard = 0n; let zero = 0n; let exempt = 0n; let base = 0n;
  for (const line of input.lines) {
    const amount = cents(Math.max(0, line.amount));
    if (line.vatClass === 'ZERO_RATED') { zero += amount; continue; }
    if (line.vatClass === 'EXEMPT') { exempt += amount; continue; }
    standard += amount;
    const charged = amount - cents(Math.max(0, shares.get(line.id) ?? 0));
    if (charged > 0n) base += charged;
  }
  const vat = vatInsideCents(base, rateBps);
  return {
    vatAmount: Number(vat),
    standardGoods: Number(standard) / 100,
    zeroRatedGoods: Number(zero) / 100,
    exemptGoods: Number(exempt) / 100,
    vatBase: Number(base) / 100,
    rateBps,
  };
}
