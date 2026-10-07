import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { ACCESS_COOKIE, REFRESH_COOKIE, SIGNUP_CONTINUATION_COOKIE, resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { devChannelLog } from '../providers/notifications/channels';
import { loginWithOtp } from './helpers/otp';
import { grantStepUp } from './helpers/step-up';
import { PASSWORD_FAILURES_PER_ACCOUNT, passwordPausedNoticeKeys, resetPasswordAttemptBudget } from '../modules/auth/password-attempts';
import { NotificationService } from '../modules/notification/notification.service';

// ---------------------------------------------------------------------------
// [L04 · MASTER-056, MASTER-041, MASTER-003] Credentials and lockouts.
//  - MASTER-056: wrong passwords are budgeted per (account, source). A guesser
//    at one address locks only that address; the owner elsewhere signs in, and
//    SMS-code sign-in is never locked by password failures.
//  - MASTER-041: a browser's password sign-in gets the session as cookies and
//    no credential in the body, exactly like SMS-code sign-in. Native is
//    unchanged.
//  - MASTER-003: setting a password needs a fresh step-up on THIS session; it
//    ends every other session, replaces this session's credentials (the old
//    refresh token stops working) and tells the owner.
// ---------------------------------------------------------------------------

const PREFIX = '+5920414';
const LOCK_PHONE = `${PREFIX}001`;
const BROWSER_PHONE = `${PREFIX}002`;
const SET_PHONE = `${PREFIX}003`;
const SET_OTHER_STEP_UP_PHONE = `${PREFIX}004`;
const SPRAY_PHONE = `${PREFIX}005`;
// Outside the launch market: no text may be sent to it.
const FOREIGN_PHONE = '+447700900414';
const OUTAGE_PHONE = `${PREFIX}006`;
const SLOW_NOTICE_PHONE = `${PREFIX}007`;
const REPEAT_PHONE = `${PREFIX}008`;
const OUTAGE_UNKNOWN_PHONE = `${PREFIX}099`;
const ALL_PHONES = [LOCK_PHONE, BROWSER_PHONE, SET_PHONE, SET_OTHER_STEP_UP_PHONE, SPRAY_PHONE, FOREIGN_PHONE, OUTAGE_PHONE, SLOW_NOTICE_PHONE, REPEAT_PHONE];
const PASSWORD = 'credentials-password-1';
const NEW_PASSWORD = 'credentials-password-2';
const ATTACKER_IP = '203.0.113.7';
const OWNER_IP = '198.51.100.20';
const ORIGIN = 'http://localhost:3001';

let app: FastifyInstance;

function post(url: string, payload: Record<string, unknown>, extra: { headers?: Record<string, string>; remoteAddress?: string } = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/auth/${url}`,
    payload,
    headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
    ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
  });
}

async function createUser(phone: string, password: string | null = PASSWORD) {
  return app.prisma.user.create({
    data: {
      phone,
      firstName: 'Cred',
      lastName: 'Ential',
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      status: 'ACTIVE',
      isPhoneVerified: true,
      passwordHash: password === null ? null : await bcrypt.hash(password, 4),
      customer: { create: {} },
    },
  });
}

async function cleanup() {
  const users = await app.prisma.user.findMany({ where: { phone: { in: ALL_PHONES } }, select: { id: true } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await app.prisma.user.deleteMany({ where: { phone: { in: ALL_PHONES } } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['CORS_ORIGIN'] = ORIGIN;
  resetBrowserOriginsForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

describe('[MASTER-056] a guesser at one address cannot lock the owner out', () => {
  it('five failures from one source lock that source only; the owner signs in from another source, and by SMS code', async () => {
    const user = await createUser(LOCK_PHONE);
    for (let i = 0; i < 5; i += 1) {
      const attempt = await post('password/login', { phone: LOCK_PHONE, password: `guess-${i}-wrong` }, { remoteAddress: ATTACKER_IP });
      expect(attempt.statusCode).toBe(401);
    }

    // The per-source lock still triggers: even the right password from the
    // guesser's address is refused, with the ordinary refusal.
    const fromAttacker = await post('password/login', { phone: LOCK_PHONE, password: PASSWORD }, { remoteAddress: ATTACKER_IP });
    expect(fromAttacker.statusCode).toBe(401);
    expect(fromAttacker.json().error.code).toBe('INVALID_CREDENTIALS');

    // The owner, elsewhere, is not locked out by someone else's failures.
    const fromOwner = await post('password/login', { phone: LOCK_PHONE, password: PASSWORD }, { remoteAddress: OWNER_IP });
    expect(fromOwner.statusCode, fromOwner.body).toBe(200);

    // And SMS-code sign-in is never closed by password failures.
    const byCode = await loginWithOtp(app, LOCK_PHONE);
    expect(byCode.statusCode, byCode.body).toBe(200);

    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(2);
  });
});

describe('[MASTER-056] rotating addresses cannot guess one account without bound', () => {
  it('failures spread across many sources reach an account-wide ceiling: password sign-in pauses for every source, SMS-code sign-in stays open', async () => {
    const user = await createUser(SPRAY_PHONE);
    // One wrong password from each of many addresses: no single source ever
    // reaches its own limit of five.
    const pausedNotices = async () => (await app.prisma.notification.findMany({ where: { userId: user.id } }))
      .filter((n) => (n.data as { kind?: string } | null)?.kind === 'password_sign_in_paused');
    for (let i = 0; i < PASSWORD_FAILURES_PER_ACCOUNT; i += 1) {
      const attempt = await post('password/login', { phone: SPRAY_PHONE, password: `spray-${i}-wrong` }, { remoteAddress: `198.18.${Math.floor(i / 250)}.${(i % 250) + 1}` });
      expect(attempt.statusCode).toBe(401);
      // No notice until the ceiling itself trips.
      if (i === PASSWORD_FAILURES_PER_ACCOUNT - 2) expect(await pausedNotices()).toHaveLength(0);
    }
    // Now even the right password, from an address never seen, is refused with the ordinary answer…
    const fresh = await post('password/login', { phone: SPRAY_PHONE, password: PASSWORD }, { remoteAddress: '192.0.2.200' });
    expect(fresh.statusCode, fresh.body).toBe(401);
    expect(fresh.json().error.code).toBe('INVALID_CREDENTIALS');
    // …and SMS-code sign-in is still open to the owner.
    const byCode = await loginWithOtp(app, SPRAY_PHONE);
    expect(byCode.statusCode, byCode.body).toBe(200);
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(1);
    // The account holder is told once, in the app (no text: a text per pause would be a spam lever).
    await expect.poll(async () => (await pausedNotices()).length, { timeout: 5000 }).toBe(1);
    const paused = await pausedNotices();
    expect(paused).toHaveLength(1);
    expect(paused[0]!.body).toMatch(/code/i);
  });
});

describe('[MASTER-054 × MASTER-056] the ceiling-trip attempt is not slower than any other refusal', () => {
  it('the attempt that trips the account pause answers without waiting for the notice to be delivered', async () => {
    const user = await createUser(SLOW_NOTICE_PHONE);
    for (let i = 0; i < PASSWORD_FAILURES_PER_ACCOUNT - 1; i += 1) {
      const attempt = await post('password/login', { phone: SLOW_NOTICE_PHONE, password: `slow-${i}-wrong` }, { remoteAddress: `198.19.${Math.floor(i / 250)}.${(i % 250) + 1}` });
      expect(attempt.statusCode).toBe(401);
    }
    // Hold every notice delivery until released: an in-band send would hold the response too.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = NotificationService.prototype.send;
    const held = vi.spyOn(NotificationService.prototype, 'send').mockImplementation(async function (this: NotificationService, ...args) {
      await gate;
      return original.apply(this, args);
    });
    try {
      const trip = post('password/login', { phone: SLOW_NOTICE_PHONE, password: 'slow-last-wrong' }, { remoteAddress: '198.19.9.9' });
      const answered = await Promise.race([trip.then((r) => r.statusCode), new Promise((resolve) => setTimeout(() => resolve('held'), 2000))]);
      expect(answered).toBe(401);
      // The notice is on its way (it reaches the held delivery after the answer was given).
      await expect.poll(() => held.mock.calls.length, { timeout: 2000 }).toBe(1);
    } finally {
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      held.mockRestore();
    }
    await expect.poll(async () => (await app.prisma.notification.findMany({ where: { userId: user.id } }))
      .filter((n) => (n.data as { kind?: string } | null)?.kind === 'password_sign_in_paused').length, { timeout: 5000 }).toBe(1);
  });
});

describe('[MASTER-056 · review r2 S3-1] the pause notice cannot be used to keep sounding a phone', () => {
  it('pauses re-tripped within a day give no further notice; a later one lands in the inbox without a push', async () => {
    const user = await createUser(REPEAT_PHONE);
    const notices = async () => (await app.prisma.notification.findMany({ where: { userId: user.id } }))
      .filter((n) => (n.data as { kind?: string } | null)?.kind === 'password_sign_in_paused');
    const send = vi.spyOn(NotificationService.prototype, 'send');
    const trip = async (round: number) => {
      // A fresh budget generation stands in for the 15-minute pause expiring.
      await resetPasswordAttemptBudget(app.redis, user.id);
      for (let i = 0; i < PASSWORD_FAILURES_PER_ACCOUNT; i += 1) {
        const attempt = await post('password/login', { phone: REPEAT_PHONE, password: `repeat-${round}-${i}-wrong` }, { remoteAddress: `198.20.${round}.${i + 1}` });
        expect(attempt.statusCode).toBe(401);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    };
    try {
      await trip(1);
      await expect.poll(async () => (await notices()).length, { timeout: 5000 }).toBe(1);
      await trip(2);
      await trip(3);
      expect(await notices()).toHaveLength(1);
      expect(send).toHaveBeenCalledTimes(1);
      // A day later (its daily mark gone), a new pause is recorded quietly: an inbox row, no push.
      await app.redis.del(passwordPausedNoticeKeys(user.id).daily);
      await trip(4);
      await expect.poll(async () => (await notices()).length, { timeout: 5000 }).toBe(2);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
  });
});

describe('[MASTER-054 × MASTER-056] a budget-store outage is not an account oracle', () => {
  it('with the budget store failing, an unknown account and an existing one (wrong or right password) get the same refusal after the same store calls', async () => {
    await createUser(OUTAGE_PHONE);
    const calls: Record<string, number> = {};
    const answers: Record<string, { status: number; body: string }> = {};
    const fail = () => Promise.reject(new Error('injected: budget store down'));
    const spies = (['get', 'exists', 'eval', 'del', 'incr', 'expire'] as const).map((m) => vi.spyOn(app.redis, m).mockImplementation(fail as never));
    try {
      for (const [label, payload] of [
        ['unknown', { phone: OUTAGE_UNKNOWN_PHONE, password: 'outage-wrong-1' }],
        ['existing-wrong', { phone: OUTAGE_PHONE, password: 'outage-wrong-1' }],
        ['existing-right', { phone: OUTAGE_PHONE, password: PASSWORD }],
      ] as const) {
        for (const spy of spies) spy.mockClear();
        const res = await post('password/login', payload, { remoteAddress: '192.0.2.77' });
        answers[label] = { status: res.statusCode, body: res.body };
        calls[label] = spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(answers['unknown']!.status).toBe(401);
    expect(answers['existing-wrong']).toEqual(answers['unknown']);
    expect(answers['existing-right']).toEqual(answers['unknown']);
    expect(calls['existing-wrong']).toBe(calls['unknown']);
    expect(calls['existing-right']).toBe(calls['unknown']);
  });
});

describe('[MASTER-041] browser password sign-in uses cookies, never a token in the body', () => {
  it('a browser gets HttpOnly session cookies and a body with no tokens', async () => {
    await createUser(BROWSER_PHONE);
    const res = await post('password/login', { phone: BROWSER_PHONE, password: PASSWORD }, {
      headers: { 'x-swift-client': 'web', origin: ORIGIN },
    });
    expect(res.statusCode, res.body).toBe(200);
    const cookies = ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
    expect(cookies.some((c) => c.startsWith(`${ACCESS_COOKIE}=`) && /HttpOnly/i.test(c))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${REFRESH_COOKIE}=`) && /HttpOnly/i.test(c))).toBe(true);
    const data = res.json().data;
    expect(data.tokens).toBeUndefined();
    expect(data.session).toBe('cookie');
    expect(res.body).not.toMatch(/accessToken|refreshToken/);
    // A signup continuation left from an abandoned SMS-code signup is cleared, as verify-otp does.
    expect(cookies.some((c) => c.startsWith(`${SIGNUP_CONTINUATION_COOKIE}=`) && /Max-Age=0/i.test(c))).toBe(true);
  });

  it('a native client still gets its tokens in the body and no cookies', async () => {
    const res = await post('password/login', { phone: BROWSER_PHONE, password: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(typeof res.json().data.tokens.accessToken).toBe('string');
    expect(typeof res.json().data.tokens.refreshToken).toBe('string');
  });
});

