import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  estimateLoad,
  requiredPackageSizeForOrder,
  totalBulkUnits,
  bandForBulk,
  mergeLoadBands,
  DEFAULT_LOAD_BANDS,
  DEFAULT_BULK_UNITS,
} from '../utils/load';
import { vehicleCanCarry } from '../modules/dispatch/dispatch.service';

// ---------------------------------------------------------------------------
// [G1] The capacity gate food and grocery never had.
//
// Vehicle capability is filtered on `courierPackageSize`, written in exactly
// ONE place (courier.routes.ts:173). Food and grocery orders never set it, and
// at dispatch.service.ts:550 a null packageSize makes the vehicle clause
// `Prisma.empty` — the filter is not RELAXED, it is NOT EMITTED. So the two
// highest-volume verticals have no capacity gate at dispatch, and the
// accept-time check in rider.routes.ts is `orderType === 'COURIER'`-gated too,
// so they have none there either. A 40-item supermarket run can be offered to
// and accepted by a bicycle.
//
// Worth being precise about the mechanism: someone "fixing" this by making the
// helper return [] for null would not fix it, because the clause is never
// emitted to be evaluated.
//
// This ships in SHADOW. These tests prove the derivation is right and that it
// cannot break dispatch; the rollout decision belongs to the logged evidence.
// ---------------------------------------------------------------------------

const line = (quantity: number, bulkUnits: number | null = null) => ({ quantity, bulkUnits });

describe('the badge is untouched — it is a shipped contract', () => {
  it('estimateLoad still bands exactly as it did', () => {
    // Three call sites put this on the offer card as `estLoad`. It gates
    // nothing and is not being made to; changing it would silently move a
    // number movers already read.
    expect(estimateLoad(1)).toBe('small');
    expect(estimateLoad(3)).toBe('small');
    expect(estimateLoad(4)).toBe('medium');
    expect(estimateLoad(10)).toBe('medium');
    expect(estimateLoad(11)).toBe('large');
  });
});

describe('what a vehicle must be able to carry', () => {
  it('TAXI needs nothing — there are no goods', () => {
    expect(requiredPackageSizeForOrder({ orderType: 'TAXI', courierPackageSize: null, items: [] })).toBeNull();
  });

  it('COURIER returns the customer’s DECLARATION, never an estimate over it', () => {
    // The customer declared a size and paid against it. An estimate that
    // overruled it would let a cheaper declaration buy a bigger vehicle, or
    // silently re-band a parcel the customer already described.
    for (const declared of ['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE']) {
      const r = requiredPackageSizeForOrder({
        orderType: 'COURIER',
        courierPackageSize: declared,
        // 200 units of bulk: an estimate would scream EXTRA_LARGE here.
        items: [line(100, 2)],
      });
      expect(r, `a declared ${declared} must survive a large basket`).toBe(declared);
    }
  });

  it('food and grocery are banded from the basket — the whole point', () => {
    const grocery = (units: number) =>
      requiredPackageSizeForOrder({ orderType: 'GROCERY_DELIVERY', courierPackageSize: null, items: [line(units)] });
    expect(grocery(4)).toBe('SMALL');
    expect(grocery(5)).toBe('MEDIUM');
    expect(grocery(12)).toBe('MEDIUM');
    expect(grocery(13)).toBe('LARGE');
    expect(grocery(30)).toBe('LARGE');
    expect(grocery(31)).toBe('EXTRA_LARGE');
    expect(requiredPackageSizeForOrder({ orderType: 'FOOD_DELIVERY', courierPackageSize: null, items: [line(2)] })).toBe('SMALL');
  });

  it('THE CASE THE DEFECT IS ABOUT: a 40-item supermarket run excludes a bicycle', () => {
    // This is the failure in one assertion. Today the filter is not emitted at
    // all, so a bicycle is a valid candidate for this order.
    const required = requiredPackageSizeForOrder({
      orderType: 'GROCERY_DELIVERY',
      courierPackageSize: null,
      items: Array.from({ length: 40 }, () => line(1)),
    });
    expect(required).toBe('EXTRA_LARGE');
    expect(vehicleCanCarry('BICYCLE', required!)).toBe(false);
    expect(vehicleCanCarry('MOTORCYCLE', required!)).toBe(false);
    expect(vehicleCanCarry('CAR', required!)).toBe(true);
  });

  it('a small food order still reaches a bicycle — the gate must not empty the pool', () => {
    // The failure mode to design against is not "too loose", it is "too tight":
    // an order no rider can take fails silently and nobody is paged.
    const required = requiredPackageSizeForOrder({
      orderType: 'FOOD_DELIVERY', courierPackageSize: null, items: [line(1), line(2)],
    });
    expect(required).toBe('SMALL');
    expect(vehicleCanCarry('BICYCLE', required!)).toBe(true);
  });

  it('an absence is null, never an invented SMALL', () => {
    // No lines to measure is not "a small order" — banding it SMALL would
    // manufacture a constraint out of missing data.
    expect(requiredPackageSizeForOrder({ orderType: 'FOOD_DELIVERY', courierPackageSize: null, items: [] })).toBeNull();
    expect(requiredPackageSizeForOrder({ orderType: 'GROCERY_DELIVERY', courierPackageSize: null, items: [line(0)] })).toBeNull();
  });

  it('an unknown order type gets NO gate rather than a guessed one', () => {
    // A new OrderType must not silently acquire a capacity rule nobody designed.
    expect(requiredPackageSizeForOrder({ orderType: 'SOMETHING_NEW', courierPackageSize: null, items: [line(50)] })).toBeNull();
  });
});

