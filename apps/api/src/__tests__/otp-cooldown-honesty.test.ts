import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { createHash } from 'node:crypto';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { authRoutes } from '../modules/auth/auth.routes';
import { devChannelLog, getChannels, resetDevChannelLog } from '../providers/notifications/channels';
import { OTP_RESEND_WINDOW_S } from '../utils/otp';
import { guyanaDayKey } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// [Q2-OTP] The resend cooldown refusal, honest and machine-readable.
//
// The defect: a second Send Code inside the per-number window answered 429
// "Please wait before requesting another OTP" and nothing else. No time to
// wait, and nothing told the app the first code was already out and still
// good, so the app flagged the phone field and stranded the person on the
// phone step with a code in their hand.
//
// Graded through ONE real Fastify composition (the mounted auth routes, the
// real error handler, Redis and Postgres); every SMS is read from the dev
// channel log. The window is exactly as strict as before (one SMS per number
// per window, claimed atomically). Only the refusal changed: it now carries
// details { retryAfterSeconds, codeAlreadySent } and a Retry-After header.
//
// Phone prefix +5920924 and TEST-NET address 203.0.113.141: both grep-proven
// unused in the monorepo before this file.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920924';
const TEST_IP = '203.0.113.141';
const FIXTURE = 'otp-cooldown-honesty-fixture';

let app: FastifyInstance;
let seq = 0;
const userIds: string[] = [];
const phone = () => { seq += 1; return `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`; };
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

