import type Redis from 'ioredis';
import { guyanaDayKey } from './guyana-day';

// Cost guardrails for outbound OTP SMS — the dominant, unauthenticated, abusable
// SMS-cost vector. The per-minute limit (utils/otp.ts) stops bursts; these are
// the HARD DAILY CEILINGS so a sustained spam/abuse spike can't run up an insane
// Twilio bill. Each ceiling is tunable via env.
//
// Audit High #2 (S0): the shared global counter was spendable with throwaway
// random/foreign numbers — every distinct number owns its per-phone counters,
// so a flood burned the one global budget and 429'd real logins nationwide.
// Defense in depth, ordered so the SMALLEST bucket trips first:
//   1. per-phone  — one number cannot be bombed forever (8/day);
//   2. per-IP     — one actor cannot drain anything shared (100/day);
//   3. global     — junk/new numbers share one circuit breaker (5000/day);
//   4. known      — EXISTING verified accounts (and admins) draw from a
//                   SEPARATE budget, so a flood of new-number requests can
//                   never lock them out (5000/day).
// A provider failure refunds this call's increments, so failed sends don't
// permanently burn the day's budget.
//
// NOTE: the definitive total-spend ceiling is a Twilio account spending limit +
// geo-permissions (restrict to the launch market's dial code). Set those too.

const PHONE_DAILY_PREFIX = 'otp_phone_day:';
const IP_DAILY_PREFIX = 'otp_ip_day:';
const GLOBAL_DAILY_PREFIX = 'sms_global_day:';
const KNOWN_DAILY_PREFIX = 'sms_known_day:';
const DAY_TTL = 86400; // 24h

const DEFAULT_PHONE_DAILY_CAP = 8;
const DEFAULT_IP_DAILY_CAP = 100;
const DEFAULT_GLOBAL_DAILY_CAP = 5000;
const DEFAULT_KNOWN_DAILY_CAP = 5000;

function dayStamp(): string {
  // The reset is midnight GYT (America/Guyana), not UTC — the day a
  // Guyanese subscriber means.
  return guyanaDayKey(new Date());
}

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export type SmsBudgetReason = 'phone_daily' | 'ip_daily' | 'global_daily' | 'known_daily';

export interface SmsBudgetOptions {
  /** The proxy-resolved client IP. When present, a per-IP daily budget trips
   *  long before the shared global counter can be drained by one actor. */
  ip?: string;
  /** True when the number belongs to an existing verified account/admin.
   *  Such numbers draw from the separate known-phone budget. */
  knownPhone?: boolean;
}

export interface SmsBudgetResult {
  allowed: boolean;
  reason?: SmsBudgetReason;
  /** Undo THIS call's counter increments (a provider failure must not burn
   *  the day's budget). Present only when the call was allowed. */
  refund?: () => Promise<void>;
}

function deny(reason: SmsBudgetReason): SmsBudgetResult {
  // No refund on a refusal: nothing was sent, and the spent increments are
  // the per-attempt guardrails doing their job (an abuser must not get them
  // back for free).
  return { allowed: false, reason };
}

/**
 * Per-phone, per-IP and global daily caps on OTP SMS. Atomic INCR per attempt;
 * a send is allowed only while every applicable counter is within its cap, so
 * the number of paid sends can never exceed the caps for a given Guyana day.
 * Tunable via OTP_PHONE_DAILY_CAP (8), OTP_IP_DAILY_CAP (100),
 * OTP_GLOBAL_DAILY_CAP (5000, junk/new numbers) and OTP_KNOWN_DAILY_CAP
 * (5000, existing verified phones).
 */
export async function checkOtpDailyBudget(
  redis: Redis,
  phone: string,
  opts: SmsBudgetOptions = {},
): Promise<SmsBudgetResult> {
  const day = dayStamp();
  const phoneCap = intEnv('OTP_PHONE_DAILY_CAP', DEFAULT_PHONE_DAILY_CAP);
  const ipCap = intEnv('OTP_IP_DAILY_CAP', DEFAULT_IP_DAILY_CAP);
  const globalCap = intEnv('OTP_GLOBAL_DAILY_CAP', DEFAULT_GLOBAL_DAILY_CAP);
  const knownCap = intEnv('OTP_KNOWN_DAILY_CAP', DEFAULT_KNOWN_DAILY_CAP);

  const spent: string[] = [];

  const phoneKey = `${PHONE_DAILY_PREFIX}${day}:${phone}`;
  const phoneCount = await redis.incr(phoneKey);
  if (phoneCount === 1) await redis.expire(phoneKey, DAY_TTL);
  spent.push(phoneKey);
  if (phoneCount > phoneCap) return deny('phone_daily');

  if (opts.ip) {
    const ipKey = `${IP_DAILY_PREFIX}${day}:${opts.ip}`;
    const ipCount = await redis.incr(ipKey);
    if (ipCount === 1) await redis.expire(ipKey, DAY_TTL);
    spent.push(ipKey);
    if (ipCount > ipCap) return deny('ip_daily');
  }

  const budgetKey = opts.knownPhone ? `${KNOWN_DAILY_PREFIX}${day}` : `${GLOBAL_DAILY_PREFIX}${day}`;
  const budgetCount = await redis.incr(budgetKey);
  if (budgetCount === 1) await redis.expire(budgetKey, DAY_TTL);
  spent.push(budgetKey);
  if (budgetCount > (opts.knownPhone ? knownCap : globalCap)) {
    return deny(opts.knownPhone ? 'known_daily' : 'global_daily');
  }

  const refund = () => refundSpend(redis, spent);
  return { allowed: true, refund };
}

async function refundSpend(redis: Redis, keys: string[]): Promise<void> {
  for (const key of keys) {
    // DECR only while positive — a refund must never dig a negative hole
    // that absorbs a future legitimate increment.
    await redis.eval(
      "if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then return redis.call('DECR', KEYS[1]) end return 0",
      1,
      key,
    );
  }
}
