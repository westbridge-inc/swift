import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import AccountPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// Opus review of #1615: the profile answers { vendors: [...] }, so Account shows
// the SELECTED store; and billing is the owner's (GET /vendor/subscription is
// owner-only), so a manager is never told "No subscription on this store yet".
function api(role: 'OWNER' | 'MANAGER') {
  const paths: string[] = [];
  mockApi(({ url }) => {
    const path = url.pathname.replace('/api/v1', '');
    paths.push(path);
    if (path === '/vendor/stores') return { body: { success: true, data: { stores: [], selectedId: 'store-1', myRole: role } } };
    if (path === '/vendor/profile') return { body: { success: true, data: { id: 'owner-1', userId: 'u1', myRole: role, vendors: [
      { id: 'store-2', name: 'Sample Shop', vendorType: 'STORE', isVerified: true },
      { id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', city: 'Georgetown', isVerified: true },
    ] } } };
    if (path === '/vendor/subscription') return role === 'OWNER' ? { body: { success: true, data: { status: 'ACTIVE', weeklyRate: '2500.00' } } } : { status: 403, body: { success: false } };
    if (path === '/vendor/hours') return { body: { success: true, data: [] } };
    if (path === '/vendor/cash-settlements') return { body: { success: true, data: { summary: { owed: 0, count: 0 }, unsettled: [], settled: [] } } };
    return { status: 404, body: { success: false } };
  });
  return paths;
}

beforeEach(async () => { (await import('@/lib/auth')).setSelectedStore('store-1'); });

describe('Account shows the selected store and keeps billing for the owner', () => {
  it('names the selected store, not the first one in the list', async () => {
    api('OWNER');
    renderWithQuery(<AccountPage />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Sample Kitchen' })).toBeTruthy();
    expect(screen.getByText(/Restaurant · Georgetown/)).toBeTruthy();
    expect(screen.queryByText('Sample Shop')).toBeNull();
    expect(await screen.findByText('Subscription')).toBeTruthy();
  });

  it('a manager sees no subscription card and the owner-only read is never made', async () => {
    const paths = api('MANAGER');
    renderWithQuery(<AccountPage />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Sample Kitchen' })).toBeTruthy();
    await waitFor(() => expect(paths).toContain('/vendor/stores'));
    expect(screen.queryByText(/No subscription on this store yet/)).toBeNull();
    expect(paths).not.toContain('/vendor/subscription');
  });
});
