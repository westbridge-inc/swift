import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { signingKeyFor, storageSigningKeys, type SigningKeyring } from '../../utils/signing-keys';

/**
 * [MOB-018] The market emergency policy.
 *
 * The phone used to dial a hard-coded `tel:911` from three screens — right for
 * the launch market, wrong the moment a configured market is not Guyana, and
 * unknowable from the code. The numbers a person is told to dial in an
 * emergency are MARKET FACTS that ops verifies (a physical-device drill with
 * legal/operations sign-off), so they live on the market's `CountryConfig`
 * row, per service, each with its own `verified` flag, and the API serves them
 * signed and cacheable. The app auto-dials only a VERIFIED number; an
 * unverified one is offered with a confirm; none at all is an honest manual
 * dial sheet — never a wrong number dialed with confidence.
 */
export type EmergencyService = 'police' | 'fire' | 'ambulance';
export const EMERGENCY_SERVICES: EmergencyService[] = ['police', 'fire', 'ambulance'];

export interface EmergencyNumber {
  /** Digits only, optionally a leading +; 2–15 characters. */
  number: string;
  /** Verified by ops for THIS market (drill + sign-off); only a verified number is auto-dialed. */
  verified: boolean;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
}

export interface MarketEmergencyPolicy {
  country: string;
  numbers: Partial<Record<EmergencyService, EmergencyNumber>>;
  notes?: string | null;
}

export interface SignedEmergencyPolicy {
  version: 1;
  country: string;
  numbers: Partial<Record<EmergencyService, EmergencyNumber>>;
  issuedAt: string;
  expiresAt: string;
  signature: { alg: 'HMAC-SHA256'; kid: string; value: string };
}

const NUMBER_RE = /^\+?[0-9]{2,15}$/;
export const EMERGENCY_POLICY_TTL_MS = 24 * 60 * 60_000;

/** The stored JSON, validated. `null` when there is no policy; a malformed one is a problem, never a policy. */
export function parseEmergencyPolicy(country: string, raw: unknown): { policy: MarketEmergencyPolicy | null; problem?: string } {
  if (raw === null || raw === undefined) return { policy: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { policy: null, problem: 'policy is not an object' };
  const numbers: Partial<Record<EmergencyService, EmergencyNumber>> = {};
  const r = raw as Record<string, unknown>;
  for (const service of EMERGENCY_SERVICES) {
    const entry = r[service];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'object' || Array.isArray(entry)) return { policy: null, problem: `${service} is not an object` };
    const e = entry as Record<string, unknown>;
    if (typeof e['number'] !== 'string' || !NUMBER_RE.test(e['number'])) return { policy: null, problem: `${service}.number is not a dialable number` };
    if (typeof e['verified'] !== 'boolean') return { policy: null, problem: `${service}.verified is not a boolean` };
    if (e['verified'] === true && (typeof e['verifiedAt'] !== 'string' || Number.isNaN(Date.parse(e['verifiedAt'])))) {
      return { policy: null, problem: `${service} is marked verified without a verification date` };
    }
    numbers[service] = {
      number: e['number'],
      verified: e['verified'],
      verifiedAt: typeof e['verifiedAt'] === 'string' ? e['verifiedAt'] : null,
      verifiedBy: typeof e['verifiedBy'] === 'string' ? e['verifiedBy'] : null,
    };
  }
  if (Object.keys(numbers).length === 0) return { policy: null, problem: 'policy names no service' };
  const notes = typeof r['notes'] === 'string' ? r['notes'] : null;
  return { policy: { country, numbers, notes } };
}

/** Stable bytes to sign: sorted keys, no whitespace. */
export function canonicalPolicyPayload(p: Omit<SignedEmergencyPolicy, 'signature'>): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(sortKeys(p));
}

export function signEmergencyPolicy(policy: MarketEmergencyPolicy, keyring: SigningKeyring, now = new Date(), ttlMs = EMERGENCY_POLICY_TTL_MS): SignedEmergencyPolicy {
  const unsigned: Omit<SignedEmergencyPolicy, 'signature'> = {
    version: 1,
    country: policy.country,
    numbers: policy.numbers,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  const value = createHmac('sha256', keyring.current.secret).update(canonicalPolicyPayload(unsigned)).digest('hex');
  return { ...unsigned, signature: { alg: 'HMAC-SHA256', kid: keyring.current.kid, value } };
}

/** True only for a policy signed by a key this process holds, unexpired, byte-for-byte. */
export function verifyEmergencyPolicy(signed: SignedEmergencyPolicy, keyring: SigningKeyring, now = new Date()): boolean {
  if (!signed || signed.version !== 1 || signed.signature?.alg !== 'HMAC-SHA256') return false;
  const key = signingKeyFor(signed.signature.kid, keyring);
  if (!key) return false;
  const expires = Date.parse(signed.expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return false;
  const { signature, ...unsigned } = signed;
  const expected = createHmac('sha256', key.secret).update(canonicalPolicyPayload(unsigned)).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature.value), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type ServedEmergencyPolicy =
  | { status: 'served'; signed: SignedEmergencyPolicy }
  | { status: 'no-policy'; country: string }
  | { status: 'invalid'; country: string; problem: string }
  | { status: 'unknown-market'; country: string };

/** What the public route answers: a signed policy, an honest "none", an invalid stored policy (never served), or an unknown market. */
export async function serveEmergencyPolicy(prisma: PrismaClient, country: string, keyring: SigningKeyring = storageSigningKeys(), now = new Date()): Promise<ServedEmergencyPolicy> {
  const code = country.toUpperCase();
  const row = await prisma.countryConfig.findUnique({ where: { code }, select: { code: true, emergency: true } });
  if (!row) return { status: 'unknown-market', country: code };
  const { policy, problem } = parseEmergencyPolicy(code, row.emergency);
  if (problem) return { status: 'invalid', country: code, problem };
  if (!policy) return { status: 'no-policy', country: code };
  return { status: 'served', signed: signEmergencyPolicy(policy, keyring, now) };
}
