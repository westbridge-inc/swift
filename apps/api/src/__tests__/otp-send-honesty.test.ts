import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { registerErrorHandler } from '../middleware/error-handler';
import { AuthService } from '../modules/auth/auth.service';
import { runWithoutTenant } from '../plugins/tenant-context';
import { guyanaDayKey } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// H3 (from the pre-launch audit): sendOtp used to `.catch(() => {})` the SMS
// send and unconditionally return "OTP sent successfully" — a user whose SMS
// failed was told the code was on its way and waited forever. Now a send
// failure surfaces as a 502 the user can retry, and is logged for ops.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
// TEST-NET-3 addresses reserved for this suite: the per-IP daily budget key
// must not accumulate against other suites across repeat runs.
const TEST_IP = '203.0.113.121';

const okChannels = {
  sms: { sendSms: async () => ({ ref: 'ok' }) },
  push: { sendPush: async () => ({ sent: 0 }) },
  email: { sendEmail: async () => ({ ref: 'ok' }) },
} as any;

const failingChannels = {
  sms: { sendSms: async () => { throw new Error('Twilio 500'); } },
  push: { sendPush: async () => ({ sent: 0 }) },
  email: { sendEmail: async () => ({ ref: 'ok' }) },
} as any;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.ready();
});

afterAll(async () => {
  // Same-day run hygiene for the new per-IP daily budget counter.
  await app.redis.del(`otp_ip_day:${guyanaDayKey(new Date())}:${TEST_IP}`);
  await app.close();
});

