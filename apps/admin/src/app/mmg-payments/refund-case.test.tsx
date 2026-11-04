import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MmgPaymentsPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// [Row 156] "Weekly-fee refunds: none, except a duplicate or mistaken payment, refunded through MMG within 3 business
// days." Recording the ask starts that clock. It moves no money: the return is its own two-person act, and a case closes
// only when MMG's records prove the return, so nothing here can close one.

const PATH = '/api/v1/admin/billing/mmg-checkouts';
const CASES = '/api/v1/admin/billing/fee-refund-cases';
const REASON = 'Partner paid this week twice by mistake';
const row = {
  id: 'co_1', swiftReference: '175933829900012345', mmgTransactionId: '20402048536279', mmgTransactionReference: '20402048601581', amount: 2100, currencyCode: 'GYD', status: 'CONFIRMED', platform: 'ios',
  partner: { kind: 'VENDOR', displayName: 'Shanta Kitchen', maskedPhone: '+592•••••1234', subscriptionId: 'sub_1' },
  createdAt: '2026-10-01T19:38:19.000Z', replyAt: '2026-10-01T19:39:40.000Z', confirmedAt: '2026-10-01T19:39:42.000Z', reason: null, matchedBy: [],
};
const detail = (status = 'CONFIRMED') => ({ ...row, status, timeline: [], timelineTruncated: false, creditedPeriod: null });
const refundCase = (patch: Record<string, unknown> = {}) => ({
  id: 'case_1', checkoutId: 'co_1', subscriptionId: 'sub_1', kind: 'DUPLICATE', reason: REASON, amount: 2100, currencyCode: 'GYD', state: 'OPEN', dueBy: '2026-11-10T03:59:59.999Z', overdue: false,
  reversalId: null, refundedAt: null, openedAt: '2026-11-04T14:00:00.000Z', ...patch,
});
const reversalView = { body: { success: true, data: { checkoutId: 'co_1', amountGyd: 2100, switchedOn: false, canReverse: false, reversals: [] } } };

function api(over: { cases?: unknown[]; one?: unknown; status?: string; onPost?: (_request: ApiRequest) => { status?: number; body: unknown }; casesFail?: boolean } = {}) {
  const state = { one: over.one ?? null };
  return { state, fetchMock: mockApi((request: ApiRequest) => {
    const { pathname } = request.url;
    if (pathname === CASES) return over.casesFail ? { status: 500, body: { success: false, error: { code: 'X', message: 'down' } } } : { body: { success: true, data: over.cases ?? [] } };
    if (pathname === `${PATH}/co_1/refund-case`) {
      if (request.method === 'POST') {
        const reply = over.onPost?.(request) ?? { body: { success: true, data: refundCase() } };
        if (!reply.status) state.one = refundCase();
        return reply;
      }
      return { body: { success: true, data: state.one } };
    }
    if (pathname === `${PATH}/co_1/reversal`) return reversalView;
    if (pathname === `${PATH}/co_1`) return { body: { success: true, data: detail(over.status) } };
    return { body: { success: true, data: [{ ...row, status: over.status ?? 'CONFIRMED' }], nextCursor: null } };
  }) };
}

async function openPayment(over: Parameters<typeof api>[0] = {}) {
  const { fetchMock, state } = api(over);
  const view = renderWithQuery(<MmgPaymentsPage />);
  await screen.findByRole('table');
  await view.user.click(screen.getByRole('button', { name: `Open payment ${row.swiftReference}` }));
  await screen.findByRole('region', { name: 'Payment detail' });
  return { fetchMock, state, ...view };
}

describe('the refund requests waiting', () => {
  it('lists what is open, says which is overdue, and opens the payment', async () => {
    const { user } = await (async () => {
      api({ cases: [refundCase({ overdue: true })] });
      return renderWithQuery(<MmgPaymentsPage />);
    })();
    const list = await screen.findByRole('region', { name: 'Refund requests' });
    expect(within(list).getByText('Overdue')).toBeTruthy();
    expect(within(list).getByText(/Paid twice/)).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: /Open refund request/ }));
    expect(await screen.findByRole('region', { name: 'Payment detail' })).toBeTruthy();
  });

  it('nothing open: no list', async () => {
    api();
    renderWithQuery(<MmgPaymentsPage />);
    await screen.findByRole('table');
    expect(screen.queryByRole('region', { name: 'Refund requests' })).toBeNull();
  });

  it('a failed read says so, it never reads as nothing waiting', async () => {
    api({ casesFail: true });
    renderWithQuery(<MmgPaymentsPage />);
    expect(await screen.findByText(/refund requests/i)).toBeTruthy();
  });
});

