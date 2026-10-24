import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

// [M013] A development server texts the sign-in code through the SMS channel
// (the dev adapter keeps it in memory for tests) and never writes the code, or
// the number it went to, into the application log. Developers sign in locally
// with the DEV_OTP_BYPASS code; a log line was never the way in, and a dev log
// is copied around (terminals, CI artefacts, screenshots). Synthetic values only.

const CODE = '654321';
const PHONE = '+5920000001';

vi.mock('../utils/otp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/otp')>()),
  generateOtp: () => CODE,
  checkOtpRateLimit: async () => true,
  markOtpCooldownDelivered: async () => undefined,
}));
vi.mock('../utils/sms-budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/sms-budget')>()),
  checkOtpDailyBudget: async () => ({ allowed: true }),
}));
vi.mock('../modules/review/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/review/credentials')>()),
  reviewCredentialFor: async () => null,
}));
vi.mock('../modules/auth/signup-continuation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/auth/signup-continuation')>()),
  storeSignupOtp: async () => undefined,
  storePasswordResetOtp: async () => undefined,
}));

import { AuthService } from '../modules/auth/auth.service';

afterEach(() => { vi.unstubAllEnvs(); });

describe('[M013] development sign-in codes are texted, never logged', () => {
  it.each(['sign-in', 'password-reset'] as const)('%s: the SMS carries the code; no log line carries the code or the number', async (purpose) => {
    vi.stubEnv('NODE_ENV', 'development');
    const entries: unknown[][] = [];
    const record = (level: string) => (...args: unknown[]) => { entries.push([level, ...args]); };
    const app = {
      log: { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug'), trace: record('trace'), fatal: record('fatal') },
      prisma: { integritySettings: { findUnique: async () => null }, user: { findUnique: async () => null } },
      redis: { incr: async () => 1, expire: async () => 1, ttl: async () => 3600 },
    } as unknown as FastifyInstance;
    const sendSms = vi.fn(async (_to: string, _body: string) => ({ ref: 'synthetic-delivery' }));
    const channels = { sms: { sendSms }, email: { sendEmail: vi.fn() }, push: { sendPush: vi.fn() } };

    await expect(new AuthService(app, channels as never).sendOtp(PHONE, '127.0.0.1', purpose)).resolves.toMatchObject({ expiresIn: 300 });

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0]![1]).toContain(CODE);
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(CODE);
    expect(logged).not.toContain(PHONE);
  });
});
