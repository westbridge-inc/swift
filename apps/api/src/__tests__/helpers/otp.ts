import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import {
  armDevelopmentSignupGeneration,
  issueSignupContinuation,
  storeSignupOtp,
} from '../../modules/auth/signup-continuation';
import { guyanaDayKey } from '../../utils/guyana-day';

/**
 * Requests a real OTP through the API, then pins a KNOWN code for the same
 * phone. Codes are hashed at rest (launch-readiness §1.1), so the old trick of
 * reading the plaintext back out of Redis is exactly what the hardening
 * forbids — instead the helper starts a second real, generation-fenced OTP
 * ceremony with a known code, and verify-otp exercises the same atomic path.
 */
const KNOWN_TEST_OTP = '246810';

export async function requestOtp(app: FastifyInstance, phone: string): Promise<string> {
  // Reset the per-phone cooldown, the trial-integrity §5 hourly cap, AND the
  // daily SMS-budget counters so repeated test runs stay deterministic (these
  // caps are cost/abuse guardrails, not test gates — each cap is covered by
  // its own dedicated suite). The loopback per-IP counter is reset too:
  // app.inject always sources 127.0.0.1, and the helper must not accumulate
  // against the new per-IP daily budget across a full run.
  const day = guyanaDayKey(new Date());
  await app.redis.del(
    `otp_rate:${phone}`,
    `otp_hr:${phone}`,
    `otp_attempt:${phone}`,
    `otp_phone_day:${day}:${phone}`,
    `sms_global_day:${day}`,
    `sms_known_day:${day}`,
    `otp_ip_day:${day}:127.0.0.1`,
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

  await storeSignupOtp(app.redis, phone, KNOWN_TEST_OTP);
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

/**
 * Mint a registration proof WITHOUT the OTP ceremony. Only for a number the
 * front door refuses: since audit High #2 a foreign number is stopped at
 * send-otp itself, so it can never walk the ceremony that issues a proof —
 * this is the one way to grade the register-level launch-market gate on its
 * own. Never a shortcut for a Guyana number: those must walk the real ceremony.
 */
export async function mintedRegistrationProofFor(app: FastifyInstance, phone: string): Promise<string> {
  const generation = await armDevelopmentSignupGeneration(app.redis, phone);
  const issued = await issueSignupContinuation(app.redis, phone, generation);
  if (!issued) throw new Error(`could not mint a registration proof for ${phone}`);
  return issued.registrationProof;
}

/** A 6-digit code guaranteed not to equal the real one. */
export function wrongCode(realCode: string): string {
  return realCode === '000000' ? '111111' : '000000';
}
