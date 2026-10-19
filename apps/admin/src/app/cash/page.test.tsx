import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CashPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';
import type { UnmatchedPayment } from '@/lib/cashRail';

// ---------------------------------------------------------------------------
// The cash rail (UI sweep, 19 Oct).
// [U08] Attach / Flag for refund are C4: the first answer is a second admin's
//       approval. After the amber "queued" line both buttons worked again, and
//       every press filed another approval for the same payment.
// [U27] The Collections tab printed "Nobody in this list." for a failed read.
// [U64] Unmatched and Settlement batches printed raw error text, no Retry.
// ---------------------------------------------------------------------------

const ROW: UnmatchedPayment = {
  id: 'unm_1', channel: 'MMG_AGENT_WEBHOOK', sanRaw: '5920001234', amount: 4500, currencyCode: 'GYD',
  paidAt: '2026-10-18T14:00:00.000Z', createdAt: '2026-10-18T14:00:05.000Z', mmgTxnId: 'MMG-TX-1', agentRef: 'AG-7',
  payerMsisdn: null, failureCode: 'SAN_UNKNOWN', diagnosis: 'A valid SAN nobody holds.', hoursOld: 3, breachesSla: false,
};
const REASON = 'Matched by amount, phone and time to this partner';
const fail = (): ApiReply => ({ status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } } });
const queued = (): ApiReply => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens.', details: { approvalId: 'apr_1' } } } });

function server(over: (_r: ApiRequest) => ApiReply | undefined = () => undefined) {
  return mockApi((r: ApiRequest) => {
    const answered = over(r);
    if (answered) return answered;
    if (r.url.pathname === '/api/v1/admin/billing/cash-kpis') return fail();
    if (r.url.pathname === '/api/v1/admin/billing/agent-payments/unmatched') return { body: { success: true, data: [ROW] } };
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

describe('[U08] an unmatched payment cannot be asked about twice', () => {
  it('Attach asks in the panel; once queued the whole card is locked, and nothing is filed again', async () => {
    const fetchMock = server((r) => (r.method === 'POST' && r.url.pathname === '/api/v1/admin/billing/agent-payments/unm_1/attach' ? queued() : undefined));
    const { user } = renderWithQuery(<CashPage />);
    await user.type(await screen.findByRole('textbox', { name: 'Subscription id to credit' }), 'sub_42');
    await user.click(screen.getByRole('button', { name: 'Attach' }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toMatch(/Attach .* to subscription sub_42\?/);
    await user.type(within(panel).getByRole('textbox', { name: 'Why this subscription' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Attach payment' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetchMock, 'POST')[0]![1]?.body))).toEqual({ subscriptionId: 'sub_42', reason: REASON });
    expect((await screen.findAllByText(/waiting for a second admin.s approval/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
    const attach = screen.getByRole('button', { name: 'Attach' }) as HTMLButtonElement;
    const flag = screen.getByRole('button', { name: 'Flag for refund' }) as HTMLButtonElement;
    expect([attach.disabled, flag.disabled]).toEqual([true, true]);
    expect((screen.getByRole('textbox', { name: 'Subscription id to credit' }) as HTMLInputElement).disabled).toBe(true);
    await user.click(attach);
    await user.click(flag);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1);
  });

  it('Flag for refund queued the same way locks the card', async () => {
    const fetchMock = server((r) => (r.method === 'POST' && r.url.pathname === '/api/v1/admin/billing/agent-payments/unm_1/refund-flag' ? queued() : undefined));
    const { user } = renderWithQuery(<CashPage />);
    await user.click(await screen.findByRole('button', { name: 'Flag for refund' }));
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByRole('textbox', { name: 'Why it goes back' }), 'Paid to a SAN that belongs to nobody we can find');
    await user.click(within(panel).getByRole('button', { name: 'Flag for refund' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    expect(await screen.findByText(/Refund-flagging this payment is waiting/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Flag for refund' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('[U27 · U64] a failed read says it failed, with a retry — never an empty list', () => {
  it('[U64] the unmatched queue', async () => {
    server((r) => (r.url.pathname === '/api/v1/admin/billing/agent-payments/unmatched' ? fail() : undefined));
    renderWithQuery(<CashPage />);
    expect(await screen.findByText(/Couldn.t load the unmatched payments/)).toBeTruthy();
    expect(screen.queryByText(/Every payment reached an account/)).toBeNull();
    expect(screen.getAllByRole('button', { name: /retry/i }).length).toBeGreaterThan(0);
  });

  it('[U27] the Collections tab', async () => {
    server((r) => (r.url.pathname === '/api/v1/admin/billing/collections' ? fail() : undefined));
    const { user } = renderWithQuery(<CashPage />);
    await user.click(await screen.findByRole('button', { name: 'Collections' }));
    expect(await screen.findByText(/Couldn.t load this collections list/)).toBeTruthy();
    expect(screen.queryByText('Nobody in this list.')).toBeNull();
  });

  it('[U27] an empty Collections answer still says so', async () => {
    server((r) => (r.url.pathname === '/api/v1/admin/billing/collections' ? { body: { success: true, data: [] } } : undefined));
    const { user } = renderWithQuery(<CashPage />);
    await user.click(await screen.findByRole('button', { name: 'Collections' }));
    expect(await screen.findByText('Nobody in this list.')).toBeTruthy();
  });

  it('[U64] the settlement batches', async () => {
    server((r) => (r.url.pathname === '/api/v1/admin/billing/settlement-batches' ? fail() : undefined));
    const { user } = renderWithQuery(<CashPage />);
    await user.click(await screen.findByRole('button', { name: 'Settlement batches' }));
    expect(await screen.findByText(/Couldn.t load the settlement batches/)).toBeTruthy();
  });
});
