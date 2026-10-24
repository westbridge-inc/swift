import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { buildApp } from '../app';
import { runWithoutTenant } from '../plugins/prisma';
import { ACCESS_COOKIE, resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { EXPECTED_PRINCIPAL_HEADER } from '../modules/auth/expected-principal';
import { requestOtp } from './helpers/otp';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [Row 225 · AUTH-PIN] The server binds a write to the account the page expected.
//
// One browser, one cookie jar, two tabs: tab 1 is still showing account A when
// someone signs in as account B in tab 2. Tab 1's next write carries B's
// cookie. The web client names the account it expects (X-Swift-Expected-
// Principal); the API refuses a state-changing request whose session is
// anyone else (409 SESSION_CHANGED) BEFORE the route runs, so nothing lands
// in B's account on A's behalf. A request that names no one — every phone
// build (9-11 included), every native client — is exactly what it was.
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost:3001';
const WEB = { 'x-swift-client': 'web', origin: ORIGIN } as const;
const PHONE_A = testPhone();
const PHONE_B = testPhone();

let app: FastifyInstance;
const ids: Record<'A' | 'B', string> = { A: '', B: '' };
/** The shared jar after tab 2 signed in as B (tab 1 had signed in as A first), and a phone's bearer token for B. */
let jarB = '';
let bearerB = '';
const priorCors = process.env['CORS_ORIGIN'];

function cookieOf(res: { headers: Record<string, unknown> }, name: string): string {
  for (const line of ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? [])) {
    const pair = line.split(';')[0]!;
    const at = pair.indexOf('=');
    if (pair.slice(0, at) === name) return decodeURIComponent(pair.slice(at + 1));
  }
  throw new Error(`no ${name} cookie issued`);
}

/** A browser signing in: the session arrives as cookies; the jar's access cookie is returned. */
async function browserSignIn(phone: string): Promise<string> {
  const code = await requestOtp(app, phone);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', payload: { phone, code }, headers: { 'content-type': 'application/json', ...WEB } });
  expect(res.statusCode, res.body).toBe(200);
  return cookieOf(res, ACCESS_COOKIE);
}

const browser = (jarAccess: string, expected?: string) => ({
  ...WEB,
  cookie: `${ACCESS_COOKIE}=${encodeURIComponent(jarAccess)}`,
  ...(expected !== undefined ? { [EXPECTED_PRINCIPAL_HEADER]: expected } : {}),
});

const putProfile = (firstName: string, headers: Record<string, string>) => app.inject({
  method: 'PUT', url: '/api/v1/customer/profile', payload: { firstName }, headers: { 'content-type': 'application/json', ...headers },
});
const firstNameOf = async (id: string) => (await runWithoutTenant(
  () => app.prisma.user.findUniqueOrThrow({ where: { id }, select: { firstName: true } }),
  'test-read:expected-principal',
)).firstName;

beforeAll(async () => {
  process.env['CORS_ORIGIN'] = ORIGIN;
  resetBrowserOriginsForTests();
  app = await buildApp();
  // The one guest-capable WRITE in the API (POST /ads/events) sits behind the
  // ads-off switch at launch, so the optional-auth decorator is exercised
  // through a route of its own here — the decorator is what holds the check.
  app.post('/api/v1/__test/optional-write', { preHandler: [app.authenticateOptional] }, async (request) => ({
    success: true, data: { principal: request.authSessionId ? request.user.userId : null },
  }));
  await app.ready();
  for (const [key, phone] of [['A', PHONE_A], ['B', PHONE_B]] as const) {
    const user = await app.prisma.user.create({
      data: {
        phone, firstName: `Pin${key}`, lastName: `Principal${nanoid(4)}`, isPhoneVerified: true, status: 'ACTIVE',
        roles: ['CUSTOMER'], activeRole: 'CUSTOMER', customer: { create: {} },
      },
      select: { id: true },
    });
    ids[key] = user.id;
  }
  // One OTP per phone per run (the send limit): tab 1 signs in as A, then tab 2
  // signs in as B — the one cookie jar the browser shares now holds B.
  await browserSignIn(PHONE_A);
  jarB = await browserSignIn(PHONE_B);
  // A phone's session for B, issued the way the API stores every session.
  bearerB = app.jwt.sign({ userId: ids.B, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: ids.B, token: bearerB, refreshToken: nanoid(64), deviceId: 'pin-phone', deviceType: 'ios', expiresAt: new Date(Date.now() + 3_600_000) },
  });
});

