import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGolden } from './gold-7-helpers';

// ---------------------------------------------------------------------------
// GOLD-7 · AUTH-02 — the picker reads /me, switches to an owned role, reaches
// its destination, refuses an unowned role, rotates the session and returns.
// Phone block +5920971nnn: literal and generator ranges checked in src.
// Device-only: rendering/tapping the native role picker. Its server contract
// is /auth/me → /customer/switch-role → the mounted role destination.
// ---------------------------------------------------------------------------
const h = createGolden('+5920971', 'gold7-auth02');
beforeAll(() => h.start());
afterAll(() => h.close());

describe('GOLD-7 · AUTH-02 — role picker to authorized destination', () => {
  it('switches an owned role, denies an unowned destination, and refreshes into the selected role', async () => {
    const actor = await h.actor(['CUSTOMER', 'VENDOR_OWNER'], 'CUSTOMER');
    const store = await h.vendor(actor);
    const picker = await h.call('GET', '/api/v1/auth/me', actor.token);
    expect(picker.statusCode).toBe(200);
    expect(picker.json().data).toMatchObject({ sessionId: actor.sessionId, user: {
      id: actor.userId, roles: ['CUSTOMER', 'VENDOR_OWNER'], activeRole: 'CUSTOMER',
    } });
    const switched = await h.call('POST', '/api/v1/customer/switch-role', actor.token, { role: 'VENDOR' });
    expect(switched.statusCode, switched.json().error?.code).toBe(200);
    expect(switched.json().data).toMatchObject({ role: 'VENDOR', activeRole: 'VENDOR_OWNER' });
    const destination = await h.call('GET', '/api/v1/vendor/profile', actor.token);
    expect(destination.statusCode, destination.json().error?.code).toBe(200);
    expect(destination.json().data).toMatchObject({ userId: actor.userId, myRole: 'OWNER' });
    expect(destination.json().data.vendors.map((v: { id: string }) => v.id)).toEqual([store.vendorId]);

    const refused = await h.call('POST', '/api/v1/customer/switch-role', actor.token, { role: 'DRIVER' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('FORBIDDEN');
    expect((await h.sys(() => h.app.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }))).activeRole).toBe('VENDOR_OWNER');
    const outsider = await h.actor();
    const wrongRole = await h.call('GET', '/api/v1/vendor/profile', outsider.token);
    expect(wrongRole.statusCode).toBe(403);
    expect(wrongRole.json().data).toBeUndefined();

    const refresh = await h.call('POST', '/api/v1/auth/refresh', actor.token, { refreshToken: actor.refreshToken });
    expect(refresh.statusCode).toBe(200); // never put session material in assertion messages
    const rotated = refresh.json().data;
    expect(rotated.accessToken !== actor.token).toBe(true);
    expect(rotated.refreshToken !== actor.refreshToken).toBe(true);
    expect(h.app.jwt.verify<{ role: string }>(rotated.accessToken).role).toBe('VENDOR_OWNER');
    const sessions = await h.sys(() => h.app.prisma.session.findMany({ where: { userId: actor.userId } }));
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.id).toBe(actor.sessionId);
    expect(sessions[0]!.token === rotated.accessToken).toBe(true);
    expect(sessions[0]!.refreshToken === rotated.refreshToken).toBe(true);
    expect(sessions[0]!.previousRefreshToken === actor.refreshToken).toBe(true);
    expect((await h.call('GET', '/api/v1/auth/me', actor.token)).statusCode).toBe(401);
    const refreshedDestination = await h.call('GET', '/api/v1/vendor/profile', rotated.accessToken);
    expect(refreshedDestination.statusCode).toBe(200);
    expect(refreshedDestination.json().data.vendors.map((v: { id: string }) => v.id)).toEqual([store.vendorId]);
    expect((await h.call('POST', '/api/v1/customer/switch-role', rotated.accessToken, { role: 'CUSTOMER' })).statusCode).toBe(200);
    const home = await h.call('GET', '/api/v1/customer/profile', rotated.accessToken);
    expect(home.statusCode).toBe(200);
    expect(home.json().data).toMatchObject({ id: actor.userId, activeRole: 'CUSTOMER' });
  });
});
