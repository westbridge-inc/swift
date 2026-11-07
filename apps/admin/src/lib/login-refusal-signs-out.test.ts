import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';
import { verifyOtpLogin } from './api';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S4-3] A non-admin was refused with clear words ("This account does not have admin access."), but
// the session the API had just issued (HttpOnly cookies) stayed live in that browser. A refusal now ends that
// session on the server before the words are shown. Fictional number.
// ---------------------------------------------------------------------------

afterEach(() => { vi.unstubAllGlobals(); });
const posts = (fetch: ReturnType<typeof mockApi>) => fetch.mock.calls.map(([input]) => new URL(String(input)).pathname);

describe('[ADMIN-AUDIT S4-3] a refused sign-in leaves no session behind', () => {
  it('a customer account: refused, and its new session is signed out', async () => {
    const fetch = mockApi((r) => (r.url.pathname.endsWith('/auth/verify-otp')
      ? { body: { success: true, data: { session: 'cookie', isNewUser: false, user: { id: 'u1', roles: ['CUSTOMER'] } } } }
      : { body: { success: true } }));
    await expect(verifyOtpLogin('+5926009999', '123456')).rejects.toThrow('This account does not have admin access.');
    expect(posts(fetch)).toEqual(['/api/v1/auth/verify-otp', '/api/v1/auth/logout']);
  });
  it('a number with no account: refused, and the session made for it is signed out', async () => {
    const fetch = mockApi((r) => (r.url.pathname.endsWith('/auth/verify-otp')
      ? { body: { success: true, data: { session: 'cookie', isNewUser: true, user: { id: 'u2', roles: ['CUSTOMER'] } } } }
      : { body: { success: true } }));
    await expect(verifyOtpLogin('+5926009998', '123456')).rejects.toThrow('No Swift account is registered to that number.');
    expect(posts(fetch)).toEqual(['/api/v1/auth/verify-otp', '/api/v1/auth/logout']);
  });
  it('an admin signs in and nothing is signed out', async () => {
    const fetch = mockApi(() => ({ body: { success: true, data: { session: 'cookie', isNewUser: false, user: { id: 'u3', roles: ['ADMIN'] } } } }));
    await expect(verifyOtpLogin('+5926009997', '123456')).resolves.toMatchObject({ id: 'u3' });
    expect(posts(fetch)).toEqual(['/api/v1/auth/verify-otp']);
  });
  it('a wrong code is refused without a sign-out call (no session was made)', async () => {
    const fetch = mockApi(() => ({ status: 400, body: { success: false, error: { code: 'INVALID_OTP', message: 'That code is not valid.' } } }));
    await expect(verifyOtpLogin('+5926009996', '000000')).rejects.toThrow('That code is not valid.');
    expect(posts(fetch)).toEqual(['/api/v1/auth/verify-otp']);
  });
});
