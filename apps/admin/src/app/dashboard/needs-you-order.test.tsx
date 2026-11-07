import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DashboardPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// [ADMIN-AUDIT S2-1 · REVIEW-F #2152 delta S4-1] A SAFETY ticket being handled is a safety row: it is listed with
// the SOS rows, before the overview's unassigned orders.
const busy = {
  todayOrders: 0, todayCompletedOrders: 0, activeVendors: 0, totalVendors: 0, activeRiders: 0, activeDrivers: 0,
  revenue: { weeklySubscriptionRevenue: 0, weeklySubscriptionWaived: 0 }, subscriptionBreakdown: [],
  alerts: { pendingVendors: 0, pastDueSubs: 0, unassignedOrders: 2 },
};
const panel = () => screen.getByRole('heading', { name: 'Needs you' }).parentElement!;
const doors = () => within(panel()).queryAllByRole('link').map((a) => a.getAttribute('href'));

describe('[ADMIN-AUDIT S2-1] safety rows come first', () => {
  it('safety tickets being handled come before unassigned orders', async () => {
    mockApi((r: ApiRequest) => {
      if (r.url.pathname === '/api/v1/admin/dashboard/waiting') {
        return { body: { success: true, data: { queues: [{ key: 'opsAlerts', count: 0, door: true }, { key: 'supportSafetyInProgress', count: 1, door: true }, { key: 'support', count: 1, door: true }], notCounted: [] } } };
      }
      if (r.url.pathname === '/api/v1/admin/dashboard/overview') return { body: { success: true, data: busy } };
      if (r.url.pathname.includes('orders')) return { body: { success: true, data: [] } };
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    renderWithQuery(<DashboardPage />);
    await waitFor(() => expect(doors()).toHaveLength(3));
    expect(doors()).toEqual(['/support?status=IN_PROGRESS', '/orders', '/support?status=OPEN']);
  });
});
