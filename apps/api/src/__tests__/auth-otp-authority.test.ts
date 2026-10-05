import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// ---------------------------------------------------------------------------
// [L04 · AUTH-2 row 111 + MASTER-054] Who a one-time code and a password
// attempt can sign in.
//  - A banned or suspended account is refused on the SMS-code path exactly as
//    on the password path, and no session is written.
//  - A code issued to reset a password resets a password and nothing else; a
//    sign-in code never resets a password.
//  - Public password sign-in answers an unknown account, a wrong password and
//    a locked account with the same status and body, and always runs one
//    password comparison.
// Codes are read from what the development SMS adapter would have sent, so
// every case walks the real send → verify ceremony of its purpose.
// ---------------------------------------------------------------------------

const PREFIX = '+5920404';
const BANNED_PHONE = `${PREFIX}001`;
const SUSPENDED_PHONE = `${PREFIX}002`;
const PURPOSE_PHONE = `${PREFIX}003`;
const RESET_ONLY_PHONE = `${PREFIX}004`;
const WRONG_PASSWORD_PHONE = `${PREFIX}005`;
const LOCKED_PHONE = `${PREFIX}006`;
const NO_PASSWORD_PHONE = `${PREFIX}007`;
const UNKNOWN_PHONE = `${PREFIX}099`;
const ALL_PHONES = [
  BANNED_PHONE,
  SUSPENDED_PHONE,
  PURPOSE_PHONE,
  RESET_ONLY_PHONE,
  WRONG_PASSWORD_PHONE,
  LOCKED_PHONE,
  NO_PASSWORD_PHONE,
  UNKNOWN_PHONE,
];
const PASSWORD = 'otp-authority-password';
const NEW_PASSWORD = 'otp-authority-new-password';

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

function post(url: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/auth/${url}`,
    payload,
    headers: { 'content-type': 'application/json' },
  });
}

/** Ask for a code through the real route, then read the code the SMS carried. */
async function codeSentBy(route: 'send-otp' | 'password/reset-request', phone: string): Promise<string> {
  await clearOtpCounters(phone);
  const before = devChannelLog.length;
  const sent = await post(route, { phone });
  expect(sent.statusCode, sent.body).toBe(200);
  const sms = devChannelLog.slice(before).filter((entry) => entry.channel === 'sms' && entry.to === phone).at(-1);
  const code = sms?.body.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no code was texted to the test number by ${route}`);
  return code;
}

async function createUser(
  phone: string,
  options: { status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED'; password?: string | null } = {},
) {
  return app.prisma.user.create({
    data: {
      phone,
      firstName: 'Otp',
      lastName: 'Authority',
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      status: options.status ?? 'ACTIVE',
      isPhoneVerified: true,
      passwordHash: options.password === null ? null : await bcrypt.hash(options.password ?? PASSWORD, 4),
      customer: { create: {} },
    },
  });
}

async function cleanup() {
  await app.prisma.user.deleteMany({ where: { phone: { in: ALL_PHONES } } });
  for (const phone of ALL_PHONES) await clearOtpCounters(phone);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
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

describe('[row 111] a banned or suspended account cannot sign in with an SMS code', () => {
  for (const [status, phone] of [['BANNED', BANNED_PHONE], ['SUSPENDED', SUSPENDED_PHONE]] as const) {
    it(`${status}: verify-otp gives the password path's refusal and writes no session`, async () => {
      const user = await createUser(phone, { status });

      const byPassword = await post('password/login', { phone, password: PASSWORD });
      expect(byPassword.statusCode, byPassword.body).toBe(403);

      const code = await codeSentBy('send-otp', phone);
      const byCode = await post('verify-otp', { phone, code });

      expect({ status: byCode.statusCode, body: byCode.json() }).toEqual({
        status: byPassword.statusCode,
        body: byPassword.json(),
      });
      expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);
    });
  }
});

describe('[row 111] a code works only for the purpose it was issued for', () => {
  it('a sign-in code cannot reset a password', async () => {
    const user = await createUser(PURPOSE_PHONE);
    const signInCode = await codeSentBy('send-otp', PURPOSE_PHONE);

    const reset = await post('password/reset', { phone: PURPOSE_PHONE, code: signInCode, newPassword: NEW_PASSWORD });

    expect(reset.statusCode, reset.body).toBe(400);
    expect(reset.json().error.code).toBe('INVALID_OTP');
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(PASSWORD, after.passwordHash!)).toBe(true);
  });

  it('a password-reset code cannot sign in, and still resets the password', async () => {
    const user = await createUser(RESET_ONLY_PHONE);
    const resetCode = await codeSentBy('password/reset-request', RESET_ONLY_PHONE);

    const signIn = await post('verify-otp', { phone: RESET_ONLY_PHONE, code: resetCode });
    expect(signIn.statusCode, signIn.body).toBe(400);
    expect(signIn.json().error.code).toBe('INVALID_OTP');
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);

    const reset = await post('password/reset', { phone: RESET_ONLY_PHONE, code: resetCode, newPassword: NEW_PASSWORD });
    expect(reset.statusCode, reset.body).toBe(200);
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(NEW_PASSWORD, after.passwordHash!)).toBe(true);
  });
});

