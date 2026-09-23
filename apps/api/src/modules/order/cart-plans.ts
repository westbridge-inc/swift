/**
 * [E01 · ALG-24] The multi-vendor cart plan-and-price — ONE computation.
 *
 * The cart quote used to price the whole basket as if it were one vendor's
 * order (one distance from `cart.vendor`, one fee, one minimum), while
 * checkout split the basket into one plan per vendor and priced each one
 * separately. The screen and the charge then disagreed by whole fees —
 * silently. The line-level helpers (lineTotal, promoDiscount, orderTotal…)
 * had already been unified in utils/order-total.ts, but the PER-VENDOR
 * structure was not.
 *
 * `planVendorGroup` prices one vendor's lines — grouping is implicit in the
 * caller's items — and `priceBasket` prices the basket: the promo basis and
 * capacity, the tip rule, the per-plan discount allocation and every plan's
 * total. The cart quote (customer.routes) and checkout (order.service) both
 * consume exactly these two functions, so a quote and a charge can no longer
 * drift.
 *
 * Laws:
 *   - `planVendorGroup` throws NO eligibility errors. Open/closed, stock,
 *     capacity, category, subscription and out-of-range refusals stay in
 *     checkout; the planner only prices.
 *   - the delivery fee for a plan is `deliveryFeeFromRates(canonical
 *     distance)` — express multiplies through the same helper checkout used;
 *   - PICKUP and APPOINTMENT plans carry no fee and no route;
 *   - a plan's minimum verdict compares THAT vendor's own subtotal with ITS
 *     own minimum — never the combined basket against one vendor.
 */

import { deliveryFeeFromRates, expressDeliveryFee, type DeliveryRates } from '../../utils/markup';
import type { LatLng, RouteSource } from '../../providers/maps/maps-provider';
import { canonicalBillableKm } from '../../utils/billable-distance';
import { resolveSelectedOptions, optionsUnitPrice } from './options';
import {
  lineTotal, orderTotal, promoCapacity, promoDiscount, allocatePromo,
  type PromoAllocation, type PromoTerms,
} from '../../utils/order-total';

/** The vendor fields a cart plan prices from — a subset every call site has. */
export interface CartPlanVendor {
  id: string;
  name: string;
  vendorType: string;
  latitude: number;
  longitude: number;
  deliveryRadius: number;
  estimatedPrepTime: number | null;
  minOrderAmount: number;
}

export type CartPlanFulfillment = 'DELIVERY' | 'PICKUP' | 'APPOINTMENT';

export interface CartPlan {
  vendor: CartPlanVendor;
  fulfillment: CartPlanFulfillment;
  /** [ALG-18] The canonical billable km this plan is priced from. Zero for
   *  PICKUP and at-the-business APPOINTMENT plans. */
  distanceKm: number;
  /** [ALG-18] Which engine produced `distanceKm`; frozen on the order. */
  distanceSource: RouteSource | null;
  /** The delivery fee WITHOUT express (zero for PICKUP / APPOINTMENT). */
  standardDeliveryFee: number;
  /** The delivery fee for the requested mode — the express premium applied
   *  when asked. */
  deliveryFee: number;
  /** The express premium (zero when the fee is already free). */
  expressSurcharge: number;
  /** THIS vendor's lines only — the number its own minimum judges. */
  subtotal: number;
  minOrderAmount: number;
  meetsMinimum: boolean;
}

export interface CartPlanItem {
  itemId: string;
  name: string;
  basePrice: number;
  quantity: number;
  selectedOptions: unknown;
  fulfillment: string;
  vendorId: string;
  optionGroups?: Array<{
    name: string;
    options: Array<{ id: string; name: string; additionalPrice: unknown }>;
  }> | null;
}

/**
 * Pure pricing for one vendor group. The distance is canonicalized before
 * pricing (same number checkout freezes), the fee comes from the shared
 * schedule, and the subtotal is the same line pricing checkout snapshots.
 */
export async function planVendorGroup(ctx: {
  items: CartPlanItem[];
  vendor: CartPlanVendor;
  /** The customer's requested mode for this vendor's GOODS lines. Ignored
   *  when every line is an APPOINTMENT — bookings carry no delivery fee. */
  fulfillment: 'DELIVERY' | 'PICKUP';
  /** The delivery destination, including the caller's coordinate fallback. */
  address: LatLng | null;
  deliveryRates: DeliveryRates;
  /** Priority delivery: the fee carries the 1.5x rider premium. */
  express: boolean;
  routeKm: (from: LatLng, to: LatLng) => Promise<{ km: number; source: RouteSource | null }>;
}): Promise<CartPlan> {
  const allAppointments = ctx.items.length > 0 && ctx.items.every((i) => i.fulfillment === 'APPOINTMENT');
  const fulfillment: CartPlanFulfillment = allAppointments ? 'APPOINTMENT' : ctx.fulfillment;

  // [ALG-24] The same line pricing checkout snapshots: unit price (base +
  // options) × quantity, so a plan's subtotal is the charge's subtotal.
  const subtotal = ctx.items.reduce((sum, ci) => {
    const options = resolveSelectedOptions(ci, ci.selectedOptions);
    return sum + lineTotal(Number(ci.basePrice) + optionsUnitPrice(options), ci.quantity);
  }, 0);

  const minOrderAmount = Number(ctx.vendor.minOrderAmount);

  let distanceKm = 0;
  let distanceSource: RouteSource | null = null;
  let standardDeliveryFee = 0;
  if (fulfillment === 'DELIVERY') {
    if (ctx.address && Number.isFinite(ctx.address.lat) && Number.isFinite(ctx.address.lng)) {
      const route = await ctx.routeKm(
        { lat: ctx.vendor.latitude, lng: ctx.vendor.longitude },
        { lat: ctx.address.lat, lng: ctx.address.lng },
      );
      distanceKm = canonicalBillableKm(route.km);
      distanceSource = route.source;
    } else {
      // The quote's no-address fallback, unchanged from the pre-planner
      // preview: a 3 km estimate. Checkout never reaches here — it refuses
      // DELIVERY without an address before planning.
      distanceKm = 3;
    }
    standardDeliveryFee = deliveryFeeFromRates(distanceKm, ctx.deliveryRates);
  }
  const deliveryFee = fulfillment === 'DELIVERY' && ctx.express
    ? expressDeliveryFee(standardDeliveryFee)
    : standardDeliveryFee;
  const expressSurcharge = fulfillment === 'DELIVERY' && standardDeliveryFee > 0
    ? expressDeliveryFee(standardDeliveryFee) - standardDeliveryFee
    : 0;

  return {
    vendor: ctx.vendor,
    fulfillment,
    distanceKm,
    distanceSource,
    standardDeliveryFee,
    deliveryFee,
    expressSurcharge,
    subtotal,
    minOrderAmount,
    meetsMinimum: subtotal >= minOrderAmount,
  };
}

