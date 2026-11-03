import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeeklyFee } from './weekly-fee';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [REVIEW-LIGHT2 #2309 M] A store's Weekly fee tab before approval quotes THE STORE'S OWN fee when the server has it
// (GET /vendor/onboarding/weekly-fee: the step its own catalogue reaches), with that step's own free trial from the
// price list: a store with 10,000+ items gets 7 days, never "14 days free". Without its own quote (a manager cannot
// read it) the tab keeps the starting rate and adds the app's line for the department step's own trial.
// ---------------------------------------------------------------------------

const PRICING = {
  currencyCode: 'GYD', currencySymbol: '$', trialDays: 14, movers: [],
  vendors: { service: 8000, catalogue: [{ minItems: 0, tier: 'small', rate: 15000, trialDays: 14 }, { minItems: 1000, tier: 'large', rate: 20000, trialDays: 14 }, { minItems: 10000, tier: 'department', rate: 45000, trialDays: 7 }] },
};

function api(own: { status?: number; weeklyFee?: unknown }) {
  return mockApi(({ url }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/vendor/subscription') return { body: { success: true, data: null } };
    if (path === '/auth/pricing') return { body: { success: true, data: PRICING } };
    if (path === '/vendor/profile') return { body: { success: true, data: { myRole: 'OWNER', vendors: [{ id: 'store-1', name: 'Sample Store', vendorType: 'STORE', status: 'PENDING_APPROVAL' }] } } };
    if (path === '/vendor/onboarding/weekly-fee') {
      if (own.status) return { status: own.status, body: { success: false } };
      return { body: { success: true, data: { vendorId: 'store-1', set: false, weeklyFee: own.weeklyFee ?? null, why: null, required: true, ticked: false, terms: null } } };
    }
    return { status: 404, body: { success: false } };
  });
}

beforeEach(async () => { (await import('@/lib/auth')).setSelectedStore('store-1'); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('[#2309 M] a store’s own quote and its own trial', () => {
  it('a department-size store: its own fee and 7 days free', async () => {
    api({ weeklyFee: { amount: 45000, currencyCode: 'GYD', tier: 'department', version: 'v1' } });
    renderWithQuery(<WeeklyFee family="vendor" />);
    expect(await screen.findByText(/7 days free, then GY\$45,000 a week\./)).toBeTruthy();
    expect(screen.queryByText(/14 days free/)).toBeNull();
  });

  it('a small store: its own fee, 14 days free', async () => {
    api({ weeklyFee: { amount: 15000, currencyCode: 'GYD', tier: 'small', version: 'v1' } });
    renderWithQuery(<WeeklyFee family="vendor" />);
    expect(await screen.findByText(/14 days free, then GY\$15,000 a week\./)).toBeTruthy();
  });

  it('no own quote (a manager): the starting rate, and the department step’s own trial in the app’s words', async () => {
    api({ status: 403 });
    renderWithQuery(<WeeklyFee family="vendor" />);
    expect(await screen.findByText(/14 days free, then GY\$15,000 a week\./)).toBeTruthy();
    expect(await screen.findByText('A new store with 10,000+ items when Swift approves it gets 7 days free.')).toBeTruthy();
  });
});