describe('[MASTER-054] password sign-in does not reveal whether an account exists or is locked', () => {
  let lockedId = '';
  beforeAll(async () => {
    await createUser(WRONG_PASSWORD_PHONE);
    await createUser(NO_PASSWORD_PHONE, { password: null });
    lockedId = (await createUser(LOCKED_PHONE)).id;
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    // Locked by earlier failures: the lock outlives this test.
    await app.prisma.user.update({
      where: { id: lockedId },
      data: { lockedUntil: new Date(Date.now() + 15 * 60_000) },
    });
  });

  it('unknown number, wrong password, account with no password and locked account: same status, same body', async () => {

    const unknown = await post('password/login', { phone: UNKNOWN_PHONE, password: 'wrong-password-1' });
    const wrong = await post('password/login', { phone: WRONG_PASSWORD_PHONE, password: 'wrong-password-1' });
    const noPassword = await post('password/login', { phone: NO_PASSWORD_PHONE, password: 'wrong-password-1' });
    const lockedWrong = await post('password/login', { phone: LOCKED_PHONE, password: 'wrong-password-1' });
    const lockedRight = await post('password/login', { phone: LOCKED_PHONE, password: PASSWORD });

    const shape = (r: typeof unknown) => ({ status: r.statusCode, body: r.body });
    expect(shape(unknown).status).toBe(401);
    expect(shape(wrong)).toEqual(shape(unknown));
    expect(shape(noPassword)).toEqual(shape(unknown));
    expect(shape(lockedWrong)).toEqual(shape(unknown));
    expect(shape(lockedRight)).toEqual(shape(unknown));
    expect(await app.prisma.session.count({ where: { userId: lockedId } })).toBe(0);
  });

  it('every refusal path runs exactly one password comparison (counted, not timed)', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');
    const paths: Array<[string, Record<string, unknown>]> = [
      ['unknown phone', { phone: UNKNOWN_PHONE, password: 'wrong-password-2' }],
      ['unknown email', { email: 'nobody-l04-otp-authority@example.invalid', password: 'wrong-password-2' }],
      ['account with no password', { phone: NO_PASSWORD_PHONE, password: 'wrong-password-2' }],
      ['wrong password', { phone: WRONG_PASSWORD_PHONE, password: 'wrong-password-2' }],
      ['locked account', { phone: LOCKED_PHONE, password: 'wrong-password-2' }],
    ];
    const counts: Record<string, number> = {};
    for (const [label, payload] of paths) {
      compare.mockClear();
      const res = await post('password/login', payload);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(401);
      counts[label] = compare.mock.calls.length;
    }
    expect(counts).toEqual(Object.fromEntries(paths.map(([label]) => [label, 1])));
  });
});