afterAll(async () => {
  const userIds = [ids.A, ids.B].filter(Boolean);
  await runWithoutTenant(async () => {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:expected-principal');
  if (priorCors === undefined) delete process.env['CORS_ORIGIN']; else process.env['CORS_ORIGIN'] = priorCors;
  resetBrowserOriginsForTests();
  await app.close();
});

describe('[Row 225] a shared browser: a stale tab never writes into the account now signed in', () => {
  it('tab 1 expected A, the jar now holds B: the write is refused 409 SESSION_CHANGED and B is untouched', async () => {
    const before = await firstNameOf(ids.B);
    const res = await putProfile('WrittenByTabOne', browser(jarB, ids.A));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SESSION_CHANGED');
    expect(await firstNameOf(ids.B)).toBe(before);
    expect(await firstNameOf(ids.A)).toBe('PinA');
  });

  it('the same cookie, expecting the account it really names, writes as before', async () => {
    const jar = jarB;
    const res = await putProfile('PinBRenamed', browser(jar, ids.B));
    expect(res.statusCode, res.body).toBe(200);
    expect(await firstNameOf(ids.B)).toBe('PinBRenamed');
  });

  it('a stale tab cannot sign the other account out: logout expecting A with B\'s cookie is refused and B stays signed in', async () => {
    const jar = jarB;
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', payload: {}, headers: { 'content-type': 'application/json', ...browser(jar, ids.A) } });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SESSION_CHANGED');
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: browser(jar) });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().data.user.id).toBe(ids.B);
  });

  it('a repeated header is no single expectation: refused, never matched', async () => {
    const jar = jarB;
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/customer/profile', payload: { firstName: 'Twice' },
      headers: { 'content-type': 'application/json', ...browser(jar), [EXPECTED_PRINCIPAL_HEADER]: [ids.B, ids.B] },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(await firstNameOf(ids.B)).not.toBe('Twice');
  });

  it('a guest-capable write (optional auth) expecting A is refused under B\'s cookie and with no session at all', async () => {
    const jar = jarB;
    const write = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/v1/__test/optional-write', payload: {}, headers: { 'content-type': 'application/json', ...headers } });
    const asB = await write(browser(jar, ids.A));
    expect(asB.statusCode, asB.body).toBe(409);
    expect(asB.json().error.code).toBe('SESSION_CHANGED');
    const asGuest = await write({ ...WEB, [EXPECTED_PRINCIPAL_HEADER]: ids.A });
    expect(asGuest.statusCode, asGuest.body).toBe(409);
    // the account it really names, a guest declaring nothing, and B declaring nothing: as before
    expect((await write(browser(jar, ids.B))).json().data.principal).toBe(ids.B);
    expect((await write({ ...WEB })).json().data.principal).toBeNull();
    expect((await write(browser(jar))).json().data.principal).toBe(ids.B);
  });

  it('a read is never refused for its expectation (it writes nothing; the web client refuses to render it)', async () => {
    const jar = jarB;
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: browser(jar, ids.A) });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().data.user.id).toBe(ids.B);
  });
});

describe('[Row 225] the header is optional: phone builds and native clients are unchanged', () => {
  it('a bearer write with no expectation (every phone build: 9, 10, 11) succeeds exactly as before', async () => {
    const accessToken = bearerB;
    const res = await putProfile('PinBPhone', { authorization: `Bearer ${accessToken}`, 'x-client-platform': 'ios' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await firstNameOf(ids.B)).toBe('PinBPhone');
  });

  it('a browser write with no expectation (an older web bundle) succeeds exactly as before', async () => {
    const jar = jarB;
    const res = await putProfile('PinBOldBundle', browser(jar));
    expect(res.statusCode, res.body).toBe(200);
    expect(await firstNameOf(ids.B)).toBe('PinBOldBundle');
  });

  it('an empty header declares nothing', async () => {
    const jar = jarB;
    const res = await putProfile('PinBEmpty', browser(jar, ''));
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a bearer client that DOES declare is held to it like a browser', async () => {
    const accessToken = bearerB;
    const wrong = await putProfile('PinBWrong', { authorization: `Bearer ${accessToken}`, [EXPECTED_PRINCIPAL_HEADER]: ids.A });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(await firstNameOf(ids.B)).not.toBe('PinBWrong');
    const right = await putProfile('PinBRight', { authorization: `Bearer ${accessToken}`, [EXPECTED_PRINCIPAL_HEADER]: ids.B });
    expect(right.statusCode, right.body).toBe(200);
  });
});
