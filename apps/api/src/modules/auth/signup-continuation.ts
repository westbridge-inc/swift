import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { storeFencedOtp, verifyFencedOtp } from '../../utils/otp';

export const SIGNUP_CONTINUATION_TTL_S = 10 * 60;

const CONTINUATION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Both keys use the same Redis Cluster hash tag. The current pointer makes a
// later successful OTP ceremony supersede every earlier continuation for the
// phone, while the proof-specific key lets one atomic script consume exactly
// one unpredictable capability.
const ISSUE_CONTINUATION_SCRIPT = `
local generation = redis.call('GET', KEYS[3])
if not generation or generation ~= ARGV[2] then return 0 end

redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('DEL', KEYS[3])
return 1
`;

const CONSUME_CONTINUATION_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then return 0 end

local proof = redis.call('GET', KEYS[2])
if not proof or proof ~= ARGV[1] then return 0 end

redis.call('DEL', KEYS[1], KEYS[2])
return 1
`;

const phoneSlot = (phone: string): string => createHash('sha256')
  .update('swift:signup-phone:v1\0')
  .update(phone)
  .digest('hex');

const proofDigest = (proof: string): string => createHash('sha256')
  .update('swift:signup-continuation:v1\0')
  .update(proof)
  .digest('hex');

const DISCARD_GENERATION_SCRIPT = `
local generation = redis.call('GET', KEYS[1])
if not generation or generation ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

const ARM_DEVELOPMENT_GENERATION_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('DEL', KEYS[2])
return 1
`;

function keysFor(phone: string, digest: string): {
  current: string;
  proof: string;
  otpRecord: string;
  otpGeneration: string;
} {
  const slot = phoneSlot(phone);
  return {
    current: `signup_continuation:{${slot}}:current`,
    proof: `signup_continuation:{${slot}}:${digest}`,
    otpRecord: `signup_otp:{${slot}}:record`,
    otpGeneration: `signup_continuation:{${slot}}:otp_generation`,
  };
}

export async function storeSignupOtp(
  redis: Pick<Redis, 'eval'>,
  phone: string,
  otp: string,
): Promise<void> {
  const generation = randomBytes(24).toString('base64url');
  const keys = keysFor(phone, 'unused');
  await storeFencedOtp(
    redis,
    { record: keys.otpRecord, generation: keys.otpGeneration },
    otp,
    generation,
    SIGNUP_CONTINUATION_TTL_S,
  );
}

export async function verifySignupOtp(
  redis: Pick<Redis, 'eval'>,
  phone: string,
  code: string,
): Promise<{ valid: boolean; reason?: string; generation?: string }> {
  const keys = keysFor(phone, 'unused');
  return verifyFencedOtp(redis, {
    record: keys.otpRecord,
    generation: keys.otpGeneration,
    invalidateOnSuccess: keys.current,
  }, code);
}

/** Preserve the explicit local-only master-code workflow without weakening deployed OTPs. */
export async function armDevelopmentSignupGeneration(
  redis: Pick<Redis, 'eval'>,
  phone: string,
): Promise<string> {
  const generation = randomBytes(24).toString('base64url');
  const { otpGeneration, current } = keysFor(phone, 'unused');
  await redis.eval(
    ARM_DEVELOPMENT_GENERATION_SCRIPT,
    2,
    otpGeneration,
    current,
    generation,
    String(SIGNUP_CONTINUATION_TTL_S),
  );
  return generation;
}

export async function consumeSignupOtpGeneration(
  redis: Pick<Redis, 'eval'>,
  phone: string,
  generation: string,
): Promise<boolean> {
  const { otpGeneration } = keysFor(phone, 'unused');
  return Number(await redis.eval(DISCARD_GENERATION_SCRIPT, 1, otpGeneration, generation)) === 1;
}

export async function issueSignupContinuation(
  redis: Pick<Redis, 'eval'>,
  phone: string,
  otpGeneration: string,
): Promise<{ registrationProof: string; expiresIn: number } | null> {
  const registrationProof = randomBytes(32).toString('base64url');
  const digest = proofDigest(registrationProof);
  const keys = keysFor(phone, digest);

  const issued = Number(await redis.eval(
    ISSUE_CONTINUATION_SCRIPT,
    3,
    keys.current,
    keys.proof,
    keys.otpGeneration,
    digest,
    otpGeneration,
    String(SIGNUP_CONTINUATION_TTL_S),
  ));

  return issued === 1
    ? { registrationProof, expiresIn: SIGNUP_CONTINUATION_TTL_S }
    : null;
}

export async function consumeSignupContinuation(
  redis: Pick<Redis, 'eval'>,
  phone: string,
  registrationProof: string,
): Promise<boolean> {
  if (!CONTINUATION_PATTERN.test(registrationProof)) return false;

  const digest = proofDigest(registrationProof);
  const keys = keysFor(phone, digest);
  const consumed = Number(await redis.eval(
    CONSUME_CONTINUATION_SCRIPT,
    2,
    keys.current,
    keys.proof,
    digest,
  ));
  return consumed === 1;
}
