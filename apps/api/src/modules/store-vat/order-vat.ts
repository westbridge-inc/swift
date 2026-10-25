/**
 * [STORE-VAT · owner O-5] The VAT frozen on an order, written by ONE function.
 *
 * Checkout freezes the seller's approved VAT number, its registered name and the rate (`vatTermsForCheckout`,
 * read inside the checkout transaction) and each line's VAT class; then `recomputeOrderVat` writes the amounts.
 * Every later change to the order's goods (an approved substitution, a removed line) calls `recomputeOrderVat`
 * again in its own transaction, so the VAT always matches the goods the customer is charged for.
 *
 * Money is untouched: the VAT is inside the goods (vat-math.ts). An order frozen without VAT (`vatRateBps` null)
 * never gains it later, and an order frozen with VAT keeps it whatever the store or the switch does next.
 */
import { Prisma } from '@prisma/client';
import { orderVat, type OrderVatResult, type VatClassName } from './vat-math';
import { STORE_VAT_RATE_BPS, STORE_VAT_RATE_PERCENT } from './vat-rate';
import { STORE_VAT_SELECT, storeVatEffective } from './store-vat';

type Db = Prisma.TransactionClient;

/** A line that came off the order was never charged (order/receipt.ts uses the same two states). */
const REMOVED_SUB_STATUSES: ReadonlySet<string> = new Set(['REFUNDED', 'REJECTED']);

export interface OrderVatTerms {
  sellerNumber: string;
  sellerName: string;
  rateBps: number;
}

/** What an order placed now at this store freezes; null = the order carries no VAT. */
export async function vatTermsForCheckout(db: Db, vendorId: string, env: Record<string, string | undefined> = process.env, now: Date = new Date()): Promise<OrderVatTerms | null> {
  const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: STORE_VAT_SELECT });
  if (!vendor || !storeVatEffective(vendor, env, now)) return null;
  return { sellerNumber: vendor.vatApprovedNumber!, sellerName: vendor.vatApprovedName!, rateBps: STORE_VAT_RATE_BPS };
}

/** The order columns checkout writes with its row (the amounts follow from `recomputeOrderVat`). */
export function orderVatCreateFields(terms: OrderVatTerms | null): { vatRateBps?: number; vatSellerNumber?: string; vatSellerName?: string } {
  return terms ? { vatRateBps: terms.rateBps, vatSellerNumber: terms.sellerNumber, vatSellerName: terms.sellerName } : {};
}

/** A line's class as checkout freezes it: the item's class for a VAT order, nothing otherwise. */
export function lineVatClass(terms: OrderVatTerms | null, itemClass: string | null | undefined): VatClassName | undefined {
  if (!terms) return undefined;
  return itemClass === 'ZERO_RATED' || itemClass === 'EXEMPT' ? itemClass : 'STANDARD';
}

function lineShares(raw: unknown): Map<string, number> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const shares = new Map<string, number>();
  for (const a of raw as Array<{ orderItemId?: unknown; goods?: unknown }>) {
    if (typeof a?.orderItemId === 'string') shares.set(a.orderItemId, Math.max(0, Number(a.goods) || 0));
  }
  return shares;
}

/** The order columns the VAT amounts are written to (Decimal, like every money column). */
export function orderVatAmountFields(result: OrderVatResult) {
  return {
    vatAmount: new Prisma.Decimal(result.vatAmount),
    vatStandardGoods: new Prisma.Decimal(result.standardGoods),
    vatZeroRatedGoods: new Prisma.Decimal(result.zeroRatedGoods),
    vatExemptGoods: new Prisma.Decimal(result.exemptGoods),
    vatBase: new Prisma.Decimal(result.vatBase),
  };
}

/**
 * Write the order's VAT from its lines as they stand. A no-op (null) for an order frozen without VAT.
 * The goods discount each line carries is the share the promo redemption stored (M-33), so the VAT is on what
 * the customer is actually charged for the goods.
 */
export async function recomputeOrderVat(db: Db, orderId: string): Promise<OrderVatResult | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      vatRateBps: true,
      items: { select: { id: true, totalCustomer: true, vatClass: true, subStatus: true } },
      promoRedemption: { select: { lineAllocations: true } },
    },
  });
  if (!order || order.vatRateBps == null) return null;
  const result = orderVat({
    lines: order.items.map((it) => ({
      id: it.id,
      amount: REMOVED_SUB_STATUSES.has(it.subStatus) ? 0 : Number(it.totalCustomer),
      vatClass: (it.vatClass ?? 'STANDARD') as VatClassName,
    })),
    lineGoodsDiscounts: lineShares(order.promoRedemption?.lineAllocations) ?? new Map(),
    // The rate the order froze, never today's: a later rate change never reaches a placed order.
    rateBps: order.vatRateBps,
  });
  await db.order.update({ where: { id: orderId }, data: orderVatAmountFields(result) });
  return result;
}

/** What the cart quote shows for one store: the VAT included in its goods, or null (no VAT for this store). */
export interface CartVat {
  included: number;
  ratePercent: number;
  standardGoods: number;
  zeroRatedGoods: number;
  exemptGoods: number;
}

/**
 * [cart quote] The VAT inside each approved VAT store's goods, by the same function checkout freezes with
 * (`orderVat`, the goods discount split across the lines). Stores whose VAT is not in effect get no entry.
 */
export async function cartVatByVendor(
  db: Pick<Prisma.TransactionClient, 'vendor'>,
  plans: ReadonlyArray<{ vendorId: string; goodsDiscount: number; lines: ReadonlyArray<{ id: string; amount: number; vatClass: string | null | undefined }> }>,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Promise<Map<string, CartVat>> {
  const out = new Map<string, CartVat>();
  if (plans.length === 0) return out;
  const vendors = await db.vendor.findMany({ where: { id: { in: plans.map((p) => p.vendorId) } }, select: STORE_VAT_SELECT });
  const effective = new Set(vendors.filter((v) => storeVatEffective(v, env, now)).map((v) => v.id));
  for (const plan of plans) {
    if (!effective.has(plan.vendorId)) continue;
    const vat = orderVat({
      lines: plan.lines.map((l) => ({ id: l.id, amount: l.amount, vatClass: (l.vatClass === 'ZERO_RATED' || l.vatClass === 'EXEMPT' ? l.vatClass : 'STANDARD') as VatClassName })),
      goodsDiscount: plan.goodsDiscount,
    });
    out.set(plan.vendorId, {
      included: vat.vatAmount, ratePercent: STORE_VAT_RATE_PERCENT,
      standardGoods: vat.standardGoods, zeroRatedGoods: vat.zeroRatedGoods, exemptGoods: vat.exemptGoods,
    });
  }
  return out;
}
