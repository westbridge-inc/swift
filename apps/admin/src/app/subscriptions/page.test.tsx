import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SubscriptionsPage from './page';
import { API_ORIGIN, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

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
    // [A-12] A top-up now names the transfer it is evidence of, and confirms the
    // target and the delta before it credits anything.
    vi.stubGlobal('prompt', vi.fn((msg: string) => {
      if (String(msg).includes('reference')) return 'BANK-9001';
      if (String(msg).includes('Why are you about to')) return 'Amount and reference match the deposit slip';
      return '5000';
    }));
    vi.stubGlobal('confirm', vi.fn(() => true));
    const fetchMock = mockApi(handler((_r, n) => (n === 1
      ? { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'lost' } } }
      : { body: { success: true, replayed: false, data: { balance: 5000, currencyCode: 'GYD' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Record fee payment' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const first = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(first[0]).toBe(`${API_ORIGIN}/api/v1/admin/subscriptions/sub-1/topup`);
    expect(JSON.parse(String(first[1]?.body))).toEqual({ amount: 5000, reference: 'BANK-9001' });
    const key = keyOf(first[1]);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);

    // The same attempt again (the admin retries after the error): the same key.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Record fee payment' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Record fee payment' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(2));
    expect(keyOf(requestsByMethod(fetchMock, 'POST')[1]![1])).toBe(key);

    // Answered — the next top-up is a new attempt with a new key.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Record fee payment' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Record fee payment' }));
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
describe('[A-12] the console cannot satisfy the evidence requirement by itself', () => {
  it('abandoning the reference prompt credits nothing', async () => {
    vi.stubGlobal('prompt', vi.fn((msg: string) => (String(msg).includes('reference') ? null : '5000')));
    vi.stubGlobal('confirm', vi.fn(() => true));
    const fetchMock = mockApi(handler(() => ({ body: { success: true, replayed: false, data: { balance: 0, currencyCode: 'GYD' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Record fee payment' }));
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
  });

  it('declining the target-and-delta confirmation credits nothing', async () => {
    vi.stubGlobal('prompt', vi.fn((msg: string) => (String(msg).includes('reference') ? 'BANK-9002' : '5000')));
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(handler(() => ({ body: { success: true, replayed: false, data: { balance: 0, currencyCode: 'GYD' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Record fee payment' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('GY$5,000'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('BANK-9002'));
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
  });

  it('a fractional amount is not a top-up', async () => {
    vi.stubGlobal('prompt', vi.fn((msg: string) => (String(msg).includes('reference') ? 'BANK-9003' : '5000.5')));
    vi.stubGlobal('confirm', vi.fn(() => true));
    const fetchMock = mockApi(handler(() => ({ body: { success: true, replayed: false, data: { balance: 0, currencyCode: 'GYD' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Record fee payment' }));
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
  });
});

describe('[A-12] a waived fee carries the operator’s own words', () => {
  it('sends what the operator typed — never the constant the console used to hard-code', async () => {
    const reason = 'Outage on 2 Sep — vendor could not trade for three days';
    vi.stubGlobal('prompt', vi.fn(() => reason));
    const fetchMock = mockApi(handler(() => ({ body: { success: true, replayed: false, data: { balance: 0, currencyCode: 'GYD' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Waive fee' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/subscriptions/sub-1/waive-fee`);
    expect(JSON.parse(String(init?.body))).toEqual({ reason });
    expect(JSON.parse(String(init?.body)).reason).not.toBe('Waived by admin');
  });

  it('an abandoned or empty reason waives nothing', async () => {
    for (const answer of [null, '   ', 'ok']) {
      vi.stubGlobal('prompt', vi.fn(() => answer));
      const fetchMock = mockApi(handler(() => ({ body: { success: true, replayed: false, data: { balance: 0, currencyCode: 'GYD' } } })));
      const { user } = renderWithQuery(<SubscriptionsPage />);
      expect(await screen.findAllByText('Shanta Kitchen')).toBeTruthy();
      await user.click(screen.getAllByRole('button', { name: 'Waive fee' })[0]!);
      expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
    }
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
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    vi.stubGlobal('prompt', vi.fn(() => REASON));
    const fetchMock = refundServer(withCredit, () => queued);
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Refund credit' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Do not pay anything yet'));
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
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn(() => REASON));
    refundServer(withCredit, () => ({ status: 409, body: { success: false, error: { code: 'FEE_CREDIT_CHANGED', message: 'The unused credit is now 3000 GYD. Nothing was set aside: ask again for exactly that amount.' } } }));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Refund credit' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The unused credit is now 3000 GYD. Nothing was set aside');
  });

  it('a set-aside row says to pay it, then records the payout with its method and reference, and shows the answer', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn((msg: string) => (String(msg).includes('Paid back by') ? 'MMG' : String(msg).includes('Reference of the refund') ? 'REFUND9001' : REASON)));
    const fetchMock = refundServer(setAsideRow, () => ({ body: { success: true, replayed: false, data: { amount: 5000, currencyCode: 'GYD', balance: 0, refundSetAside: 0 } } }));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    expect(screen.getByText(/set aside: pay it outside Swift, then record the payout/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refund credit' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Record payout' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/subscriptions/sub-1/refund-credit/paid`);
    // [Sol r2 S1] the payout record names the set-aside it pays
    expect(JSON.parse(String(init?.body))).toEqual({ amount: 5000, method: 'MMG', reference: 'REFUND9001', setAsideId: 'evt-aside-1' });
    expect((await screen.findByRole('status')).textContent).toContain('Payout recorded');
  });

  it('a replay of an earlier payout does not say a new set-aside is complete', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn((msg: string) => (msg.includes('Paid back by') ? 'MMG' : msg.includes('Reference of the refund') ? 'EARLIER9001' : REASON)));
    refundServer(setAsideRow, () => ({ body: { success: true, replayed: true, data: { amount: 5000, currencyCode: 'GYD', balance: 0, refundSetAside: 5000 } } }));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    await screen.findByText('Shanta Kitchen');
    await user.click(screen.getByRole('button', { name: 'Record payout' }));
    const message = (await screen.findByRole('status')).textContent;
    expect(message).toContain('earlier payout');
    expect(message).toContain('still set aside');
    expect(message).not.toContain('refund is complete');
  });

  it('a queued payout record says payment was reported and prevents another payment or release', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn((msg: string) => (msg.includes('Paid back by') ? 'MMG' : msg.includes('Reference of the refund') ? 'SENT9001' : REASON)));
    refundServer(setAsideRow, () => queued);
    const { user } = renderWithQuery(<SubscriptionsPage />);
    await screen.findByText('Shanta Kitchen');
    await user.click(screen.getByRole('button', { name: 'Record payout' }));
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
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn((msg: string) => (msg.includes('Paid back by') ? 'MMG' : msg.includes('Reference of the refund') ? 'SENT9002' : REASON)));
    let row: unknown = setAsideRow;
    mockApi((request: ApiRequest) => {
      if (request.url.pathname === '/api/v1/admin/subscriptions') return { body: { success: true, data: [row] } };
      if (request.method === 'POST' && request.url.pathname.startsWith('/api/v1/admin/subscriptions/sub-1/refund-credit/')) return queued;
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user, queryClient } = renderWithQuery(<SubscriptionsPage />);
    await screen.findByText('Shanta Kitchen');
    await user.click(screen.getByRole('button', { name: 'Record payout' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement).disabled).toBe(true));
    // That payout is recorded; credit is later set aside again (a new set-aside).
    row = { ...setAsideRow, refundSetAsideId: 'evt-aside-2' };
    await queryClient.invalidateQueries();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole('button', { name: 'Record payout' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/set aside: pay it outside Swift/)).toBeTruthy();
  });

  it('a payout refusal (a bad reference) is shown, not swallowed', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn((msg: string) => (String(msg).includes('Paid back by') ? 'BANK' : String(msg).includes('Reference of the refund') ? 'x' : REASON)));
    refundServer(setAsideRow, () => ({ status: 400, body: { success: false, error: { code: 'REFUND_REFERENCE_INVALID', message: 'That does not look like a transfer reference. Copy it from the MMG or bank record.' } } }));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Record payout' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That does not look like a transfer reference');
  });

  it('a set-aside that could not be paid is released with the whole amount', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn(() => REASON));
    const fetchMock = refundServer(setAsideRow, () => queued);
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/subscriptions/sub-1/refund-credit/release`);
    expect(JSON.parse(String(init?.body))).toEqual({ amount: 5000, setAsideId: 'evt-aside-1' });
    expect((await screen.findByRole('status')).textContent).toContain('apr_9');
  });
});

// ---------------------------------------------------------------------------
// [OWNER 8 Oct (4)] Production records no fee payment by hand (BILLING_TOPUP_HOLD):
// partners pay through the MMG checkout page. The server says when the hold is on,
// and the console then offers no "Record fee payment" button. When it is offered and
// the server refuses (the hold, or more than one week ahead, owner #62), its words show.
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
    expect(screen.getByText(/Recording fee payments by hand is on hold/)).toBeTruthy();
  });

  it('shows the server’s words when it refuses one', async () => {
    vi.stubGlobal('prompt', vi.fn((msg: string) => {
      if (String(msg).includes('reference')) return 'BANK-9100';
      if (String(msg).includes('Why are you about to')) return 'Amount and reference match the deposit slip';
      return '9000';
    }));
    vi.stubGlobal('confirm', vi.fn(() => true));
    const refusal = 'This would pay more than one week ahead on this account. Record at most GY$8,400 now and refund the rest to the partner (finance procedure: weekly fee refunds).';
    mockApi(handler(() => ({ status: 409, body: { success: false, error: { code: 'PAY_AHEAD_LIMIT', message: refusal } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Record fee payment' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Record at most GY$8,400');
  });
});
