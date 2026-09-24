import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { checkOtpDailyBudget } from '../utils/sms-budget';
import { guyanaDayKey } from '../utils/guyana-day';

// Cost guardrails: hard daily ceilings on OTP SMS so an abuse spike can't run up
// the Twilio bill. Failure paths first — prove the caps actually block, the
// per-IP budget trips before anything shared can be drained, known phones draw
// from a budget junk cannot touch, and a refund gives a failed send back.
describe('OTP SMS daily budget (cost guardrails)', () => {
  let redis: Redis;
  const day = guyanaDayKey(new Date());
  const origPhoneCap = process.env['OTP_PHONE_DAILY_CAP'];
  const origIpCap = process.env['OTP_IP_DAILY_CAP'];
  const origGlobalCap = process.env['OTP_GLOBAL_DAILY_CAP'];
  const origKnownCap = process.env['OTP_KNOWN_DAILY_CAP'];
  // TEST-NET-3 addresses reserved for this suite — never shared with other
  // suites, so repeat runs cannot accumulate against them.
  const IP_A = '203.0.113.200';
  const IP_B = '203.0.113.201';

  beforeAll(() => {
    redis = new Redis(process.env['REDIS_URL'] || 'redis://localhost:6382');
  });

  afterAll(async () => {
    // Restore env so the rest of the suite runs with default caps.
    if (origPhoneCap === undefined) delete process.env['OTP_PHONE_DAILY_CAP']; else process.env['OTP_PHONE_DAILY_CAP'] = origPhoneCap;
    if (origIpCap === undefined) delete process.env['OTP_IP_DAILY_CAP']; else process.env['OTP_IP_DAILY_CAP'] = origIpCap;
    if (origGlobalCap === undefined) delete process.env['OTP_GLOBAL_DAILY_CAP']; else process.env['OTP_GLOBAL_DAILY_CAP'] = origGlobalCap;
    if (origKnownCap === undefined) delete process.env['OTP_KNOWN_DAILY_CAP']; else process.env['OTP_KNOWN_DAILY_CAP'] = origKnownCap;
    await redis.del(
      `sms_global_day:${day}`,
      `sms_known_day:${day}`,
      `otp_ip_day:${day}:${IP_A}`,
      `otp_ip_day:${day}:${IP_B}`,
    );
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

  it('a per-IP budget trips before one actor can drain the shared global counter', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '1000000';
    process.env['OTP_IP_DAILY_CAP'] = '2';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';
    await redis.del(`otp_ip_day:${day}:${IP_A}`, `sms_global_day:${day}`);

    const out = [];
    for (let i = 0; i < 3; i++) out.push(await checkOtpDailyBudget(redis, `+592ip${Date.now()}${i}`, { ip: IP_A }));

    expect(out[0]!.allowed && out[1]!.allowed).toBe(true);
    expect(out[2]).toMatchObject({ allowed: false, reason: 'ip_daily' });
    // The shared counter absorbed only the two allowed attempts — a third
    // throwaway number from the same IP never reached it.
    expect(Number(await redis.get(`sms_global_day:${day}`))).toBe(2);
  });

  it('known phones draw from a separate budget that junk numbers cannot exhaust', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '1000000';
    process.env['OTP_IP_DAILY_CAP'] = '1000000';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '1';
    process.env['OTP_KNOWN_DAILY_CAP'] = '1000000';
    await redis.del(`sms_global_day:${day}`, `sms_known_day:${day}`);

    const junk1 = await checkOtpDailyBudget(redis, `+592j1${Date.now()}`);
    const junk2 = await checkOtpDailyBudget(redis, `+592j2${Date.now()}`);
    const known = await checkOtpDailyBudget(redis, `+592known${Date.now()}`, { knownPhone: true });

    expect(junk1.allowed).toBe(true);
    expect(junk2).toMatchObject({ allowed: false, reason: 'global_daily' });
    expect(known.allowed).toBe(true); // junk exhaustion never touches the known budget
    expect(Number(await redis.get(`sms_global_day:${day}`))).toBe(2);
    expect(Number(await redis.get(`sms_known_day:${day}`))).toBe(1);
  });

  it('refund undoes the counters a provider failure just spent', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '1000000';
    process.env['OTP_IP_DAILY_CAP'] = '1000000';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';
    const phone = `+592ref${Date.now()}`;
    await redis.del(`otp_phone_day:${day}:${phone}`, `otp_ip_day:${day}:${IP_B}`, `sms_global_day:${day}`);

    const res = await checkOtpDailyBudget(redis, phone, { ip: IP_B });
    expect(res.allowed).toBe(true);
    expect(typeof res.refund).toBe('function');

    const counts = async () => Promise.all([
      redis.get(`otp_phone_day:${day}:${phone}`),
      redis.get(`otp_ip_day:${day}:${IP_B}`),
      redis.get(`sms_global_day:${day}`),
    ]);
    expect(await counts()).toEqual(['1', '1', '1']);

    await res.refund!();
    expect(await counts()).toEqual(['0', '0', '0']);
    // A refund never digs a negative hole.
    await res.refund!();
    expect(await counts()).toEqual(['0', '0', '0']);
  });
});
