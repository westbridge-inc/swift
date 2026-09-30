import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';

const attempt = { key: 'principal-bound-attempt', signature: 'original-tip-and-options' };
const storageKey = 'swift_web_checkout_attempt:customer-a';

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/login');
});

describe('AX354 forced sign-out during receipt recovery', () => {
  it.each([
    ['login', 401], ['login', 503], ['reload probe', 401], ['reload probe', 503],
  ] as const)('restores the same principal through %s after refresh HTTP %i', async (signIn, refreshStatus) => {
    const auth = await import('./auth');
    const customer = await import('./customer');
    const recovery = await import('./checkout-recovery');
    auth.adoptSession('customer-a');
    customer.persistCheckoutAttempt(attempt);
    const failed = mockApi(({ url }) => ({
      status: url.pathname.endsWith('/auth/refresh') ? refreshStatus : 401,
      body: { success: false },
    }));
    expect(await recovery.resolveCheckoutAttempt(attempt)).toEqual({ status: 'unknown' });
    expect(failed.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/customer/checkout/receipts/' + attempt.key, '/api/v1/auth/refresh',
    ]);
    expect(auth.getSessionPrincipal()).toBeNull();
    expect(customer.readCheckoutAttempt()).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(attempt);

    // A new page has no in-memory copy of either the principal or the attempt.
    vi.resetModules();
    const signedInAuth = await import('./auth');
    const restoredCustomer = await import('./customer');
    expect(restoredCustomer.readCheckoutAttempt()).toBeNull();
    const resumed = mockApi(({ url }) => ({ body: { success: true, data: url.pathname.endsWith('/auth/me')
      ? { user: { id: 'customer-a' } } : { status: 'placed', orderIds: ['committed-order'] } } }));
    if (signIn === 'login') signedInAuth.adoptSession('customer-a');
    else await signedInAuth.sessionProbe();
    expect(restoredCustomer.readCheckoutAttempt()).toEqual(attempt);
    const restoredRecovery = await import('./checkout-recovery');
    expect(await restoredRecovery.resolveCheckoutAttempt(restoredCustomer.readCheckoutAttempt()!))
      .toEqual({ status: 'placed', orderIds: ['committed-order'] });
    expect(resumed.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    expect(new URL(String(resumed.mock.calls.at(-1)![0])).pathname)
      .toBe('/api/v1/customer/checkout/receipts/' + attempt.key);
  });

  it.each(['login', 'reload probe'])('never restores another principal’s attempt through %s', async (signIn) => {
    const auth = await import('./auth');
    const customer = await import('./customer');
    auth.adoptSession('customer-a');
    customer.persistCheckoutAttempt(attempt);
    mockApi(() => ({ status: 401, body: { success: false } }));
    await expect(auth.apiFetch('/api/v1/customer/checkout/receipts/' + attempt.key)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(attempt);
    vi.resetModules();
    const nextAuth = await import('./auth');
    const nextCustomer = await import('./customer');
    if (signIn === 'login') nextAuth.adoptSession('customer-b');
    else {
      mockApi(() => ({ body: { success: true, data: { user: { id: 'customer-b' } } } }));
      await nextAuth.sessionProbe();
    }
    expect(nextCustomer.readCheckoutAttempt()).toBeNull();
    nextCustomer.persistCheckoutAttempt({ key: 'b-attempt', signature: 'b-cart' });
    expect(nextCustomer.readCheckoutAttempt()?.key).toBe('b-attempt');
    expect(JSON.parse(sessionStorage.getItem('swift_web_checkout_attempt:customer-b')!).key).toBe('b-attempt');
  });
});
