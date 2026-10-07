import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { devChannelLog } from '../providers/notifications/channels';
import { guyanaDayKey } from '../utils/guyana-day';
import { SUPPORT_EMAIL_FALLBACK, supportEmail } from '../modules/auth/account-blocked';

// ---------------------------------------------------------------------------
// [NO-DEAD-ENDS · owner, 6 Oct] "Nobody is ever stuck without a reason and a
// next step." An account Swift suspended, banned or closed used to get one
// sentence at sign-in — "This account is suspended." — and nothing else: no
// way to learn why, and no door, because every in-app door (Get Help, appeal)
// needs the session it was just refused.
//
// The store build in review (build 9) shows the server's `error.message`
// verbatim on the code-entry screen and keys nothing on the text, so the next
// step must live IN the message. Every request below is the exact shape build
// 9 sends (POST /auth/send-otp {phone}, /auth/verify-otp {phone, code},
// /auth/refresh {refreshToken}); the status and code it branches on are
// unchanged.
// ---------------------------------------------------------------------------

const PREFIX = '+5920467';
const SUSPENDED_PHONE = `${PREFIX}001`;
const BANNED_PHONE = `${PREFIX}002`;
const DEACTIVATED_PHONE = `${PREFIX}003`;
const MID_SESSION_PHONE = `${PREFIX}004`;
const ALL_PHONES = [SUSPENDED_PHONE, BANNED_PHONE, DEACTIVATED_PHONE, MID_SESSION_PHONE];
const PASSWORD = 'no-dead-ends-password';
const BARE_OLD_MESSAGE = 'This account is suspended.';

let app: FastifyInstance;

async function clearOtpCounters(phone: string) {
  const day = guyanaDayKey(new Date());
  await app.redis.del(
    `otp_rate:${phone}`,
    `otp_hr:${phone}`,
    `otp_attempt:${phone}`,
    `otp_phone_day:${day}:${phone}`,
    `sms_global_day:${day}`,
    `sms_known_day:${day}`,
    `otp_ip_day:${day}:127.0.0.1`,
  );
}

/** Build 9's request: JSON body, no browser-client header. */
function post(url: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/auth/${url}`,
    payload,
    headers: { 'content-type': 'application/json' },
  });
}

/** The real send → verify ceremony: ask for a code, read the code the SMS carried. */
async function signInWithCode(phone: string) {
  await clearOtpCounters(phone);
  const before = devChannelLog.length;
  const sent = await post('send-otp', { phone });
  expect(sent.statusCode, sent.body).toBe(200);
  const sms = devChannelLog.slice(before).filter((entry) => entry.channel === 'sms' && entry.to === phone).at(-1);
  const code = sms?.body.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error('no code was texted to the test number');
  return post('verify-otp', { phone, code });
}

async function createUser(phone: string, status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED') {
  return app.prisma.user.create({
    data: {
      phone,
      firstName: 'Dead',
      lastName: 'End',
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      status,
      isPhoneVerified: true,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      customer: { create: {} },
    },
  });
}

/** What build 9's code-entry screen renders: `response.data.error.message`. */
function build9Shows(res: { json: () => any }) {
  return res.json()?.error?.message as string | undefined;
}

async function cleanup() {
  await app.prisma.user.deleteMany({ where: { phone: { in: ALL_PHONES } } });
  for (const phone of ALL_PHONES) await clearOtpCounters(phone);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  delete process.env['SUPPORT_EMAIL'];
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

describe('a blocked account is told what happened and the one door that works without a session', () => {
  it('SUSPENDED: the code-entry refusal says suspended + how to reach a person (build 9 shape, contract unchanged)', async () => {
    const user = await createUser(SUSPENDED_PHONE, 'SUSPENDED');

    const res = await signInWithCode(SUSPENDED_PHONE);

    // The contract build 9 branches on is unchanged.
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().success).toBe(false);
    expect(res.json().error.code).toBe('ACCOUNT_SUSPENDED');
    // What build 9 puts on screen now carries the reason and the next step.
    const shown = build9Shows(res)!;
    expect(shown).not.toBe(BARE_OLD_MESSAGE);
    expect(shown).toMatch(/suspended/i);
    expect(shown).toContain(SUPPORT_EMAIL_FALLBACK);
    expect(shown).toMatch(/why/i);
    // Newer apps get the door as data.
    expect(res.json().error.details).toEqual({
      accountStatus: 'SUSPENDED',
      supportEmail: SUPPORT_EMAIL_FALLBACK,
      nextStep: 'EMAIL_SUPPORT',
    });
    // Still no session for a blocked account.
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('BANNED: says Swift closed it, and how to ask for a review', async () => {
    const user = await createUser(BANNED_PHONE, 'BANNED');

    const res = await signInWithCode(BANNED_PHONE);

    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_SUSPENDED');
    const shown = build9Shows(res)!;
    expect(shown).toMatch(/closed/i);
    expect(shown).not.toMatch(/suspended/i);
    expect(shown).toContain(SUPPORT_EMAIL_FALLBACK);
    expect(res.json().error.details.accountStatus).toBe('BANNED');
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('DEACTIVATED: the password path names the closed account and the mailbox too', async () => {
    const user = await createUser(DEACTIVATED_PHONE, 'DEACTIVATED');

    const res = await post('password/login', { phone: DEACTIVATED_PHONE, password: PASSWORD });

    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_SUSPENDED');
    expect(build9Shows(res)).toMatch(/closed/i);
    expect(build9Shows(res)).toContain(SUPPORT_EMAIL_FALLBACK);
    expect(res.json().error.details.accountStatus).toBe('DEACTIVATED');
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('suspended mid-session: the refresh that ends the session says why (build 9 refresh shape)', async () => {
    const user = await createUser(MID_SESSION_PHONE, 'ACTIVE');
    const signedIn = await signInWithCode(MID_SESSION_PHONE);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const { refreshToken } = signedIn.json().data.tokens as { refreshToken: string };

    await app.prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    const res = await post('refresh', { refreshToken });

    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_SUSPENDED');
    expect(build9Shows(res)).toMatch(/suspended/i);
    expect(build9Shows(res)).toContain(SUPPORT_EMAIL_FALLBACK);
    expect(res.json().error.details).toMatchObject({ accountStatus: 'SUSPENDED', nextStep: 'EMAIL_SUPPORT' });
  });
});

describe('the support address', () => {
  it('uses a configured, well-formed SUPPORT_EMAIL and otherwise the mailbox the apps show', () => {
    expect(supportEmail({})).toBe(SUPPORT_EMAIL_FALLBACK);
    expect(supportEmail({ SUPPORT_EMAIL: '  help@example.gy ' })).toBe('help@example.gy');
    for (const bad of ['', '   ', 'not-an-email', 'a@b', 'x <y@z.gy>', 'a b@c.gy']) {
      expect(supportEmail({ SUPPORT_EMAIL: bad }), bad).toBe(SUPPORT_EMAIL_FALLBACK);
    }
  });
});
