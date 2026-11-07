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

// [BUG-HUNT F03] A store's staff hold no partner role and no vendorOwner: the server's `storeStaff` is what says they
// work at a store. They land on the store dashboard; nobody else gets past this door on it.
describe('partner sign-in for branch staff', () => {
  const answer = (user: Record<string, unknown>) => mockApi(({ url }) => {
    if (url.pathname === '/api/v1/auth/verify-otp') return { body: { success: true, data: { isNewUser: false, user, session: 'cookie' } } };
    if (url.pathname === '/api/v1/services/providers/me') return { status: 404, body: { success: false } };
    throw new Error(url.pathname);
  });

  it('staff land on the store dashboard', async () => {
    answer({ id: 's1', roles: ['CUSTOMER'], storeStaff: true });
    const auth = await import('@/lib/auth');
    expect((await auth.verifyPartnerLogin('+5926001004', '246810')).home).toBe('/dashboard');
  });

  it('a rider who also works at a store keeps the portal as home', async () => {
    answer({ id: 'r1', roles: ['CUSTOMER', 'MOVER'], storeStaff: true });
    const auth = await import('@/lib/auth');
    expect((await auth.verifyPartnerLogin('+5926001005', '246810')).home).toBe('/portal');
  });

  it('storeStaff false is still a refusal', async () => {
    answer({ id: 'c2', roles: ['CUSTOMER'], storeStaff: false });
    const auth = await import('@/lib/auth');
    await expect(auth.verifyPartnerLogin('+5926001006', '246810')).rejects.toThrow('No business or earner profile on this account yet');
  });
});
