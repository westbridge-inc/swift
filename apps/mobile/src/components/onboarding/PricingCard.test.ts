import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      { minItems: 0, tier: 'small', rate: 15000, trialDays: 14 },
      { minItems: 1000, tier: 'large', rate: 20000, trialDays: 14 },
      // [DEPT-PRICE · owner 29 Oct 2026] 45,000 (was 60,000); a NEW department-store signup gets 7 days free.
      { minItems: 10000, tier: 'department', rate: 45000, trialDays: 7 },
    ],
  },
  franchise: { minLocations: 5, discountPct: 50 },
  // What an older app reads: the safe, conflated legacy numbers.
  weekly: { mover: 9000, moverHeavy: 9000, serviceVendor: 8000, smallVendor: 15000, largeVendor: 20000, departmentVendor: 45000 },
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

describe('PricingCard — vendors see the rate a new store starts on, and that it does not move with the catalogue', () => {
  it('a service provider is quoted 8,000 and no catalogue ladder', () => {
    const text = textOf(card({ kind: 'vendor', vendorType: 'SERVICE' }));
    expect(text).toContain('14 days free, then $8,000/week');
    expect(text).not.toContain('15,000');
    expect(text).not.toContain('items');
  });

  // [RETIER PR-A · owner 30 Oct 2026] A new store's fee is born when Swift approves it, on its own catalogue's step;
  // above the first step its owner sees that exact fee and ticks it first. [R27] The weekly re-tier is OFF on the
  // server (apps/api/src/modules/billing/weekly-retier.ts): after that nothing moves it. The card must not promise a
  // move, nor show the larger steps' fees as if they were this store's.
  it('[RETIER PR-A · R27] a restaurant, grocery or shop is quoted 15,000 under 1,000 items, told a bigger catalogue at approval is priced for its size and ticked first, and that nothing moves it after', () => {
    for (const vendorType of ['RESTAURANT', 'SUPERMARKET', 'STORE']) {
      const text = textOf(card({ kind: 'vendor', vendorType }));
      expect(text).toContain('14 days free, then $15,000/week');
      expect(text).toContain('Keep 100% of every sale — no commission on orders. This is the rate for a store with under 1,000 active items. '
        + 'If yours has more by the time Swift approves the store, its weekly fee is the rate for its size: you see that exact fee and tick it before anything is charged. '
        + 'After that, the rate does not change as your catalogue grows.');
      expect(text).not.toMatch(/automatic/i);
      expect(text).not.toContain('$20,000');
      expect(text).not.toContain('$45,000');
    }
  });

  it('[R27] the card says so only while the server\'s weekly re-tier is off — turning it on must revisit this card', () => {
    const flag = readFileSync(join(__dirname, '..', '..', '..', '..', 'api', 'src', 'modules', 'billing', 'weekly-retier.ts'), 'utf8');
    expect(flag).toMatch(/^export const WEEKLY_RETIER_ON = false;$/m);
  });

  it('[DEPT-PRICE] a shop is told, from the server, that a new store at department size gets 7 days free; the headline keeps 14', () => {
    const text = textOf(card({ kind: 'vendor', vendorType: 'SUPERMARKET' }));
    expect(text).toContain('14 days free, then $15,000/week');
    expect(text).toContain('A new store with 10,000+ active items when Swift approves it gets 7 days free.');
    expect(text).not.toContain('1,000+ active items when Swift approves it');
    // A service provider and a mover are never told it.
    for (const props of [{ kind: 'vendor', vendorType: 'SERVICE' }, { kind: 'mover', vehicleType: 'CAR' }]) {
      expect(textOf(card(props))).not.toContain('when Swift approves it');
    }
  });

  it('[DEPT-PRICE] a server that predates the per-step trial, or sends a value that is not whole days, adds no trial line', () => {
    for (const trialDays of [undefined, 0, 2.5, '7']) {
      state.pricing = { ...GY, vendors: { ...GY.vendors, catalogue: GY.vendors.catalogue.map((band) => ({ ...band, trialDays })) } };
      expect(textOf(card({ kind: 'vendor', vendorType: 'STORE' })), String(trialDays)).not.toContain('when Swift approves it');
    }
  });

  it('the steps are the server boundaries, not copy frozen into the app', () => {
    state.pricing = {
      ...GY,
      vendors: { service: 8000, catalogue: [{ minItems: 0, tier: 'small', rate: 12000 }, { minItems: 500, tier: 'large', rate: 20000, trialDays: 7 }] },
    };
    const text = textOf(card({ kind: 'vendor', vendorType: 'STORE' }));
    expect(text).toContain('14 days free, then $12,000/week');
    expect(text).toContain('A new store with 500+ active items when Swift approves it gets 7 days free.');
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
