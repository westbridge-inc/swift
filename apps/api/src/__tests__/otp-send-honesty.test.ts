import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { registerErrorHandler } from '../middleware/error-handler';
import { AuthService } from '../modules/auth/auth.service';
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
