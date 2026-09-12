import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SIGNUP_CONTINUATION_COOKIE,
  clearSignupContinuationCookie,
  resetBrowserOriginsForTests,
  setSessionCookies,
  setSignupContinuationCookie,
  signupContinuationOf,
} from './browser-session';

function replyHarness() {
  const headers = new Map<string, string | string[]>();
  return {
    reply: {
      getHeader(name: string) { return headers.get(name); },
      header(name: string, value: string | string[]) { headers.set(name, value); return this; },
    } as unknown as FastifyReply,
    cookies: () => ([] as string[]).concat(headers.get('Set-Cookie') ?? []),
  };
}

beforeEach(() => {
  process.env['CORS_ORIGIN'] = 'https://swift.example';
  resetBrowserOriginsForTests();
});

afterEach(() => {
  delete process.env['CORS_ORIGIN'];
  resetBrowserOriginsForTests();
});

describe('browser signup continuation', () => {
  it('issues a short-lived HttpOnly strict cookie and marks it Secure in production', () => {
    const { reply, cookies } = replyHarness();
    setSignupContinuationCookie(reply, 'opaque-proof', { NODE_ENV: 'production' });
    expect(cookies()).toEqual([
      expect.stringMatching(/^swift_signup=opaque-proof; Path=\/api\/v1\/auth; Max-Age=600; HttpOnly; SameSite=Strict; Secure$/),
    ]);
  });

  it('accepts a browser cookie only for a named client at an allowed origin', () => {
    const body = { registrationProof: 'body-proof' };
    const cookie = `${SIGNUP_CONTINUATION_COOKIE}=cookie-proof`;
    expect(signupContinuationOf({ headers: { 'x-swift-client': 'web', origin: 'https://swift.example', cookie }, body })).toBe('cookie-proof');
    expect(signupContinuationOf({ headers: { 'x-swift-client': 'web', origin: 'https://evil.example', cookie }, body })).toBeNull();
    expect(signupContinuationOf({ headers: { 'x-swift-client': 'web', cookie }, body })).toBeNull();
  });

  it('uses the body for native clients and never lets an untrusted browser fall back to it', () => {
    const body = { registrationProof: 'native-proof' };
    expect(signupContinuationOf({ headers: {}, body })).toBe('native-proof');
    expect(signupContinuationOf({
      headers: { 'x-swift-client': 'web', origin: 'https://evil.example' },
      body,
    })).toBeNull();
  });

  it('preserves a signup-cookie deletion when the session pair is appended', () => {
    const { reply, cookies } = replyHarness();
    clearSignupContinuationCookie(reply, { NODE_ENV: 'production' });
    setSessionCookies(reply, { accessToken: 'access', refreshToken: 'refresh' }, { NODE_ENV: 'production' });

    expect(cookies()).toHaveLength(3);
    expect(cookies()[0]).toMatch(new RegExp(`^${SIGNUP_CONTINUATION_COOKIE}=; .*Max-Age=0`));
    expect(cookies()[1]).toMatch(new RegExp(`^${ACCESS_COOKIE}=access;`));
    expect(cookies()[2]).toMatch(new RegExp(`^${REFRESH_COOKIE}=refresh;`));
  });
});
