import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as markup from '../utils/markup';
import {
  DEFAULT_DELIVERY_RATES, EXPRESS_DELIVERY_SURCHARGE, calculateCourierFee, deliveryFeeFromRates, expressDeliveryFee,
  type DeliveryRates,
} from '../utils/markup';
import { DEFAULT_COURIER_RATES, estimateCourierFee } from '../modules/courier/courier.service';
import { planVendorGroup, priceBasket } from '../modules/order/cart-plans';

// ---------------------------------------------------------------------------
// [Owner ruling, 1 Nov 2026] EXPRESS delivery on a store or food order is the
// normal delivery fee PLUS A FLAT GYD 1,000, whatever the distance (it was one
// and a half times the fee: +250 at the 500 base, +608 at 10 km). All of the
// extra still goes to the rider. Parcels are untouched: courier express and
// rush keep their speed multipliers.
//
// One definition (markup.ts expressDeliveryFee) prices both the cart quote
// and the checkout charge through cart-plans planVendorGroup, so the number
// on the phone is the number charged. The DB-backed half of this proof (quote
// = charge = what the rider is paid) is express-flat-surcharge.test.ts.
// ---------------------------------------------------------------------------

const REPO = join(__dirname, '..', '..', '..', '..');
const GYD = (n: number) => n.toLocaleString('en-US');

describe('the express premium is a flat GYD 1,000 [owner 1 Nov 2026]', () => {
  it('is the owner’s amount, and the only express number markup.ts exports', () => {
    expect(EXPRESS_DELIVERY_SURCHARGE).toBe(1000);
    // The old multiplier is gone, so nothing can price express as a multiple again.
    expect(Object.keys(markup)).not.toContain('EXPRESS_DELIVERY_MULTIPLIER');
  });

  it.each([
    // [km, standard fee on the Georgetown schedule (500 for 3 km, then 100 a km, rounded up)]
    [0, 500], [1, 500], [3, 500], [3.46, 546], [5, 700], [10.15, 1215], [25, 2700], [60, 6200], [150, 15200],
  ])('%s km: express = standard + 1,000 (standard %s)', (km, standard) => {
    expect(deliveryFeeFromRates(km, DEFAULT_DELIVERY_RATES)).toBe(standard);
    expect(expressDeliveryFee(standard)).toBe(standard + 1000);
  });

  it('the premium does not scale with the fee: another market schedule still adds exactly 1,000', () => {
    const dear: DeliveryRates = { baseFee: 1000, perKmRate: 300, includedKm: 1, surgeMultiplier: 1 };
    const standard = deliveryFeeFromRates(5, dear); // 1000 + 4 × 300 = 2200
    expect(standard).toBe(2200);
    expect(expressDeliveryFee(standard)).toBe(3200);
    expect(expressDeliveryFee(standard) - standard).toBe(expressDeliveryFee(500) - 500);
  });
});

describe('the planner the quote and the checkout share', () => {
  const vendor = { id: 'v1', name: 'Flat Kitchen', latitude: 6.8015, longitude: -58.156, minOrderAmount: '0' };
  const line = (basePrice: number, quantity = 1) => ({
    quantity, selectedOptions: {}, item: { vendorId: 'v1', fulfillment: 'DELIVERY', basePrice: String(basePrice), optionGroups: [] },
  });
  const at = (km: number) => async () => ({ km, source: 'osrm' as const });
  const plan = (km: number, express: boolean, fulfillment: 'DELIVERY' | 'PICKUP' | 'APPOINTMENT' = 'DELIVERY') => planVendorGroup({
    vendor, lines: [line(1800)], fulfillment, destination: { lat: 6.81, lng: -58.17 }, deliveryRates: DEFAULT_DELIVERY_RATES, express, routeKm: at(km),
  });

  it.each([[1.2, 500], [3.46, 546], [10.15, 1215], [42, 4400]])('%s km: the express plan charges standard + 1,000 and says so', async (km, standard) => {
    const fast = await plan(km, true);
    expect(fast).toMatchObject({ standardDeliveryFee: standard, deliveryFee: standard + 1000, expressSurcharge: 1000 });
    // The standard quote carries the same surcharge, so the toggle's "+GYD 1,000" is the number checkout adds.
    const plain = await plan(km, false);
    expect(plain).toMatchObject({ standardDeliveryFee: standard, deliveryFee: standard, expressSurcharge: 1000 });
  });

  it('PICKUP and APPOINTMENT have no rider: no fee and no premium, even when express is asked', async () => {
    for (const fulfillment of ['PICKUP', 'APPOINTMENT'] as const) {
      expect(await plan(9, true, fulfillment)).toMatchObject({ standardDeliveryFee: 0, deliveryFee: 0, expressSurcharge: 0 });
    }
  });

  it('a two-store express basket is two deliveries: 1,000 on each, inside each order’s own total', async () => {
    const near = await plan(2, true);
    const far = await plan(12.5, true);
    const priced = priceBasket({ plans: [near, far], promo: null, tip: 0 });
    expect(priced.perPlan.map((p) => p.total)).toEqual([1800 + 500 + 1000, 1800 + 1450 + 1000]);
    expect(priced.grandTotal).toBe(3600 + 500 + 1450 + 2000);
  });
});

