import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ReturnsPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [U06] Deciding and settling a return are C4 (money): the first answer is a
// second admin's approval. A queued or refused answer used to show NOTHING,
// which invited a second press and a duplicate approval. Each answer is shown
// now, and once a row's ask is queued its buttons are locked.
// ---------------------------------------------------------------------------

const REASON = 'Item arrived damaged, photos match the complaint';
const requested = { id: 'ret_1', orderId: 'ord_1', status: 'REQUESTED', reason: 'DAMAGED', refundAmount: null, createdAt: '2026-10-18T10:00:00.000Z' };
const owed = { ...requested, id: 'ret_2', status: 'REFUND_DUE', refundAmount: 4500 };
const queued = (): ApiReply => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens.', details: { approvalId: 'apr_r1' } } } });

function server(rows: unknown[], write: (_r: ApiRequest) => ApiReply) {
  return mockApi((r: ApiRequest) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/returns') return { body: { success: true, data: rows } };
    if (r.method === 'PUT') return write(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

// [ADMIN-AUDIT S4-1] The status tabs now use the same words as the row's decision buttons ("Refund owed",
// "Rejected"): a row action is the button OUTSIDE the "Show returns" tab group.
const inRow = (buttons: HTMLElement[]) => buttons.filter((b) => !b.closest('[aria-label="Show returns"]'));
const rowButton = async (name: string) => {
  // The tabs render before the rows arrive: wait for the row's own button.
  await waitFor(() => expect(inRow(screen.getAllByRole('button', { name }))).not.toHaveLength(0));
  return inRow(screen.getAllByRole('button', { name }))[0]!;
};

describe('[U06] a return decision is shown, and a queued one cannot be asked twice', () => {
  it('"Refund owed" asks in the panel; once queued every decision on that return is locked', async () => {
    const fetchMock = server([requested], queued);
    const { user } = renderWithQuery(<ReturnsPage />);
    await user.click(await rowButton('Refund owed'));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('This does not move money');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Refund owed' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(new URL(String(url)).pathname).toBe('/api/v1/admin/returns/ret_1/resolve');
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'REFUND_DUE' });
    expect(new Headers(init?.headers).get('x-swift-reason')).toBe(REASON);

    expect((await screen.findAllByText(/second admin.s approval/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
    for (const name of ['Approved', 'Refund owed', 'Rejected']) {
      expect((inRow(screen.getAllByRole('button', { name }))[0] as HTMLButtonElement).disabled, name).toBe(true);
    }
    await user.click(inRow(screen.getAllByRole('button', { name: 'Rejected' }))[0]!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
  });

  it('a refusal is shown in the server\'s words, never swallowed', async () => {
    server([requested], () => ({ status: 409, body: { success: false, error: { code: 'ALREADY_RESOLVED', message: 'This return was already decided.' } } }));
    const { user } = renderWithQuery(<ReturnsPage />);
    await user.click(await rowButton('Rejected'));
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Reject' }));
    expect((await within(panel).findByRole('alert')).textContent).toContain('This return was already decided.');
  });

  it('recording the transfer types the amount actually sent (never pre-filled) and locks once queued', async () => {
    const fetchMock = server([owed], queued);
    const { user } = renderWithQuery(<ReturnsPage />);
    await user.click(await screen.findByRole('button', { name: 'Record the transfer' }));
    const panel = await screen.findByRole('dialog');
    const amount = within(panel).getByLabelText(/Amount you actually refunded/) as HTMLInputElement;
    expect(amount.value).toBe('');
    await user.type(within(panel).getByLabelText(/Transfer reference/), 'bank-77');
    await user.type(amount, '4500');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Record the transfer' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(new URL(String(url)).pathname).toBe('/api/v1/admin/returns/ret_2/refund-settled');
    expect(JSON.parse(String(init?.body))).toEqual({ reference: 'BANK-77', amount: 4500 });
    const waiting = await screen.findByRole('button', { name: 'Waiting for approval' }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
  });
});
