import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import * as vendorApi from '@/lib/vendor-api';
import * as vatReport from '@/lib/vat-report';
import type { VatReport } from '@/lib/vat-report';
import VatReportPage from './page';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5 · PR4] The VAT report page: the owner picks a month (a VAT return's tax period), sees the GRA
// return's sales lines, each Guyana day and each order, and downloads the CSV for the accountant. Swift never files.
// A manager is told only the owner sees it (and nothing is asked of the server). Synthetic store only.
// ---------------------------------------------------------------------------

const report: VatReport = {
  from: '2026-02-01', to: '2026-02-28',
  days: [{ day: '2026-02-03', orders: 1, standardRatedInclVat: 1000, vatCharged: 123, standardRatedExclVat: 877, zeroRatedSales: 600, exemptSales: 0 }],
  totals: { orders: 1, standardRatedInclVat: 1000, vatCharged: 123, standardRatedExclVat: 877, zeroRatedSales: 600, exemptSales: 0 },
  orders: [{ orderId: 'o1', orderNumber: 'SW-1', day: '2026-02-03', ratePercent: 14, standardRatedInclVat: 1000, vatCharged: 123, standardRatedExclVat: 877, zeroRatedSales: 600, exemptSales: 0 }],
  returnLines: [
    { line: 15, label: 'Zero-Rated Sales', amount: 600 }, { line: 16, label: 'Exempt Sales', amount: 0 },
    { line: 17, label: 'Standard Rated Sales excluding VAT', amount: 877 }, { line: 18, label: 'VAT charged on goods and services during this period', amount: 123 },
  ],
  sellers: [{ name: 'Sample Shop Ltd', vatNumber: '012345678', orders: 1 }],
  prepared: 'Prepared from your Swift orders. Your accountant files your VAT return; Swift does not file it for you.',
  notes: ['These figures cover only your sales through Swift.'],
};
const profile = (myRole: string) => ({ myRole, vendors: [{ id: 'store-1', name: 'Sample Shop' }] });

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('[O-5 PR4] the VAT report page', () => {
  it('the owner sees last month’s report: who files, the GRA sales lines, the days and the total', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER') as never);
    vi.spyOn(vatReport, 'lastGuyanaMonth').mockReturnValue('2026-02');
    const get = vi.spyOn(vatReport, 'getVatReport').mockResolvedValue(report);
    renderWithQuery(<VatReportPage />);
    expect(await screen.findByRole('note')).toHaveProperty('textContent', report.prepared);
    expect(get).toHaveBeenCalledWith('2026-02-01', '2026-02-28');
    const lines = screen.getByRole('table', { name: 'VAT return sales lines' });
    expect(within(lines).getByText('Standard Rated Sales excluding VAT')).toBeTruthy();
    expect(within(lines).getAllByRole('row')).toHaveLength(5);
    expect(screen.getByText('VAT charged by Sample Shop Ltd · VAT reg. no. 012345678 (1 orders)')).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'VAT by day' })).getByText('Total')).toBeTruthy();
  });

  it('another month asks for exactly that month’s Guyana days', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER') as never);
    vi.spyOn(vatReport, 'lastGuyanaMonth').mockReturnValue('2026-02');
    const get = vi.spyOn(vatReport, 'getVatReport').mockResolvedValue(report);
    renderWithQuery(<VatReportPage />);
    const month = await screen.findByLabelText('Month');
    fireEvent.change(month, { target: { value: '2026-03' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('2026-03-01', '2026-03-31'));
  });

  it('the download is the CSV of exactly the figures on screen', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER') as never);
    vi.spyOn(vatReport, 'lastGuyanaMonth').mockReturnValue('2026-02');
    vi.spyOn(vatReport, 'getVatReport').mockResolvedValue(report);
    let saved: Blob | null = null;
    const create = vi.fn((b: Blob) => { saved = b; return 'blob:vat'; });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderWithQuery(<VatReportPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Download CSV for your accountant' }));
    expect(click).toHaveBeenCalled();
    expect(await (saved as unknown as Blob).text()).toBe(vatReport.vatReportCsv(report));
  });

  it('a manager is told only the owner sees it, and nothing is asked of the server', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('MANAGER') as never);
    const get = vi.spyOn(vatReport, 'getVatReport').mockResolvedValue(report);
    renderWithQuery(<VatReportPage />);
    expect(await screen.findByText('Only the store’s owner sees its VAT report.')).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });

  it('a failed read says so (never an empty report)', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER') as never);
    vi.spyOn(vatReport, 'getVatReport').mockRejectedValue(new Error('The server could not build the report.'));
    renderWithQuery(<VatReportPage />);
    expect(await screen.findByText(/The server could not build the report\./)).toBeTruthy();
    expect(screen.queryByText('No supplied orders with VAT in this month.')).toBeNull();
  });
});
