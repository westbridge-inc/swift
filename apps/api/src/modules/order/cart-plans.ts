/**
 * [E01 · E09 · ALG-24] The cart quote and checkout price a basket through ONE
 * computation.
 *
 * A multi-vendor cart becomes one order per vendor. Checkout always priced it
 * that way; the quote priced the whole basket as ONE order of `cart.vendor`
 * (only the most recently added store): one distance, one delivery fee, one
 * minimum, a tip that stayed on a pickup-only basket, and no way to ask for
 * pickup or express at all. The screen and the charge could then differ by
 * whole delivery fees, silently. utils/order-total.ts had already unified the
 * per-order arithmetic; the PER-VENDOR structure around it was still two
 * copies. This module is that structure, once.
 *
 * Both callers run the same pipeline:
 *   groupLinesByVendor → planFulfillment → planVendorGroup (each vendor)
 *     → resolveTip → priceBasket (the whole basket).
 * The quote (customer.routes buildCartResponse) and checkout
 * (OrderService.checkout) differ only in what they REFUSE. Checkout keeps every
 * eligibility check inline — open, stock, capacity, radius, minimum, promo
 * validity, cash-promo sponsorship. Nothing in here throws.
 *
 * Laws:
 *   - one plan order: the tip rides the FIRST delivery plan and a platform code
 *     fills plans in order, so the quote's per-vendor rows and the orders
 *     checkout writes must be built in the same order — groupLinesByVendor;
 *   - a plan's fee is `deliveryFeeFromRates(canonical km)`; express multiplies
 *     it through `expressDeliveryFee`; PICKUP and APPOINTMENT plans carry none;
 *   - a plan's minimum compares THAT vendor's subtotal with ITS OWN minimum —
 *     never the combined basket against one vendor's;
 *   - the client never computes a total the server owns; it renders these.
 */

import { deliveryFeeFromRates, expressDeliveryFee, type DeliveryRates } from '../../utils/markup';
import type { LatLng, RouteSource } from '../../providers/maps/maps-provider';
import { canonicalBillableKm } from '../../utils/billable-distance';
import { resolveSelectedOptions, optionsUnitPrice, type ResolvedOption } from './options';
import {
  lineTotal, orderTotal, promoCapacity, promoDiscount, allocatePromo,
  type PromoAllocation, type PromoTerms,
} from '../../utils/order-total';

export type PlanFulfillment = 'DELIVERY' | 'PICKUP' | 'APPOINTMENT';
/** What the customer may choose for a vendor's goods (checkout's
 *  `fulfillmentSelections` values). */
export type CustomerFulfillment = 'DELIVERY' | 'PICKUP';

/** The distance the QUOTE prices a delivery from when it has no destination
 *  at all (no saved address, no device fix) — the historical preview default.
 *  Checkout never uses it: it refuses a DELIVERY plan without an address
 *  before planning. */
export const QUOTE_FALLBACK_KM = 3;

/** A cart line as both callers load it (checkout includes every option
 *  column; the quote selects the three that price). */
export interface PricedCartLineInput {
  id: string;
  createdAt: Date;
  quantity: number;
  selectedOptions: unknown;
  item: {
    vendorId: string;
    fulfillment: string;
    basePrice: unknown;
    optionGroups?: Array<{ name: string; options: Array<{ id: string; name: string; additionalPrice: unknown }> }> | null;
  };
}

/**
 * One deterministic plan order for both callers: vendors in the order their
 * first line was added (created, then id); lines keep that order inside each
 * vendor. Money placement depends on it — the tip rides the first DELIVERY
 * plan, a platform code fills plans in order — so the quote's per-vendor rows
 * and the orders checkout writes line up one for one.
 */
export function groupLinesByVendor<L extends Pick<PricedCartLineInput, 'id' | 'createdAt'> & { item: { vendorId: string } }>(
  lines: readonly L[],
): Array<{ vendorId: string; lines: L[] }> {
  const ordered = [...lines].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const groups = new Map<string, L[]>();
  for (const line of ordered) {
    const group = groups.get(line.item.vendorId);
    if (group) group.push(line);
    else groups.set(line.item.vendorId, [line]);
  }
  return [...groups].map(([vendorId, grouped]) => ({ vendorId, lines: grouped }));
}

/**
 * The mode a vendor's group is priced under. A booking line makes the group an
 * APPOINTMENT whatever was chosen (checkout then refuses a group that mixes a
 * booking with anything else); every other group takes the customer's
 * DELIVERY/PICKUP choice, DELIVERY when none was made — checkout's own rule.
 */