function post(url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/v1/auth/${url}`,
    payload,
    remoteAddress: TEST_IP,
    headers: { 'content-type': 'application/json' },
  });
}

const smsTo = (p: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === p);

/** The code the REAL send-otp path handed the dev SMS adapter. */
function codeFor(p: string): string {
  const code = smsTo(p).at(-1)?.body.match(/verification code is: (\d{6})/)?.[1];
  expect(code, `expected a dev SMS carrying a 6-digit code for ${p}`).toBeTruthy();
  return code!;
}

const secondsText = (n: number) => `${n} second${n === 1 ? '' : 's'}`;

/** The refusal with its two moving parts (the live figure) masked out. */
function refusalShape(res: LightMyRequestResponse) {
  const body = res.json();
  return {
    ...body,
    error: {
      ...body.error,
      message: String(body.error.message).replace(/\d+ seconds?/, 'N seconds'),
      details: { ...body.error.details, retryAfterSeconds: 'N' },
    },
  };
}

async function waitFor(cond: () => Promise<boolean>, withinMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > withinMs) throw new Error('waitFor condition not met');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Every Redis key this file can create, including a crashed earlier run. */
async function purgeRedis() {
  const day = guyanaDayKey(new Date());
  const keys: string[] = [`otp_ip_day:${day}:${TEST_IP}`];
  for (let i = 1; i <= 16; i += 1) {
    const p = `${PHONE_PREFIX}${String(i).padStart(3, '0')}`;
    const slot = createHash('sha256').update('swift:signup-phone:v1\0').update(p).digest('hex');
    keys.push(`otp_rate:${p}`, `otp_hr:${p}`, `otp_phone_day:${day}:${p}`, `signup_otp:{${slot}}:record`);
    let cursor = '0';
    do {
      const [next, found] = await app.redis.scan(cursor, 'MATCH', `signup_continuation:{${slot}}:*`, 'COUNT', 100);
      cursor = next;
      keys.push(...found);
    } while (cursor !== '0');
  }
  await app.redis.del(...keys);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  // The shared daily SMS budgets are not under test here (each has its own
  // suite): keep them out of the way so only the per-number window refuses.
  process.env['OTP_PHONE_DAILY_CAP'] = '1000';
  process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();

  // Every SMS here must land in the dev adapter log, never a real provider.
  expect(process.env['NOTIFICATION_PROVIDER'] ?? 'dev').toBe('dev');
  resetDevChannelLog();
  await sys(() => app.prisma.user.deleteMany({ where: { phone: { startsWith: PHONE_PREFIX } } }));
  await purgeRedis();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await sys(() => app.prisma.user.deleteMany({ where: { id: { in: userIds } } }));
  await purgeRedis();
  resetDevChannelLog();
  await app.close();
});

describe('send-otp cooldown refusal: honest and machine-readable', () => {
  it('a resend inside the window is refused with the time left and the fact that a code is out; no second SMS leaves, and that code still verifies', async () => {
    const p = phone();
    const first = await post('send-otp', { phone: p });
    expect(first.statusCode, first.body).toBe(200);
    expect(smsTo(p)).toHaveLength(1);
    const code = codeFor(p);
    // Delivering did not touch the window: the claim still runs out on time.
    const pttl = await app.redis.pttl(`otp_rate:${p}`);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(OTP_RESEND_WINDOW_S * 1000);

    // Three at once, as a double tap or a flaky retry would send them.
    const refusals = await Promise.all([1, 2, 3].map(() => post('send-otp', { phone: p })));
    for (const res of refusals) {
      expect(res.statusCode).toBe(429);
      const { retryAfterSeconds } = res.json().error.details;
      expect(Number.isInteger(retryAfterSeconds)).toBe(true);
      expect(retryAfterSeconds).toBeGreaterThan(0);
      expect(retryAfterSeconds).toBeLessThanOrEqual(OTP_RESEND_WINDOW_S);
      expect(res.json()).toEqual({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: `We already sent a code to this number. You can request a new one in ${secondsText(retryAfterSeconds)}.`,
          details: { retryAfterSeconds, codeAlreadySent: true },
        },
      });
      expect(res.headers['retry-after']).toBe(String(retryAfterSeconds));
      expect(res.body).not.toContain(code);
    }
    expect(smsTo(p)).toHaveLength(1);

    // The code the refusal points back to is the one that works.
    const verified = await post('verify-otp', { phone: p, code });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data.isNewUser).toBe(true);
  });

  it('the retry figure is the remaining life of the claim, rounded up and never 0', async () => {
    const p = phone();
    expect((await post('send-otp', { phone: p })).statusCode).toBe(200);

    await app.redis.pexpire(`otp_rate:${p}`, 12_950);
    const later = await post('send-otp', { phone: p });
    expect(later.statusCode).toBe(429);
    expect(later.json().error.details).toEqual({ retryAfterSeconds: 13, codeAlreadySent: true });
    expect(later.json().error.message).toBe('We already sent a code to this number. You can request a new one in 13 seconds.');
    expect(later.headers['retry-after']).toBe('13');

    await app.redis.pexpire(`otp_rate:${p}`, 950);
    const last = await post('send-otp', { phone: p });
    expect(last.statusCode).toBe(429);
    expect(last.json().error.details).toEqual({ retryAfterSeconds: 1, codeAlreadySent: true });
    expect(last.json().error.message).toBe('We already sent a code to this number. You can request a new one in 1 second.');
    expect(last.headers['retry-after']).toBe('1');
    expect(smsTo(p)).toHaveLength(1);
  });

  it('once the window closes on its own, the number is served again, and the new window speaks for the new code', async () => {
    const p = phone();
    expect((await post('send-otp', { phone: p })).statusCode).toBe(200);
    expect((await post('send-otp', { phone: p })).statusCode).toBe(429);

    // Shortened, not deleted: the claim lapses the way it does in production.
    await app.redis.pexpire(`otp_rate:${p}`, 50);
    await waitFor(async () => (await app.redis.exists(`otp_rate:${p}`)) === 0);
    const next = await post('send-otp', { phone: p });
    expect(next.statusCode, next.body).toBe(200);
    expect(smsTo(p)).toHaveLength(2);

    const refused = await post('send-otp', { phone: p });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.details).toMatchObject({ codeAlreadySent: true });
    expect(smsTo(p)).toHaveLength(2);
  });

  it('a window that lapses while the SMS is still in flight stays closed: marking the delivery never brings it back', async () => {
    const p = phone();
    const sms = getChannels().sms;
    const deliver = sms.sendSms.bind(sms);
    const slow = vi.spyOn(sms, 'sendSms').mockImplementationOnce(async (to: string, body: string) => {
      // A provider slow enough that the claim runs out before it answers.
      await app.redis.pexpire(`otp_rate:${p}`, 1);
      await waitFor(async () => (await app.redis.exists(`otp_rate:${p}`)) === 0);
      return deliver(to, body);
    });
    const first = await post('send-otp', { phone: p });
    expect(first.statusCode, first.body).toBe(200);
    expect(slow).toHaveBeenCalledTimes(1);
    slow.mockRestore();
    expect(await app.redis.exists(`otp_rate:${p}`)).toBe(0);

    const next = await post('send-otp', { phone: p });
    expect(next.statusCode, next.body).toBe(200);
    expect(smsTo(p)).toHaveLength(2);
    const refused = await post('send-otp', { phone: p });
    expect(refused.json().error.details).toMatchObject({ codeAlreadySent: true });
  });

  it('a window whose send delivered nothing never claims that a code is out', async () => {
    const p = phone();
    const failing = vi.spyOn(getChannels().sms, 'sendSms').mockRejectedValueOnce(new Error('provider down'));
    const failed = await post('send-otp', { phone: p });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe('SMS_SEND_FAILED');
    expect(failing).toHaveBeenCalledTimes(1);
    failing.mockRestore();

    const again = await post('send-otp', { phone: p });
    expect(again.statusCode).toBe(429);
    const { retryAfterSeconds } = again.json().error.details;
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(OTP_RESEND_WINDOW_S);
    expect(again.json().error).toEqual({
      code: 'RATE_LIMITED',
      message: `A code was just requested for this number. You can request a new one in ${secondsText(retryAfterSeconds)}.`,
      details: { retryAfterSeconds, codeAlreadySent: false },
    });
    expect(again.headers['retry-after']).toBe(String(retryAfterSeconds));
    expect(smsTo(p)).toHaveLength(0);
  });

  it('the hourly cap stays its own refusal (no cooldown details, no Retry-After), and its window claims no code', async () => {
    const p = phone();
    await app.redis.set(`otp_hr:${p}`, '1000', 'EX', 3600);
    const capped = await post('send-otp', { phone: p });
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.code).toBe('RATE_LIMITED');
    expect(capped.json().error.message).toMatch(/^Too many codes requested for this number\. Try again in \d+ minutes?\.$/);
    expect(capped.json().error).not.toHaveProperty('details');
    expect(capped.headers['retry-after']).toBeUndefined();

    // The capped attempt still holds the window, and it delivered nothing.
    const again = await post('send-otp', { phone: p });
    expect(again.statusCode).toBe(429);
    expect(again.json().error.details).toMatchObject({ codeAlreadySent: false });
    expect(smsTo(p)).toHaveLength(0);
  });

  it('the refusal reads the same whether or not the number has an account', async () => {
    const known = phone();
    const user = await sys(() => app.prisma.user.create({
      data: {
        phone: known, firstName: 'Cooldown', lastName: 'Known', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
        tenantId: 'swift-default', isPhoneVerified: true,
      },
    }));
    userIds.push(user.id);
    const unknown = phone();

    for (const p of [known, unknown]) expect((await post('send-otp', { phone: p })).statusCode).toBe(200);
    const knownRefusal = await post('send-otp', { phone: known });
    const unknownRefusal = await post('send-otp', { phone: unknown });
    expect(knownRefusal.statusCode).toBe(429);
    expect(unknownRefusal.statusCode).toBe(429);
    expect(knownRefusal.json().error.details.codeAlreadySent).toBe(true);
    expect(refusalShape(knownRefusal)).toEqual(refusalShape(unknownRefusal));
  });

  it('a password-reset request inside the window gets the same honest refusal', async () => {
    const p = phone();
    expect((await post('send-otp', { phone: p })).statusCode).toBe(200);
    const reset = await post('password/reset-request', { phone: p });
    expect(reset.statusCode).toBe(429);
    const { retryAfterSeconds } = reset.json().error.details;
    expect(reset.json().error.details).toEqual({ retryAfterSeconds, codeAlreadySent: true });
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(reset.headers['retry-after']).toBe(String(retryAfterSeconds));
    expect(smsTo(p)).toHaveLength(1);
  });
});
