import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { rateLimitKey } from '../utils/rate-limit-key';
import { registerErrorHandler } from '../middleware/error-handler';
import { AUTH_LIMITS, bodyPhone, perAddress, perCredential, sessionCookie } from '../modules/auth/auth-rate-limits';

// ---------------------------------------------------------------------------
// [FLOW-QA F15] The sign-in limits with no database: the limiter the API registers (in-memory here, Redis in
// production) and two routes built from the same helpers auth.routes.ts uses. People behind one carrier address
// each get their own per-number allowance; one number is held as tightly as before; one address is still bounded.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const send = (phone: string, remoteAddress = '198.51.100.7') =>
  app.inject({ method: 'POST', url: '/send', payload: { phone }, remoteAddress });
const refresh = (cookie: string | null, remoteAddress = '198.51.100.9') =>
  app.inject({ method: 'POST', url: '/refresh', remoteAddress, ...(cookie ? { headers: { cookie } } : {}) });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(rateLimit, { keyGenerator: rateLimitKey(() => { throw new Error('no tokens here'); }), max: 1000, timeWindow: '1 minute' });
  await app.register(async (scope) => {
    scope.post('/send', { config: perAddress(AUTH_LIMITS.codePerAddress), preValidation: perCredential(scope, 'code', AUTH_LIMITS.codePerNumber, bodyPhone) }, async () => ({ success: true }));
    scope.post('/refresh', { config: perAddress(AUTH_LIMITS.refreshPerAddress), preValidation: perCredential(scope, 'refresh', AUTH_LIMITS.refreshPerSession, sessionCookie) }, async () => ({ success: true }));
  });
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe('[FLOW-QA F15] per address AND number, then per address alone', () => {
  it('one number from one address: held after the per-number ceiling, with the wait to count down', async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= AUTH_LIMITS.codePerNumber; i++) statuses.push((await send('+592 600 1001')).statusCode);
    expect(statuses.slice(0, AUTH_LIMITS.codePerNumber)).toEqual(Array(AUTH_LIMITS.codePerNumber).fill(200));
    const refused = await send('+5926001001');
    expect(refused.statusCode).toBe(429);
    const body = refused.json() as { error: { code: string; details: { retryAfterSeconds: number; codeAlreadySent: boolean } } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.error.details.codeAlreadySent).toBe(false);
  });

  it('the same number typed differently is the same number', async () => {
    for (let i = 0; i < AUTH_LIMITS.codePerNumber; i++) await send(i % 2 ? '+592-600-1002' : '+592 600 1002', '198.51.100.20');
    expect((await send('+5926001002', '198.51.100.20')).statusCode).toBe(429);
  });

  it('many people behind one carrier address each get their own allowance (the old 5-a-minute address cap is gone)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await send(`+59260020${String(i).padStart(2, '0')}`, '198.51.100.30')).statusCode);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('one address rotating through numbers is still bounded by the per-address ceiling', async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= AUTH_LIMITS.codePerAddress; i++) statuses.push((await send(`+59260030${String(i).padStart(2, '0')}`, '198.51.100.40')).statusCode);
    expect(statuses.slice(0, AUTH_LIMITS.codePerAddress).every((s) => s === 200)).toBe(true);
    expect(statuses[AUTH_LIMITS.codePerAddress]).toBe(429);
  });

  it('the same number from another address has its own allowance', async () => {
    for (let i = 0; i < AUTH_LIMITS.codePerNumber; i++) await send('+5926001003', '198.51.100.50');
    expect((await send('+5926001003', '198.51.100.50')).statusCode).toBe(429);
    expect((await send('+5926001003', '198.51.100.51')).statusCode).toBe(200);
  });
});

describe('[FLOW-QA F15] refresh: per address AND session, then per address alone', () => {
  it('one session refreshing too often is held; another session on the same address is not', async () => {
    for (let i = 0; i < AUTH_LIMITS.refreshPerSession; i++) expect((await refresh('swift_rt=one')).statusCode).toBe(200);
    expect((await refresh('swift_rt=one')).statusCode).toBe(429);
    expect((await refresh('swift_rt=two')).statusCode).toBe(200);
  });

  it('rotating cookies from one address is still bounded', async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= AUTH_LIMITS.refreshPerAddress; i++) statuses.push((await refresh(`swift_rt=r${i}`, '198.51.100.60')).statusCode);
    expect(statuses[AUTH_LIMITS.refreshPerAddress]).toBe(429);
  });

  it('the ceilings are the reviewed numbers', () => {
    expect(AUTH_LIMITS).toEqual({ codePerNumber: 5, codePerAddress: 30, accountPerNumber: 10, accountPerAddress: 30, refreshPerSession: 10, refreshPerAddress: 60 });
  });
});
