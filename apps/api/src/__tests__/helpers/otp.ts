import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';

/**
 * Requests a real OTP through the API and reads the generated code from Redis.
 * SEC-6 removed the hardcoded dev OTP, so tests exercise the actual flow:
 * send-otp -> code stored in Redis -> verify-otp with that code.
 */
export async function requestOtp(app: FastifyInstance, phone: string): Promise<string> {
  // Reset the per-phone cooldown AND the daily SMS-budget counters so repeated
  // test runs stay deterministic (these caps are cost guardrails, not test gates).
  const day = new Date().toISOString().slice(0, 10);
  await app.redis.del(
    `otp_rate:${phone}`,
    `otp_attempt:${phone}`,
    `otp_phone_day:${day}:${phone}`,
    `sms_global_day:${day}`,
  );

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/send-otp',
    payload: { phone },
    headers: { 'content-type': 'application/json' },
  });
  if (res.statusCode !== 200) {
    throw new Error(`send-otp failed for ${phone}: ${res.statusCode} ${res.body}`);
  }

  const code = await app.redis.get(`otp:${phone}`);
  if (!code) {
    throw new Error(`No OTP stored in Redis for ${phone}`);
  }
  return code;
}

/** Full login: request an OTP, then verify it. Returns the verify-otp response. */
export async function loginWithOtp(
  app: FastifyInstance,
  phone: string,
): Promise<LightMyRequestResponse> {
  const code = await requestOtp(app, phone);
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-otp',
    payload: { phone, code },
    headers: { 'content-type': 'application/json' },
  });
}

/** A 6-digit code guaranteed not to equal the real one. */
export function wrongCode(realCode: string): string {
  return realCode === '000000' ? '111111' : '000000';
}
