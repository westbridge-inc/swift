import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import PricingPage from './page';

// The real config refuses to load while company details are placeholders; the
// page only needs a support address from it.
vi.mock('@/site.config', () => ({ site: { supportEmail: 'support@example.test' }, showAppStoreBadges: false }));

// ---------------------------------------------------------------------------
// The public price list must quote each partner the rate they will be billed.
// A taxi driver and a delivery rider no longer share one "Riders & drivers"
// number, and the catalogue steps are the server's boundaries — the page reads
// the typed list the API resolves with the same function signup and the weekly
// re-tier bill through, and never a conflated or hardcoded figure.
// ---------------------------------------------------------------------------

// The server lists every vehicle with `offered` (config/vehicle-classes
// isVehicleOffered): canters and box trucks are not taken at launch — heavy
// delivery is OFF (owner, 13 Oct 2026). Rates are the owner's card.
const quote = (vehicleType: string, label: string, role: string, band: string, tier: string, rate: number, offered = true) => ({ vehicleType, label, role, band, tier, rate, offered });
const GY = {
  countryCode: 'GY',
  currencyCode: 'GYD',
  currencySymbol: '$',
  isActive: true,
  trialDays: 14,
  movers: [
    quote('BICYCLE', 'Bicycle', 'RIDER', 'STANDARD', 'courier', 6000),
    quote('MOTORCYCLE', 'Motorbike', 'RIDER', 'STANDARD', 'courier', 6000),
    quote('CAR', 'Car', 'DRIVER', 'STANDARD', 'taxi', 8000),
    quote('WAGON_CAR', 'Wagon Car', 'DRIVER', 'STANDARD', 'taxi', 8000),
    quote('BUS_9', 'Bus (9-seater)', 'DRIVER', 'HEAVY', 'taxi', 8000),
    quote('BUS_15', 'Bus (15-seater)', 'DRIVER', 'HEAVY', 'taxi', 8000),
    quote('CANTER_SHORT', 'Short-Base Canter (Open Back)', 'RIDER', 'HEAVY', 'courierHeavy', 9000, false),
    quote('CANTER_LONG', 'Long-Base Canter (Open Back)', 'RIDER', 'HEAVY', 'courierHeavy', 9000, false),
    quote('BOX_TRUCK_SHORT', 'Short-Base Box Truck', 'RIDER', 'HEAVY', 'courierHeavy', 9000, false),
    quote('BOX_TRUCK_LONG', 'Long-Base Box Truck', 'RIDER', 'HEAVY', 'courierHeavy', 9000, false),
  ],
  vendors: {
    service: 8000,
    catalogue: [
      { minItems: 0, tier: 'small', rate: 15000 },
      { minItems: 1000, tier: 'large', rate: 20000 },
      { minItems: 10000, tier: 'department', rate: 60000 },
    ],
  },
  // No multi-store pricing (owner, 13 Oct 2026): the server serves null.
  franchise: null,
  // What an older page reads; this page must not.
  weekly: { mover: 8000, moverHeavy: 8000, serviceVendor: 8000, smallVendor: 15000, largeVendor: 60000, departmentVendor: 60000 },
};

let pricing: unknown;
beforeEach(() => {
  pricing = GY;
  vi.spyOn(api, 'fetchPricing').mockImplementation(async () => pricing as never);
});
afterEach(() => vi.restoreAllMocks());

async function renderPage() {
  render(await PricingPage({ searchParams: Promise.resolve({}) }));
}
const cardOf = (title: string) => screen.getByRole('heading', { name: title }).parentElement!;