export function planFulfillment(
  lines: ReadonlyArray<{ item: { fulfillment: string } }>,
  requested: CustomerFulfillment | undefined,
): PlanFulfillment {
  if (lines.some((l) => l.item.fulfillment === 'APPOINTMENT')) return 'APPOINTMENT';
  return requested ?? 'DELIVERY';
}

/** One line's price: unit = base + selected options (only options that belong
 *  to the item), line = unit × quantity. The quote's line rows, the plan
 *  subtotal and the order's line snapshot all come from here. */
export function priceCartLine(line: Pick<PricedCartLineInput, 'quantity' | 'selectedOptions' | 'item'>): {
  basePrice: number;
  unitPrice: number;
  options: ResolvedOption[];
  lineTotal: number;
} {
  const basePrice = Number(line.item.basePrice);
  const options = resolveSelectedOptions(line.item, line.selectedOptions);
  const unitPrice = basePrice + optionsUnitPrice(options);
  return { basePrice, unitPrice, options, lineTotal: lineTotal(unitPrice, line.quantity) };
}

/** [REPORT-012 F-012-01] Presence, not truthiness: an explicit 0 means "no
 *  tip" and must not fall through to a tip persisted on the cart by another
 *  surface or session. Only an ABSENT tip inherits the cart's. */
export function resolveTip(requested: number | null | undefined, cartTip: unknown): number {
  return requested != null ? requested : (Number(cartTip) || 0);
}

export interface VendorPlan {
  vendorId: string;
  vendorName: string;
  fulfillment: PlanFulfillment;
  /** [ALG-18] The canonical billable km the fee was priced from. Zero for
   *  PICKUP and APPOINTMENT plans (checkout records a mobile booking's travel
   *  distance itself). */
  distanceKm: number;
  /** [ALG-18] Which engine produced `distanceKm`; frozen on the order. */
  distanceSource: RouteSource | null;
  /** THIS vendor's lines only — the number its own minimum judges. */
  subtotal: number;
  /** The fee without the express premium. */
  standardDeliveryFee: number;
  /** The fee this plan is charged: the express premium applied when asked. */
  deliveryFee: number;
  /** What express adds (or added) to this plan's fee; zero off DELIVERY. */
  expressSurcharge: number;
  minOrderAmount: number;
  meetsMinimum: boolean;
  /** How much more of THIS vendor's goods reaches its minimum (0 once met). */
  amountToMinimum: number;
}

/**
 * Price one vendor's group. The distance is canonicalized before pricing (the
 * number checkout freezes), the fee comes from the buyer's schedule, and the
 * subtotal is the sum of `priceCartLine`. Pure apart from `routeKm`.
 */
export async function planVendorGroup(ctx: {
  vendor: { id: string; name: string; latitude: number; longitude: number; minOrderAmount: unknown };
  lines: ReadonlyArray<Pick<PricedCartLineInput, 'quantity' | 'selectedOptions' | 'item'>>;
  fulfillment: PlanFulfillment;
  /** Where a DELIVERY goes. Null only in the quote (see QUOTE_FALLBACK_KM). */
  destination: LatLng | null;
  deliveryRates: DeliveryRates;
  /** Priority delivery: the fee carries the rider's 1.5x premium. */
  express: boolean;
  routeKm: (from: LatLng, to: LatLng) => Promise<{ km: number; source: RouteSource | null }>;
}): Promise<VendorPlan> {
  const subtotal = ctx.lines.reduce((sum, line) => sum + priceCartLine(line).lineTotal, 0);

  let distanceKm = 0;
  let distanceSource: RouteSource | null = null;
  let standardDeliveryFee = 0;
  if (ctx.fulfillment === 'DELIVERY') {
    if (ctx.destination) {
      const route = await ctx.routeKm(
        { lat: ctx.vendor.latitude, lng: ctx.vendor.longitude },
        { lat: ctx.destination.lat, lng: ctx.destination.lng },
      );
      // [ALG-18] Canonical BEFORE pricing: the fee and the frozen number are one number.
      distanceKm = canonicalBillableKm(route.km);
      distanceSource = route.source;
    } else {
      distanceKm = QUOTE_FALLBACK_KM;
    }
    standardDeliveryFee = deliveryFeeFromRates(distanceKm, ctx.deliveryRates);
  }
  // Express mirrors the courier EXPRESS multiplier; the premium is the
  // rider's cash upside. Zero off DELIVERY (expressDeliveryFee(0) is 0).
  const expressFee = ctx.fulfillment === 'DELIVERY' ? expressDeliveryFee(standardDeliveryFee) : 0;
  const minOrderAmount = Number(ctx.vendor.minOrderAmount);
  return {
    vendorId: ctx.vendor.id,
    vendorName: ctx.vendor.name,
    fulfillment: ctx.fulfillment,
    distanceKm,
    distanceSource,
    subtotal,
    standardDeliveryFee,
    deliveryFee: ctx.express ? expressFee : standardDeliveryFee,
    expressSurcharge: expressFee - standardDeliveryFee,
    minOrderAmount,
    // Checkout refuses exactly when `subtotal < minimum`; this is its negation.
    meetsMinimum: !(subtotal < minOrderAmount),
    amountToMinimum: Math.max(0, minOrderAmount - subtotal),
  };
}