describe('bulk, not unit count [G2]', () => {
  it('a single 20 kg rice bag outweighs ten sachets', () => {
    // The whole of G2 in two lines. Unit count says these are 1 vs 10.
    const rice = totalBulkUnits([line(1, 8)]);
    const sachets = totalBulkUnits([line(10, 1)]);
    expect(rice).toBe(8);
    expect(sachets).toBe(10);
    // And banded, the rice bag is no longer "small".
    expect(bandForBulk(rice)).toBe('MEDIUM');
    expect(estimateLoad(1)).toBe('small'); // what the old badge still says
  });

  it('an item with no bulk set behaves EXACTLY as it does today', () => {
    // Every row predating the column is null. If that changed anything, the
    // migration would be a behaviour change wearing an additive costume.
    expect(totalBulkUnits([line(5, null)])).toBe(5 * DEFAULT_BULK_UNITS);
    expect(totalBulkUnits([line(5)])).toBe(5);
  });

  it('nonsense bulk falls back rather than poisoning the total', () => {
    // A hand-edited row or a bad import must not band an order to EXTRA_LARGE
    // and strand it, nor to SMALL and hand it to a bicycle.
    expect(totalBulkUnits([{ quantity: 2, bulkUnits: -5 }])).toBe(2);
    expect(totalBulkUnits([{ quantity: 2, bulkUnits: 0 }])).toBe(2);
    expect(totalBulkUnits([{ quantity: -3, bulkUnits: 2 }])).toBe(0);
    expect(totalBulkUnits([{ quantity: Number.NaN, bulkUnits: 2 }])).toBe(0);
  });

  it('reads bulk from a joined item OR a flattened line', () => {
    expect(totalBulkUnits([{ quantity: 2, item: { bulkUnits: 4 } }])).toBe(8);
    expect(totalBulkUnits([{ quantity: 2, bulkUnits: 4 }])).toBe(8);
  });
});

