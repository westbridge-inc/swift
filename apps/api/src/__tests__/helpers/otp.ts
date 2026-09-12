import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { storeOtp } from '../../utils/otp';

/**
 * Requests a real OTP through the API, then pins a KNOWN code for the same
 * phone. Codes are hashed at rest (launch-readiness §1.1), so the old trick of
 * reading the plaintext back out of Redis is exactly what the hardening
 * forbids — instead the helper overwrites the stored hash via the real
 * storeOtp(), and verify-otp still exercises the full hashed-compare path.
 */
const KNOWN_TEST_OTP = '246810';

export async function requestOtp(app: FastifyInstance, phone: string): Promise<string> {
  // Reset the per-phone cooldown, the trial-integrity §5 hourly cap, AND the
  // daily SMS-budget counters so repeated test runs stay deterministic (these
  // caps are cost/abuse guardrails, not test gates — each cap is covered by
  // its own dedicated suite).
  const day = new Date().toISOString().slice(0, 10);
  await app.redis.del(
    `otp_rate:${phone}`,
    `otp_hr:${phone}`,
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

  const stored = await app.redis.get(`otp:${phone}`);
  if (!stored) {
    throw new Error(`No OTP stored in Redis for ${phone}`);
  }
  await storeOtp(app.redis, phone, KNOWN_TEST_OTP);
  return KNOWN_TEST_OTP;
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

/** Complete a new-user OTP ceremony and return its single-use signup capability. */
export async function registrationProofFor(app: FastifyInstance, phone: string): Promise<string> {
  const response = await loginWithOtp(app, phone);
  if (response.statusCode !== 200) {
    throw new Error(`verify-otp failed for ${phone}: ${response.statusCode} ${response.body}`);
  }
  const proof = response.json().data?.registrationProof;
  if (typeof proof !== 'string' || !proof) {
    throw new Error(`verify-otp did not issue a registration proof for new phone ${phone}`);
  }
  return proof;
}

/** A 6-digit code guaranteed not to equal the real one. */
export function wrongCode(realCode: string): string {
  return realCode === '000000' ? '111111' : '000000';
}
