import { createHash, createPrivateKey, createPublicKey, sign as signBytes } from 'node:crypto';
import { isProduction } from '../../utils/runtime-mode';
import type { MarketEmergencyPolicy } from './emergency-policy';

/**
 * [AUD-G7-023 · MASTER-071 · board row 202] The emergency-number policy, SIGNED
 * so the phone can check it.
 *
 * The v1 response carries an HMAC "signature" the phone can never check (the
 * HMAC secret cannot ship in an app), so phones up to build 11 accept any
 * policy that merely has the right SHAPE: anything able to alter the response
 * (a compromised proxy, a poisoned cache, a server bug) could change the number
 * the SOS button dials. Now the API also signs the policy with an Ed25519 key
 * whose PUBLIC half is pinned inside the app (apps/mobile/src/lib/
 * emergencyPolicyPins.ts). Build 12 and later trust a served number only when
 * that signature verifies; otherwise they keep the last policy that verified,
 * or their bundled numbers (Guyana 911 / 912 / 913).
 *
 * Backward compatible: the envelope is an ADDED field (`envelope`) beside the
 * unchanged v1 body. Builds 9-11 read only the v1 fields and ignore it.
 *
 * The private key is a managed secret, EMERGENCY_POLICY_SIGNING_KEY (at least
 * 32 characters, delivered as a *_FILE from the encrypted host store, never in
 * .env, a log, or the repository). The Ed25519 key is derived from it:
 * seed = SHA-256(domain, NUL, secret). The public half is not secret; the API
 * logs it at boot so the owner can pin it in the app (deploy/PILOT-RUNBOOK.md).
 *
 * The signed bytes (both sides build them the same way):
 *   "swift.emergency-policy.v2" NUL "Ed25519" NUL kid NUL payload
 * where payload is canonical ASCII JSON with sorted keys and no spaces:
 *   {"country":"GY","expiresAt":<ms>,"issuedAt":<ms>,"numbers":{"ambulance":{"number":"913","verified":true},...},"v":2}
 * Only number + verified are signed; ops notes and who verified stay internal.
 */

export const EMERGENCY_POLICY_SIGNING_KEY_NAME = 'EMERGENCY_POLICY_SIGNING_KEY';
export const MIN_EMERGENCY_POLICY_SECRET_LENGTH = 32;
export const EMERGENCY_ENVELOPE_VERSION = 2;
export const EMERGENCY_ENVELOPE_ALG = 'Ed25519';
export const EMERGENCY_ENVELOPE_MESSAGE_PREFIX = 'swift.emergency-policy.v2';
/** The phone refuses a policy that claims a longer life than this. */
export const EMERGENCY_ENVELOPE_TTL_MS = 24 * 60 * 60_000;

const SEED_DOMAIN = 'swift.emergency-policy.ed25519-seed.v1';
// RFC 8410: the fixed PKCS#8 header for a raw 32-byte Ed25519 private key.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const KID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
// The signed services in canonical (sorted) order; a type import keeps this module free of a cycle.
const SIGNED_SERVICES = ['ambulance', 'fire', 'police'] as const;

export interface EmergencyEnvelope {
  version: 2;
  alg: 'Ed25519';
  kid: string;
  /** Canonical ASCII JSON — the exact signed text. */
  payload: string;
  /** 64 bytes, lowercase hex. */
  signature: string;
}

/** The signing side. The private key never leaves this closure: no getter, no serializer. */
export interface EmergencyPolicySigner {
  readonly kid: string;
  /** The 32-byte Ed25519 public key, lowercase hex — NOT a secret; this is what the app pins. */
  readonly publicKeyHex: string;
  sign(message: Buffer): Buffer;
}

