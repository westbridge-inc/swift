import { describe, it, expect } from 'vitest';
import {
  groupLinesByVendor, planFulfillment, planVendorGroup, priceBasket, priceCartLine, resolveTip,
  QUOTE_FALLBACK_KM, type BasketPlan, type BasketPromo, type PlanFulfillment,
} from '../modules/order/cart-plans';
import { allocatePromo, orderTotal, promoCapacity, promoDiscount, type PromoAllocation } from '../utils/order-total';
import { DEFAULT_DELIVERY_RATES, deliveryFeeFromRates, expressDeliveryFee } from '../utils/markup';

// ---------------------------------------------------------------------------
// [E01 · ALG-24] The shared cart plan-and-price, as pure functions.
//
// The quote and checkout now price a basket through cart-plans.ts. Two things
// must be true for that to be safe:
//   1. CHECKOUT CHARGES EXACTLY WHAT IT CHARGED BEFORE: priceBasket is the
//      arithmetic checkout ran inline on main (4ecd1264). The reference below
//      is that code, copied verbatim (validatePromoCode's discount + the
//      capacity clamp + the tip rule + the allocation loop + orderTotal), and
//      the two are compared on thousands of seeded random baskets.
//   2. SINGLE-VENDOR QUOTES ARE UNCHANGED: for one DELIVERY plan with a code
//      that applies to it, the basket pricer gives the old quote formula's
//      discount and total.
// The DB suite (cart-quote-parity.test.ts) then proves quote == charge end to
// end on mounted routes.
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) — the same cases on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Promo = { discountType: string; discountValue: unknown; maxDiscount?: unknown; funder?: string | null; vendorId?: string | null };

/** main 4ecd1264 OrderService.checkout + validatePromoCode, the pricing lines
 *  only, verbatim apart from the plan shape ({ vendor: { id } } → vendorId). */
function mainCheckoutArithmetic(plans: BasketPlan[], promo: Promo | null, tip: number) {
  const tipPlanIndex = plans.findIndex((p) => p.fulfillment === 'DELIVERY');
  const effectiveTip = tipPlanIndex >= 0 ? tip : 0;

  let discount = 0;
  let promoVendorId: string | null = null;
  let promoTerms: Promo | null = null;
  if (promo) {
    // validatePromoCode: the discount basis is the promo vendor's plan (it
    // refuses PROMO_WRONG_VENDOR when that plan is missing) or the basket.
    let subtotal: number;
    let deliveryFeeBasis: number;
    if (promo.vendorId) {
      const plan = plans.find((p) => p.vendorId === promo.vendorId)!;
      subtotal = plan.subtotal;
      deliveryFeeBasis = plan.deliveryFee;
    } else {
      subtotal = plans.reduce((s, p) => s + p.subtotal, 0);
      deliveryFeeBasis = plans.reduce((s, p) => s + p.deliveryFee, 0);
    }
    discount = promoDiscount(promo, { subtotal, deliveryFee: deliveryFeeBasis });
    promoVendorId = promo.vendorId ?? null;
    promoTerms = promo;
  }
  const promoFunder = promoTerms?.funder ?? null;
  const promoPlanIdxForCap = promoVendorId ? plans.findIndex((p) => p.vendorId === promoVendorId) : -1;
  const discountCapacity = (promoPlanIdxForCap >= 0 ? [promoPlanIdxForCap] : plans.map((_, i) => i)).reduce(
    (sum, i) => sum + promoCapacity(promoFunder, { subtotal: plans[i]!.subtotal, deliveryFee: plans[i]!.deliveryFee }, promoTerms?.discountType ?? null),
    0,
  );
  discount = Math.min(discount, Math.max(0, discountCapacity));
  const grandTotal = plans.reduce((s, p) => s + p.subtotal + p.deliveryFee, 0) + effectiveTip - discount;

  const promoPlanIndex = promoVendorId ? plans.findIndex((p) => p.vendorId === promoVendorId) : -1;
  const planTipFor = (i: number) => (i === tipPlanIndex ? effectiveTip : 0);
  const discountAlloc = new Array<number>(plans.length).fill(0);
  const discountParts = new Array<PromoAllocation | null>(plans.length).fill(null);
  let remainingDiscount = discount;
  const discountTargets = promoPlanIndex >= 0 ? [promoPlanIndex] : plans.map((_, i) => i);
  for (const i of discountTargets) {
    if (remainingDiscount <= 0) break;
    const parts = allocatePromo(promoFunder, remainingDiscount, { subtotal: plans[i]!.subtotal, deliveryFee: plans[i]!.deliveryFee }, promoTerms?.discountType ?? null);
    discountAlloc[i] = parts.total;
    discountParts[i] = parts;
    remainingDiscount -= parts.total;
  }
  const perPlan = plans.map((plan, index) => {
    const planTip = planTipFor(index);
    const planDiscount = discountAlloc[index]!;
    return {
      discount: planDiscount,
      tip: planTip,
      total: orderTotal({ subtotal: plan.subtotal, deliveryFee: plan.deliveryFee, tip: planTip, discount: planDiscount }),
      allocation: discountParts[index]!,
    };
  });
  return { discount, effectiveTip, grandTotal, perPlan };
}

