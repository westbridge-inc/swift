import { describe, it, expect } from 'vitest';
import { estimateCourierFee, mergeCourierRates, DEFAULT_COURIER_RATES } from '../modules/courier/courier.service';

// ---------------------------------------------------------------------------
// UG-CRAFT-03 — courier pricing moves to CountryConfig.courierRates with the
// taxiRates null→code-default pattern. Pure unit: pins the default math
// (characterization — a null config must price byte-identically to the old
// hardcoded constants) and the tolerant config merge.
// ---------------------------------------------------------------------------

describe('courier rates [UG-CRAFT-03]', () => {
  it('null config prices exactly like the old hardcoded constants', () => {
    // 10 km MEDIUM EXPRESS: (1000 base + 3000 distance + 500 size) * 1.5
    const e = estimateCourierFee(10, 'MEDIUM', 'EXPRESS');
    expect(e.totalFee).toBe(6750);
    expect(e.baseFee).toBe(1000);
    expect(e.distanceFee).toBe(3000);
    expect(e.sizeSurcharge).toBe(500);
    expect(e.speedMultiplier).toBe(1.5);
  });

  it('a country override reprices; unset fields keep defaults', () => {
    const rates = mergeCourierRates({ baseFee: 2000, sizeSurcharge: { LARGE: 1500 } });
    expect(rates.baseFee).toBe(2000);
    expect(rates.perKmRate).toBe(DEFAULT_COURIER_RATES.perKmRate); // untouched
    expect(rates.sizeSurcharge.LARGE).toBe(1500);
    expect(rates.sizeSurcharge.MEDIUM).toBe(500); // merged, not replaced
    expect(rates.speedMultiplier.RUSH).toBe(2.0);

    const e = estimateCourierFee(10, 'LARGE', 'STANDARD', rates);
    expect(e.totalFee).toBe(2000 + 3000 + 1500); // new base + default per-km + new surcharge
  });

  it('malformed config falls back wholesale to defaults', () => {
    expect(mergeCourierRates('nonsense')).toEqual(DEFAULT_COURIER_RATES);
    expect(mergeCourierRates(null)).toEqual(DEFAULT_COURIER_RATES);
  });
});
