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
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}
const keyOf = (init: RequestInit | undefined) => (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'];

afterEach(() => vi.unstubAllGlobals());

describe('the top-up key belongs to the attempt', () => {
  it('sends an Idempotency-Key, reuses it when the same attempt is retried after an error, and mints a new one for the next attempt', async () => {
    vi.stubGlobal('prompt', vi.fn(() => '5000'));
    const fetchMock = mockApi(handler((_r, n) => (n === 1
      ? { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'lost' } } }
      : { body: { success: true, replayed: false, data: { balance: 5000, currencyCode: 'GYD' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Top up' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const first = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(first[0]).toBe(`${API_ORIGIN}/api/v1/admin/subscriptions/sub-1/topup`);
    expect(JSON.parse(String(first[1]?.body))).toEqual({ amount: 5000 });
    const key = keyOf(first[1]);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);

    // The same attempt again (the admin retries after the error): the same key.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Top up' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Top up' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(2));
    expect(keyOf(requestsByMethod(fetchMock, 'POST')[1]![1])).toBe(key);

    // Answered — the next top-up is a new attempt with a new key.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Top up' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Top up' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(3));
    const third = keyOf(requestsByMethod(fetchMock, 'POST')[2]![1]);
    expect(third).toMatch(/^[0-9a-f-]{36}$/);
    expect(third).not.toBe(key);
  });
});
