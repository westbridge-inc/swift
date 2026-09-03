import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DashboardPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [A-06] ABSENCE OF DATA IS NOT EVIDENCE OF ABSENCE.
//
// Every panel on this page rendered a reassuring sentence when its query
// FAILED: "All clear — no active alerts", "No recent orders", "No data", and a
// weekly total of $0 with a monthly projection multiplied out of it. A
// timeout, a 403 or a schema change looked exactly like a quiet, healthy
// platform — at the one moment an operator most needs to know they are blind.
//
// These tests fail the reads and assert the page says so.
// ---------------------------------------------------------------------------

const healthy = {
  todayOrders: 12,
  todayCompletedOrders: 9,
  activeVendors: 4,
  totalVendors: 7,
  activeRiders: 3,
  activeDrivers: 2,
  revenue: { weeklySubscriptionRevenue: 45000 },
  subscriptionBreakdown: [{ type: 'RESTAURANT', count: 4, weeklyRevenue: 45000 }],
  alerts: { pendingVendors: 0, pastDueSubs: 0, unassignedOrders: 0 },
};

function handler(mode: 'ok' | 'fail') {
  return (request: ApiRequest) => {
    if (mode === 'fail') return { status: 503, body: { success: false, error: { code: 'DB_DOWN', message: 'unavailable' } } };
    if (request.url.pathname.includes('orders')) return { body: { success: true, data: [] } };
    return { body: { success: true, data: healthy } };
  };
}

describe('[A-06] a failed dashboard read is never a quiet platform', () => {
  it('says the page is blind, and says these figures are unknown rather than zero', async () => {
    mockApi(handler('fail'));
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText(/dashboard could not be loaded/i)).toBeTruthy();
    expect(screen.getByText(/not zero — they are unknown/i)).toBeTruthy();
    // and no card invents a figure
    await waitFor(() => expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(1));
  });

  it('never renders "All clear" when the alerts read failed', async () => {
    mockApi(handler('fail'));
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText(/NOT an all-clear/i)).toBeTruthy();
    expect(screen.queryByText(/All clear — no active alerts/i)).toBeNull();
  });

  it('never renders "No recent orders" when the feed read failed', async () => {
    mockApi(handler('fail'));
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText(/order feed could not be loaded/i)).toBeTruthy();
    expect(screen.getByText(/not an empty queue/i)).toBeTruthy();
    expect(screen.queryByText(/No recent orders/i)).toBeNull();
  });

  it('prints no monthly projection when there is no weekly total to project from', async () => {
    mockApi(handler('fail'));
    renderWithQuery(<DashboardPage />);

    await screen.findByText(/dashboard could not be loaded/i);
    expect(screen.queryByText(/Monthly Projection/i)).toBeNull();
    // the old shape: "$0 GYD" as an authoritative total
    expect(screen.queryByText(/^\$0 GYD$/)).toBeNull();
  });

  it('a genuinely quiet platform still reads as quiet — the guard is not a permanent alarm', async () => {
    mockApi(handler('ok'));
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText(/All clear — no active alerts/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    expect(await screen.findByText('12')).toBeTruthy(); // today's orders, really 12
    expect(screen.getByText(/Monthly Projection/i)).toBeTruthy();
  });
});
