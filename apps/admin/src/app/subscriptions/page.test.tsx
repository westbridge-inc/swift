import { screen, waitFor, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SubscriptionsPage from './page';
import { describeAction } from '@/lib/approvals';
import { API_ORIGIN, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

type User = ReturnType<typeof userEvent.setup>;

/**
 * [U06] Every money action here asks in the in-page panel, never a browser
 * prompt: open it with the row's button, type into its labelled fields, then
 * confirm with the panel's own button.
 */
async function answerPanel(user: User, opener: string, answers: { fields?: Record<string, string>; choose?: string; reason?: string }) {
  await user.click(screen.getAllByRole('button', { name: opener })[0]!);
  const panel = await screen.findByRole('dialog');
  for (const [label, value] of Object.entries(answers.fields ?? {})) await user.type(within(panel).getByLabelText(label), value);
  if (answers.choose) await user.click(within(panel).getByLabelText(answers.choose));
  if (answers.reason !== undefined) {
    const box = within(panel).getByRole('textbox', { name: /reason|why/i });
    await user.clear(box);
    if (answers.reason) await user.type(box, answers.reason);
  }
  return panel;
}
const confirmPanel = async (user: User, panel: HTMLElement, label: string) => user.click(within(panel).getByRole('button', { name: label }));
const REASON_TYPED = 'Amount and reference match the deposit slip';

// ---------------------------------------------------------------------------
// [M-08] The console's top-up carries an Idempotency-Key the ATTEMPT owns.
//
// The server refuses a top-up without a key (a retry after a lost response
// used to be able to credit twice). The route's comment claimed "the admin
// console sends one per top-up action" — it never did. These pin that the
// key is sent, that a retry of the SAME attempt reuses it (so the server
// replays instead of crediting again), and that the next attempt is new.
// ---------------------------------------------------------------------------

const subscription = {
  id: 'sub-1', status: 'ACTIVE', type: 'RESTAURANT', weeklyRate: 2100, feeWaived: false,
  nextBillingDate: '2026-09-09T00:00:00.000Z', vendor: { id: 'v1', name: 'Shanta Kitchen' },
};

function handler(onTopUp: (_r: ApiRequest, _n: number) => { body: unknown; status?: number }) {
  let n = 0;
  return (request: ApiRequest) => {
    if (request.url.pathname === '/api/v1/admin/subscriptions') return { body: { success: true, data: [subscription] } };
    if (request.method === 'POST' && request.url.pathname === '/api/v1/admin/subscriptions/sub-1/topup') { n += 1; return onTopUp(request, n); }
    if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/subscriptions/sub-1/waive-fee') {
      return { body: { success: true, data: {} } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}
const keyOf = (init: RequestInit | undefined) => (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'];

afterEach(() => vi.unstubAllGlobals());

// [OWNER RULING 8 Oct, NO "WALLET"] The console never says "top up": the button that
// records a weekly-fee payment that arrived by cash or bank is "Record fee payment".
describe('the recorded fee payment key belongs to the attempt', () => {
  it('sends an Idempotency-Key, reuses it when the same attempt is retried after an error, and mints a new one for the next attempt', async () => {
    // [A-12] A top-up names the transfer it is evidence of, and the panel names
    // the target before it credits anything.
    const fetchMock = mockApi(handler((_r, n) => (n === 1
      ? { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'lost' } } }
      : { body: { success: true, replayed: false, data: { balance: 5000, currencyCode: 'GYD' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();

    const answers = { fields: { 'Amount received (GYD)': '5000', 'Bank or MMG reference of the transfer': 'BANK-9001' }, reason: REASON_TYPED };
    const panel = await answerPanel(user, 'Record fee payment', answers);
    expect(panel.textContent).toContain('Shanta Kitchen');
    await confirmPanel(user, panel, 'Record payment');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const first = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(first[0]).toBe(`${API_ORIGIN}/api/v1/admin/subscriptions/sub-1/topup`);
    expect(JSON.parse(String(first[1]?.body))).toEqual({ amount: 5000, reference: 'BANK-9001' });
    const key = keyOf(first[1]);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);

    // The same attempt again (the admin retries from the panel, which kept what they typed): the same key.
    expect(await within(panel).findByRole('alert')).toBeTruthy();
    await confirmPanel(user, panel, 'Record payment');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(2));
    expect(keyOf(requestsByMethod(fetchMock, 'POST')[1]![1])).toBe(key);
    expect(await screen.findByText('Payment recorded for Shanta Kitchen.')).toBeTruthy();

    // Answered — the next top-up is a new attempt with a new key.
    const again = await answerPanel(user, 'Record fee payment', answers);
    await confirmPanel(user, again, 'Record payment');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(3));
    const third = keyOf(requestsByMethod(fetchMock, 'POST')[2]![1]);
    expect(third).toMatch(/^[0-9a-f-]{36}$/);
    expect(third).not.toBe(key);
  });
});


// ---------------------------------------------------------------------------
// [A-12] The server requires evidence. A console that satisfies that with a
// constant defeats it entirely — which is exactly what the waiver did, sending
// the literal 'Waived by admin' as the "reason" on every call.
// ---------------------------------------------------------------------------
describe('[REVIEW-F2 S4-4] a queued fee payment cannot be recorded twice', () => {
  it('202: says it waits for a second admin and locks Record fee payment on that row', async () => {
    const fetchMock = mockApi(handler(() => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens.', details: { approvalId: 'apr_f1' } } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await answerPanel(user, 'Record fee payment', { fields: { 'Amount received (GYD)': '5000', 'Bank or MMG reference of the transfer': 'BANK-9101' }, reason: REASON_TYPED });
    await confirmPanel(user, panel, 'Record payment');
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain("Sent for a second admin's approval");
    const locked = screen.getByRole('button', { name: 'Payment waiting for approval' }) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Record fee payment' })).toBeNull();
    await user.click(locked);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1);
  });
});

describe('[A-12] the console cannot satisfy the evidence requirement by itself', () => {
  it('a missing reference credits nothing', async () => {
    const fetchMock = mockApi(handler(() => ({ body: { success: true, replayed: false, data: { balance: 0, currencyCode: 'GYD' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await answerPanel(user, 'Record fee payment', { fields: { 'Amount received (GYD)': '5000' }, reason: REASON_TYPED });
    await confirmPanel(user, panel, 'Record payment');
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
  });

  it('closing the panel credits nothing', async () => {
    const fetchMock = mockApi(handler(() => ({ body: { success: true, replayed: false, data: { balance: 0, currencyCode: 'GYD' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await answerPanel(user, 'Record fee payment', { fields: { 'Amount received (GYD)': '5000', 'Bank or MMG reference of the transfer': 'BANK-9002' }, reason: REASON_TYPED });
    await confirmPanel(user, panel, 'Cancel');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
  });

  it('a fractional amount is not a top-up', async () => {
    const fetchMock = mockApi(handler(() => ({ body: { success: true, replayed: false, data: { balance: 0, currencyCode: 'GYD' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await answerPanel(user, 'Record fee payment', { fields: { 'Amount received (GYD)': '5000.5', 'Bank or MMG reference of the transfer': 'BANK-9003' }, reason: REASON_TYPED });
    await confirmPanel(user, panel, 'Record payment');
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
  });
});

describe('[A-12] a waived fee carries the operator’s own words', () => {
  it('sends what the operator typed — never the constant the console used to hard-code', async () => {
    const reason = 'Outage on 2 Sep - vendor could not trade for three days';
    const fetchMock = mockApi(handler(() => ({ body: { success: true, replayed: false, data: { balance: 0, currencyCode: 'GYD' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();

    const panel = await answerPanel(user, 'Waive fee', { reason });
    await confirmPanel(user, panel, 'Waive fee');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/subscriptions/sub-1/waive-fee`);
    expect(JSON.parse(String(init?.body))).toEqual({ reason });
    expect(JSON.parse(String(init?.body)).reason).not.toBe('Waived by admin');
  });

  it('an abandoned, empty or one-word reason waives nothing', async () => {
    for (const answer of [null, '', 'ok']) {
      const fetchMock = mockApi(handler(() => ({ body: { success: true, replayed: false, data: { balance: 0, currencyCode: 'GYD' } } })));
      const { user, unmount } = renderWithQuery(<SubscriptionsPage />);
      expect(await screen.findAllByText('Shanta Kitchen')).toBeTruthy();
      const panel = await answerPanel(user, 'Waive fee', answer === null ? {} : { reason: answer });
      await confirmPanel(user, panel, answer === null ? 'Cancel' : 'Waive fee');
      expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// [U06] A waiver is C4: its first answer is a second admin's approval. That
// used to show nothing, so the operator pressed again and filed a second
// approval; a refusal was swallowed. Every answer is now shown, and once the
// waiver is queued its button is locked.
// ---------------------------------------------------------------------------
describe('[U06] a queued or refused waiver is shown, and a queued one cannot be asked twice', () => {
  const reason = 'Outage on 2 Sep - vendor could not trade for three days';
  const serve = (reply: { status?: number; body: unknown }) => mockApi((request: ApiRequest) => {
    if (request.url.pathname === '/api/v1/admin/subscriptions') return { body: { success: true, data: [subscription] } };
    if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/subscriptions/sub-1/waive-fee') return reply;
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });

  it('202: says it waits for a second admin and locks the button', async () => {
    const fetchMock = serve({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens.', details: { approvalId: 'apr_w1' } } } });
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await answerPanel(user, 'Waive fee', { reason });
    await confirmPanel(user, panel, 'Waive fee');
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain("Sent for a second admin's approval");
    expect(status.textContent).toContain('apr_w1');
    expect(screen.queryByText(/failed|try again/i)).toBeNull();
    const locked = screen.getByRole('button', { name: 'Waiver waiting for approval' }) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    await user.click(locked);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
  });

  it('409 APPROVAL_ALREADY_OPEN (asked before a reload): shown as already waiting, never as a failure, and locked', async () => {
    serve({ status: 409, body: { success: false, error: { code: 'APPROVAL_ALREADY_OPEN', message: 'This is already waiting for a second admin in Approvals.', details: { approvalId: 'apr_w0', approvalStatus: 'PENDING' } } } });
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await answerPanel(user, 'Waive fee', { reason });
    await confirmPanel(user, panel, 'Waive fee');
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain("Already waiting for a second admin's approval");
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Waiver waiting for approval' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a refusal is shown in the server words and keeps the reason typed', async () => {
    serve({ status: 409, body: { success: false, error: { code: 'ALREADY_WAIVED', message: 'This period is already waived for this account.' } } });
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await answerPanel(user, 'Waive fee', { reason });
    await confirmPanel(user, panel, 'Waive fee');
    expect((await within(panel).findByRole('alert')).textContent).toContain('This period is already waived');
    expect((within(panel).getByRole('textbox', { name: /why/i }) as HTMLTextAreaElement).value).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// [Owner ruling 2026-10-07 · Sol S1/S2 on #1527] The refund runs in order: set
// the credit aside (a second admin approves), pay it outside Swift, then record
// the payout. The console never tells anyone to pay before the credit is set
// aside, and every answer is shown: a 202 queued for a second admin (with its
// approval id), a refusal in the server's words, or done.
// ---------------------------------------------------------------------------
describe('fee credit refund: set aside, pay, record, and every answer is shown', () => {
  const withCredit = { ...subscription, prepaidBalance: { balance: 5000, currencyCode: 'GYD' }, refundSetAside: 0 };
  const setAsideRow = { ...subscription, prepaidBalance: { balance: 0, currencyCode: 'GYD' }, refundSetAside: 5000, refundSetAsideId: 'evt-aside-1' };
  const REASON = 'Partner asked to close their account and get the credit back';
  function refundServer(row: unknown, reply: (_r: ApiRequest) => { status?: number; body: unknown }) {
    return mockApi((request: ApiRequest) => {
      if (request.url.pathname === '/api/v1/admin/subscriptions') return { body: { success: true, data: [row] } };
      if (request.method === 'POST' && request.url.pathname.startsWith('/api/v1/admin/subscriptions/sub-1/refund-credit/')) return reply(request);
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
  }
  const queued = { status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens. It is in the approvals queue.', details: { approvalId: 'apr_9' } } } };

  it('asking for a refund sets the credit aside first, says not to pay yet, and shows the approval it is waiting on', async () => {
    const fetchMock = refundServer(withCredit, () => queued);
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await answerPanel(user, 'Refund credit', { reason: REASON });
    expect(panel.textContent).toContain('Do not pay anything yet');
    await confirmPanel(user, panel, 'Set aside for refund');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/subscriptions/sub-1/refund-credit/set-aside`);
    expect(JSON.parse(String(init?.body))).toEqual({ amount: 5000 });
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Queued for a second admin');
    expect(status.textContent).toContain('Do not pay anything yet');
    expect(status.textContent).toContain('apr_9');
    expect(screen.getByRole('link', { name: 'Open the approvals queue' }).getAttribute('href')).toBe('/approvals');
  });

  it('a refusal is shown in the server words', async () => {
    refundServer(withCredit, () => ({ status: 409, body: { success: false, error: { code: 'FEE_CREDIT_CHANGED', message: 'The unused credit is now 3000 GYD. Nothing was set aside: ask again for exactly that amount.' } } }));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await confirmPanel(user, await answerPanel(user, 'Refund credit', { reason: REASON }), 'Set aside for refund');
    expect((await screen.findByRole('alert')).textContent).toContain('The unused credit is now 3000 GYD. Nothing was set aside');
  });

  it('a set-aside row says to pay it, then records the payout with its method and reference, and shows the answer', async () => {
    const fetchMock = refundServer(setAsideRow, () => ({ body: { success: true, replayed: false, data: { amount: 5000, currencyCode: 'GYD', balance: 0, refundSetAside: 0 } } }));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    expect(screen.getByText(/set aside: pay it outside Swift, then record the payout/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refund credit' })).toBeNull();
    await confirmPanel(user, await answerPanel(user, 'Record payout', { choose: 'MMG', fields: { 'Reference of the refund you paid': 'REFUND9001' }, reason: REASON }), 'Record payout');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/subscriptions/sub-1/refund-credit/paid`);
    // [Sol r2 S1] the payout record names the set-aside it pays
    expect(JSON.parse(String(init?.body))).toEqual({ amount: 5000, method: 'MMG', reference: 'REFUND9001', setAsideId: 'evt-aside-1' });
    expect((await screen.findByRole('status')).textContent).toContain('Payout recorded');
  });

  it('a replay of an earlier payout does not say a new set-aside is complete', async () => {
    refundServer(setAsideRow, () => ({ body: { success: true, replayed: true, data: { amount: 5000, currencyCode: 'GYD', balance: 0, refundSetAside: 5000 } } }));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    await screen.findByText('Shanta Kitchen');
    await confirmPanel(user, await answerPanel(user, 'Record payout', { choose: 'MMG', fields: { 'Reference of the refund you paid': 'EARLIER9001' }, reason: REASON }), 'Record payout');
    const message = (await screen.findByRole('status')).textContent;
    expect(message).toContain('earlier payout');
    expect(message).toContain('still set aside');
    expect(message).not.toContain('refund is complete');
  });

  it('a queued payout record says payment was reported and prevents another payment or release', async () => {
    refundServer(setAsideRow, () => queued);
    const { user } = renderWithQuery(<SubscriptionsPage />);
    await screen.findByText('Shanta Kitchen');
    await confirmPanel(user, await answerPanel(user, 'Record payout', { choose: 'MMG', fields: { 'Reference of the refund you paid': 'SENT9001' }, reason: REASON }), 'Record payout');
    const message = (await screen.findByRole('status')).textContent;
    expect(message).toContain('Payment reported');
    expect(message).not.toContain('Nothing has moved');
    expect(screen.queryByText(/set aside: pay it outside Swift/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Record payout' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('[DS1122 S3] the server says a payout was reported: after a reload neither payout nor release is offered', async () => {
    refundServer({ ...setAsideRow, refundPayoutReported: true }, () => queued);
    renderWithQuery(<SubscriptionsPage />);
    await screen.findByText('Shanta Kitchen');
    expect(screen.getByText(/Payment reported; recording awaits approval/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Record payout' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('[DS1122 S3] a payout reported for one set-aside never blocks the next set-aside on the same account', async () => {
    let row: unknown = setAsideRow;
    mockApi((request: ApiRequest) => {
      if (request.url.pathname === '/api/v1/admin/subscriptions') return { body: { success: true, data: [row] } };
      if (request.method === 'POST' && request.url.pathname.startsWith('/api/v1/admin/subscriptions/sub-1/refund-credit/')) return queued;
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user, queryClient } = renderWithQuery(<SubscriptionsPage />);
    await screen.findByText('Shanta Kitchen');
    await confirmPanel(user, await answerPanel(user, 'Record payout', { choose: 'MMG', fields: { 'Reference of the refund you paid': 'SENT9002' }, reason: REASON }), 'Record payout');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement).disabled).toBe(true));
    // That payout is recorded; credit is later set aside again (a new set-aside).
    row = { ...setAsideRow, refundSetAsideId: 'evt-aside-2' };
    await queryClient.invalidateQueries();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole('button', { name: 'Record payout' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/set aside: pay it outside Swift/)).toBeTruthy();
  });

  it('[review S2-1] after a refused, expired or failed payout record, Record payout is offered again and Release is not', async () => {
    refundServer({ ...setAsideRow, refundPayoutReported: false, refundPayoutAsk: 'NOT_COMPLETED' }, () => queued);
    renderWithQuery(<SubscriptionsPage />);
    await screen.findByText('Shanta Kitchen');
    expect(screen.getByText(/last payout record was not completed/)).toBeTruthy();
    expect(screen.queryByText(/recording awaits approval/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Record payout' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a payout refusal (a bad reference) is shown, not swallowed', async () => {
    refundServer(setAsideRow, () => ({ status: 400, body: { success: false, error: { code: 'REFUND_REFERENCE_INVALID', message: 'That does not look like a transfer reference. Copy it from the MMG or bank record.' } } }));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await confirmPanel(user, await answerPanel(user, 'Record payout', { choose: 'Bank transfer', fields: { 'Reference of the refund you paid': 'X1Y2' }, reason: REASON }), 'Record payout');
    expect((await screen.findByRole('alert')).textContent).toContain('That does not look like a transfer reference');
  });

  it('a set-aside that could not be paid is released with the whole amount', async () => {
    const fetchMock = refundServer(setAsideRow, () => queued);
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await confirmPanel(user, await answerPanel(user, 'Release', { reason: REASON }), 'Return to credit');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/subscriptions/sub-1/refund-credit/release`);
    expect(JSON.parse(String(init?.body))).toEqual({ amount: 5000, setAsideId: 'evt-aside-1' });
    expect((await screen.findByRole('status')).textContent).toContain('apr_9');
  });
});

// ---------------------------------------------------------------------------
// [OWNER 8 Oct (4)] Production holds the top-up and agent routes (BILLING_TOPUP_HOLD).
// The server says when the hold is on, and the console then offers no "Record fee payment"
// button. When it is offered and the server refuses (the hold, or more than four weeks ahead,
// owner 6 Nov 2026). its words show. [OWNER 5 Nov 2026] Money paid in person has its own button.
// ---------------------------------------------------------------------------
describe('[owner 8 Oct] recording a fee payment by hand', () => {
  it('is not offered while the server says the hold is on', async () => {
    mockApi((request: ApiRequest) => {
      if (request.url.pathname === '/api/v1/admin/subscriptions') return { body: { success: true, data: [subscription], manualFeeRecording: 'held' } };
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record fee payment' })).toBeNull();
    expect(screen.getByText(/The agent route and the old Record fee payment button are on hold/)).toBeTruthy();
  });

  it('shows the server’s words when it refuses one', async () => {
    const refusal = 'This would pay more than four weeks ahead on this account. Record at most GY$8,400 now and refund the rest to the partner (finance procedure: weekly fee refunds).';
    mockApi(handler(() => ({ status: 409, body: { success: false, error: { code: 'PAY_AHEAD_LIMIT', message: refusal } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await answerPanel(user, 'Record fee payment', { fields: { 'Amount received (GYD)': '9000', 'Bank or MMG reference of the transfer': 'BANK-9100' }, reason: REASON_TYPED });
    await confirmPanel(user, panel, 'Record payment');
    expect((await within(panel).findByRole('alert')).textContent).toContain('Record at most GY$8,400');
  });
});

// ---------------------------------------------------------------------------
// [OWNER 5 Nov 2026] Anyone may pay the weekly fee directly to Westbridge Inc. in person. Under the hold the button
// stays, for the role the server names. Each way of paying asks for what makes it count.
// ---------------------------------------------------------------------------
describe('[owner 5 Nov] recording a fee paid in person', () => {
  it('the approver reads what it is, not a route', () => {
    expect(describeAction('POST /subscriptions/:id/in-person-payment')).toBe('Record a weekly fee paid in person');
  });

  const OPEN_DOOR = { open: true, refused: null, mostGyd: 10_000, leastGyd: 5000 };
  const server = (posts: ApiRequest[], reply: { body: unknown; status?: number } = { status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens.', details: { approvalId: 'apr_7' } } } }, offered = true, door: unknown = OPEN_DOOR) => (request: ApiRequest) => {
    if (request.url.pathname === '/api/v1/admin/subscriptions') return { body: { success: true, data: [subscription], manualFeeRecording: 'held', inPersonRecording: offered } };
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/subscriptions/sub-1/in-person-payment') return { body: { success: true, data: door } };
    if (request.method === 'POST' && request.url.pathname === '/api/v1/admin/subscriptions/sub-1/in-person-payment') { posts.push(request); return reply; }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
  const choose = async (user: User, label: string) => {
    const first = await answerPanel(user, 'Record in-person payment', { choose: label });
    await confirmPanel(user, first, 'Continue');
    return screen.findByRole('dialog');
  };
  const bodyOf = (posts: ApiRequest[]) => JSON.parse(String(posts[0]!.init?.body));

  it('stays offered under the hold, and the second panel says what the first answer means', async () => {
    const posts: ApiRequest[] = [];
    mockApi(server(posts));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record fee payment' })).toBeNull();
    const panel = await choose(user, 'Cheque');
    expect(panel.textContent).toContain('A cheque counts only once it has cleared');
    expect(panel.textContent).toContain('never through an agent or a Swift Number');
    expect(panel.textContent).toContain('An MMG payment is never recorded here');
    expect(panel.textContent).toContain('At most GY$10,000 can be recorded now, and at least GY$5,000 is due');
  });

  it('the first panel says the limits before anyone chooses how to pay', async () => {
    mockApi(server([]));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const first = await answerPanel(user, 'Record in-person payment', {});
    expect(first.textContent).toContain('At most GY$10,000 can be recorded now, and at least GY$5,000 is due');
  });

  it('a closed door says why before any money is taken, and asks for nothing', async () => {
    const posts: ApiRequest[] = [];
    mockApi(server(posts, undefined, true, { open: false, refused: 'The weekly fee is paused, so nothing is owed right now.', mostGyd: 0, leastGyd: 0 }));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Record in-person payment' }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('Do not take money from Shanta Kitchen now');
    expect(panel.textContent).toContain('The weekly fee is paused');
    expect(within(panel).queryByLabelText('Cash')).toBeNull();
  });

  it('the fields ask for no names, and the steps after sending are spelled out', async () => {
    const posts: ApiRequest[] = [];
    mockApi(server(posts));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await choose(user, 'Cash');
    expect(panel.textContent).toContain('numbered slip from your receipt book');
    expect(panel.textContent).toContain("Swift's own receipt is issued on Execute");
    expect(panel.textContent).toContain('Not a card, account or phone number, and no names');
    expect(within(panel).queryByRole('textbox', { name: /who paid/i })).toBeNull();
    await user.type(within(panel).getByLabelText('Amount received (GYD)'), '5000');
    await user.type(within(panel).getByLabelText('Slip number'), 'RCPT-0042');
    await user.click(within(panel).getByLabelText('I will print it from Finance and hand it over'));
    await user.type(within(panel).getByRole('textbox', { name: /why this is being recorded/i }), REASON_TYPED);
    await confirmPanel(user, panel, 'Record in-person payment');
    const told = await screen.findByText(/press Start there/);
    expect(told.textContent).toContain('it waits 12 hours by default');
    expect(told.textContent).toContain('it lapses');
  });

  it('is not offered to a role the server does not name', async () => {
    mockApi(server([], undefined, false));
    renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record in-person payment' })).toBeNull();
  });

  it('a cheque is sent only after the person says it has cleared, and the row locks while it waits', async () => {
    const posts: ApiRequest[] = [];
    mockApi(server(posts));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await choose(user, 'Cheque');
    await user.type(within(panel).getByLabelText('Amount received (GYD)'), '5000');
    await user.type(within(panel).getByLabelText('Cheque number'), 'GBTI-004512');
    await user.type(within(panel).getByRole('textbox', { name: /why this is being recorded/i }), REASON_TYPED);
    await confirmPanel(user, panel, 'Record in-person payment');
    expect(posts).toHaveLength(0);
    await user.click(within(panel).getByLabelText('Yes, it has cleared and the money is in the bank'));
    await confirmPanel(user, panel, 'Record in-person payment');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(bodyOf(posts)).toEqual({ method: 'CHEQUE', amount: 5000, reference: 'GBTI-004512', cleared: true });
    expect(await screen.findByRole('button', { name: 'Payment waiting for approval' })).toBeTruthy();
  });

  it('cash names the receipt the partner holds; the server\'s refusal stays in the panel', async () => {
    const posts: ApiRequest[] = [];
    const refusal = 'That reference is already on record. One reference credits once, so nothing was recorded.';
    mockApi(server(posts, { status: 409, body: { success: false, error: { code: 'IN_PERSON_REFERENCE_USED', message: refusal } } }));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await choose(user, 'Cash');
    await user.type(within(panel).getByLabelText('Amount received (GYD)'), '5000');
    await user.type(within(panel).getByLabelText('Slip number'), 'RCPT-0042');
    await user.click(within(panel).getByLabelText('On their fee page, sent with the payment notice'));
    await user.type(within(panel).getByRole('textbox', { name: /why this is being recorded/i }), REASON_TYPED);
    await confirmPanel(user, panel, 'Record in-person payment');
    expect((await within(panel).findByRole('alert')).textContent).toContain('One reference credits once');
    expect(bodyOf(posts)).toEqual({ method: 'CASH', amount: 5000, reference: 'RCPT-0042', receipt: 'SENT' });
  });

  it('a transfer says it was seen in the bank', async () => {
    const posts: ApiRequest[] = [];
    mockApi(server(posts));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    const panel = await choose(user, 'Bank transfer');
    await user.type(within(panel).getByLabelText('Amount received (GYD)'), '5000');
    await user.type(within(panel).getByLabelText('Bank reference'), 'FT-77120');
    await user.click(within(panel).getByLabelText('Yes, it is in the company bank account'));
    await user.type(within(panel).getByRole('textbox', { name: /why this is being recorded/i }), REASON_TYPED);
    await confirmPanel(user, panel, 'Record in-person payment');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(bodyOf(posts)).toEqual({ method: 'BANK_TRANSFER', amount: 5000, reference: 'FT-77120', seenInBank: true });
  });
});
