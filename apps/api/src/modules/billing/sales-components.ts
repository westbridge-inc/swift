import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * [M-38] A vendor's sales, separated — from each order's redemption snapshot
 * (M-32 / M-33), never from the aggregate discount.
 *
 * Stop-ship register M-38: the vendor statement computed subtotal minus the
 * order's whole discount, so a FREE_DELIVERY code or a platform-funded goods
 * discount was subtracted from the vendor's sales as if the vendor had given
 * it; the weekly digest inherited the same drift. Now every order yields:
 *
 *   goodsSales           what the vendor sold (subtotalCustomer)
 *   vendorPromoDiscount  the vendor's OWN promotion (funder VENDOR) — the
 *                        only discount that reduces what the vendor keeps
 *   sponsorReceivable    a platform-funded goods discount (funder PLATFORM):
 *                        the customer paid less, Swift owes the vendor this
 *   customerCollection   what the customer actually paid for goods
 *   feeFunding           the platform-funded delivery-fee discount (the
 *                        rider's fee gap Swift funds — not the vendor's money)
 *   moverPayable         delivery fee + tip — the rider's, never the vendor's
 *
 * An order with a discount but no snapshot (placed before M-32) is split by
 * the conservative reading the old statement made — the discount as the
 * vendor's own — and MARKED estimated, so a report that contains one says
 * "estimated, not settled".
 */
export interface OrderMoneyRow {
  subtotalCustomer: unknown;
  discount: unknown;
  deliveryFee: unknown;
  tipAmount: unknown;
  promoRedemption: { goodsDiscount: unknown; deliveryDiscount: unknown; funder: string } | null;
}

export interface SalesComponents {
  goodsSales: number;
  vendorPromoDiscount: number;
  sponsorReceivable: number;
  customerCollection: number;
  feeFunding: number;
  moverPayable: number;
  estimated: boolean;
}

const num = (v: unknown) => Math.max(0, Number(v ?? 0) || 0);

export function orderComponents(o: OrderMoneyRow): SalesComponents {
  const goods = num(o.subtotalCustomer);
  const moverPayable = num(o.deliveryFee) + num(o.tipAmount);
  if (o.promoRedemption) {
    const g = Math.min(goods, num(o.promoRedemption.goodsDiscount));
    const vendorPromoDiscount = o.promoRedemption.funder === 'VENDOR' ? g : 0;
    const sponsorReceivable = o.promoRedemption.funder === 'PLATFORM' ? g : 0;
    return {
      goodsSales: goods, vendorPromoDiscount, sponsorReceivable, customerCollection: goods - g,
      feeFunding: num(o.promoRedemption.deliveryDiscount), moverPayable, estimated: false,
    };
  }
  const discount = num(o.discount);
  const goodsShare = Math.min(discount, goods);
  return {
    goodsSales: goods, vendorPromoDiscount: goodsShare, sponsorReceivable: 0, customerCollection: goods - goodsShare,
    feeFunding: Math.max(0, discount - goodsShare), moverPayable, estimated: discount > 0,
  };
}

export interface SalesTotals {
  goodsSales: number;
  vendorPromoDiscount: number;
  sponsorReceivable: number;
  customerCollection: number;
  feeFunding: number;
  moverPayable: number;
  estimatedOrders: number;
  /** What the vendor keeps from goods: goodsSales − vendorPromoDiscount. */
  netSales: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function sumComponents(rows: readonly OrderMoneyRow[]): SalesTotals {
  const t = { goodsSales: 0, vendorPromoDiscount: 0, sponsorReceivable: 0, customerCollection: 0, feeFunding: 0, moverPayable: 0, estimatedOrders: 0 };
  for (const row of rows) {
    const c = orderComponents(row);
    t.goodsSales += c.goodsSales; t.vendorPromoDiscount += c.vendorPromoDiscount; t.sponsorReceivable += c.sponsorReceivable;
    t.customerCollection += c.customerCollection; t.feeFunding += c.feeFunding; t.moverPayable += c.moverPayable;
    if (c.estimated) t.estimatedOrders += 1;
  }
  return {
    goodsSales: round2(t.goodsSales), vendorPromoDiscount: round2(t.vendorPromoDiscount), sponsorReceivable: round2(t.sponsorReceivable),
    customerCollection: round2(t.customerCollection), feeFunding: round2(t.feeFunding), moverPayable: round2(t.moverPayable),
    estimatedOrders: t.estimatedOrders, netSales: round2(t.goodsSales - t.vendorPromoDiscount),
  };
}

/** The components over every completed order of one vendor in a window (or
 *  an explicit id set), in SQL — a busy vendor's statement never understates
 *  past a line cap. Same law as `orderComponents`, in one query. */
export async function aggregateSalesComponents(
  prisma: PrismaClient,
  scope: { vendorId: string } & ({ from: Date; to: Date } | { orderIds: string[] }),
): Promise<SalesTotals & { orders: number }> {
  const filter = 'orderIds' in scope
    ? (scope.orderIds.length === 0 ? Prisma.sql`FALSE` : Prisma.sql`o."id" IN (${Prisma.join(scope.orderIds)})`)
    : Prisma.sql`o."placedAt" >= ${scope.from} AND o."placedAt" <= ${scope.to}`;
  const [row] = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT count(*)::bigint AS orders,
      coalesce(sum(o."subtotalCustomer"), 0) AS goods,
      coalesce(sum(CASE WHEN r."funder" = 'VENDOR' THEN least(o."subtotalCustomer", r."goodsDiscount") ELSE 0 END), 0) AS vendor_promo,
      coalesce(sum(CASE WHEN r."funder" = 'PLATFORM' THEN least(o."subtotalCustomer", r."goodsDiscount") ELSE 0 END), 0) AS sponsor,
      coalesce(sum(CASE WHEN r."orderId" IS NULL THEN least(greatest(o."discount", 0), o."subtotalCustomer") ELSE 0 END), 0) AS legacy_goods,
      coalesce(sum(CASE WHEN r."orderId" IS NULL THEN greatest(greatest(o."discount", 0) - o."subtotalCustomer", 0) ELSE r."deliveryDiscount" END), 0) AS fee_funding,
      coalesce(sum(o."deliveryFee" + o."tipAmount"), 0) AS mover,
      count(*) FILTER (WHERE r."orderId" IS NULL AND o."discount" > 0)::bigint AS estimated
    FROM "orders" o
    LEFT JOIN "promo_redemptions" r ON r."orderId" = o."id"
    WHERE o."vendorId" = ${scope.vendorId} AND o."status" IN ('DELIVERED', 'COMPLETED') AND ${filter}`);
  const n = (k: string) => Number(row?.[k] ?? 0);
  const goodsSales = round2(n('goods'));
  const vendorPromoDiscount = round2(n('vendor_promo') + n('legacy_goods'));
  const sponsorReceivable = round2(n('sponsor'));
  return {
    orders: n('orders'), goodsSales, vendorPromoDiscount, sponsorReceivable,
    customerCollection: round2(goodsSales - vendorPromoDiscount - sponsorReceivable),
    feeFunding: round2(n('fee_funding')), moverPayable: round2(n('mover')), estimatedOrders: n('estimated'),
    netSales: round2(goodsSales - vendorPromoDiscount),
  };
}
