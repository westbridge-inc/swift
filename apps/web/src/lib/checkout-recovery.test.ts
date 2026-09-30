import { describe, expect, it } from 'vitest';
import { mockApi } from '@/test/test-utils';
import { resolveCheckoutAttempt } from './checkout-recovery';

const attempt = { key: 'retained/key?fixture', signature: 'a different cart, tip and options' };

describe('checkout receipt resolver', () => {
  it('looks up the retained key without replaying checkout or substituting the current cart', async () => {
    const fetchMock = mockApi(() => ({ body: { success: true, data: { status: 'placed', orderIds: ['order-a', 'order-b'] } } }));
    expect(await resolveCheckoutAttempt(attempt)).toEqual({ status: 'placed', orderIds: ['order-a', 'order-b'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/api/v1/customer/checkout/receipts/retained%2Fkey%3Ffixture');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('only an explicit none verdict permits a new order', async () => {
    mockApi(() => ({ body: { success: true, data: { status: 'none' } } }));
    expect(await resolveCheckoutAttempt(attempt)).toEqual({ status: 'none' });
  });

  it.each([
    { status: 'in_flight' },
    { status: 'new-status' },
    null,
    { status: 'placed' },
    { status: 'placed', orderIds: [] },
    { status: 'placed', orderIds: [''] },
    { status: 'placed', orderIds: ['   '] },
    { status: 'placed', orderIds: ['order-a', 42] },
  ])('keeps unresolved or malformed verdict %j unknown', async (data) => {
    mockApi(() => ({ body: { success: true, data } }));
    expect(await resolveCheckoutAttempt(attempt)).toEqual({ status: 'unknown' });
  });

  it.each([404, 408, 503])('a failed probe with HTTP %i cannot prove the checkout absent', async (status) => {
    mockApi(() => ({ status, body: { success: false, error: { code: 'AUTH_UNAVAILABLE', message: 'Please retry shortly.' } } }));
    expect(await resolveCheckoutAttempt(attempt)).toEqual({ status: 'unknown' });
  });

  it('keeps a network failure unknown', async () => {
    mockApi(() => { throw new TypeError('Failed to fetch'); });
    expect(await resolveCheckoutAttempt(attempt)).toEqual({ status: 'unknown' });
  });
});
