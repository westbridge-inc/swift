import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  clearSessionCookies, clearSignupContinuationCookie,
  setSessionCookies, setSignupContinuationCookie,
} from '../modules/auth/browser-session';

describe('browser credentials follow the HTTPS transport', () => {
  async function cookies(env: Record<string, string | undefined>, trustProxy = false, forwarded = 'http') {
    const app = Fastify({ trustProxy });
    app.get('/', async (_request, reply) => {
      setSessionCookies(reply, { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' }, env);
      setSignupContinuationCookie(reply, 'synthetic-signup', env);
      clearSessionCookies(reply, env);
      clearSignupContinuationCookie(reply, env);
      return { ok: true };
    });
    try {
      const response = await app.inject({ url: '/', headers: { 'x-forwarded-proto': forwarded } });
      const values = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
      expect(values).toHaveLength(6);
      for (const value of values) {
        expect(value).toContain('HttpOnly');
        expect(value).toContain('SameSite=Strict');
      }
      return values;
    } finally {
      await app.close();
    }
  }

  it('HTTPS public URL marks issue and deletion cookies Secure in staging', async () => {
    for (const value of await cookies({ NODE_ENV: 'loadtest', API_PUBLIC_URL: 'https://staging.example.test' })) {
      expect(value).toMatch(/; Secure(?:;|$)/);
    }
  });

  it('trusted HTTPS request marks every cookie Secure even without a public URL', async () => {
    for (const value of await cookies({ NODE_ENV: 'loadtest' }, true, 'https')) {
      expect(value).toMatch(/; Secure(?:;|$)/);
    }
  });

  it('HTTP local development stays usable and does not trust an arbitrary forwarded header', async () => {
    for (const value of await cookies({ NODE_ENV: 'development', API_PUBLIC_URL: 'http://localhost:3000' }, false, 'https')) {
      expect(value).not.toMatch(/; Secure(?:;|$)/);
    }
  });

  it('production keeps Secure even when the public URL is HTTP', async () => {
    for (const value of await cookies({ NODE_ENV: 'production', API_PUBLIC_URL: 'http://localhost:3000' })) {
      expect(value).toMatch(/; Secure(?:;|$)/);
    }
  });
});