describe('parcels are unchanged: courier express and rush keep their multipliers', () => {
  it('the courier speed table and both courier pricers', () => {
    expect(DEFAULT_COURIER_RATES.speedMultiplier).toEqual({ STANDARD: 1, EXPRESS: 1.5, RUSH: 2 });
    // 800 + 5 km × 120 = 1400 before speed.
    expect(estimateCourierFee(5, 'SMALL', 'STANDARD').totalFee).toBe(1400);
    expect(estimateCourierFee(5, 'SMALL', 'EXPRESS').totalFee).toBe(2100);
    expect(estimateCourierFee(5, 'SMALL', 'RUSH').totalFee).toBe(2800);
    expect(calculateCourierFee(5, 'SMALL', 'express')).toBe(2100);
    expect(calculateCourierFee(5, 'SMALL', 'rush')).toBe(2800);
  });
});

// ---------------------------------------------------------------------------
// The words. The phone and the web show the server's number; the only place a
// figure is written out is the website's Delivery policy, and it must be this
// one. No client or server text may still describe store express as a
// multiple of the fee (courier code, which keeps its multipliers, is out of
// scope).
// ---------------------------------------------------------------------------

/** Every non-test .ts/.tsx file under `dir` (repo-relative). */
function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules' || name === '.next' || name === 'dist' || name === '__tests__' || name === '__snapshots__') continue;
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) out.push(relative(REPO, p));
    }
  };
  walk(join(REPO, dir));
  return out;
}

const MULTIPLE = String.raw`(?:1\.5|1½|one and a half|half again)`;
const EXPRESS_AS_A_MULTIPLE = new RegExp(String.raw`(?:express|priority)[\s\S]{0,140}?${MULTIPLE}|${MULTIPLE}[\s\S]{0,140}?(?:express|priority)`, 'i');
/** Courier code prices parcels, whose express and rush stay multipliers. */
const COURIER = /(^|\/)(courier|parcels?)(\/|\.)|country\/pricing-config\.ts$/;

describe('the words say a flat GYD 1,000', () => {
  it('the website Delivery policy states the flat amount, from the one constant', () => {
    const page = readFileSync(join(REPO, 'apps/web/src/app/legal/delivery/page.tsx'), 'utf8').replace(/\s+/g, ' ');
    expect(page).toContain(`express adds GYD ${GYD(EXPRESS_DELIVERY_SURCHARGE)} to the standard fee, whatever the distance.`);
    expect(page).toContain(`Express delivery, where offered, adds GYD ${GYD(EXPRESS_DELIVERY_SURCHARGE)} for each store in your order that is delivered to you.`);
    expect(page).not.toMatch(/1\.5 times|one and a half/i);
  });

  it('no phone, web, admin or ops-console text, and no server text, calls store express a multiple of the fee', () => {
    const files = [
      ...sources('apps/mobile/src'), ...sources('apps/web/src'), ...sources('apps/admin/src'), ...sources('apps/desktop/src'),
      ...sources('apps/api/src'), 'apps/api/prisma/schema.prisma',
    ].filter((f) => !COURIER.test(f));
    expect(files.length).toBeGreaterThan(500); // the walk found the trees
    const offenders = files.filter((f) => EXPRESS_AS_A_MULTIPLE.test(readFileSync(join(REPO, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the phone renders the server’s surcharge and computes none of its own', () => {
    const cart = readFileSync(join(REPO, 'apps/mobile/src/modules/cart/screens/CartScreen.tsx'), 'utf8');
    expect(cart).toContain('+{money(c.expressSurcharge)} — all of it goes to your rider.');
    // No arithmetic on the fee or the surcharge: the screen prints what the quote says.
    expect(cart).not.toMatch(/expressSurcharge\s*(?:=[^=]|[*+\-/])|deliveryFee\s*[*+]\s*\d/);
  });
});