const MODES: PlanFulfillment[] = ['DELIVERY', 'PICKUP', 'APPOINTMENT'];
const TYPES = ['PERCENTAGE', 'FIXED_AMOUNT', 'FREE_DELIVERY', 'SOMETHING_NEW'];
const FUNDERS = ['PLATFORM', 'VENDOR', null];

function randomBasket(r: () => number) {
  const int = (n: number) => Math.floor(r() * n);
  const plans: BasketPlan[] = Array.from({ length: 1 + int(4) }, (_, i) => {
    const fulfillment = MODES[int(3)]!;
    const standard = fulfillment === 'DELIVERY' ? deliveryFeeFromRates(int(1200) / 100, DEFAULT_DELIVERY_RATES) : 0;
    return {
      vendorId: `v${i}`,
      fulfillment,
      subtotal: int(4) === 0 ? 0 : 50 * int(300),
      deliveryFee: fulfillment === 'DELIVERY' && int(2) === 0 ? expressDeliveryFee(standard) : standard,
    };
  });
  let promo: Promo | null = null;
  if (int(5) > 0) {
    const discountType = TYPES[int(TYPES.length)]!;
    promo = {
      discountType,
      discountValue: discountType === 'PERCENTAGE' ? String(1 + int(100)) : 50 * int(400),
      maxDiscount: [null, undefined, 0, 50 * int(200)][int(4)],
      funder: FUNDERS[int(3)],
      vendorId: int(2) === 0 ? null : plans[int(plans.length)]!.vendorId,
    };
  }
  const tip = [0, 0, 100, 200, 500, 1000, int(50_000)][int(7)]!;
  return { plans, promo, tip };
}

describe('priceBasket is main’s checkout arithmetic, unchanged', () => {
  it('agrees with the verbatim main reference on 20,000 seeded random baskets (discount, tip, allocation, every plan total, grandTotal)', () => {
    const r = rng(0xe01);
    let withPromo = 0;
    let spilled = 0;
    for (let n = 0; n < 20_000; n++) {
      const { plans, promo, tip } = randomBasket(r);
      const expected = mainCheckoutArithmetic(plans, promo, tip);
      const actual = priceBasket({ plans, promo: promo as BasketPromo | null, tip });
      expect(actual, `case ${n}: ${JSON.stringify({ plans, promo, tip })}`).toEqual(expected);
      if (promo && expected.discount > 0) withPromo += 1;
      if (expected.perPlan.filter((p) => p.discount > 0).length > 1) spilled += 1;
    }
    // The generator really exercised the promo paths, including a platform
    // code spilling across more than one order.
    expect(withPromo).toBeGreaterThan(5_000);
    expect(spilled).toBeGreaterThan(500);
  });

  it('what the orders carry is what grandTotal says: the per-plan totals sum to it, and the discount is fully placed', () => {
    const r = rng(0x5eed);
    for (let n = 0; n < 20_000; n++) {
      const { plans, promo, tip } = randomBasket(r);
      const priced = priceBasket({ plans, promo: promo as BasketPromo | null, tip });
      const totals = priced.perPlan.reduce((s, p) => s + p.total, 0);
      expect(totals, `case ${n}`).toBe(priced.grandTotal);
      expect(priced.perPlan.reduce((s, p) => s + p.discount, 0)).toBe(priced.discount);
      expect(priced.perPlan.reduce((s, p) => s + p.tip, 0)).toBe(priced.effectiveTip);
      for (const p of priced.perPlan) expect(p.total).toBeGreaterThanOrEqual(p.tip);
    }
  });

  it('the tip rides the FIRST delivery plan; a basket with none charges no tip at all', () => {
    const plans: BasketPlan[] = [
      { vendorId: 'a', fulfillment: 'PICKUP', subtotal: 1000, deliveryFee: 0 },
      { vendorId: 'b', fulfillment: 'DELIVERY', subtotal: 2000, deliveryFee: 600 },
      { vendorId: 'c', fulfillment: 'DELIVERY', subtotal: 3000, deliveryFee: 700 },
    ];
    const priced = priceBasket({ plans, promo: null, tip: 400 });
    expect(priced.perPlan.map((p) => p.tip)).toEqual([0, 400, 0]);
    expect(priced.grandTotal).toBe(1000 + 2600 + 3700 + 400);
    const pickupOnly = priceBasket({ plans: plans.map((p) => ({ ...p, fulfillment: 'PICKUP' as const, deliveryFee: 0 })), promo: null, tip: 400 });
    expect(pickupOnly.effectiveTip).toBe(0);
    expect(pickupOnly.grandTotal).toBe(6000);
  });

  it('a store code whose store is not in the basket discounts nothing (checkout refuses that cart; the quote shows no phantom discount)', () => {
    const plans: BasketPlan[] = [{ vendorId: 'a', fulfillment: 'PICKUP', subtotal: 1000, deliveryFee: 0 }];
    const priced = priceBasket({ plans, promo: { discountType: 'FIXED_AMOUNT', discountValue: 300, funder: 'VENDOR', vendorId: 'elsewhere' }, tip: 0 });
    expect(priced.discount).toBe(0);
    expect(priced.perPlan[0]).toEqual({ discount: 0, tip: 0, total: 1000, allocation: null });
  });
});

