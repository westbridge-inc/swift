import { screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PortalHome from './page';
import HistoryPage from './history/page';
import AccountPage from './account/page';
import MoverWeeklyFeePage from './weekly-fee/page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [PORTAL-404 · FLOW-QA F29] A new rider's Earnings, History and Account pages each logged a 404 for
// GET /driver/profile in the browser console, and Weekly fee one for GET /provider/subscription. The browser logs
// every 404 itself, so the page must not ask: GET /auth/me now says which profiles the account holds, and the pages
// ask only for those. The last case is the control: with an API from before /auth/me said, the pages ask as before
// (so the assertions above can see a request when one is made). Synthetic data only.
// ---------------------------------------------------------------------------

afterEach(() => { vi.unstubAllGlobals(); });

const RIDER = { id: 'rider-1', vehicleType: 'MOTORCYCLE', user: { firstName: 'Rae', lastName: 'Rider', phone: '+5920000001' } };
const SUMMARY = { today: { total: 0, count: 0 }, thisWeek: { total: 0, count: 0 }, thisMonth: { total: 0, count: 0 }, allTime: { total: 0, count: 0 }, pendingPayout: 0 };
const NOT_HELD = ['/api/v1/driver/profile', '/api/v1/provider/subscription'];

/** A new rider. `sayProfiles: false` = an API from before /auth/me named the profiles. */
function newRider({ sayProfiles = true } = {}) {
  const asked: string[] = [];
  mockApi(({ url }) => {
    const path = url.pathname;
    asked.push(path);
    if (path === '/api/v1/auth/me') {
      return { body: { success: true, data: { user: { id: 'u-rider', roles: ['CUSTOMER', 'MOVER'] }, ...(sayProfiles ? { profiles: { rider: true, driver: false, provider: false } } : {}) } } };
    }
    if (path === '/api/v1/rider/profile') return { body: { success: true, data: RIDER } };
    if (path === '/api/v1/rider/earnings/summary') return { body: { success: true, data: SUMMARY } };
    if (path === '/api/v1/rider/orders') return { body: { success: true, data: [], meta: { page: 1, totalPages: 1, total: 0 } } };
    if (path === '/api/v1/rider/cash-settlements') return { body: { success: true, data: { unsettled: [], settled: [], summary: { owed: 0, count: 0 } } } };
    if (path === '/api/v1/rider/subscription') return { body: { success: true, data: { status: 'ACTIVE', weeklyRate: '2000.00' } } };
    if (path === '/api/v1/verification/status') return { body: { success: true, data: { roleVerified: true, missing: [], documents: [] } } };
    // What the account does not hold: the server's 404 (which a browser would log).
    if (path === '/api/v1/driver/profile' || path.startsWith('/api/v1/provider') || path === '/api/v1/services/providers/me') return { status: 404, body: { success: false, error: { message: 'Not found' } } };
    return { body: { success: true, data: null } };
  });
  return asked;
}

const PAGES: Array<[string, () => ReactElement, RegExp]> = [
  ['Earnings (/portal)', () => <PortalHome />, /^Earnings$/],
  ['History (/portal/history)', () => <HistoryPage />, /No deliveries yet|Deliveries|History/],
  ['Account (/portal/account)', () => <AccountPage />, /Your Swift account/],
  ['Weekly fee (/portal/weekly-fee)', () => <MoverWeeklyFeePage />, /Delivery and courier/],
];

async function settle(asked: string[]) {
  // The profile reads have answered once /rider/profile was asked; let every query that follows them run too.
  await waitFor(() => expect(asked).toContain('/api/v1/rider/profile'));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('[F29] a new rider’s portal pages never ask for a profile the account does not hold', () => {
  it.each(PAGES)('%s asks for no driver profile and no provider fee', async (_name, page, landmark) => {
    const asked = newRider();
    renderWithQuery(page());
    expect((await screen.findAllByText(landmark)).length).toBeGreaterThan(0);
    await settle(asked);
    for (const path of NOT_HELD) expect(asked, path).not.toContain(path);
    expect(asked).toContain('/api/v1/auth/me');
  });

  it('control: with an API from before /auth/me named the profiles, the pages ask as they always did', async () => {
    const asked = newRider({ sayProfiles: false });
    renderWithQuery(<MoverWeeklyFeePage />);
    expect(await screen.findByText('Delivery and courier')).toBeTruthy();
    await settle(asked);
    expect(asked).toContain('/api/v1/driver/profile');
    expect(asked).toContain('/api/v1/provider/subscription');
  });
});
