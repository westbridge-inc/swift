import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
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
    { vendorId: 'v1', branchName: 'North Branch', address: '1 Sample Street, Georgetown', subscriptionStatus: 'ACTIVE', weeklyFee: 14000, feeWaived: false, dealWeeklyRate: 14000,
      weeks: [{ periodStart: '2026-10-02T12:00:00.000Z', periodEnd: '2026-10-09T12:00:00.000Z', amount: 14000, paidAt: '2026-10-02T12:00:00.000Z' }],
      owedNow: null, receipts: [{ receiptNumber: 'SWF-1', issuedAt: '2026-10-02T12:00:00.000Z', amount: 14000, channel: 'MMG_CHECKOUT' }], weeksTotal: 14000, receiptsTotal: 14000 },
    { vendorId: 'v2', branchName: 'Camp Branch', address: '', subscriptionStatus: 'PAST_DUE', weeklyFee: 12000, feeWaived: false, dealWeeklyRate: null,
      weeks: [], owedNow: { amount: 12000, dueSince: '2026-10-20T12:00:00.000Z' }, receipts: [], weeksTotal: 0, receiptsTotal: 0 },
  ],
  totals: { weeksCharged: 14000, received: 14000, owedNow: 12000 },
  vatNote: 'Not a VAT invoice', generatedAt: '2026-11-02T12:00:00.000Z',
};

afterEach(() => { vi.restoreAllMocks(); });

describe('[E3] the fee statement page', () => {
  it('the owner sees the month: issuer, owner, each branch, totals and "Not a VAT invoice"', async () => {
    vi.spyOn(chainStatement, 'getMyRole').mockResolvedValue('OWNER');
    vi.spyOn(chainStatement, 'lastGuyanaMonth').mockReturnValue('2026-10');
    const get = vi.spyOn(chainStatement, 'getChainStatement').mockResolvedValue(statement);
    renderWithQuery(<FeeStatementPage />);
    const doc = await screen.findByRole('article', { name: 'Fee statement for 2026-10' });
    expect(get).toHaveBeenCalledWith('2026-10');
    expect(doc.textContent).toContain('Sample Operator Inc. (trading as Swift)');
    expect(doc.textContent).toContain('Business owner: Sample Owner · owner@example.test');
    expect(doc.textContent).toContain('Not a VAT invoice');
    expect(within(doc).getByRole('table', { name: 'Paid weeks starting this month, North Branch' })).toBeTruthy();
    expect(within(doc).getByRole('table', { name: 'Receipts issued this month, North Branch' }).textContent).toContain('SWF-1');
    // [REVIEW-F #2228 S3-1/S3-3] Said as it is: paid weeks STARTING this month; dated owed figures; the making time.
    expect(doc.textContent).toContain('No paid week starts this month.');
    expect(doc.textContent).toContain('Paid weeks starting this month: ');
    expect(doc.textContent).toContain('Receipts issued this month (before any refund): ');
    expect(doc.textContent).toContain('Made 2 Nov 2026');
    expect(doc.textContent).toContain('Owed on 2 Nov 2026: ');
    // Both the branch's line and the total say the day.
    const totals = Array.from(doc.querySelectorAll(':scope > section:last-of-type p')).map((p) => p.textContent ?? '');
    expect(totals.some((t) => t.startsWith('Owed on 2 Nov 2026: '))).toBe(true);
    expect(within(doc).getByText('Camp Branch').parentElement!.textContent).toContain(' · Owed on 2 Nov 2026: ');
    expect(doc.textContent).toMatch(/Weekly fee \S*14,000 \(chain deal\)/);
    expect(screen.getByRole('button', { name: 'Print or save as PDF' })).toBeTruthy();
  });

  it('another month asks for exactly that month', async () => {
    vi.spyOn(chainStatement, 'getMyRole').mockResolvedValue('OWNER');
    vi.spyOn(chainStatement, 'lastGuyanaMonth').mockReturnValue('2026-10');
    const get = vi.spyOn(chainStatement, 'getChainStatement').mockResolvedValue(statement);
    renderWithQuery(<FeeStatementPage />);
    fireEvent.change(await screen.findByLabelText('Month'), { target: { value: '2026-09' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('2026-09'));
  });

  it('[REVIEW-F #2228 S4-2] each branch says what it pays: its own lower fee is not the deal; waived, trial and not-billed are said', async () => {
    vi.spyOn(chainStatement, 'getMyRole').mockResolvedValue('OWNER');
    vi.spyOn(chainStatement, 'lastGuyanaMonth').mockReturnValue('2026-10');
    const base = statement.branches[1]!;
    const branch = (name: string, over: Partial<typeof base>) => ({ ...base, vendorId: name, branchName: name, owedNow: null, ...over });
    vi.spyOn(chainStatement, 'getChainStatement').mockResolvedValue({ ...statement, branches: [
      branch('Lower', { weeklyFee: 9000, dealWeeklyRate: 14000, subscriptionStatus: 'ACTIVE' }),
      branch('Waived', { weeklyFee: 0, feeWaived: true, subscriptionStatus: 'ACTIVE' }),
      branch('Trial', { weeklyFee: 12000, subscriptionStatus: 'TRIAL' }),
      branch('Gone', { weeklyFee: 12000, subscriptionStatus: 'CHURNED' }),
    ] });
    renderWithQuery(<FeeStatementPage />);
    const doc = await screen.findByRole('article', { name: 'Fee statement for 2026-10' });
    const line = (name: string) => within(doc).getByRole('heading', { name }).parentElement!.textContent!;
    expect(line('Lower')).toMatch(/Weekly fee \S*9,000 ·/);
    expect(line('Lower')).not.toContain('(chain deal)');
    expect(line('Waived')).toContain('Weekly fee waived');
    expect(line('Trial')).toMatch(/In its free trial \(then \S*12,000 a week\)/);
    expect(line('Gone')).toContain('Not billed now');
  });

  it('[REVIEW-F #2228 S4-3] the month picker runs from 2026-01 to this month, and the page says it is loading while it checks the role', async () => {
    let resolve: (_role: string) => void = () => undefined;
    vi.spyOn(chainStatement, 'getMyRole').mockReturnValue(new Promise((r) => { resolve = r; }));
    vi.spyOn(chainStatement, 'thisGuyanaMonth').mockReturnValue('2026-11');
    vi.spyOn(chainStatement, 'getChainStatement').mockResolvedValue(statement);
    renderWithQuery(<FeeStatementPage />);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    resolve('OWNER');
    const input = await screen.findByLabelText('Month');
    expect(input.getAttribute('min')).toBe('2026-01');
    expect(input.getAttribute('max')).toBe('2026-11');
  });

  it('a manager is told only the owner sees it, and the server is not asked', async () => {
    vi.spyOn(chainStatement, 'getMyRole').mockResolvedValue('MANAGER');
    const get = vi.spyOn(chainStatement, 'getChainStatement').mockResolvedValue(statement);
    renderWithQuery(<FeeStatementPage />);
    expect(await screen.findByText('Only the business owner sees the fee statement.')).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });
});
