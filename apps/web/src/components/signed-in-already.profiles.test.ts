import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';
import { homeFor } from './signed-in-already';

// [PORTAL-404 · REVIEW-G4 #2315 S4-2] The signed-in card (sign-in and sign-up, a browser already signed in) sends a
// self-employed pro to their weekly fee. It asks /auth/me's `profiles.provider`, never GET /services/providers/me
// (a 404 in the console for everyone who is not a pro); only an API that does not say asks the provider route.
// Synthetic data only.
afterEach(() => { vi.unstubAllGlobals(); });

function server(provider: boolean | undefined) {
  const asked: string[] = [];
  mockApi(({ url }) => {
    asked.push(url.pathname);
    if (url.pathname === '/api/v1/auth/me') {
      return { body: { success: true, data: { user: { id: 'c1', roles: ['CUSTOMER'] }, ...(provider === undefined ? {} : { profiles: { rider: false, driver: false, provider } }) } } };
    }
    if (url.pathname === '/api/v1/services/providers/me') return provider === undefined ? { body: { success: true, data: { id: 'p1' } } } : { status: 404, body: { success: false } };
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  return asked;
}

describe('[F29] the signed-in card asks /auth/me whether the account is a pro', () => {
  it('a pro goes to their weekly fee, with no provider request', async () => {
    const asked = server(true);
    expect(await homeFor({ id: 'c1', roles: ['CUSTOMER'] })).toEqual({ home: '/portal/weekly-fee', label: 'Go to your weekly fee' });
    expect(asked).toEqual(['/api/v1/auth/me']);
  });

  it('a customer goes to Swift, with no provider request', async () => {
    const asked = server(false);
    expect(await homeFor({ id: 'c1', roles: ['CUSTOMER'] })).toEqual({ home: '/', label: 'Go to Swift' });
    expect(asked).toEqual(['/api/v1/auth/me']);
  });

  it('an API from before /auth/me said: the provider route is asked, as before', async () => {
    const asked = server(undefined);
    expect((await homeFor({ id: 'c1', roles: ['CUSTOMER'] })).home).toBe('/portal/weekly-fee');
    expect(asked).toEqual(['/api/v1/auth/me', '/api/v1/services/providers/me']);
  });
});

describe('[BUG-HUNT F03] the signed-in card sends branch staff to their store', () => {
  it('staff: "Go to your dashboard", with no earner or provider request', async () => {
    const asked = server(false);
    expect(await homeFor({ id: 's1', roles: ['CUSTOMER'], storeStaff: true })).toEqual({ home: '/dashboard', label: 'Go to your dashboard' });
    expect(asked).toEqual([]);
  });
});