/** Derive the Ed25519 signer from the managed secret. Pure; never logs. */
export function emergencyPolicySignerFromSecret(secret: string): EmergencyPolicySigner {
  const seed = createHash('sha256').update(SEED_DOMAIN).update('\0').update(secret, 'utf8').digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  seed.fill(0);
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const raw = spki.subarray(spki.length - 32);
  const kid = `ep1-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  return Object.freeze({
    kid,
    publicKeyHex: raw.toString('hex'),
    sign: (message: Buffer) => signBytes(null, message, privateKey),
  });
}

let cached: { secret: string; signer: EmergencyPolicySigner } | null = null;

/**
 * The signer for this process, or null when no key is configured outside
 * production (development and tests serve the v1 body only; the phone then
 * uses its bundled numbers). Production NEVER runs without one, and a key that
 * is set but too short is refused in every mode. Messages carry no value.
 */
export function emergencyPolicySigner(env: Record<string, string | undefined> = process.env): EmergencyPolicySigner | null {
  const secret = env[EMERGENCY_POLICY_SIGNING_KEY_NAME];
  if (secret === undefined || secret === '') {
    if (isProduction(env)) {
      throw new Error(
        `FATAL: ${EMERGENCY_POLICY_SIGNING_KEY_NAME} is required in production — it signs the emergency-number policy the phone ` +
        'checks before trusting a served number. Store it in the encrypted host store (deploy/owner/emergency-policy-key.command). Refusing to start.',
      );
    }
    return null;
  }
  if (secret.length < MIN_EMERGENCY_POLICY_SECRET_LENGTH) {
    throw new Error(
      `FATAL: ${EMERGENCY_POLICY_SIGNING_KEY_NAME} must be a managed secret of at least ${MIN_EMERGENCY_POLICY_SECRET_LENGTH} characters — ` +
      'a short value is a guessable emergency-policy signing key. Refusing to start.',
    );
  }
  if (cached && cached.secret === secret) return cached.signer;
  const signer = emergencyPolicySignerFromSecret(secret);
  cached = { secret, signer };
  return signer;
}

/** The boot guard (server.ts): throws on a missing production key or a short one anywhere. */
export function assertEmergencyPolicySigningConfig(env: Record<string, string | undefined> = process.env): EmergencyPolicySigner | null {
  return emergencyPolicySigner(env);
}

/** The exact signed text: sorted keys, no whitespace, ASCII only, only number + verified per service. */
export function canonicalEmergencyPayload(p: { country: string; issuedAt: number; expiresAt: number; numbers: MarketEmergencyPolicy['numbers'] }): string {
  const numbers: Record<string, { number: string; verified: boolean }> = {};
  for (const service of SIGNED_SERVICES) {
    const entry = p.numbers[service];
    if (entry) numbers[service] = { number: entry.number, verified: entry.verified === true };
  }
  const payload = JSON.stringify({ country: p.country, expiresAt: p.expiresAt, issuedAt: p.issuedAt, numbers, v: EMERGENCY_ENVELOPE_VERSION });
  if (!PRINTABLE_ASCII.test(payload)) throw new Error('emergency policy payload is not printable ASCII');
  return payload;
}

/** The bytes Ed25519 signs: purpose + version, algorithm, key id and the payload, NUL-separated. */
export function emergencyEnvelopeMessage(kid: string, payload: string): Buffer {
  if (!KID_RE.test(kid)) throw new Error('emergency policy key id is malformed');
  if (!PRINTABLE_ASCII.test(payload)) throw new Error('emergency policy payload is not printable ASCII');
  return Buffer.from(`${EMERGENCY_ENVELOPE_MESSAGE_PREFIX}\0${EMERGENCY_ENVELOPE_ALG}\0${kid}\0${payload}`, 'utf8');
}

/** Sign a validated market policy for `ttlMs` from `now`. */
export function signEmergencyEnvelope(
  policy: MarketEmergencyPolicy,
  signer: EmergencyPolicySigner,
  now = new Date(),
  ttlMs = EMERGENCY_ENVELOPE_TTL_MS,
): EmergencyEnvelope {
  const issuedAt = now.getTime();
  const payload = canonicalEmergencyPayload({ country: policy.country, issuedAt, expiresAt: issuedAt + ttlMs, numbers: policy.numbers });
  const signature = signer.sign(emergencyEnvelopeMessage(signer.kid, payload)).toString('hex');
  return { version: EMERGENCY_ENVELOPE_VERSION, alg: EMERGENCY_ENVELOPE_ALG, kid: signer.kid, payload, signature };
}