/** What priceBasket needs to know about one plan. */
export interface BasketPlanInput {
  vendorId: string;
  fulfillment: CartPlanFulfillment;
  subtotal: number;
  deliveryFee: number;
}

/** The promo terms plus which vendor's plan the code targets (null =
 *  platform-wide). */
export interface BasketPromo extends PromoTerms {
  vendorId?: string | null;
}

export interface PricedPlan {
  /** [ALG-24] The one total — orderTotal, never a second sum. */
  total: number;
  discount: number;
  tip: number;
  /** [M-32] The component split snapshotted on the order's redemption. */
  allocation: PromoAllocation | null;
}

export interface PricedBasket {
  discount: number;
  /** The tip actually charged — zero unless some plan is DELIVERY (a pickup
   *  or appointment-only basket has no rider to tip). */
  effectiveTip: number;
  grandTotal: number;
  perPlan: PricedPlan[];
}

/**
 * Price the whole basket from resolved plans. Mirrors checkout's former
 * inline arithmetic: the promo basis is the promo vendor's plan (vendor code)
 * or every plan (platform code); the discount is capacity-clamped; it is
 * allocated plan by plan (goods first, then a platform code's fee, never the
 * tip); the tip rides the first DELIVERY plan; every plan's total is
 * `orderTotal`. A vendor code whose vendor is not in the basket discounts
 * nothing — checkout refuses that cart outright.
 */
export function priceBasket(input: {
  plans: BasketPlanInput[];
  promo: BasketPromo | null;
  tip: number;
}): PricedBasket {
  const promo = input.promo;
  const promoPlanIndex = promo?.vendorId
    ? input.plans.findIndex((p) => p.vendorId === promo.vendorId)
    : -1;

  let discount = 0;
  if (promo && (promoPlanIndex >= 0 || !promo.vendorId)) {
    const targets = promoPlanIndex >= 0 ? [input.plans[promoPlanIndex]!] : input.plans;
    const basis = targets.reduce(
      (b, p) => ({ subtotal: b.subtotal + p.subtotal, deliveryFee: b.deliveryFee + p.deliveryFee }),
      { subtotal: 0, deliveryFee: 0 },
    );
    // [ALG-24] The one promo switch, then the one capacity clamp — a discount
    // can never exceed what the basket it targets is able to absorb.
    discount = promoDiscount(promo, basis);
    const capacity = targets.reduce(
      (sum, p) => sum + promoCapacity(promo.funder, { subtotal: p.subtotal, deliveryFee: p.deliveryFee }, promo.discountType),
      0,
    );
    discount = Math.min(discount, Math.max(0, capacity));
  }

  const tipPlanIndex = input.plans.findIndex((p) => p.fulfillment === 'DELIVERY');
  const effectiveTip = tipPlanIndex >= 0 ? input.tip : 0;
  const grandTotal = input.plans.reduce((s, p) => s + p.subtotal + p.deliveryFee, 0)
    + effectiveTip - discount;

  // [M-32] Spread the discount across the plans so it is never swallowed by a
  // per-order clamp: a vendor code hits only its plan; a platform code fills
  // each plan up to its own total until the discount is exhausted.
  const discountTargets = promoPlanIndex >= 0 ? [promoPlanIndex] : input.plans.map((_, i) => i);
  let remaining = discount;
  const perPlan: PricedPlan[] = input.plans.map((plan, i) => {
    let allocation: PromoAllocation | null = null;
    if (discountTargets.includes(i) && remaining > 0) {
      allocation = allocatePromo(
        promo?.funder,
        remaining,
        { subtotal: plan.subtotal, deliveryFee: plan.deliveryFee },
        promo?.discountType,
      );
      remaining -= allocation.total;
    }
    const planDiscount = allocation?.total ?? 0;
    const planTip = i === tipPlanIndex ? effectiveTip : 0;
    return {
      total: orderTotal({ subtotal: plan.subtotal, deliveryFee: plan.deliveryFee, tip: planTip, discount: planDiscount }),
      discount: planDiscount,
      tip: planTip,
      allocation,
    };
  });

  return { discount, effectiveTip, grandTotal, perPlan };
}
