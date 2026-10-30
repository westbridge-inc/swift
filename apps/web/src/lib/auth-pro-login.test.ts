import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';

// [BILL-PRO PR6 · owner A4] A service provider (a pro, no partner role) signs in to the partner website to pay their
// own weekly fee: the server's provider profile decides, never a role guess; anyone else without a partner profile is
// still refused.
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('partner sign-in for a service provider', () => {
  it('a pro lands on the portal\'s weekly fee', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/auth/verify-otp') return { body: { success: true, data: { isNewUser: false, user: { id: 'p1', roles: ['CUSTOMER'] }, session: 'cookie' } } };
      if (url.pathname === '/api/v1/services/providers/me') return { body: { success: true, data: { id: 'sp1' } } };
      throw new Error(url.pathname);
    });
    const auth = await import('@/lib/auth');
    expect((await auth.verifyPartnerLogin('+5926001002', '246810')).home).toBe('/portal/weekly-fee');
  });

  it('a customer with no provider profile is refused as before', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/auth/verify-otp') return { body: { success: true, data: { isNewUser: false, user: { id: 'c1', roles: ['CUSTOMER'] }, session: 'cookie' } } };
      if (url.pathname === '/api/v1/services/providers/me') return { status: 404, body: { success: false } };
      throw new Error(url.pathname);
    });
    const auth = await import('@/lib/auth');
    await expect(auth.verifyPartnerLogin('+5926001003', '246810')).rejects.toThrow('No business or earner profile on this account yet');
  });
});