describe('a single-vendor quote is priced exactly as before', () => {
  /** main 4ecd1264 buildCartResponse, the discount + total lines. */
  function mainQuoteArithmetic(subtotal: number, deliveryFee: number, promo: Promo | null, tip: number) {
    let discount = 0;
    if (promo) {
      discount = promoDiscount(promo, { subtotal, deliveryFee });
      discount = Math.min(discount, promoCapacity(promo.funder, { subtotal, deliveryFee }, promo.discountType));
    }
    return { discount, total: orderTotal({ subtotal, deliveryFee, tip, discount }) };
  }

  it('one DELIVERY plan and a code that applies to it: the same discount and total as the old quote, 20,000 seeded cases', () => {
    const r = rng(0x1ce);
    for (let n = 0; n < 20_000; n++) {
      const { plans, promo, tip } = randomBasket(r);
      const plan = { ...plans[0]!, fulfillment: 'DELIVERY' as const };
      const applicable = promo ? { ...promo, vendorId: [null, plan.vendorId][n % 2] } : null;
      const old = mainQuoteArithmetic(plan.subtotal, plan.deliveryFee, applicable, tip);
      const priced = priceBasket({ plans: [plan], promo: applicable as BasketPromo | null, tip });
      expect({ discount: priced.discount, total: priced.perPlan[0]!.total }, `case ${n}`).toEqual(old);
    }
  });
});