describe('public pricing page — every partner reads their own weekly fee', () => {
  it('quotes delivery riders and taxi drivers apart — riders 6,000, taxi drivers 8,000', async () => {
    await renderPage();
    expect(within(cardOf('Delivery & courier riders')).getByText(/6,000/)).toBeTruthy();
    expect(within(cardOf('Taxi drivers')).getByText(/8,000/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Riders & drivers' })).toBeNull();
  });

  it('names the vehicles in each mover class from the server list', async () => {
    await renderPage();
    const taxi = cardOf('Taxi drivers').textContent!;
    expect(taxi).toContain('Car');
    expect(taxi).toContain('Bus (15-seater)');
    expect(taxi).not.toContain('Motorbike');
    expect(cardOf('Delivery & courier riders').textContent).toContain('Motorbike');
  });

  it('heavy delivery is off at launch: no card, no canter or truck, no heavy rate anywhere on the page', async () => {
    await renderPage();
    expect(screen.queryByRole('heading', { name: 'Heavy delivery' })).toBeNull();
    const page = document.body.textContent!;
    expect(page).not.toMatch(/canter|box truck/i);
    expect(page).not.toContain('9,000');
  });

  it('a mover card lists only the vehicles a mover can register today', async () => {
    // Buses hidden at launch (#1545): the server marks them not offered.
    pricing = { ...GY, movers: GY.movers.map((q) => (q.vehicleType.startsWith('BUS') ? { ...q, offered: false } : q)) };
    await renderPage();
    const taxi = cardOf('Taxi drivers').textContent!;
    expect(taxi).toContain('Wagon Car');
    expect(taxi).not.toContain('Bus');
  });

  it('a quote from an older server that predates the offered flag is still shown', async () => {
    pricing = { ...GY, movers: GY.movers.filter((q) => q.tier !== 'courierHeavy').map(({ offered: _offered, ...q }) => q) };
    await renderPage();
    expect(within(cardOf('Taxi drivers')).getByText(/8,000/)).toBeTruthy();
    expect(cardOf('Taxi drivers').textContent).toContain('Bus (9-seater)');
  });

  it('quotes services flat and every catalogue step with its active-item range', async () => {
    await renderPage();
    expect(within(cardOf('Services')).getByText(/8,000/)).toBeTruthy();
    const small = cardOf('Businesses');
    expect(within(small).getByText(/15,000/)).toBeTruthy();
    expect(small.textContent).toContain('fewer than 1,000 active items');
    const large = cardOf('Large catalogues');
    expect(within(large).getByText(/20,000/)).toBeTruthy();
    expect(large.textContent).toContain('1,000–9,999 active items');
    const department = cardOf('Department stores');
    expect(within(department).getByText(/60,000/)).toBeTruthy();
    expect(department.textContent).toContain('10,000+ active items');
  });

  it('shows no multi-store discount — every store pays its own tier, even if an older server still sends the old rule', async () => {
    pricing = { ...GY, franchise: { minLocations: 5, discountPct: 50 } };
    await renderPage();
    expect(screen.queryByRole('heading', { name: 'Franchises' })).toBeNull();
    const page = document.body.textContent!;
    expect(page).not.toMatch(/franchise|% off|7,500/i);
  });

  it('prints the server boundaries, not copy frozen into the page', async () => {
    pricing = {
      ...GY,
      vendors: { service: 8000, catalogue: [{ minItems: 0, tier: 'small', rate: 15000 }, { minItems: 500, tier: 'large', rate: 20000 }] },
    };
    await renderPage();
    expect(cardOf('Businesses').textContent).toContain('fewer than 500 active items');
    expect(cardOf('Large catalogues').textContent).toContain('500+ active items');
    expect(document.body.textContent).not.toContain('1,000');
    expect(screen.queryByRole('heading', { name: 'Department stores' })).toBeNull();
  });

  it('shows the honest fallback, not conflated legacy numbers, when the typed list is missing', async () => {
    pricing = { ...GY, movers: undefined, vendors: undefined };
    await renderPage();
    expect(screen.getByText(/could not load this week/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Taxi drivers' })).toBeNull();
    expect(document.body.textContent).not.toContain('9,000');
  });

  it('[PR1270-S2-02] a rate that is not a whole number of dollars is not quoted — it would render as $0 or as a different figure', async () => {
    pricing = { ...GY, vendors: { ...GY.vendors, service: 0.4 } };
    await renderPage();
    expect(screen.getByText(/could not load this week/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('$0');
    expect(screen.queryByRole('heading', { name: 'Services' })).toBeNull();
  });
});
