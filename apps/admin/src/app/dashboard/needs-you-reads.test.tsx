import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DashboardPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S2-1 · REVIEW-F #2152 S3-1, S4-1] Two reads, neither hides the other.
// The overview read failing must not hide the SOS pages the server DID count (a safety
// line). And nothing says all clear (or unknown) before the queue counts answer.
// ---------------------------------------------------------------------------
const quiet = {
  todayOrders: 0, todayCompletedOrders: 0, activeVendors: 0, totalVendors: 0, activeRiders: 0, activeDrivers: 0,
  revenue: { weeklySubscriptionRevenue: 0, weeklySubscriptionWaived: 0 }, subscriptionBreakdown: [],
  alerts: { pendingVendors: 0, pastDueSubs: 0, unassignedOrders: 0 },
};
const KEYS = ['opsAlerts', 'supportSafety', 'documents', 'approvals', 'paymentConfirmations', 'support', 'catalogue', 'storeVat',
  'custody', 'claimsToDecide', 'claimsToPay', 'returnsToDecide', 'refundsOwed', 'moderation'] as const;
const panel = () => screen.getByRole('heading', { name: 'Needs you' }).parentElement!;
const doors = () => within(panel()).queryAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);

describe('[ADMIN-AUDIT S2-1 · REVIEW-F #2152] the overview and the queue counts are read apart', () => {
  it('the overview read failed, the queue counts did not: the SOS page the server counted is still a door', async () => {
    mockApi((r: ApiRequest) => {
      if (r.url.pathname === '/api/v1/admin/dashboard/waiting') {
        return { body: { success: true, data: { queues: KEYS.map((key) => ({ key, count: key === 'opsAlerts' ? 1 : 0 })), notCounted: [] } } };
      }
      if (r.url.pathname === '/api/v1/admin/dashboard/overview') return { status: 503, body: { success: false, error: { code: 'DB_DOWN', message: 'unavailable' } } };
      if (r.url.pathname.includes('orders')) return { body: { success: true, data: [] } };
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    renderWithQuery(<DashboardPage />);
    await screen.findByText(/The dashboard could not be loaded/);
    await waitFor(() => expect(doors()).toContainEqual(['1 SOS or ops page waiting to be acknowledged', '/ops-alerts']));
  });

  it('while the queue counts are on their way: "Counting every queue…", never All clear, never unknown', async () => {
    mockApi((r: ApiRequest) => {
      if (r.url.pathname === '/api/v1/admin/dashboard/waiting') return new Promise(() => {});
      if (r.url.pathname === '/api/v1/admin/dashboard/overview') return { body: { success: true, data: quiet } };
      if (r.url.pathname.includes('orders')) return { body: { success: true, data: [] } };
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    renderWithQuery(<DashboardPage />);
    expect(await screen.findByText('Counting every queue…')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.getByText('Counting every queue…')).toBeTruthy();
    expect(within(panel()).queryByText(/All clear/)).toBeNull();
    expect(within(panel()).queryByText(/could not be/)).toBeNull();
  });
});
