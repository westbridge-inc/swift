import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-4] The audit's line: Subscribers said "trial → 11/10/2026".
// It now says the day in words, Guyana time: no slashes to misread.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ pathname: '/subscriptions', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => nav, useSearchParams: () => new URLSearchParams() }));

import SubscriptionsPage from './subscriptions/page';

describe('[ADMIN-AUDIT S3-4] Subscribers dates in words', () => {
  it('a free trial shows the day it ends in words', async () => {
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/subscriptions') return { body: { success: true, data: [{
        id: 'sub-t', status: 'TRIAL', type: 'RESTAURANT', weeklyRate: 2100, feeWaived: false, isTrialActive: true,
        trialEndDate: '2026-11-10T16:00:00.000Z', nextBillingDate: '2026-11-10T16:00:00.000Z', vendor: { id: 'v1', name: 'Shanta Kitchen' },
      }] } };
      return { body: { success: true, data: [] } };
    });
    renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText(/Free trial until 10 Nov 2026/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });
});