describe('the bands are config, and a bad config cannot make a wrong gate', () => {
  it('a missing config falls back to defaults rather than throwing', () => {
    // Dispatch must never crash because a CountryConfig row is absent.
    expect(mergeLoadBands(null)).toEqual(DEFAULT_LOAD_BANDS);
    expect(mergeLoadBands(undefined)).toEqual(DEFAULT_LOAD_BANDS);
    expect(mergeLoadBands('nonsense')).toEqual(DEFAULT_LOAD_BANDS);
    expect(mergeLoadBands({})).toEqual(DEFAULT_LOAD_BANDS);
  });

  it('a partial config overrides only what it validly sets', () => {
    expect(mergeLoadBands({ small: 2 })).toEqual({ ...DEFAULT_LOAD_BANDS, small: 2 });
  });

  it('a NON-ASCENDING config is rejected whole, not applied by halves', () => {
    // `{small: 20, medium: 5}` describes no coherent banding. Honouring half of
    // it would produce a gate that is silently wrong rather than obviously
    // absent — the worse of the two failures.
    expect(mergeLoadBands({ small: 20, medium: 5, large: 30 })).toEqual(DEFAULT_LOAD_BANDS);
    expect(mergeLoadBands({ small: 4, medium: 12, large: 6 })).toEqual(DEFAULT_LOAD_BANDS);
  });

  it('custom bands actually change the verdict', () => {
    const tight = mergeLoadBands({ small: 1, medium: 2, large: 3 });
    expect(bandForBulk(4, tight)).toBe('EXTRA_LARGE');
    expect(bandForBulk(4, DEFAULT_LOAD_BANDS)).toBe('SMALL');
  });
});

describe('it is a SHADOW — it cannot change or stop a dispatch', () => {
  const dispatchSrc = readFileSync(path.join(__dirname, '..', 'modules', 'dispatch', 'dispatch.service.ts'), 'utf8');
  const riderSrc = readFileSync(path.join(__dirname, '..', 'modules', 'rider', 'rider.routes.ts'), 'utf8');

  it('the candidate query is still driven by courierPackageSize alone', () => {
    // The moment this argument changes, the gate is LIVE. That must be a
    // deliberate, evidence-backed change, not something that rides along here.
    expect(dispatchSrc).toContain('order.courierPackageSize, order.customerId, order.taxiPassengerCount)');
    expect(dispatchSrc).not.toMatch(/findCandidates\([^)]*requiredPackageSizeForOrder/s);
  });

  it('both shadows are wrapped, so a classification bug cannot end a dispatch', () => {
    // A shadow that can take the cascade down is not a shadow, it is an outage.
    const shadow = shadowMethod();
    expect(shadow).toContain('try {');
    expect(shadow).toContain('} catch {');

    const accept = riderSrc.slice(riderSrc.indexOf("'loadgate:accepted'") - 1500, riderSrc.indexOf("'loadgate:accepted'") + 300);
    expect(accept).toContain('try {');
  });

  /** Just the shadow method — bounded at the next member, or a fixed slice
   *  would run into the following method and read ITS awaits. */
  function shadowMethod(): string {
    const start = dispatchSrc.indexOf('private logLoadGateShadow');
    expect(start, 'the shadow method must exist').toBeGreaterThan(-1);
    const rest = dispatchSrc.slice(start);
    const end = rest.search(/\n {2}(private|public|async|\/\*\*)/);
    return end > 0 ? rest.slice(0, end) : rest;
  }

  it('the dispatch shadow awaits nothing, so it adds no latency to a round', () => {
    const body = shadowMethod();
    expect(body).toContain('): void {');
    expect(body).not.toContain('await ');
  });

  it('the accept path records the decision field: wouldHaveExcluded', () => {
    // `wouldHaveExcluded: true` on a job that then completes fine is the single
    // signal that says the bands are too tight. Without it there is no rollout
    // evidence, only opinion.
    expect(riderSrc).toContain('wouldHaveExcluded');
    expect(riderSrc).toContain('acceptedByVehicle');
    expect(riderSrc).toContain("'loadgate:accepted'");
  });

  it('the accept-time refusal is still COURIER-only — nothing is enforced yet', () => {
    expect(riderSrc).toContain("order.orderType === 'COURIER' && order.courierPackageSize && !vehicleCanCarry");
    // The new code must not throw. A shadow that refuses an accept has shipped.
    const shadowBlock = riderSrc.slice(riderSrc.indexOf('[G1 SHADOW] The gate that does NOT exist'), riderSrc.indexOf("'loadgate:accepted'"));
    expect(shadowBlock).not.toContain('throw ');
    expect(shadowBlock).not.toContain('VEHICLE_TOO_SMALL');
  });
});