describe('[MASTER-003] setting a password needs fresh proof and ends the other sessions', () => {
  it('refuses without a fresh step-up on this session, and stores nothing', async () => {
    const user = await createUser(SET_PHONE, null);
    const login = await loginWithOtp(app, SET_PHONE);
    const token = login.json().data.tokens.accessToken as string;

    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/password/set', payload: { password: NEW_PASSWORD },
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toBeNull();
  });

  it('a step-up earned by ANOTHER session of the same account does not count', async () => {
    await createUser(SET_OTHER_STEP_UP_PHONE, null);
    const mine = (await loginWithOtp(app, SET_OTHER_STEP_UP_PHONE)).json().data.tokens.accessToken as string;
    const other = (await loginWithOtp(app, SET_OTHER_STEP_UP_PHONE)).json().data.tokens.accessToken as string;
    await grantStepUp(app, other);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/password/set', payload: { password: NEW_PASSWORD },
      headers: { authorization: `Bearer ${mine}`, 'content-type': 'application/json' },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
  });

  it('with a step-up: other sessions end, this session gets new credentials, the old refresh token is refused, the owner is told', async () => {
    const user = await app.prisma.user.findUniqueOrThrow({ where: { phone: SET_PHONE } });
    await app.prisma.session.deleteMany({ where: { userId: user.id } });
    const mine = (await loginWithOtp(app, SET_PHONE)).json().data.tokens as { accessToken: string; refreshToken: string };
    const other = (await loginWithOtp(app, SET_PHONE)).json().data.tokens as { accessToken: string; refreshToken: string };
    await grantStepUp(app, mine.accessToken);
    // The other device's push registration (tokens are per install, not per session).
    const otherDevice = await app.prisma.deviceToken.create({ data: { userId: user.id, token: `ExponentPushToken[l04-other-${Date.now()}]`, platform: 'android', isActive: true } });
    const smsBefore = devChannelLog.length;

    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/password/set', payload: { password: NEW_PASSWORD },
      headers: { authorization: `Bearer ${mine.accessToken}`, 'content-type': 'application/json' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(NEW_PASSWORD, after.passwordHash!)).toBe(true);

    // The other device's session is gone and its refresh token is refused.
    const otherRefresh = await post('refresh', { refreshToken: other.refreshToken });
    expect(otherRefresh.statusCode).toBe(401);
    // This session's credentials were replaced: the old refresh token is refused too…
    const oldRefresh = await post('refresh', { refreshToken: mine.refreshToken });
    expect(oldRefresh.statusCode).toBe(401);
    // …and the new pair works.
    const fresh = res.json().data.tokens as { accessToken: string; refreshToken: string };
    expect(fresh.refreshToken).not.toBe(mine.refreshToken);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${fresh.accessToken}` } });
    expect(me.statusCode, me.body).toBe(200);
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(1);
    // The ended device stops receiving pushes too (the notice included): every
    // registration is retired in the same transaction, and this device
    // re-registers its own on its next launch — exactly as after a reset.
    expect((await app.prisma.deviceToken.findUniqueOrThrow({ where: { id: otherDevice.id } })).isActive).toBe(false);

    // The owner is told: an inbox row, and a text to the phone on the account.
    const notices = await app.prisma.notification.findMany({ where: { userId: user.id } });
    expect(notices.filter((n) => (n.data as { kind?: string } | null)?.kind === 'password_changed')).toHaveLength(1);
    expect(devChannelLog.slice(smsBefore).filter((e) => e.channel === 'sms' && e.to === SET_PHONE)).toHaveLength(1);
  });

  it('the password-changed text passes the launch-market gate like every other text', async () => {
    const user = await createUser(FOREIGN_PHONE, null);
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: `l04-foreign-${Date.now()}` });
    await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: `l04-foreign-refresh-${Date.now()}`, authMethod: 'OTP', deviceId: 'l04', deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } });
    await grantStepUp(app, token);
    const smsBefore = devChannelLog.length;
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/password/set', payload: { password: NEW_PASSWORD },
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(devChannelLog.slice(smsBefore).filter((e) => e.channel === 'sms')).toHaveLength(0);
  });
});
