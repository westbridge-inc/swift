import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeeklyFee } from './weekly-fee';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [WEB-ONBOARDING · FLOW-QA F8 (S2)] Every new partner opened the Weekly fee tab to "Could not load your weekly fee":
// before Swift approves a partner there is no subscription yet, and GET /<family>/subscription answers data: null. That
// is not a failure. Like the app's price card, the tab now says the fee starts after approval and shows the quote:
// the free trial and the weekly amount, from the server's price list (GET /auth/pricing) for THIS store's type or
// THIS vehicle. A price list that cannot be read claims no price; a subscription read that fails still says so.
// ---------------------------------------------------------------------------

const PRICING = {
  currencyCode: 'GYD', currencySymbol: '$', trialDays: 14,
  movers: [{ vehicleType: 'MOTORCYCLE', rate: 6000 }, { vehicleType: 'CAR', rate: 8000 }],
  vendors: { service: 8000, catalogue: [{ minItems: 0, rate: 15000, trialDays: 14 }, { minItems: 1000, rate: 20000, trialDays: 14 }, { minItems: 10000, rate: 45000, trialDays: 7 }] },
};

function api(opts: { subscription?: { status?: number; data?: unknown }; pricing?: { status?: number; data?: unknown }; vendorType?: string; vehicleType?: string } = {}) {
  return mockApi(({ url }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    if (/^\/(vendor|rider|driver)\/subscription$/.test(path)) {
      const s = opts.subscription ?? {};
      return { status: s.status ?? 200, body: s.status && s.status >= 400 ? { success: false, error: { message: 'Service unavailable' } } : { success: true, data: s.data ?? null } };
    }
    if (path === '/auth/pricing') {
      const p = opts.pricing ?? {};
      return { status: p.status ?? 200, body: p.status && p.status >= 400 ? { success: false } : { success: true, data: p.data ?? PRICING } };
    }
    if (path === '/vendor/profile') return { body: { success: true, data: { myRole: 'OWNER', vendors: [{ id: 'store-1', name: 'Sample Shop', vendorType: opts.vendorType ?? 'STORE', status: 'PENDING_APPROVAL' }] } } };
    if (path === '/rider/profile') return { body: { success: true, data: { id: 'rider-1', vehicleType: opts.vehicleType ?? 'MOTORCYCLE' } } };
    if (path === '/driver/profile') return { body: { success: true, data: { id: 'driver-1', vehicleType: opts.vehicleType ?? 'CAR' } } };
    return { status: 404, body: { success: false } };
  });
}

beforeEach(async () => { (await import('@/lib/auth')).setSelectedStore('store-1'); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('[F8] before approval the Weekly fee tab says when the fee starts, and what it will be', () => {
  it('a rider: starts after approval; 14 days free, then GY$6,000 a week; nothing paid until then', async () => {
    api();
    renderWithQuery(<WeeklyFee family="rider" />);
    expect(await screen.findByText('Starts after Swift approves you')).toBeTruthy();
    expect(await screen.findByText(/14 days free, then GY\$6,000 a week\./)).toBeTruthy();
    expect(screen.getByText(/Nothing is paid before that\./)).toBeTruthy();
    expect(screen.queryByText(/Could not load your weekly fee/)).toBeNull();
  });

  it('a taxi driver: the taxi rate', async () => {
    api();
    renderWithQuery(<WeeklyFee family="driver" />);
    expect(await screen.findByText(/14 days free, then GY\$8,000 a week\./)).toBeTruthy();
  });

  it('a store: its type’s starting rate, said to be the starting rate', async () => {
    api({ vendorType: 'STORE' });
    renderWithQuery(<WeeklyFee family="vendor" />);
    expect(await screen.findByText(/14 days free, then GY\$15,000 a week\./)).toBeTruthy();
    expect(screen.getByText(/This is the starting rate\./)).toBeTruthy();
  });

  it('a services business: the services rate, with no catalogue words', async () => {
    api({ vendorType: 'SERVICE' });
    renderWithQuery(<WeeklyFee family="vendor" />);
    expect(await screen.findByText(/14 days free, then GY\$8,000 a week\./)).toBeTruthy();
    expect(screen.queryByText(/This is the starting rate\./)).toBeNull();
  });

  it('a price list that cannot be read claims no price', async () => {
    api({ pricing: { status: 503 } });
    renderWithQuery(<WeeklyFee family="rider" />);
    expect(await screen.findByText('Starts after Swift approves you')).toBeTruthy();
    expect(await screen.findByText(/Nothing is paid before that\./)).toBeTruthy();
    expect(screen.queryByText(/GY\$/)).toBeNull();
  });

  it('a subscription read that fails still says it could not load', async () => {
    api({ subscription: { status: 503 } });
    renderWithQuery(<WeeklyFee family="rider" />);
    expect(await screen.findByText('Could not load your weekly fee.')).toBeTruthy();
  });
});
