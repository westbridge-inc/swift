import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { checkOtpDailyBudget } from '../utils/sms-budget';

// Cost guardrails: hard daily ceilings on OTP SMS so an abuse spike can't run up
// the Twilio bill. Failure paths first — prove the caps actually block.
describe('OTP SMS daily budget (cost guardrails)', () => {
  let redis: Redis;
  const day = new Date().toISOString().slice(0, 10);
  const origPhoneCap = process.env['OTP_PHONE_DAILY_CAP'];
  const origGlobalCap = process.env['OTP_GLOBAL_DAILY_CAP'];

  beforeAll(() => {
    redis = new Redis(process.env['REDIS_URL'] || 'redis://localhost:6382');
  });

  afterAll(async () => {
    // Restore env so the rest of the suite runs with default caps.
    if (origPhoneCap === undefined) delete process.env['OTP_PHONE_DAILY_CAP']; else process.env['OTP_PHONE_DAILY_CAP'] = origPhoneCap;
    if (origGlobalCap === undefined) delete process.env['OTP_GLOBAL_DAILY_CAP']; else process.env['OTP_GLOBAL_DAILY_CAP'] = origGlobalCap;
    await redis.del(`sms_global_day:${day}`);
    await redis.quit();
  });

  it('blocks a phone once its daily cap is exceeded', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '3';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';
    const phone = `+592budget${Date.now()}`;
    await redis.del(`otp_phone_day:${day}:${phone}`);

    const out = [];
    for (let i = 0; i < 4; i++) out.push(await checkOtpDailyBudget(redis, phone));

    expect(out.slice(0, 3).every((r) => r.allowed)).toBe(true);
    expect(out[3]).toEqual({ allowed: false, reason: 'phone_daily' });
  });

  it('trips the global circuit breaker across different phones', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '1000000';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '2';
    await redis.del(`sms_global_day:${day}`);

    const r1 = await checkOtpDailyBudget(redis, `+592ga${Date.now()}`);
    const r2 = await checkOtpDailyBudget(redis, `+592gb${Date.now()}`);
    const r3 = await checkOtpDailyBudget(redis, `+592gc${Date.now()}`);

    expect(r1.allowed && r2.allowed).toBe(true);
    expect(r3).toEqual({ allowed: false, reason: 'global_daily' });
  });
});
