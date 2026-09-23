import { beforeEach, describe, expect, it, vi } from 'vitest';

// The onboarding price card is role-specific: a taxi driver, a delivery rider,
// a heavy-delivery rider, a service provider and a shop each read THEIR weekly
// fee — the one signup will write — or no card at all.

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('@swift/ui', () => ({ color: { brand: { 50: 'brand-50', 500: 'brand-500' } }, radius: { full: 9999 }, space: { md: 12 } }));
vi.mock('../../kit', () => ({ Card: 'Card', T: 'T' }));

const state = vi.hoisted(() => ({ pricing: undefined as unknown, countryCode: 'GY' as string | undefined, askedFor: [] as unknown[] }));
vi.mock('../../hooks/verification', () => ({
  usePartnerPricing: (countryCode?: string) => {
    state.askedFor.push(countryCode);
    return { data: state.pricing };
  },
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (select: (s: unknown) => unknown) => select({ user: { countryCode: state.countryCode } }),
}));

import { PricingCard } from './PricingCard';

type Props = Parameters<typeof PricingCard>[0];
const card = (props: Record<string, unknown>) => PricingCard(props as unknown as Props);

function textOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as { props?: { children?: unknown } }).props?.children);
}

const quote = (vehicleType: string, role: string, band: string, tier: string, rate: number) => ({ vehicleType, label: vehicleType, role, band, tier, rate });
const GY = {
  countryCode: 'GY',
  currencyCode: 'GYD',
  currencySymbol: '$',
  isActive: true,
  trialDays: 14,
  movers: [
    quote('MOTORCYCLE', 'RIDER', 'STANDARD', 'courier', 8000),
    quote('CAR', 'DRIVER', 'STANDARD', 'taxi', 9000),
    quote('BUS_15', 'DRIVER', 'HEAVY', 'taxi', 9000),
    quote('CANTER_LONG', 'RIDER', 'HEAVY', 'courierHeavy', 9000),
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
  // What an older app reads: the safe, conflated legacy numbers.
  weekly: { mover: 9000, moverHeavy: 9000, serviceVendor: 8000, smallVendor: 15000, largeVendor: 20000, departmentVendor: 60000 },
};

beforeEach(() => {
  state.pricing = GY;
  state.countryCode = 'GY';
  state.askedFor = [];
});

describe('PricingCard — movers see the rate for the vehicle they register', () => {
  it('a delivery rider on a motorbike is quoted 8,000, not the taxi rate', () => {
    const text = textOf(card({ kind: 'mover', vehicleType: 'MOTORCYCLE' }));
    expect(text).toContain('14 days free, then $8,000/week');
    expect(text).toContain('Delivery & courier rider');
    expect(text).not.toContain('9,000');
  });

  it('a taxi driver is quoted 9,000 — car or bus', () => {
    for (const vehicleType of ['CAR', 'BUS_15']) {
      const text = textOf(card({ kind: 'mover', vehicleType }));
      expect(text).toContain('14 days free, then $9,000/week');
      expect(text).toContain('Taxi driver');
    }
  });

  it('a canter is quoted the heavy-delivery rate', () => {
    const text = textOf(card({ kind: 'mover', vehicleType: 'CANTER_LONG' }));
    expect(text).toContain('then $9,000/week');
    expect(text).toContain('Heavy delivery');
  });

  it('prices in the country the account signed up in', () => {
    state.countryCode = 'TT';
    card({ kind: 'mover', vehicleType: 'CAR' });
    expect(state.askedFor).toEqual(['TT']);
  });
});

describe('PricingCard — vendors see their own tier and the automatic ladder', () => {
  it('a service provider is quoted 8,000 and no catalogue ladder', () => {
    const text = textOf(card({ kind: 'vendor', vendorType: 'SERVICE' }));
    expect(text).toContain('14 days free, then $8,000/week');
    expect(text).not.toContain('15,000');
    expect(text).not.toContain('items');
  });

  it('a restaurant, grocery or shop starts at 15,000 and sees the 1,000 / 10,000 steps from the server', () => {
    for (const vendorType of ['RESTAURANT', 'SUPERMARKET', 'STORE']) {
      const text = textOf(card({ kind: 'vendor', vendorType }));
      expect(text).toContain('14 days free, then $15,000/week');
      expect(text).toContain('1,000+ active items $20,000/week');
      expect(text).toContain('10,000+ $60,000/week');
      expect(text).toContain('automatically');
    }
  });

  it('the steps are the server boundaries, not copy frozen into the app', () => {
    state.pricing = {
      ...GY,
      vendors: { service: 8000, catalogue: [{ minItems: 0, tier: 'small', rate: 15000 }, { minItems: 500, tier: 'large', rate: 20000 }] },
    };
    const text = textOf(card({ kind: 'vendor', vendorType: 'STORE' }));
    expect(text).toContain('500+ active items $20,000/week');
    expect(text).not.toContain('1,000');
  });
});

describe('PricingCard — no quote, no card: never a zero and never a conflated guess', () => {
  it('renders nothing until the price list has loaded', () => {
    state.pricing = undefined;
    expect(card({ kind: 'mover', vehicleType: 'CAR' })).toBeNull();
    expect(card({ kind: 'vendor', vendorType: 'STORE' })).toBeNull();
  });

  it('renders nothing for a vehicle or vendor tier the server did not quote', () => {
    expect(card({ kind: 'mover', vehicleType: 'BICYCLE' })).toBeNull();
    state.pricing = { ...GY, movers: undefined, vendors: undefined };
    expect(card({ kind: 'mover', vehicleType: 'CAR' })).toBeNull();
    expect(card({ kind: 'vendor', vendorType: 'SERVICE' })).toBeNull();
  });
});
