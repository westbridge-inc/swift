// [AUD-G7-023 · MASTER-071 · board row 202] Checking the emergency-number
// policy's signature on the phone — pure, no RN imports, fully testable.
//
// Builds up to 11 accepted any served policy with the right SHAPE (a
// "signature" object with two strings), so anything able to alter the response
// — a compromised proxy, a poisoned cache, a server bug — could choose the
// number the SOS button dials. The API now signs the policy with Ed25519
// (apps/api modules/country/emergency-policy-signature.ts) and this app pins
// the public keys (emergencyPolicyPins.ts). A policy is trusted only when ALL of
// these hold:
//   - the envelope is exactly { version: 2, alg: 'Ed25519', kid, payload, signature };
//   - the kid is pinned in this app, and the Ed25519 signature over
//       "swift.emergency-policy.v2" NUL "Ed25519" NUL kid NUL payload
//     verifies under that pin (strict RFC 8032, no ZIP-215 leniency);
//   - the payload is canonical JSON of exactly {country, expiresAt, issuedAt,
//     numbers, v: 2}, with only police / fire / ambulance → {number, verified};
//   - it is for the market that was asked for, issued no later than 15 minutes
//     ahead of this phone's clock, lives at most 24 hours, and has not expired;
//   - if the pin has a `notAfter` (the staging pin), this phone's clock reads
//     before it; the policy is then held no later than it (`expiresAt` is the
//     earlier of the signed expiry and the pin's notAfter).
// Any failure, or any exception on the way, is "no policy" — never a number.

import { ed25519 } from '@noble/curves/ed25519';
import type { EmergencyPolicyPin } from './emergencyPolicyPins';

export const EMERGENCY_ENVELOPE_MESSAGE_PREFIX = 'swift.emergency-policy.v2';
export const MAX_EMERGENCY_POLICY_LIFETIME_MS = 24 * 60 * 60_000;
export const MAX_EMERGENCY_POLICY_CLOCK_AHEAD_MS = 15 * 60_000;
const MAX_PAYLOAD_CHARS = 2_048;

const KID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const HEX_64_BYTES = /^[0-9a-f]{128}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const NUMBER_RE = /^\+?[0-9]{2,15}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const SIGNED_SERVICES = ['ambulance', 'fire', 'police'] as const;
type SignedService = (typeof SIGNED_SERVICES)[number];

export interface VerifiedEmergencyPayload {
  readonly kid: string;
  readonly country: string;
  readonly issuedAt: number;
  /** Until when this policy is trusted: the signed expiry, or the pin's notAfter if that is earlier. */
  readonly expiresAt: number;
  readonly numbers: Readonly<Partial<Record<SignedService, Readonly<{ number: string; verified: boolean }>>>>;
}

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const hasExactly = (o: Plain, keys: readonly string[]): boolean => {
  const own = Object.keys(o).sort();
  return own.length === keys.length && [...keys].sort().every((k, i) => own[i] === k);
};

/** Lowercase hex → bytes (the pattern is checked first by the caller). */
function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The exact bytes the API signs. ASCII only (kid and payload are checked first), so no text encoder is needed. */
export function emergencyEnvelopeMessage(kid: string, payload: string): Uint8Array {
  const text = `${EMERGENCY_ENVELOPE_MESSAGE_PREFIX}\0Ed25519\0${kid}\0${payload}`;
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c > 0x7e) throw new Error('emergency policy message is not ASCII');
    out[i] = c;
  }
  return out;
}

/** The API's canonical payload text for these facts — sorted keys, no whitespace. */
export function canonicalEmergencyPayload(p: { country: string; issuedAt: number; expiresAt: number; numbers: VerifiedEmergencyPayload['numbers'] }): string {
  const numbers: Record<string, { number: string; verified: boolean }> = {};
  for (const service of SIGNED_SERVICES) {
    const entry = p.numbers[service];
    if (entry) numbers[service] = { number: entry.number, verified: entry.verified };
  }
  return JSON.stringify({ country: p.country, expiresAt: p.expiresAt, issuedAt: p.issuedAt, numbers, v: 2 });
}

