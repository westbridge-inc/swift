import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply } from 'fastify';
import type { FastifyRequest } from 'fastify';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  adoptCookieCredential,
  SIGNUP_CONTINUATION_COOKIE,
  clearSignupContinuationCookie,
  resetBrowserOriginsForTests,
  setSessionCookies,
  setSignupContinuationCookie,
  signupContinuationOf,
} from './browser-session';
import { registerErrorHandler } from '../../middleware/error-handler';

function replyHarness() {
  const headers = new Map<string, string | string[]>();
  return {
    reply: {
      getHeader(name: string) { return headers.get(name); },
      header(name: string, value: string | string[]) { headers.set(name, value); return this; },
      removeHeader(name: string) { headers.delete(name); return this; },
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

describe('[AUTH-SRC] cookie provenance survives a second authenticate pass', () => {
  // authenticate() runs twice on admin routes (the plugin's onRequest hook and
  // the per-route guard). The first pass writes the cookie into Authorization;
  // the second used to read that Bearer and relabel the session 'bearer', so a
  // gate keyed on request.authCredentialSource === 'cookie' (the web taxi
  // refusal, #1271) would have been bypassed on any double-authenticated route.
  const browser = () => ({
    headers: { 'x-swift-client': 'admin-web', origin: 'https://swift.example', cookie: `${ACCESS_COOKIE}=cookie-token` } as Record<string, string>,
  }) as unknown as FastifyRequest;

  it('a cookie session is "cookie" on every pass, the header adopted once', () => {
    const request = browser();
    expect(adoptCookieCredential(request)).toBe('cookie');
    expect(request.headers.authorization).toBe('Bearer cookie-token');
    expect(adoptCookieCredential(request)).toBe('cookie');
    expect(adoptCookieCredential(request)).toBe('cookie');
    expect(request.headers.authorization).toBe('Bearer cookie-token');
  });

  it('a real Bearer stays "bearer", and a request with neither stays unauthenticated', () => {
    const native = { headers: { authorization: 'Bearer native-token' } } as unknown as FastifyRequest;
    expect(adoptCookieCredential(native)).toBe('bearer');
    expect(adoptCookieCredential(native)).toBe('bearer');
    const none = { headers: {} } as unknown as FastifyRequest;
    expect(adoptCookieCredential(none)).toBeNull();
    expect(none.headers.authorization).toBeUndefined();
  });

  it('an ungated cookie (no named client) is never adopted, on any pass', () => {
    const request = { headers: { origin: 'https://swift.example', cookie: `${ACCESS_COOKIE}=cookie-token` } } as unknown as FastifyRequest;
    expect(adoptCookieCredential(request)).toBeNull();
    expect(adoptCookieCredential(request)).toBeNull();
    expect(request.headers.authorization).toBeUndefined();
  });
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

  it('emits exactly one deletion and one session pair on a real Fastify reply', async () => {
    const app = Fastify();
    app.get('/cookies', async (_request, reply) => {
      clearSignupContinuationCookie(reply, { NODE_ENV: 'production' });
      setSessionCookies(reply, { accessToken: 'access', refreshToken: 'refresh' }, { NODE_ENV: 'production' });
      return reply.send({ ok: true });
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/cookies' });
      const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
      expect(cookies).toHaveLength(3);
      expect(cookies.filter((value) => value.startsWith(`${SIGNUP_CONTINUATION_COOKIE}=`))).toHaveLength(1);
      expect(cookies.filter((value) => value.startsWith(`${ACCESS_COOKIE}=`))).toHaveLength(1);
      expect(cookies.filter((value) => value.startsWith(`${REFRESH_COOKIE}=`))).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('preserves exactly one continuation deletion through the real error handler', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.post('/failed-register', async (_request, reply) => {
      clearSignupContinuationCookie(reply, { NODE_ENV: 'production' });
      throw new Error('simulated post-consumption failure');
    });

    try {
      const response = await app.inject({ method: 'POST', url: '/failed-register' });
      const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
      expect(response.statusCode).toBe(500);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(new RegExp(`^${SIGNUP_CONTINUATION_COOKIE}=; .*Max-Age=0`));
    } finally {
      await app.close();
    }
  });
});
