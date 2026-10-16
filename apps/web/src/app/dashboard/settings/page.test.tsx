import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';
import * as vendorApi from '@/lib/vendor-api';
import SettingsPage from './page';
import { storeCheckLabel } from './store-check';

// ---------------------------------------------------------------------------
// [GUARDRAILS §7(4)] The settings card names the SELECTED store and says what
// Swift's team actually did. GET /vendor/profile answers
// { id, userId, vendors: [...], myRole }: the store's name, type, city and
// check live on data.vendors[i]. The card used to read them off the top level,
// so it showed no name and always said "Verification pending". Synthetic
// stores only.
// ---------------------------------------------------------------------------

const profile = {
  id: 'owner-1', userId: 'user-1', myRole: 'OWNER',
  vendors: [
    { id: 'store-1', name: 'First Sample Shop', vendorType: 'STORE', city: 'Town A', description: null, isVerified: false, activationValidUntil: null },
    { id: 'store-2', name: 'Second Sample Kitchen', vendorType: 'RESTAURANT', city: 'Town B', description: 'Synthetic test kitchen.', isVerified: true, activationValidUntil: '2999-01-01T00:00:00.000Z' },
  ],
};

function stubReads() {
  vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile as never);
  vi.spyOn(vendorApi, 'getSubscription').mockReturnValue(new Promise(() => {}) as never);
  vi.spyOn(vendorApi, 'getCashSettlements').mockReturnValue(new Promise(() => {}) as never);
  vi.spyOn(vendorApi, 'getHours').mockReturnValue(new Promise(() => {}) as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('dashboard settings: the store card', () => {
  it('reads the selected store from data.vendors and says its documents were checked', async () => {
    stubReads();
    setSelectedStore('store-2');
    renderWithQuery(<SettingsPage />);
    expect(await screen.findByRole('heading', { name: 'Second Sample Kitchen' })).toBeTruthy();
    expect(screen.getByText(/Restaurant · Town B · Documents checked by Swift/)).toBeTruthy();
    expect(screen.getByText('Synthetic test kitchen.')).toBeTruthy();
    expect(screen.queryByText(/Verification pending|Verified ✓/)).toBeNull();
  });

  // [REVIEW-F S3-1] "Waiting for Swift" was false for a store that has not uploaded, or was asked for more.
  it('a store not yet checked says so and points to its documents, never that Swift is already checking', async () => {
    stubReads();
    setSelectedStore('store-1');
    renderWithQuery(<SettingsPage />);
    expect(await screen.findByRole('heading', { name: 'First Sample Shop' })).toBeTruthy();
    expect(screen.getByText(/Shop · Town A · Not checked by Swift yet: see your documents in the Swift app/)).toBeTruthy();
    expect(screen.queryByText(/Waiting for Swift/)).toBeNull();
  });

  it('never says "checked" once a checked document has lapsed', () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    expect(storeCheckLabel({ isVerified: true, activationValidUntil: '2026-10-16T11:59:59.000Z' }, now)).toBe('A checked document has expired: renew it in the Swift app');
    expect(storeCheckLabel({ isVerified: true, activationValidUntil: null }, now)).toBe('Documents checked by Swift');
    expect(storeCheckLabel({ isVerified: false, activationValidUntil: '2999-01-01T00:00:00.000Z' }, now)).toBe('Not checked by Swift yet: see your documents in the Swift app');
  });
});