/** The signed payload, read strictly: exact keys, exact types, and it must already be in canonical form. */
function readPayload(payload: string): Omit<VerifiedEmergencyPayload, 'kid'> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isPlain(parsed) || !hasExactly(parsed, ['country', 'expiresAt', 'issuedAt', 'numbers', 'v'])) return null;
  const { country, expiresAt, issuedAt, numbers: rawNumbers, v } = parsed;
  if (v !== 2 || typeof country !== 'string' || !COUNTRY_RE.test(country)) return null;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return null;
  if (!isPlain(rawNumbers)) return null;
  const numbers: Partial<Record<SignedService, Readonly<{ number: string; verified: boolean }>>> = {};
  for (const service of Object.keys(rawNumbers)) {
    if (!(SIGNED_SERVICES as readonly string[]).includes(service)) return null;
    const entry = rawNumbers[service];
    if (!isPlain(entry) || !hasExactly(entry, ['number', 'verified'])) return null;
    if (typeof entry['number'] !== 'string' || !NUMBER_RE.test(entry['number']) || typeof entry['verified'] !== 'boolean') return null;
    numbers[service as SignedService] = Object.freeze({ number: entry['number'], verified: entry['verified'] });
  }
  if (Object.keys(numbers).length === 0) return null;
  const facts = { country, issuedAt: issuedAt as number, expiresAt: expiresAt as number, numbers: Object.freeze(numbers) };
  // Duplicate keys, reordering, spacing or any other re-encoding of the same facts is refused.
  if (canonicalEmergencyPayload(facts) !== payload) return null;
  return facts;
}

/**
 * The served envelope → the verified facts, or null. `country` is the market the
 * phone ASKED for; a response for another market is never accepted for it.
 */
export function verifyEmergencyEnvelope(
  raw: unknown,
  opts: { country: string; now: number; pins: readonly EmergencyPolicyPin[] },
): VerifiedEmergencyPayload | null {
  try {
    if (!isPlain(raw) || !hasExactly(raw, ['alg', 'kid', 'payload', 'signature', 'version'])) return null;
    if (raw['version'] !== 2 || raw['alg'] !== 'Ed25519') return null;
    const { kid, payload, signature } = raw;
    if (typeof kid !== 'string' || !KID_RE.test(kid)) return null;
    if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD_CHARS || !PRINTABLE_ASCII.test(payload)) return null;
    if (typeof signature !== 'string' || !HEX_64_BYTES.test(signature)) return null;
    const pin = opts.pins.find((p) => p.kid === kid);
    if (!pin || !HEX_32_BYTES.test(pin.ed25519)) return null;
    // A pin's hard end of trust (the staging pin): at and after it, on this
    // phone's clock, nothing that key signed is a policy. Malformed fails closed.
    const notAfter = pin.notAfter;
    if (notAfter !== undefined && (!Number.isSafeInteger(notAfter) || opts.now >= notAfter)) return null;
    // THE check: the bytes were signed by the holder of a key this app pins.
    if (!ed25519.verify(hexBytes(signature), emergencyEnvelopeMessage(kid, payload), hexBytes(pin.ed25519), { zip215: false })) return null;
    const facts = readPayload(payload);
    if (!facts) return null;
    if (facts.country !== opts.country) return null;
    if (!(facts.issuedAt < facts.expiresAt) || facts.expiresAt - facts.issuedAt > MAX_EMERGENCY_POLICY_LIFETIME_MS) return null;
    if (facts.issuedAt > opts.now + MAX_EMERGENCY_POLICY_CLOCK_AHEAD_MS || facts.expiresAt <= opts.now) return null;
    // A policy from an expiring pin is held no later than the pin's notAfter.
    return Object.freeze({ kid, ...facts, expiresAt: notAfter === undefined ? facts.expiresAt : Math.min(facts.expiresAt, notAfter) });
  } catch {
    return null;
  }
}
