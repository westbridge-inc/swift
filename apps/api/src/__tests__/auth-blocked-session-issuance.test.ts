import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { UserStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { AuthService } from '../modules/auth/auth.service';
import { storeOtp } from '../utils/otp';

// OTA-062: account state and session issuance are one security decision. A
// valid OTP proves control of a phone; it does not override suspension, a ban,
// or deletion. These tests also force the time-of-check/time-of-use window in
// which an administrator changes status after the initial account lookup.

let app: FastifyInstance;
const run = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
const phones = {
  suspended: `+59271${run.slice(-5)}1`,
  banned: `+59271${run.slice(-5)}2`,
  deactivated: `+59271${run.slice(-5)}3`,
  race: `+59271${run.slice(-5)}4`,
  pending: `+59271${run.slice(-5)}5`,
};
const code = '246810';

const device = {
  deviceId: 'ota-062-device',
  deviceType: 'test',
  ipAddress: '127.0.0.1',
  userAgent: 'ota-062-hostile-test',
};

async function createAccount(phone: string, status: UserStatus) {
  return app.prisma.user.create({
    data: {
      phone,
      firstName: 'Blocked',
      lastName: 'Session',
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      status,
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
}

async function armOtp(phone: string) {
  await storeOtp(app.redis, phone, code);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.ready();
});

afterAll(async () => {
  for (const phone of Object.values(phones)) {
    await app.redis.del(`otp:${phone}`, `otp_attempt:${phone}`, `otp_verified:${phone}`);
  }
  await app.prisma.user.deleteMany({ where: { phone: { in: Object.values(phones) } } });
  await app.close();
});

describe('OTA-062 — blocked accounts cannot mint dormant sessions', () => {
  it.each([
    ['SUSPENDED', phones.suspended],
    ['BANNED', phones.banned],
    ['DEACTIVATED', phones.deactivated],
  ] as const)('%s + valid OTP creates zero sessions', async (status, phone) => {
    const user = await createAccount(phone, status);
    await armOtp(phone);

    await expect(new AuthService(app).verifyOtp(phone, code, device)).rejects.toMatchObject({
      statusCode: 403,
      code: 'ACCOUNT_SUSPENDED',
    });
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);

    // Reactivation cannot resurrect a credential that was never allowed to
    // exist. The next login must perform a fresh authentication ceremony.
    await app.prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('a ban committed after OTP verification wins before session insertion', async () => {
    const user = await createAccount(phones.race, 'ACTIVE');
    await armOtp(phones.race);

    const original = app.prisma.user.findUnique.bind(app.prisma.user);
    let releaseLookup!: () => void;
    let reachedLookup!: () => void;
    const paused = new Promise<void>((resolve) => { reachedLookup = resolve; });
    const resume = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const lookup = vi.spyOn(app.prisma.user, 'findUnique').mockImplementationOnce((async (...args: unknown[]) => {
      const found = await original(...(args as Parameters<typeof original>));
      reachedLookup();
      await resume;
      return found;
    }) as never);

    const attempt = new AuthService(app).verifyOtp(phones.race, code, device);
    await paused;
    await app.prisma.user.update({ where: { id: user.id }, data: { status: 'BANNED' } });
    releaseLookup();

    try {
      await expect(attempt).rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_SUSPENDED' });
      expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);
    } finally {
      lookup.mockRestore();
    }
  });

  it('PENDING_VERIFICATION remains eligible to finish onboarding', async () => {
    const user = await createAccount(phones.pending, 'PENDING_VERIFICATION');
    await armOtp(phones.pending);

    const result = await new AuthService(app).verifyOtp(phones.pending, code, device);
    expect(result).toMatchObject({ isNewUser: false });
    expect(result.tokens?.accessToken).toBeTruthy();
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });
});
