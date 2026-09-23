import { describe, expect, it } from 'vitest';
import { moverQuote, vendorQuote, type PartnerPricing } from './partnerPricing';

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