/** What priceBasket needs from each plan. */
export interface BasketPlan {
  vendorId: string;
  fulfillment: PlanFulfillment;
  subtotal: number;
  deliveryFee: number;
}

/** The promo terms plus the vendor a store's own code belongs to (null or
 *  absent = a platform code). */
export interface BasketPromo extends PromoTerms {
  vendorId?: string | null;
}

export interface PricedPlan {
  discount: number;
  tip: number;
  /** [ALG-24] The one total — orderTotal, never a second sum. */
  total: number;
  /** [M-32] The component split snapshotted on the order's redemption. */
  allocation: PromoAllocation | null;
}

export interface PricedBasket {
  discount: number;
  /** The tip actually charged: zero unless some plan is DELIVERY (a pickup or
   *  appointment-only basket has no rider to tip). */
  effectiveTip: number;
  /** Feeds checkout's ID gate and the customer's totalSpent. Equal to the sum
   *  of `perPlan[].total` (the discount never exceeds what the plans absorb). */
  grandTotal: number;
  /** Index-aligned with the input plans. */
  perPlan: PricedPlan[];
}

/**
 * Price the whole basket from its plans — the arithmetic checkout ran inline
 * before E01, unchanged:
 *   - the promo basis is the promo vendor's plan (a store's own code) or every
 *     plan (a platform code); a store code whose store is not in the basket
 *     discounts nothing (checkout refuses that cart outright);
 *   - [REPORT-034 S1 · M-32] the discount is clamped to what its funder may
 *     absorb — goods, plus the delivery fee only for a platform code, never
 *     the tip;
 *   - [REPORT-012 F-012-01] the tip rides the first DELIVERY plan, and a basket
 *     with no DELIVERY plan charges none;
 *   - the discount is spread plan by plan (goods first, then a platform code's
 *     fee), so no order's own zero floor swallows part of it;
 *   - every plan's total is `orderTotal`.
 */
export function priceBasket(input: {
  plans: readonly BasketPlan[];
  promo: BasketPromo | null;
  tip: number;
}): PricedBasket {
  const { plans, promo } = input;
  const promoPlanIndex = promo?.vendorId ? plans.findIndex((p) => p.vendorId === promo.vendorId) : -1;
  const promoApplies = promo != null && (promoPlanIndex >= 0 || !promo.vendorId);
  const targets = promoPlanIndex >= 0 ? [promoPlanIndex] : plans.map((_, i) => i);

  let discount = 0;
  if (promo && promoApplies) {
    const basis = targets.reduce(
      (b, i) => ({ subtotal: b.subtotal + plans[i]!.subtotal, deliveryFee: b.deliveryFee + plans[i]!.deliveryFee }),
      { subtotal: 0, deliveryFee: 0 },
    );
    // [ALG-24] The one promo switch, then the one capacity clamp.
    const capacity = targets.reduce(
      (sum, i) => sum + promoCapacity(promo.funder, { subtotal: plans[i]!.subtotal, deliveryFee: plans[i]!.deliveryFee }, promo.discountType),
      0,
    );
    discount = Math.min(promoDiscount(promo, basis), Math.max(0, capacity));
  }

  const tipPlanIndex = plans.findIndex((p) => p.fulfillment === 'DELIVERY');
  const effectiveTip = tipPlanIndex >= 0 ? input.tip : 0;
  const grandTotal = plans.reduce((s, p) => s + p.subtotal + p.deliveryFee, 0) + effectiveTip - discount;

  let remaining = discount;
  const perPlan = plans.map((plan, i): PricedPlan => {
    let allocation: PromoAllocation | null = null;
    if (promo && promoApplies && targets.includes(i) && remaining > 0) {
      allocation = allocatePromo(promo.funder, remaining, { subtotal: plan.subtotal, deliveryFee: plan.deliveryFee }, promo.discountType);
      remaining -= allocation.total;
    }
    const planDiscount = allocation?.total ?? 0;
    const planTip = i === tipPlanIndex ? effectiveTip : 0;
    return {
      discount: planDiscount,
      tip: planTip,
      total: orderTotal({ subtotal: plan.subtotal, deliveryFee: plan.deliveryFee, tip: planTip, discount: planDiscount }),
      allocation,
    };
  });

  return { discount, effectiveTip, grandTotal, perPlan };
}
