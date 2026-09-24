import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatResendWait, OTP_RESEND_WINDOW_S, otpCooldownOf, secondsUntil } from './otpCooldown';

// An Axios-shaped failure carrying the API's error body. The resend window
// refusal body is the one the API pins in
// apps/api/src/__tests__/otp-cooldown-honesty.test.ts.
const failed = (status: number, error: Record<string, unknown>) => ({
  isAxiosError: true,
  response: { status, data: { success: false, error } },
});
const windowRefusal = (details: Record<string, unknown>) => failed(429, {
  code: 'RATE_LIMITED',
  message: 'We already sent a code to this number. You can request a new one in 42 seconds.',
  details,
});

describe('otpCooldownOf', () => {
  it('reads the resend window refusal: how long to wait, and whether a code is already out', () => {
    expect(otpCooldownOf(windowRefusal({ retryAfterSeconds: 42, codeAlreadySent: true })))
      .toEqual({ retryAfterSeconds: 42, codeAlreadySent: true });
    expect(otpCooldownOf(windowRefusal({ retryAfterSeconds: 7, codeAlreadySent: false })))
      .toEqual({ retryAfterSeconds: 7, codeAlreadySent: false });
  });

  it('leaves every other refusal to its own copy: the hourly cap, the daily budget, a foreign number, no network', () => {
    expect(otpCooldownOf(failed(429, {
      code: 'RATE_LIMITED',
      message: 'Too many codes requested for this number. Try again in 42 minutes.',
    }))).toBeNull();
    expect(otpCooldownOf(failed(429, {
      code: 'RATE_LIMITED',
      message: 'Too many verification requests right now. Please try again later.',
    }))).toBeNull();
    expect(otpCooldownOf(failed(400, {
      code: 'COUNTRY_NOT_ACTIVE',
      message: 'Swift is currently available in Guyana only',
      details: { retryAfterSeconds: 42 },
    }))).toBeNull();
    expect(otpCooldownOf(failed(429, { code: 'ERROR', message: 'Rate limit exceeded', details: { retryAfterSeconds: 42 } }))).toBeNull();
    expect(otpCooldownOf(Object.assign(new Error('Network Error'), { isAxiosError: true }))).toBeNull();
    expect(otpCooldownOf(undefined)).toBeNull();
    expect(otpCooldownOf(null)).toBeNull();
  });

  it('never trusts a missing or malformed wait', () => {
    for (const retryAfterSeconds of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, '42', null, undefined]) {
      expect(otpCooldownOf(windowRefusal({ retryAfterSeconds, codeAlreadySent: true }))).toBeNull();
    }
  });

  it('rounds a fractional wait up, and treats anything but true as no code out', () => {
    expect(otpCooldownOf(windowRefusal({ retryAfterSeconds: 4.2, codeAlreadySent: 'yes' })))
      .toEqual({ retryAfterSeconds: 5, codeAlreadySent: false });
  });
});

describe('formatResendWait', () => {
  it('prints whole seconds, rounded up, and never 0s while the wait is on', () => {
    expect(formatResendWait(42)).toBe('42s');
    expect(formatResendWait(41.2)).toBe('42s');
    expect(formatResendWait(1)).toBe('1s');
    expect(formatResendWait(0.2)).toBe('1s');
    expect(formatResendWait(0)).toBe('1s');
    expect(formatResendWait(OTP_RESEND_WINDOW_S)).toBe('60s');
  });
});

describe('secondsUntil', () => {
  it('counts whole seconds to a wall-clock deadline, rounded up, and stops at 0', () => {
    const now = 1_000_000;
    expect(secondsUntil(now + 42_000, now)).toBe(42);
    expect(secondsUntil(now + 41_001, now)).toBe(42);
    expect(secondsUntil(now + 1, now)).toBe(1);
    expect(secondsUntil(now, now)).toBe(0);
    expect(secondsUntil(now - 5_000, now)).toBe(0);
  });
});

describe('OTP_RESEND_WINDOW_S', () => {
  it('mirrors the API window, so a fresh verify screen never unlocks a resend the server would refuse', () => {
    const api = readFileSync(join(process.cwd(), '../api/src/utils/otp.ts'), 'utf8');
    const serverWindow = Number(api.match(/const OTP_RATE_TTL = (\d+);/)?.[1]);
    expect(serverWindow).toBeGreaterThan(0);
    expect(OTP_RESEND_WINDOW_S).toBe(serverWindow);
  });
});
