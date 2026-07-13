import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { registerErrorHandler } from '../middleware/error-handler';
import { AuthService } from '../modules/auth/auth.service';

// ---------------------------------------------------------------------------
// H3 (from the pre-launch audit): sendOtp used to `.catch(() => {})` the SMS
// send and unconditionally return "OTP sent successfully" — a user whose SMS
// failed was told the code was on its way and waited forever. Now a send
// failure surfaces as a 502 the user can retry, and is logged for ops.
// ---------------------------------------------------------------------------

let app: FastifyInstance;

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

afterAll(async () => { await app.close(); });

describe('OTP send honesty', () => {
  it('reports success only when the SMS actually sends', async () => {
    const svc = new AuthService(app, okChannels);
    const res = await svc.sendOtp(`+59248${Math.floor(Math.random() * 9e6) + 1e6}`);
    expect(res.message).toBe('OTP sent successfully');
  });

  it('throws 502 (not a false success) when the SMS send fails', async () => {
    const svc = new AuthService(app, failingChannels);
    await expect(svc.sendOtp(`+59248${Math.floor(Math.random() * 9e6) + 1e6}`)).rejects.toMatchObject({
      statusCode: 502,
      code: 'SMS_SEND_FAILED',
    });
  });
});
