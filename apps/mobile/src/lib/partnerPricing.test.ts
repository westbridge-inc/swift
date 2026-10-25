import { describe, expect, it } from 'vitest';
import { moverQuote, vendorQuote, quoteGate, QUOTE_GATE_COPY, QUOTE_MAX_AGE_MS, type PartnerPricing } from './partnerPricing';

// The app never prices a partner itself. It looks up the quote the server
// resolved with the SAME function signup and the weekly re-tier bill through,
// and when that quote is missing it shows nothing — never a zero, never a guess.

const mover = (vehicleType: string, role: 'RIDER' | 'DRIVER', band: 'STANDARD' | 'HEAVY', tier: string, rate: number) =>
  ({ vehicleType, label: vehicleType, role, band, tier, rate }) as NonNullable<PartnerPricing['movers']>[number];

const GY: PartnerPricing = {
  countryCode: 'GY',
  currencyCode: 'GYD',
  currencySymbol: '$',
  isActive: true,
  trialDays: 14,
  movers: [
    mover('MOTORCYCLE', 'RIDER', 'STANDARD', 'courier', 8000),
    mover('CAR', 'DRIVER', 'STANDARD', 'taxi', 9000),
    mover('BUS_15', 'DRIVER', 'HEAVY', 'taxi', 9000),
    mover('CANTER_LONG', 'RIDER', 'HEAVY', 'courierHeavy', 9000),
  ],
  vendors: {
    service: 8000,
    catalogue: [
      { minItems: 0, tier: 'small', rate: 15000 },
      { minItems: 1000, tier: 'large', rate: 20000 },
      { minItems: 10000, tier: 'department', rate: 60000 },
    ],
  },
  franchise: { minLocations: 5, discountPct: 50 },
  weekly: { mover: 9000, moverHeavy: 9000, serviceVendor: 8000, smallVendor: 15000, largeVendor: 20000, departmentVendor: 60000 },
};

describe('moverQuote — the rate for the vehicle a mover registers', () => {
  it('separates the taxi rate from the rider rate and maps heavy delivery', () => {
    expect(moverQuote(GY, 'MOTORCYCLE')).toMatchObject({ role: 'RIDER', tier: 'courier', rate: 8000 });
    expect(moverQuote(GY, 'CAR')).toMatchObject({ role: 'DRIVER', tier: 'taxi', rate: 9000 });
    expect(moverQuote(GY, 'BUS_15')).toMatchObject({ role: 'DRIVER', tier: 'taxi', rate: 9000 });
    expect(moverQuote(GY, 'CANTER_LONG')).toMatchObject({ role: 'RIDER', tier: 'courierHeavy', rate: 9000 });
  });

  it('has no quote — not a zero — when the list, the vehicle or a positive rate is missing', () => {
    expect(moverQuote(undefined, 'CAR')).toBeNull();
    expect(moverQuote(null, 'CAR')).toBeNull();
    expect(moverQuote(GY, 'BICYCLE')).toBeNull();
    // An API that predates the typed list: the conflated legacy number is not
    // a quote for any one role.
    expect(moverQuote({ ...GY, movers: undefined }, 'CAR')).toBeNull();
    expect(moverQuote({ ...GY, movers: [mover('CAR', 'DRIVER', 'STANDARD', 'taxi', 0)] }, 'CAR')).toBeNull();
    expect(moverQuote({ ...GY, movers: [mover('CAR', 'DRIVER', 'STANDARD', 'taxi', Number.NaN)] }, 'CAR')).toBeNull();
  });
});

describe('vendorQuote — services flat, catalogues by active items', () => {
  it('quotes services at the service rate and new catalogue stores at the first band', () => {
    expect(vendorQuote(GY, 'SERVICE')).toMatchObject({ tier: 'service', rate: 8000 });
    for (const type of ['RESTAURANT', 'SUPERMARKET', 'STORE'] as const) {
      expect(vendorQuote(GY, type)).toMatchObject({ tier: 'small', rate: 15000 });
      expect(vendorQuote(GY, type)?.ladder).toEqual(GY.vendors!.catalogue);
    }
    expect(vendorQuote(GY, 'SERVICE')?.ladder).toEqual([]);
  });

  it('uses the same >= boundaries the biller does', () => {
    expect(vendorQuote(GY, 'STORE', 999)?.rate).toBe(15000);
    expect(vendorQuote(GY, 'STORE', 1000)?.rate).toBe(20000);
    expect(vendorQuote(GY, 'STORE', 9999)?.rate).toBe(20000);
    expect(vendorQuote(GY, 'STORE', 10000)?.rate).toBe(60000);
    expect(vendorQuote(GY, 'SERVICE', 20000)?.rate).toBe(8000);
  });

  it('has no quote — not a zero — when the list or a positive rate is missing', () => {
    expect(vendorQuote(undefined, 'STORE')).toBeNull();
    expect(vendorQuote({ ...GY, vendors: undefined }, 'STORE')).toBeNull();
    expect(vendorQuote({ ...GY, vendors: { service: 0, catalogue: GY.vendors!.catalogue } }, 'SERVICE')).toBeNull();
    expect(vendorQuote({ ...GY, vendors: { service: 8000, catalogue: [] } }, 'STORE')).toBeNull();
    expect(vendorQuote({ ...GY, vendors: { service: 8000, catalogue: [{ minItems: 0, tier: 'small', rate: -1 }] } }, 'STORE')).toBeNull();
  });
});

