import { screen, within } from '@testing-library/react';
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
// string, and the promo confirmation repeated the typed YYYY-MM-DD values (that form is gone: see the promo test).
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
  // [Ruling 1 Nov 2026] The console no longer makes promo codes (Swift-paid codes are off), so the confirmation is
  // gone; the list's expiry day is the date it still writes, in words and Guyana time.
  it('a promo code’s last day is listed in words, in Guyana time', async () => {
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/promos' && r.method === 'GET') return { body: { success: true, data: [{
        id: 'p1', code: 'STORE20', description: '20% off', discountType: 'PERCENTAGE', discountValue: 20, minOrderAmount: null,
        maxDiscount: null, maxUses: null, currentUses: 0, isActive: true, funder: 'VENDOR', vendorId: 'v1',
        // 03:59:59Z on 1 Dec is 23:59 on 30 Nov in Georgetown (UTC-4).
        validFrom: '2026-11-01T04:00:00.000Z', validUntil: '2026-12-01T03:59:59.999Z',
      }] } };
      throw new Error(`Unexpected request: ${r.method} ${r.url}`);
    });
    renderWithQuery(<PromosPage />);
    const line = (await screen.findByText('STORE20')).closest('tr')!;
    expect(within(line).getByText('30 Nov 2026')).toBeTruthy();
    expect(line.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
