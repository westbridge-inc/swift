import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';
import { headerAccount } from './header-session';

// [PORTAL-404 · FLOW-QA F29] The public header's account link for a signed-in customer asked
// GET /services/providers/me on every page, a 404 in the browser console for everyone who is not a pro. It now reads
// /auth/me's `profiles.provider`; the provider route is asked only when /auth/me does not say. Synthetic data only.
afterEach(() => { vi.unstubAllGlobals(); });

function signedInCustomer(profiles: { rider: boolean; driver: boolean; provider: boolean } | undefined) {
  const asked: string[] = [];
  mockApi(({ url }) => {
    asked.push(url.pathname);
    if (url.pathname === '/api/v1/auth/me') return { body: { success: true, data: { user: { id: 'c1', roles: ['CUSTOMER'] }, ...(profiles ? { profiles } : {}) } } };
    if (url.pathname === '/api/v1/services/providers/me') return { status: 404, body: { success: false } };
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  return asked;
}

describe('[F29] the header asks /auth/me whether a signed-in customer is a pro', () => {
  it('not a pro: no link, and no provider request', async () => {
    const asked = signedInCustomer({ rider: false, driver: false, provider: false });
    expect(await headerAccount()).toBeNull();
    expect(asked).not.toContain('/api/v1/services/providers/me');
  });

  it('a pro: "My weekly fee", and no provider request', async () => {
    const asked = signedInCustomer({ rider: false, driver: false, provider: true });
    expect(await headerAccount()).toEqual({ href: '/portal/weekly-fee', label: 'My weekly fee' });
    expect(asked).not.toContain('/api/v1/services/providers/me');
  });

  it('an API from before /auth/me said: the provider route is asked, as before', async () => {
    const asked = signedInCustomer(undefined);
    expect(await headerAccount()).toBeNull();
    expect(asked).toContain('/api/v1/services/providers/me');
  });
});
