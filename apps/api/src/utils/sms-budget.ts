import type Redis from 'ioredis';

// Cost guardrails for outbound OTP SMS — the dominant, unauthenticated, abusable
// SMS-cost vector. The per-minute limit (utils/otp.ts) stops bursts; these are
// the HARD DAILY CEILINGS so a sustained spam/abuse spike can't run up an insane
// Twilio bill. Both are tunable via env; a global cap acts as a circuit breaker.
//
// NOTE: the definitive total-spend ceiling is a Twilio account spending limit +
// geo-permissions (restrict to the launch market's dial code). Set those too.

const PHONE_DAILY_PREFIX = 'otp_phone_day:';
const GLOBAL_DAILY_PREFIX = 'sms_global_day:';
const DAY_TTL = 86400; // 24h

const DEFAULT_PHONE_DAILY_CAP = 8;
const DEFAULT_GLOBAL_DAILY_CAP = 5000;

function dayStamp(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export interface SmsBudgetResult {
  allowed: boolean;
  reason?: 'phone_daily' | 'global_daily';
}

/**
 * Per-phone and global daily caps on OTP SMS. Atomic INCR per attempt; a send is
 * allowed only while both counters are within their caps, so the number of paid
 * sends can never exceed the caps for a given UTC day. Tunable via
 * OTP_PHONE_DAILY_CAP (default 8) and OTP_GLOBAL_DAILY_CAP (default 5000).
 */
export async function checkOtpDailyBudget(redis: Redis, phone: string): Promise<SmsBudgetResult> {
  const day = dayStamp();
  const phoneCap = intEnv('OTP_PHONE_DAILY_CAP', DEFAULT_PHONE_DAILY_CAP);
  const globalCap = intEnv('OTP_GLOBAL_DAILY_CAP', DEFAULT_GLOBAL_DAILY_CAP);

  const phoneKey = `${PHONE_DAILY_PREFIX}${day}:${phone}`;
  const phoneCount = await redis.incr(phoneKey);
  if (phoneCount === 1) await redis.expire(phoneKey, DAY_TTL);
  if (phoneCount > phoneCap) return { allowed: false, reason: 'phone_daily' };

  const globalKey = `${GLOBAL_DAILY_PREFIX}${day}`;
  const globalCount = await redis.incr(globalKey);
  if (globalCount === 1) await redis.expire(globalKey, DAY_TTL);
  if (globalCount > globalCap) return { allowed: false, reason: 'global_daily' };

  return { allowed: true };
}
