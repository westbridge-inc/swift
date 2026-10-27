import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-4] The audit's line: Subscribers said "trial → 11/10/2026".
// It now says the day in words, Guyana time: no slashes to misread.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ pathname: '/subscriptions', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => nav, useSearchParams: () => new URLSearchParams() }));

import SubscriptionsPage from './subscriptions/page';
import StoreVatPage from './store-vat/page';
import PromosPage from './promos/page';

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
    // [REVIEW-F #2155 S4-3] The whole line: a time appended to the day would not pass.
    expect(await screen.findByText(/^Free trial until 10 Nov 2026$/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });
});

// [REVIEW-F #2155 S3-1 + S4-4] Two pages still wrote dates themselves: the Store VAT queue cut the UTC day off an ISO
// string, and the promo confirmation repeated the typed YYYY-MM-DD values.
describe('[ADMIN-AUDIT S3-4] Store VAT and promo dates in words', () => {
  it('a certificate sent on the evening of 27 Oct (Guyana) says 27 Oct, in words', async () => {
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/store-vat/pending') return { body: { success: true, data: [{
        vendorId: 'vnd-1', name: 'Sample Shop', vatRegistrationNumber: '012345678', mode: 'PRICES_INCLUDE_VAT',
        // 01:00Z on 28 Oct is 21:00 on 27 Oct in Georgetown (UTC-4).
        certificate: { id: 'doc-1', status: 'PENDING', state: 'COMMITTED', createdAt: '2026-10-28T01:00:00.000Z' },
      }] } };
      return { body: { success: true, data: [] } };
    });
    renderWithQuery(<StoreVatPage />);
    expect(await screen.findByText('Certificate sent 27 Oct 2026 (not decided yet)')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
  it('the promo confirmation says the days it runs in words', async () => {
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/promos' && r.method === 'GET') return { body: { success: true, data: [] } };
      throw new Error(`Unexpected request: ${r.method} ${r.url}`);
    });
    const { user } = renderWithQuery(<PromosPage />);
    await user.click(await screen.findByRole('button', { name: /create promo/i }));
    await user.type(screen.getByLabelText('Code'), 'welcome10');
    await user.type(screen.getByLabelText('Description'), '10% off your first order');
    fireEvent.change(screen.getByLabelText('Valid from'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Valid until'), { target: { value: '2026-11-30' } });
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const panel = await screen.findByRole('dialog', { name: /Create the promo code WELCOME10\?/ });
    expect(within(panel).getByText(/valid 1 Nov 2026 to 30 Nov 2026\./)).toBeTruthy();
    expect(panel.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
