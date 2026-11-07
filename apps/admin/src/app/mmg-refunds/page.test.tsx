import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MmgRefundsPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// [BUG-HUNT-2 G08] The refund list: what is owed, how late, and support's two decisions, each with a reason. Nothing here says a
// refund happened unless a person said so, and Swift moves no money.

const REASON = 'Checked the store MMG statement line with the store on the phone';
const owed = { id: 'obl_1', orderId: 'ord_1', orderNumber: 'SW-1', storeName: 'Corner Shop', status: 'OWED', amount: '1300.00', currencyCode: 'GYD', dueAt: '2026-10-07T10:00:00.000Z', overdue: true, missedAt: null, send: null };
const disputed = { ...owed, id: 'obl_2', orderId: 'ord_2', orderNumber: 'SW-2', status: 'DISPUTED', overdue: false, send: { id: 'snd_2', mmgRefundRef: 'REF-22', sentAt: '2026-10-06T10:00:00.000Z', answer: 'NOT_RECEIVED' } };
const queued = (): ApiReply => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this.', details: { approvalId: 'apr_1' } } } });

function server(rows: unknown[], write: (_r: ApiRequest) => ApiReply = () => ({ body: { success: true, data: {} } })) {
  return mockApi((r: ApiRequest) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/mmg-refunds') return { body: { success: true, data: rows.filter((row) => r.url.searchParams.get('filter') !== 'disputed' || (row as { status: string }).status === 'DISPUTED') } };
    if (r.method === 'POST') return write(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

describe('[G08] MMG refunds', () => {
  it('lists what stores owe, late or not, and links the order', async () => {
    server([owed, disputed]);
    renderWithQuery(<MmgRefundsPage />);
    expect(await screen.findByText('Owed by the store')).toBeTruthy();
    expect(screen.getByText('OVERDUE')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'SW-1 →' }).getAttribute('href')).toBe('/orders/ord_1');
    expect(screen.getByText(/Customer says it did not arrive\. MMG reference REF-22/)).toBeTruthy();
  });

  it('only a disputed refund offers a finding', async () => {
    server([owed]);
    renderWithQuery(<MmgRefundsPage />);
    await screen.findByText('Owed by the store');
    expect(screen.queryByRole('button', { name: 'It arrived' })).toBeNull();
  });

  it('a finding asks what was checked and why, then says what happened', async () => {
    const fetchMock = server([disputed]);
    const { user } = renderWithQuery(<MmgRefundsPage />);
    await user.click(await screen.findByRole('button', { name: 'It did not arrive' }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('that MMG reference cannot be used again');
    expect(panel.textContent).toContain('Swift moves no money');
    await user.type(within(panel).getByRole('textbox', { name: 'What you checked' }), 'The statement');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'It did not arrive' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(new URL(String(url)).pathname).toBe('/api/v1/admin/mmg-refunds/sends/snd_2/resolve');
    expect(JSON.parse(String(init?.body))).toEqual({ received: false, note: 'The statement' });
    expect(new Headers(init?.headers).get('x-swift-reason')).toBe(REASON);
    expect(await screen.findByText('Refund owed again.')).toBeTruthy();
  });

  it('closing a record is a two-person ask: once queued, it cannot be asked twice', async () => {
    const fetchMock = server([owed], queued);
    const { user } = renderWithQuery(<MmgRefundsPage />);
    await user.click(await screen.findByRole('button', { name: 'Close the record' }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('a second admin must agree');
    await user.type(within(panel).getByRole('textbox', { name: 'Why nothing is owed' }), 'Settled in cash');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Close the record' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    expect(new URL(String(requestsByMethod(fetchMock, 'POST')[0]![0])).pathname).toBe('/api/v1/admin/mmg-refunds/obl_1/void');
    expect(await screen.findByRole('button', { name: 'Waiting for approval' })).toHaveProperty('disabled', true);
  });

  it('the tabs ask the server, and an empty tab says so', async () => {
    server([owed]);
    const { user } = renderWithQuery(<MmgRefundsPage />);
    await screen.findByText('Owed by the store');
    await user.click(screen.getByRole('button', { name: 'Disputed' }));
    expect(await screen.findByText('No MMG refunds here.')).toBeTruthy();
  });
});
