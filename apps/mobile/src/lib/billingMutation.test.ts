import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ userId: 'synthetic-a', generation: 1, token: 'synthetic-token', store: 'store-a' as string | null }));
vi.mock('../stores/authStore', () => ({
  requireAuthSessionSnapshot: () => ({ userId: state.userId, generation: state.generation, accessToken: state.token }),
  requireAuthSessionForPrincipal: (p: any) => {
    if (p.userId !== state.userId || p.generation !== state.generation) throw new Error('PRINCIPAL_CHANGED');
    return { ...p, accessToken: state.token };
  },
}));
import { runBillingMutation } from './billingMutation';
const cold = new Error('STEP_UP_REQUIRED');
beforeEach(() => Object.assign(state, { userId: 'synthetic-a', generation: 1, token: 'synthetic-token', store: 'store-a' }));
function retryAfter(change: () => void): any {
  return (fn: any) => async () => { try { return await fn(); } catch (error) { if (error !== cold) throw error; change(); return fn(); } };
}
describe('billing caller retains principal, selected store and exact operation', () => {
  it.each(['CASH', 'MOBILE_MONEY', 'NONE'])('%s retries the same body and store after token refresh', async (method) => {
    const body = { method, mmgPayerMsisdn: method === 'MOBILE_MONEY' ? '5920000100' : undefined };
    const api = vi.fn().mockRejectedValueOnce(cold).mockResolvedValue('saved');
    const result = await runBillingMutation(retryAfter(() => { state.token = 'synthetic-refreshed'; }),
      (session, store) => api(body, session, store), () => state.store);
    expect(result).toBe('saved'); expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.calls[0]![0]).toBe(body); expect(api.mock.calls[1]![0]).toBe(body);
    expect(api.mock.calls.map(call => call[2])).toEqual(['store-a', 'store-a']);
    expect(api.mock.calls[1]![1].accessToken).toBe('synthetic-refreshed');
  });
  it.each(['account', 'relogin', 'store', 'unselect'])('%s change during verification cannot replay billing', async (change) => {
    const api = vi.fn().mockRejectedValueOnce(cold).mockResolvedValue('wrong');
    const guard = retryAfter(() => {
      if (change === 'account') state.userId = 'synthetic-b';
      if (change === 'relogin') state.generation++;
      if (change === 'store') state.store = 'store-b';
      if (change === 'unselect') state.store = null;
    });
    await expect(runBillingMutation(guard, (session, store) => api(session, store), () => state.store)).rejects.toThrow();
    expect(api).toHaveBeenCalledOnce();
  });
});
