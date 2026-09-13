import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { isProduction } from './runtime-mode';

const OTP_PREFIX = 'otp:';
const OTP_TTL = 300; // 5 minutes
const OTP_RATE_PREFIX = 'otp_rate:';
const OTP_RATE_TTL = 60; // 1 request per 60 seconds
const OTP_MAX_ATTEMPTS = 5;
const OTP_ATTEMPT_PREFIX = 'otp_attempt:';
const OTP_RECORD_VERSION = 'v2';
const HASH_TAG = 'hmac-sha256:';

/** CSPRNG 6-digit code — Math.random is guessable in principle; this isn't. */
export function generateOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

function otpHashSecret(): string {
  const secret = process.env['OTP_HASH_SECRET'] ?? process.env['JWT_SECRET'];
  if (secret) return secret;
  if (isProduction()) {
    throw new Error('OTP_HASH_SECRET or JWT_SECRET is required in production');
  }
  // Unit/local development only. Production is rejected above and by the boot
  // guard, while tests stay hermetic without weakening deployed records.
  return 'swift-local-otp-hmac-key-not-for-production';
}

const hashOtp = (otp: string) => HASH_TAG + crypto
  .createHmac('sha256', otpHashSecret())
  .update('swift:otp:v2\0')
  .update(otp)
  .digest('hex');

const otpRecord = (otp: string) => `${OTP_RECORD_VERSION}|${hashOtp(otp)}|0`;

// One Redis key holds both the HMAC and attempt count, so this script remains
// atomic on standalone Redis and Redis Cluster. Return codes:
// 0 missing/expired/legacy, 1 consumed, 2 locked, 3 invalid.
const VERIFY_OTP_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end

local expected, attemptsText = string.match(raw, '^v2|([^|]+)|(%d+)$')
if not expected then
  redis.call('DEL', KEYS[1])
  return 0
end

local attempts = tonumber(attemptsText) or 0
local maxAttempts = tonumber(ARGV[2])
if attempts >= maxAttempts then return 2 end

attempts = attempts + 1
if expected == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end

local ttl = redis.call('TTL', KEYS[1])
if ttl <= 0 then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('SET', KEYS[1], 'v2|' .. expected .. '|' .. attempts, 'EX', ttl)
return 3
`;

// Login/signup OTPs need one more invariant than the generic one-key code:
// the exact ceremony consumed by verify must remain current while the handler
// awaits account lookup. These scripts update/consume the OTP record together
// with an opaque generation fence. Callers must give both keys the same Redis
// Cluster hash tag; Redis itself rejects a cross-slot mistake.
const STORE_FENCED_OTP_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
return 1
`;

const VERIFY_FENCED_OTP_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '0' end

local expected, attemptsText = string.match(raw, '^v2|([^|]+)|(%d+)$')
if not expected then
  redis.call('DEL', KEYS[1])
  return '0'
end

local attempts = tonumber(attemptsText) or 0
local maxAttempts = tonumber(ARGV[2])
if attempts >= maxAttempts then return '2' end

attempts = attempts + 1
if expected == ARGV[1] then
  local generation = redis.call('GET', KEYS[2])
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[3])
  if not generation then return '0' end
  return '1|' .. generation
end

local ttl = redis.call('TTL', KEYS[1])
if ttl <= 0 then
  redis.call('DEL', KEYS[1])
  return '0'
end
redis.call('SET', KEYS[1], 'v2|' .. expected .. '|' .. attempts, 'EX', ttl)
return '3'
`;

/** Codes are HASHED at rest (launch-readiness §1.1): a redis snapshot or a
 *  MONITOR tap never yields a usable code. */
export async function storeOtp(redis: Redis, phone: string, otp: string): Promise<void> {
  await redis.set(`${OTP_PREFIX}${phone}`, otpRecord(otp), 'EX', OTP_TTL);
  // Remove the pre-v2 split counter during the rolling cutover. Verification
  // never reads it; new records are one-key/cluster-safe.
  await redis.del(`${OTP_ATTEMPT_PREFIX}${phone}`);
}

export async function verifyOtp(redis: Redis, phone: string, code: string): Promise<{ valid: boolean; reason?: string }> {
  const result = Number(await redis.eval(
    VERIFY_OTP_SCRIPT,
    1,
    `${OTP_PREFIX}${phone}`,
    hashOtp(code),
    String(OTP_MAX_ATTEMPTS),
  ));
  if (result === 1) return { valid: true };
  if (result === 2) return { valid: false, reason: 'Too many attempts. Request a new OTP.' };
  if (result === 3) return { valid: false, reason: 'Invalid OTP code' };
  return { valid: false, reason: 'OTP expired or not found. Request a new one.' };
}

export async function storeFencedOtp(
  redis: Pick<Redis, 'eval'>,
  keys: { record: string; generation: string },
  otp: string,
  generation: string,
  generationTtlSeconds: number,
): Promise<void> {
  await redis.eval(
    STORE_FENCED_OTP_SCRIPT,
    2,
    keys.record,
    keys.generation,
    otpRecord(otp),
    generation,
    String(OTP_TTL),
    String(generationTtlSeconds),
  );
}

export async function verifyFencedOtp(
  redis: Pick<Redis, 'eval'>,
  keys: { record: string; generation: string; invalidateOnSuccess: string },
  code: string,
): Promise<{ valid: boolean; reason?: string; generation?: string }> {
  const raw = String(await redis.eval(
    VERIFY_FENCED_OTP_SCRIPT,
    3,
    keys.record,
    keys.generation,
    keys.invalidateOnSuccess,
    hashOtp(code),
    String(OTP_MAX_ATTEMPTS),
  ));
  if (raw.startsWith('1|')) {
    const generation = raw.slice(2);
    return generation ? { valid: true, generation } : { valid: false, reason: 'OTP expired or not found. Request a new one.' };
  }
  if (raw === '2') return { valid: false, reason: 'Too many attempts. Request a new OTP.' };
  if (raw === '3') return { valid: false, reason: 'Invalid OTP code' };
  return { valid: false, reason: 'OTP expired or not found. Request a new one.' };
}

export async function checkOtpRateLimit(redis: Redis, phone: string): Promise<boolean> {
  // Atomic check-and-set: SET NX returns null if the key already exists, 'OK' if
  // we just claimed it. A plain exists→set is a TOCTOU race — N concurrent
  // requests all see "not set" and all pass, defeating the 1-per-minute cap and
  // letting an attacker fan out SMS (bombing a victim + burning the SMS budget).
  const claimed = await redis.set(`${OTP_RATE_PREFIX}${phone}`, '1', 'EX', OTP_RATE_TTL, 'NX');
  return claimed === 'OK';
}