describe('the per-vendor planner', () => {
  const vendor = { id: 'v1', name: 'Near', latitude: 6.8015, longitude: -58.156, minOrderAmount: '1000' };
  const line = (basePrice: number, quantity: number, extra: Partial<{ selectedOptions: unknown; optionGroups: unknown }> = {}) => ({
    quantity,
    selectedOptions: extra.selectedOptions ?? {},
    item: {
      vendorId: 'v1', fulfillment: 'DELIVERY', basePrice: String(basePrice),
      optionGroups: (extra.optionGroups ?? []) as Array<{ name: string; options: Array<{ id: string; name: string; additionalPrice: unknown }> }>,
    },
  });
  const routeKm = async () => ({ km: 3.456789, source: 'haversine' as const });

  it('DELIVERY: canonical km (2 dp) prices the fee; express is the one helper’s 1.5× premium', async () => {
    const plain = await planVendorGroup({ vendor, lines: [line(1200, 1)], fulfillment: 'DELIVERY', destination: { lat: 6.81, lng: -58.17 }, deliveryRates: DEFAULT_DELIVERY_RATES, express: false, routeKm });
    expect(plain.distanceKm).toBe(3.46);
    expect(plain.distanceSource).toBe('haversine');
    expect(plain.standardDeliveryFee).toBe(deliveryFeeFromRates(3.46, DEFAULT_DELIVERY_RATES));
    expect(plain.deliveryFee).toBe(plain.standardDeliveryFee);
    expect(plain.expressSurcharge).toBe(expressDeliveryFee(plain.standardDeliveryFee) - plain.standardDeliveryFee);
    const fast = await planVendorGroup({ vendor, lines: [line(1200, 1)], fulfillment: 'DELIVERY', destination: { lat: 6.81, lng: -58.17 }, deliveryRates: DEFAULT_DELIVERY_RATES, express: true, routeKm });
    expect(fast.deliveryFee).toBe(expressDeliveryFee(plain.standardDeliveryFee));
    expect(fast.standardDeliveryFee + fast.expressSurcharge).toBe(fast.deliveryFee);
  });

  it('PICKUP and APPOINTMENT carry no fee, no route and no express premium — even when express is asked', async () => {
    let routed = 0;
    const counting = async () => { routed += 1; return { km: 9, source: 'haversine' as const }; };
    for (const fulfillment of ['PICKUP', 'APPOINTMENT'] as const) {
      const plan = await planVendorGroup({ vendor, lines: [line(1200, 2)], fulfillment, destination: { lat: 6.81, lng: -58.17 }, deliveryRates: DEFAULT_DELIVERY_RATES, express: true, routeKm: counting });
      expect(plan).toMatchObject({ fulfillment, distanceKm: 0, distanceSource: null, standardDeliveryFee: 0, deliveryFee: 0, expressSurcharge: 0, subtotal: 2400 });
    }
    expect(routed).toBe(0);
  });

  it('a quote with no destination at all prices the historical 3 km preview', async () => {
    const plan = await planVendorGroup({ vendor, lines: [line(1200, 1)], fulfillment: 'DELIVERY', destination: null, deliveryRates: DEFAULT_DELIVERY_RATES, express: false, routeKm });
    expect(plan.distanceKm).toBe(QUOTE_FALLBACK_KM);
    expect(plan.deliveryFee).toBe(deliveryFeeFromRates(3, DEFAULT_DELIVERY_RATES));
  });

  it('[E09] the minimum is THIS vendor’s subtotal against ITS minimum — exactly-at meets; short says how much more', async () => {
    const at = await planVendorGroup({ vendor, lines: [line(500, 2)], fulfillment: 'PICKUP', destination: null, deliveryRates: DEFAULT_DELIVERY_RATES, express: false, routeKm });
    expect(at).toMatchObject({ subtotal: 1000, minOrderAmount: 1000, meetsMinimum: true, amountToMinimum: 0 });
    const short = await planVendorGroup({ vendor, lines: [line(350, 2)], fulfillment: 'PICKUP', destination: null, deliveryRates: DEFAULT_DELIVERY_RATES, express: false, routeKm });
    expect(short).toMatchObject({ subtotal: 700, meetsMinimum: false, amountToMinimum: 300 });
  });

  it('a line is (base + its own selected options) × quantity; a foreign option id prices nothing', () => {
    const groups = [{ name: 'Size', options: [{ id: 'large', name: 'Large', additionalPrice: '300' }, { id: 'small', name: 'Small', additionalPrice: 0 }] }];
    expect(priceCartLine(line(1200, 3, { selectedOptions: { g: 'large' }, optionGroups: groups }))).toMatchObject({ basePrice: 1200, unitPrice: 1500, lineTotal: 4500 });
    expect(priceCartLine(line(1200, 3, { selectedOptions: { g: ['large', 'not-this-items'] }, optionGroups: groups })).lineTotal).toBe(4500);
    expect(priceCartLine(line(1200, 3, { selectedOptions: null })).lineTotal).toBe(3600);
  });
});

describe('the shared rules both callers route through', () => {
  it('one plan order: vendors by their first line added (created, then id), lines kept in that order', () => {
    const t = (s: number) => new Date(Date.UTC(2026, 8, 23, 12, 0, s));
    const lines = [
      { id: 'c3', createdAt: t(3), item: { vendorId: 'B' } },
      { id: 'c1', createdAt: t(1), item: { vendorId: 'A' } },
      { id: 'c2b', createdAt: t(2), item: { vendorId: 'B' } },
      { id: 'c2a', createdAt: t(2), item: { vendorId: 'C' } },
      { id: 'c4', createdAt: t(4), item: { vendorId: 'A' } },
    ];
    const groups = groupLinesByVendor(lines);
    expect(groups.map((g) => g.vendorId)).toEqual(['A', 'C', 'B']);
    expect(groups.map((g) => g.lines.map((l) => l.id))).toEqual([['c1', 'c4'], ['c2a'], ['c2b', 'c3']]);
    // Whatever order the database hands the lines back in.
    expect(groupLinesByVendor([...lines].reverse())).toEqual(groups);
  });

  it('a booking line makes the group an APPOINTMENT whatever was chosen; otherwise the choice, DELIVERY by default', () => {
    const goods = [{ item: { fulfillment: 'DELIVERY' } }];
    expect(planFulfillment(goods, undefined)).toBe('DELIVERY');
    expect(planFulfillment(goods, 'PICKUP')).toBe('PICKUP');
    expect(planFulfillment([{ item: { fulfillment: 'APPOINTMENT' } }], 'PICKUP')).toBe('APPOINTMENT');
    expect(planFulfillment([...goods, { item: { fulfillment: 'APPOINTMENT' } }], 'DELIVERY')).toBe('APPOINTMENT');
  });

  it('[REPORT-012 F-012-01] presence, not truthiness: an explicit 0 tip is no tip; only an absent one inherits the cart’s', () => {
    expect(resolveTip(0, '500.00')).toBe(0);
    expect(resolveTip(undefined, '500.00')).toBe(500);
    expect(resolveTip(null, null)).toBe(0);
    expect(resolveTip(300, 500)).toBe(300);
  });
});
