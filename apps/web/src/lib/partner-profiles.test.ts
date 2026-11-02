import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest } from '@/test/test-utils';
import { getDriverProfile, getRiderProfile } from './mover-api';
import { getProviderFee } from './provider-fee-api';
import { hasProviderProfile, readPartnerProfiles } from './auth';
import { partnerProfiles } from './partner-profiles';

// ---------------------------------------------------------------------------
// [PORTAL-404 · FLOW-QA F29] GET /auth/me says which partner profiles the person holds (`data.profiles`); the website
// asks a profile route only when /auth/me did not say "no". The browser logs every 404 itself, so a profile the person
// does not hold must not be asked for at all. When /auth/me cannot say (a failure, or an API from before it said),
// the routes are asked exactly as before: absence stays the server's word, and a failure never reads as "no profile".
// Synthetic data only.
// ---------------------------------------------------------------------------

afterEach(() => { vi.unstubAllGlobals(); });

const ME = '/api/v1/auth/me';
const NO = { status: 404, body: { success: false, error: { message: 'No profile' } } };
type Profiles = { rider: boolean; driver: boolean; provider: boolean };

/** /auth/me answers with these profiles (or without the field: `undefined`); every other route as `routes` says. */
function server(profiles: Profiles | undefined | 'fail', routes: Record<string, { status?: number; body: unknown }> = {}) {
  const asked: string[] = [];
  mockApi(({ url }: ApiRequest) => {
    asked.push(url.pathname);
    if (url.pathname === ME) {
      if (profiles === 'fail') return { status: 500, body: { success: false, error: { message: 'down' } } };
      return { body: { success: true, data: { user: { id: 'u1', roles: ['CUSTOMER', 'MOVER'] }, ...(profiles ? { profiles } : {}) } } };
    }
    const canned = routes[url.pathname];
    if (canned) return canned;
    return NO;
  });
  return asked;
}

describe('[F29] the profile reads ask only for profiles the person holds', () => {
  it('a new rider: the rider profile is read, the driver profile is never asked for', async () => {
    const asked = server({ rider: true, driver: false, provider: false }, { '/api/v1/rider/profile': { body: { success: true, data: { id: 'r1' } } } });
    const [rider, driver] = await Promise.all([getRiderProfile(), getDriverProfile()]);
    expect(rider).toEqual({ id: 'r1' });
    expect(driver).toBeNull();
    expect(asked).not.toContain('/api/v1/driver/profile');
    expect(asked).toContain('/api/v1/rider/profile');
  });

  it('a driver: the rider profile is never asked for', async () => {
    const asked = server({ rider: false, driver: true, provider: false }, { '/api/v1/driver/profile': { body: { success: true, data: { id: 'd1' } } } });
    expect(await getRiderProfile()).toBeNull();
    expect(await getDriverProfile()).toEqual({ id: 'd1' });
    expect(asked).not.toContain('/api/v1/rider/profile');
  });

  it('reads at the same moment share one /auth/me', async () => {
    const asked = server({ rider: false, driver: false, provider: false });
    await Promise.all([getRiderProfile(), getDriverProfile(), getProviderFee()]);
    expect(asked.filter((p) => p === ME)).toHaveLength(1);
    expect(asked).toEqual([ME]);
  });

  it('nothing is kept after /auth/me answers: a profile added since is read on the next ask', async () => {
    server({ rider: false, driver: false, provider: false });
    expect(await getRiderProfile()).toBeNull();
    const asked = server({ rider: true, driver: false, provider: false }, { '/api/v1/rider/profile': { body: { success: true, data: { id: 'r2' } } } });
    expect(await getRiderProfile()).toEqual({ id: 'r2' });
    expect(asked).toEqual([ME, '/api/v1/rider/profile']);
  });

  it('a profile /auth/me says is held but the route no longer has (a race) is still "no profile", from the route', async () => {
    server({ rider: true, driver: true, provider: true });
    expect(await getDriverProfile()).toBeNull();
    expect(await getProviderFee()).toBeNull();
  });

  it('an API from before /auth/me said: both routes are asked, as before', async () => {
    const asked = server(undefined, { '/api/v1/rider/profile': { body: { success: true, data: { id: 'r1' } } } });
    expect(await getRiderProfile()).toEqual({ id: 'r1' });
    expect(await getDriverProfile()).toBeNull();
    expect(asked).toContain('/api/v1/driver/profile');
    expect(await partnerProfiles()).toBeNull();
  });

  it('/auth/me failing never reads as "no profile": the route is asked, and its failure reaches the page', async () => {
    const asked = server('fail', { '/api/v1/driver/profile': { status: 500, body: { success: false, error: { message: 'down' } } } });
    await expect(getDriverProfile()).rejects.toMatchObject({ status: 500 });
    expect(asked).toContain('/api/v1/driver/profile');
  });
});

describe('[F29] the provider fee is asked only of a pro', () => {
  it('not a pro: no /provider/subscription request, and no fee', async () => {
    const asked = server({ rider: true, driver: false, provider: false });
    expect(await getProviderFee()).toBeNull();
    expect(asked).not.toContain('/api/v1/provider/subscription');
  });

  it('a pro: the fee is read', async () => {
    const asked = server({ rider: false, driver: false, provider: true }, { '/api/v1/provider/subscription': { body: { success: true, data: null, coveredBy: null } } });
    expect(await getProviderFee()).toMatchObject({ data: null, coveredBy: null });
    expect(asked).toContain('/api/v1/provider/subscription');
  });

  it('hasProviderProfile reads /auth/me and asks the provider route only when /auth/me does not say', async () => {
    let asked = server({ rider: false, driver: false, provider: false });
    expect(await hasProviderProfile()).toBe(false);
    expect(asked).toEqual([ME]);
    asked = server({ rider: false, driver: false, provider: true });
    expect(await hasProviderProfile()).toBe(true);
    expect(asked).toEqual([ME]);
    asked = server(undefined, { '/api/v1/services/providers/me': { body: { success: true, data: { id: 'p1' } } } });
    expect(await hasProviderProfile()).toBe(true);
    expect(asked).toEqual([ME, '/api/v1/services/providers/me']);
    // /auth/me failing is not "not a pro": the provider route is asked, as before.
    asked = server('fail', { '/api/v1/services/providers/me': { body: { success: true, data: { id: 'p1' } } } });
    expect(await hasProviderProfile()).toBe(true);
    expect(asked).toEqual([ME, '/api/v1/services/providers/me']);
  });
});

describe('[F29] readPartnerProfiles takes only three yes/no answers', () => {
  it('anything else is "the server did not say"', () => {
    expect(readPartnerProfiles({ rider: true, driver: false, provider: false })).toEqual({ rider: true, driver: false, provider: false });
    expect(readPartnerProfiles(undefined)).toBeNull();
    expect(readPartnerProfiles(null)).toBeNull();
    expect(readPartnerProfiles({ rider: true, driver: false })).toBeNull();
    expect(readPartnerProfiles({ rider: 'yes', driver: false, provider: false })).toBeNull();
    expect(readPartnerProfiles({ rider: 1, driver: 0, provider: 0 })).toBeNull();
  });
});
