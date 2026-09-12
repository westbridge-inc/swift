import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';

export const SIGNUP_CONTINUATION_TTL_S = 10 * 60;

const CONTINUATION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Both keys use the same Redis Cluster hash tag. The current pointer makes a
// later successful OTP ceremony supersede every earlier continuation for the
// phone, while the proof-specific key lets one atomic script consume exactly
// one unpredictable capability.
const ISSUE_CONTINUATION_SCRIPT = `
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
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

function keysFor(phone: string, digest: string): [current: string, proof: string] {
  const slot = phoneSlot(phone);
  return [
    `signup_continuation:{${slot}}:current`,
    `signup_continuation:{${slot}}:${digest}`,
  ];
}

export async function issueSignupContinuation(
  redis: Pick<Redis, 'eval'>,
  phone: string,
): Promise<{ registrationProof: string; expiresIn: number }> {
  const registrationProof = randomBytes(32).toString('base64url');
  const digest = proofDigest(registrationProof);
  const [currentKey, proofKey] = keysFor(phone, digest);

  await redis.eval(
    ISSUE_CONTINUATION_SCRIPT,
    2,
    currentKey,
    proofKey,
    digest,
    String(SIGNUP_CONTINUATION_TTL_S),
  );

  return { registrationProof, expiresIn: SIGNUP_CONTINUATION_TTL_S };
}

export async function consumeSignupContinuation(
  redis: Pick<Redis, 'eval'>,
  phone: string,
  registrationProof: string,
): Promise<boolean> {
  if (!CONTINUATION_PATTERN.test(registrationProof)) return false;

  const digest = proofDigest(registrationProof);
  const [currentKey, proofKey] = keysFor(phone, digest);
  const consumed = Number(await redis.eval(
    CONSUME_CONTINUATION_SCRIPT,
    2,
    currentKey,
    proofKey,
    digest,
  ));
  return consumed === 1;
}