describe('OTP send honesty', () => {
  it('reports success only when the SMS actually sends', async () => {
    const svc = new AuthService(app, okChannels);
    const res = await svc.sendOtp(`+59248${Math.floor(Math.random() * 9e6) + 1e6}`, TEST_IP);
    expect(res.message).toBe('OTP sent successfully');
  });

  it('throws 502 (not a false success) when the SMS send fails', async () => {
    const svc = new AuthService(app, failingChannels);
    await expect(svc.sendOtp(`+59248${Math.floor(Math.random() * 9e6) + 1e6}`, TEST_IP)).rejects.toMatchObject({
      statusCode: 502,
      code: 'SMS_SEND_FAILED',
    });
  });

  it('refuses a non-Guyana number BEFORE spending any budget or rate counter', async () => {
    const svc = new AuthService(app, okChannels);
    const phone = `+1555${Math.floor(Math.random() * 9e6) + 1e6}`;
    const day = guyanaDayKey(new Date());
    const globalBefore = Number((await app.redis.get(`sms_global_day:${day}`)) ?? 0);

    await expect(svc.sendOtp(phone, TEST_IP)).rejects.toMatchObject({
      statusCode: 400,
      code: 'COUNTRY_NOT_ACTIVE',
    });

    // The gate is the FIRST statement: neither the shared daily counter nor
    // the per-phone 1/min claim nor the hourly counter was touched.
    expect(Number((await app.redis.get(`sms_global_day:${day}`)) ?? 0)).toBe(globalBefore);
    expect(await app.redis.get(`otp_rate:${phone}`)).toBeNull();
    expect(await app.redis.get(`otp_hr:${phone}`)).toBeNull();
  });

  it('refunds the just-spent daily budget when the SMS provider fails', async () => {
    const svc = new AuthService(app, failingChannels);
    const phone = `+59277${Math.floor(Math.random() * 9e6) + 1e6}`;
    const day = guyanaDayKey(new Date());
    await app.redis.del(`otp_phone_day:${day}:${phone}`, `otp_ip_day:${day}:${TEST_IP}`);
    const globalBefore = Number((await app.redis.get(`sms_global_day:${day}`)) ?? 0);

    await expect(svc.sendOtp(phone, TEST_IP)).rejects.toMatchObject({
      statusCode: 502,
      code: 'SMS_SEND_FAILED',
    });

    // Provider failure gives the attempt back: the global counter, the
    // per-phone counter and the per-IP counter all return to their prior value.
    expect(Number((await app.redis.get(`sms_global_day:${day}`)) ?? 0)).toBe(globalBefore);
    expect(Number((await app.redis.get(`otp_phone_day:${day}:${phone}`)) ?? 0)).toBe(0);
    expect(Number((await app.redis.get(`otp_ip_day:${day}:${TEST_IP}`)) ?? 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Audit High #2 (S0): the shared daily SMS budget used to be spendable with
// throwaway numbers — 5,000 random +592 numbers from one machine and every
// real login, signup, reset and step-up in the country 429'd until reset.
// Three things must hold now, graded through the REAL sendOtp against Redis:
//   • a per-IP budget trips before one actor can move the shared counter far;
//   • when junk from many IPs does exhaust the shared counter, that is not the
//     budget known accounts draw from — a verified customer and an admin
//     still get their codes;
//   • a known account keeps working from the SAME IP the flood came from
//     (carrier NAT: attacker and victim can share an IP in Guyana).
// ---------------------------------------------------------------------------
describe('OTP budget under a junk flood (audit High #2)', () => {
  // +592791… is reserved for this suite: no other suite uses or generates it.
  const base = 592_791_000_000 + Math.floor(Math.random() * 900_000);
  const KNOWN_PHONE = `+${base}`; // a verified customer
  const ADMIN_PHONE = `+${base + 1}`; // an admin whose phone is NOT verified yet
  const junk = (n: number) => `+${base + 10 + n}`;
  // TEST-NET-3 addresses reserved for this block.
  const FLOOD_IP = '203.0.113.124';
  const OTHER_IP = '203.0.113.125';
  const day = guyanaDayKey(new Date());
  const CAPS = ['OTP_PHONE_DAILY_CAP', 'OTP_IP_DAILY_CAP', 'OTP_GLOBAL_DAILY_CAP', 'OTP_KNOWN_DAILY_CAP'] as const;
  const saved: Partial<Record<(typeof CAPS)[number], string | undefined>> = {};
  const userIds: string[] = [];

  const phoneKeys = (p: string) => [
    `otp:${p}`, `otp_rate:${p}`, `otp_hr:${p}`, `otp_phone_day:${day}:${p}`,
    `signup_otp:{${p}}:record`, `signup_continuation:{${p}}:otp_generation`, `signup_continuation:{${p}}:current`,
  ];
  const allPhones = () => [KNOWN_PHONE, ADMIN_PHONE, ...Array.from({ length: 10 }, (_, i) => junk(i))];
  const sharedKeys = () => [`sms_global_day:${day}`, `sms_known_day:${day}`, `otp_ip_day:${day}:${FLOOD_IP}`, `otp_ip_day:${day}:${OTHER_IP}`];
  const resetCounters = () => app.redis.del(...sharedKeys(), ...allPhones().flatMap(phoneKeys));
  const send = (svc: AuthService, phone: string, ip: string) =>
    svc.sendOtp(phone, ip).then(() => 'sent' as const, (e: unknown) => (e as { code?: string }).code ?? 'error');
  const count = async (key: string) => Number((await app.redis.get(key)) ?? 0);

  beforeAll(async () => {
    for (const c of CAPS) saved[c] = process.env[c];
    const known = await runWithoutTenant(() => app.prisma.user.create({
      data: { phone: KNOWN_PHONE, firstName: 'Known', lastName: 'Flood', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
      select: { id: true },
    }), 'otp-flood-test-fixture');
    const admin = await runWithoutTenant(() => app.prisma.user.create({
      data: { phone: ADMIN_PHONE, firstName: 'Admin', lastName: 'Flood', roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: false },
      select: { id: true },
    }), 'otp-flood-test-fixture');
    userIds.push(known.id, admin.id);
  });

  afterAll(async () => {
    for (const c of CAPS) {
      if (saved[c] === undefined) delete process.env[c]; else process.env[c] = saved[c];
    }
    await resetCounters();
    await runWithoutTenant(async () => {
      await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }, 'otp-flood-test-fixture');
  });

  it('one IP flooding throwaway numbers trips the per-IP budget before the shared counter moves — and a known account on that SAME IP still gets its code', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '8';
    process.env['OTP_IP_DAILY_CAP'] = '3';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '1000';
    process.env['OTP_KNOWN_DAILY_CAP'] = '1000';
    await resetCounters();
    const svc = new AuthService(app, okChannels);

    // Three throwaway numbers spend the flood IP's budget…
    for (let i = 0; i < 3; i++) expect(await send(svc, junk(i), FLOOD_IP)).toBe('sent');
    // …and the fourth is refused BY THE IP BUDGET: the shared counter never saw it.
    expect(await send(svc, junk(3), FLOOD_IP)).toBe('RATE_LIMITED');
    expect(await count(`sms_global_day:${day}`)).toBe(3);
    expect(await count(`otp_ip_day:${day}:${FLOOD_IP}`)).toBe(4);

    // A verified customer behind the same carrier-NAT IP is untouched: the
    // known budget, never the exhausted per-IP counter or the shared one.
    expect(await send(svc, KNOWN_PHONE, FLOOD_IP)).toBe('sent');
    expect(await count(`sms_known_day:${day}`)).toBe(1);
    expect(await count(`sms_global_day:${day}`)).toBe(3);
    expect(await count(`otp_ip_day:${day}:${FLOOD_IP}`)).toBe(4);

    // And the shared budget was never drained — a newcomer elsewhere still signs up.
    expect(await send(svc, junk(4), OTHER_IP)).toBe('sent');
  });

  it('junk from many IPs can exhaust the shared budget, but a verified customer and an admin still get their codes', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '8';
    process.env['OTP_IP_DAILY_CAP'] = '1000';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '2';
    process.env['OTP_KNOWN_DAILY_CAP'] = '1000';
    await resetCounters();
    const svc = new AuthService(app, okChannels);

    expect(await send(svc, junk(5), FLOOD_IP)).toBe('sent');
    expect(await send(svc, junk(6), OTHER_IP)).toBe('sent');
    expect(await send(svc, junk(7), OTHER_IP)).toBe('RATE_LIMITED'); // the shared circuit breaker
    expect(await count(`sms_global_day:${day}`)).toBe(3);

    // Existing accounts — a verified customer and a not-yet-verified admin —
    // draw from the known budget the flood cannot reach.
    expect(await send(svc, KNOWN_PHONE, OTHER_IP)).toBe('sent');
    expect(await send(svc, ADMIN_PHONE, OTHER_IP)).toBe('sent');
    expect(await count(`sms_known_day:${day}`)).toBe(2);
    // A brand-new number is still refused: the junk cap protects the SMS spend.
    expect(await send(svc, junk(8), FLOOD_IP)).toBe('RATE_LIMITED');
  });
});