describe('[PR1270-S2-02] a fee is a whole number of dollars', () => {
  it('a fractional rate is no quote — the formatter would show a different number, or $0', () => {
    expect(moverQuote({ ...GY, movers: [mover('CAR', 'DRIVER', 'STANDARD', 'taxi', 0.4)] }, 'CAR')).toBeNull();
    expect(moverQuote({ ...GY, movers: [mover('CAR', 'DRIVER', 'STANDARD', 'taxi', 9000.5)] }, 'CAR')).toBeNull();
    expect(vendorQuote({ ...GY, vendors: { service: 0.001, catalogue: GY.vendors!.catalogue } }, 'SERVICE')).toBeNull();
    expect(vendorQuote({ ...GY, vendors: { service: 8000, catalogue: [{ minItems: 0, tier: 'small', rate: 15000.25 }] } }, 'STORE')).toBeNull();
    expect(vendorQuote({ ...GY, vendors: { service: 8000, catalogue: [{ minItems: 0, tier: 'small', rate: 15000 }, { minItems: 1000, tier: 'large', rate: 0.5 }] } }, 'STORE')).toBeNull();
  });
});

describe('[PR1270-S2-04] quoteGate — a partner commits only to a fetched, current, on-screen quote', () => {
  const pick = (p: PartnerPricing | null | undefined) => moverQuote(p, 'CAR');
  const now = 1_700_000_000_000;
  const fresh = { data: GY, isPending: false, isError: false, dataUpdatedAt: now - 1_000 };

  it('is ready only with data, no error, a quote for the selection and a recent fetch', () => {
    expect(quoteGate(fresh, pick, now)).toEqual({ ok: true, quote: moverQuote(GY, 'CAR') });
  });

  it('loading: nothing has arrived yet', () => {
    expect(quoteGate({ data: undefined, isPending: true, isError: false, dataUpdatedAt: 0 }, pick, now)).toEqual({ ok: false, why: 'loading' });
    expect(quoteGate({ data: null, isPending: false, isError: false, dataUpdatedAt: 0 }, pick, now)).toEqual({ ok: false, why: 'loading' });
  });

  it('error: a failed fetch refuses even while an older answer is still in hand', () => {
    expect(quoteGate({ ...fresh, isError: true }, pick, now)).toEqual({ ok: false, why: 'error' });
  });

  it('missing: the list holds no quote for what was picked', () => {
    expect(quoteGate(fresh, (p) => moverQuote(p, 'BICYCLE'), now)).toEqual({ ok: false, why: 'missing' });
    expect(quoteGate({ ...fresh, data: { ...GY, movers: undefined } }, pick, now)).toEqual({ ok: false, why: 'missing' });
    expect(quoteGate({ ...fresh, data: { ...GY, vendors: undefined } }, (p) => vendorQuote(p, 'STORE'), now)).toEqual({ ok: false, why: 'missing' });
  });

  it('stale: a quote fetched too long ago is not the price today', () => {
    expect(quoteGate({ ...fresh, dataUpdatedAt: now - QUOTE_MAX_AGE_MS }, pick, now).ok).toBe(true);
    expect(quoteGate({ ...fresh, dataUpdatedAt: now - QUOTE_MAX_AGE_MS - 1 }, pick, now)).toEqual({ ok: false, why: 'stale' });
    expect(quoteGate({ ...fresh, dataUpdatedAt: undefined }, pick, now)).toEqual({ ok: false, why: 'stale' });
    // The one-hour cache the review flagged is far outside what a signup may rely on.
    expect(QUOTE_MAX_AGE_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('every refusal has honest copy for the disabled control, and none of it is a price', () => {
    for (const why of ['loading', 'error', 'missing', 'stale'] as const) {
      expect(QUOTE_GATE_COPY[why]).toMatch(/fee/i);
      expect(QUOTE_GATE_COPY[why]).not.toMatch(/\$|\d/);
    }
  });
});
