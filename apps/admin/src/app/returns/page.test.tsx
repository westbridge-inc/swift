import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReturnsPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · MONEY] Retail returns: deciding and settling are each one
// in-page panel, and the server's answer is on screen. The old page asked
// through three browser boxes per action and showed nothing when the server
// refused — the operator could not tell a recorded refund from a refused one.
// ---------------------------------------------------------------------------

const requested = { id: 'ret-1', orderId: 'order-1', status: 'REQUESTED', reason: 'Wrong size', createdAt: '2026-10-01T10:00:00.000Z' };
const due = { ...requested, id: 'ret-2', status: 'REFUND_DUE', refundAmount: 4500 };
const REASON = 'Customer returned the item unused within the window';

function server(rows: Record<string, unknown[]>, write: (_r: ApiRequest) => ApiReply) {
  return mockApi((r: ApiRequest) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/returns') {
      return { body: { success: true, data: rows[r.url.searchParams.get('status') ?? ''] ?? [] } };
    }
    return write(r);
  });
}

beforeEach(() => {
  vi.stubGlobal('prompt', vi.fn(() => { throw new Error('window.prompt was called'); }));
  vi.stubGlobal('confirm', vi.fn(() => { throw new Error('window.confirm was called'); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('[MC-MONEY] a return decision', () => {
  it('"Refund owed" says no money moves, takes an optional note and the reason, and says what happened', async () => {
    const fetchMock = server({ REQUESTED: [requested] }, () => ({ body: { success: true, data: {} } }));
    const { user } = renderWithQuery(<ReturnsPage />);
    await user.click(await screen.findByRole('button', { name: 'Refund owed…' }));
    const dialog = screen.getByRole('dialog', { name: 'Record that a refund is owed on this return?' });
    expect(dialog.textContent).toContain('This does not move money');
    await user.type(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), 'Store agreed by phone');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Record refund owed' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toContain('/api/v1/admin/returns/ret-1/resolve');
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'REFUND_DUE', note: 'Store agreed by phone' });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
    expect((await screen.findByRole('status')).textContent).toContain('A refund is recorded as owed.');
  });

  it('a refusal is shown in the panel — the old page showed nothing', async () => {
    server({ REQUESTED: [requested] }, () => ({ status: 409, body: { success: false, error: { code: 'RETURN_ALREADY_DECIDED', message: 'This return was already decided.' } } }));
    const { user } = renderWithQuery(<ReturnsPage />);
    await user.click(await screen.findByRole('button', { name: 'Rejected…' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject this return?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Reject return' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('This return was already decided.');
  });
});

describe('[MC-MONEY · A-13] settling a refund needs the transfer that paid it', () => {
  it('reference and amount are fields of the one panel; nothing is sent until both are there; a 202 says it went to a second admin', async () => {
    const fetchMock = server({ REQUESTED: [], REFUND_DUE: [due] }, () => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this.', details: { approvalId: 'apr_7' } } } }));
    const { user } = renderWithQuery(<ReturnsPage />);
    await user.click(await screen.findByRole('button', { name: 'refund_due' }));
    await user.click(await screen.findByRole('button', { name: 'Record the transfer…' }));
    const dialog = screen.getByRole('dialog', { name: 'Record the refund transfer for this return?' });
    expect(dialog.textContent).toContain('owed: $4,500');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Record transfer' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
    await user.type(within(dialog).getByRole('textbox', { name: 'Transfer reference' }), 'mmg-77812');
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount refunded' }), '4500');
    await user.click(within(dialog).getByRole('button', { name: 'Record transfer' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toContain('/api/v1/admin/returns/ret-2/refund-settled');
    expect(JSON.parse(String(init?.body))).toEqual({ reference: 'MMG-77812', amount: 4500 });
    expect((await screen.findByRole('status')).textContent).toContain("Sent for a second admin's approval");
  });
});
