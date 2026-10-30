import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import * as vendorApi from '@/lib/vendor-api';
import * as chainStatement from '@/lib/chain-statement';
import type { ChainStatement } from '@/lib/chain-statement';
import FeeStatementPage from './page';

// ---------------------------------------------------------------------------
// [ENTERPRISE E3 · owner 29 Oct 2026] The owner's fee statement page: one month, every branch with its fee and deal,
// the weeks paid, what is owed now and the receipts, the issuer's details and "Not a VAT invoice"; print or save as
// PDF. A manager is told only the owner sees it, and nothing is asked of the server. Synthetic business only.
// ---------------------------------------------------------------------------

const statement: ChainStatement = {
  month: '2026-10', from: '2026-10-01T04:00:00.000Z', to: '2026-11-01T04:00:00.000Z',
  issuer: { name: 'Sample Operator Inc.', tradingAs: 'Swift', registrationNo: 'R-1', registeredOffice: 'Sample office', tin: null },
  billedTo: { name: 'Sample Owner', email: 'owner@example.test', phone: null },
  currencyCode: 'GYD', deal: { weeklyRate: 14000, currencyCode: 'GYD' },
  branches: [
    { vendorId: 'v1', branchName: 'North Branch', address: '1 Sample Street, Georgetown', subscriptionStatus: 'ACTIVE', weeklyFee: 14000, dealWeeklyRate: 14000,
      weeks: [{ periodStart: '2026-10-02T12:00:00.000Z', periodEnd: '2026-10-09T12:00:00.000Z', amount: 14000, paidAt: '2026-10-02T12:00:00.000Z' }],
      owedNow: null, receipts: [{ receiptNumber: 'SWF-1', issuedAt: '2026-10-02T12:00:00.000Z', amount: 14000, channel: 'MMG_CHECKOUT' }], weeksTotal: 14000, receiptsTotal: 14000 },
    { vendorId: 'v2', branchName: 'Camp Branch', address: '', subscriptionStatus: 'PAST_DUE', weeklyFee: 12000, dealWeeklyRate: null,
      weeks: [], owedNow: { amount: 12000, dueSince: '2026-10-20T12:00:00.000Z' }, receipts: [], weeksTotal: 0, receiptsTotal: 0 },
  ],
  totals: { weeksCharged: 14000, received: 14000, owedNow: 12000 },
  vatNote: 'Not a VAT invoice', generatedAt: '2026-11-02T12:00:00.000Z',
};
const profile = (myRole: string) => ({ myRole, vendors: [{ id: 'store-1', name: 'North Branch' }] });

afterEach(() => { vi.restoreAllMocks(); });

describe('[E3] the fee statement page', () => {
  it('the owner sees the month: issuer, owner, each branch, totals and "Not a VAT invoice"', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER') as never);
    vi.spyOn(chainStatement, 'lastGuyanaMonth').mockReturnValue('2026-10');
    const get = vi.spyOn(chainStatement, 'getChainStatement').mockResolvedValue(statement);
    renderWithQuery(<FeeStatementPage />);
    const doc = await screen.findByRole('article', { name: 'Fee statement for 2026-10' });
    expect(get).toHaveBeenCalledWith('2026-10');
    expect(doc.textContent).toContain('Sample Operator Inc. (trading as Swift)');
    expect(doc.textContent).toContain('Business owner: Sample Owner · owner@example.test');
    expect(doc.textContent).toContain('Not a VAT invoice');
    expect(within(doc).getByRole('table', { name: 'Weeks paid by North Branch' })).toBeTruthy();
    expect(within(doc).getByRole('table', { name: 'Receipts for North Branch' }).textContent).toContain('SWF-1');
    expect(doc.textContent).toContain('Owed now: ');
    expect(doc.textContent).toContain('No week paid this month.');
    expect(screen.getByRole('button', { name: 'Print or save as PDF' })).toBeTruthy();
  });

  it('another month asks for exactly that month', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER') as never);
    vi.spyOn(chainStatement, 'lastGuyanaMonth').mockReturnValue('2026-10');
    const get = vi.spyOn(chainStatement, 'getChainStatement').mockResolvedValue(statement);
    renderWithQuery(<FeeStatementPage />);
    fireEvent.change(await screen.findByLabelText('Month'), { target: { value: '2026-09' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('2026-09'));
  });

  it('a manager is told only the owner sees it, and the server is not asked', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('MANAGER') as never);
    const get = vi.spyOn(chainStatement, 'getChainStatement').mockResolvedValue(statement);
    renderWithQuery(<FeeStatementPage />);
    expect(await screen.findByText('Only the business owner sees the fee statement.')).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });
});