describe('recording a request on a payment', () => {
  it('needs what kind and a reason, then starts the clock: nothing else is sent', async () => {
    const { fetchMock, user } = await openPayment();
    const panel = await screen.findByRole('region', { name: 'Refund request' });
    const button = within(panel).getByRole('button', { name: 'Record the request' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(within(panel).getByRole('radio', { name: 'Paid twice' }));
    expect(button.disabled).toBe(true);
    await user.type(within(panel).getByRole('textbox', { name: 'What the partner said' }), REASON);
    expect(button.disabled).toBe(false);
    await user.click(button);

    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(String(url)).toContain('/billing/mmg-checkouts/co_1/refund-case');
    expect(JSON.parse(String(init?.body))).toEqual({ kind: 'DUPLICATE', reason: REASON });
    expect(await within(panel).findByText(/Due by/)).toBeTruthy();
  });

  it('says what it does not do: it moves no money', async () => {
    await openPayment();
    const panel = await screen.findByRole('region', { name: 'Refund request' });
    expect(within(panel).getByText(/moves no money/)).toBeTruthy();
  });

  it('a refusal stays on the page', async () => {
    await openPayment({ onPost: () => ({ status: 409, body: { success: false, error: { code: 'REFUND_CASE_EXISTS', message: 'This payment already has a refund case.' } } }) }).then(async ({ user }) => {
      const panel = await screen.findByRole('region', { name: 'Refund request' });
      await user.click(within(panel).getByRole('radio', { name: 'Paid by mistake' }));
      await user.type(within(panel).getByRole('textbox', { name: 'What the partner said' }), REASON);
      await user.click(within(panel).getByRole('button', { name: 'Record the request' }));
      expect(await within(panel).findByText(/already has a refund case/)).toBeTruthy();
    });
  });

  it('not on a payment that is not confirmed', async () => {
    await openPayment({ status: 'HELD' });
    expect(screen.queryByRole('region', { name: 'Refund request' })).toBeNull();
  });
});

describe('every read is recorded on the server, so it happens when asked', () => {
  it('closing a payment and opening it again reads nothing twice', async () => {
    const { fetchMock, user } = await openPayment({ one: refundCase() });
    await screen.findByRole('region', { name: 'Refund request' });
    const reads = () => requestsByMethod(fetchMock, 'GET').filter(([url]) => String(url).endsWith('/refund-case')).length;
    expect(reads()).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Refund request' })).toBeNull());
    await user.click(await screen.findByRole('button', { name: `Open payment ${row.swiftReference}` }));
    await screen.findByRole('region', { name: 'Refund request' });
    expect(reads()).toBe(1);
  });
});

describe('a request already recorded', () => {
  it('open: the due date, no form, and no way to close it here', async () => {
    await openPayment({ one: refundCase() });
    const panel = await screen.findByRole('region', { name: 'Refund request' });
    expect(await within(panel).findByText(/Due by/)).toBeTruthy();
    expect(within(panel).getByText(REASON)).toBeTruthy();
    expect(within(panel).queryByRole('button')).toBeNull();
  });

  it('overdue says so', async () => {
    await openPayment({ one: refundCase({ overdue: true }) });
    const panel = await screen.findByRole('region', { name: 'Refund request' });
    expect(await within(panel).findByText('Overdue')).toBeTruthy();
  });

  it('refunded says when', async () => {
    await openPayment({ one: refundCase({ state: 'REFUNDED', reversalId: 'rev_1', refundedAt: '2026-11-06T15:00:00.000Z' }) });
    const panel = await screen.findByRole('region', { name: 'Refund request' });
    expect(await within(panel).findByText(/Refunded through MMG/)).toBeTruthy();
    expect(within(panel).queryByText(/Due by/)).toBeNull();
  });
});
