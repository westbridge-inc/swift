import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InPersonPayments } from '@/components/finance/InPersonPayments';
import { receiptPrintDocument } from '@/lib/print-receipt';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// [OWNER 5 Nov 2026] Finance reads fees paid in person apart from MMG, and can show the receipt to print it.
afterEach(() => vi.restoreAllMocks());

describe('Weekly fees paid in person', () => {
  const rows = [{ receiptNumber: 'SWF-SWIFT-2026-000042', method: 'CHEQUE', amount: 5000, reference: 'GBTI-004512', issuedAt: '2026-11-05T15:00:00.000Z', san: 'SAN-1', type: 'RESTAURANT' }];
  const api = (data: unknown) => (request: ApiRequest) => {
    if (request.url.pathname === '/api/v1/admin/finance/in-person-payments') return { body: { success: true, data } };
    if (request.url.pathname === '/api/v1/admin/finance/in-person-payments/SWF-SWIFT-2026-000042') return { body: { success: true, data: { receiptNumber: 'SWF-SWIFT-2026-000042', lines: ['Westbridge Inc. (trading as Swift)', 'Paid directly to Westbridge Inc. by cheque (cleared). Reference: GBTI-004512'] } } };
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  it('shows the method, the reference, the totals and the cash, and opens the receipt', async () => {
    mockApi(api({ windowDays: 30, totals: [{ method: 'CHEQUE', count: 1, totalGyd: 5000 }], cashOnHandGyd: 2500, rows }));
    const { user } = renderWithQuery(<InPersonPayments />);
    expect(await screen.findByText('GBTI-004512')).toBeTruthy();
    expect(screen.getAllByText(/Cheque/).length).toBeGreaterThan(0);
    expect(screen.getByText('$2,500')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'SWF-SWIFT-2026-000042' }));
    expect(await screen.findByText(/Paid directly to Westbridge Inc\. by cheque/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Print this receipt' })).toBeTruthy();
  });

  it('Print sends that receipt alone to paper: the page itself is never printed', async () => {
    const page = vi.fn();
    Object.defineProperty(window, 'print', { value: page, configurable: true });
    mockApi(api({ windowDays: 30, totals: [{ method: 'CHEQUE', count: 1, totalGyd: 5000 }], cashOnHandGyd: 2500, rows }));
    const { user } = renderWithQuery(<InPersonPayments />);
    await user.click(await screen.findByRole('button', { name: 'SWF-SWIFT-2026-000042' }));
    await user.click(await screen.findByRole('button', { name: 'Print this receipt' }));
    expect(page).not.toHaveBeenCalled();
    const frame = document.querySelector('iframe')!;
    expect(frame.srcdoc).toContain('Paid directly to Westbridge Inc. by cheque (cleared)');
    expect(frame.srcdoc).not.toContain('2,500');
    expect(frame.srcdoc).not.toContain('SAN-1');
    frame.remove();
  });

  it('the printed document is only its lines, escaped', () => {
    const html = receiptPrintDocument(['A <b>& "B"']);
    expect(html).toContain('A &#60;b&#62;&#38; &#34;B&#34;');
    expect(html).not.toContain('<b>');
    expect(html).not.toMatch(/<script|<link|<img/);
  });

  it('says so when there are none', async () => {
    mockApi(api({ windowDays: 30, totals: [], cashOnHandGyd: 0, rows: [] }));
    renderWithQuery(<InPersonPayments />);
    expect(await screen.findByText('No fees paid in person yet.')).toBeTruthy();
  });
});
