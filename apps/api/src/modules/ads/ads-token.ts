import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

// Impression token (ads-platform spec §11.3) — what makes a stat billable. The
// serve endpoint signs one per rendered creative; the events endpoint verifies
// it. An event whose token was never issued by a real serve is impossible by
// construction — that IS the anti-fraud core. Secret is ADS_EVENT_SECRET
// (server-only, never in the client bundle).

export interface AdTokenPayload {
  v: 1; // token schema version — legacy unscoped tokens are not billable
  c: string; // campaignId
  r: string; // creativeId
  p: string; // placementKey
  s: string; // sessionId
  a: string; // signed serve-time principal scope (guest or pseudonymous user)
  e: number; // expiry (epoch ms)
}

function secret(): string {
  const s = process.env['ADS_EVENT_SECRET'];
  if (s && s.length >= 16) return s;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('ADS_EVENT_SECRET missing or too short in production');
  }
  return 'dev-ads-event-secret-not-for-production';
}

const b64url = (buf: Buffer) => buf.toString('base64url');

function sign(payloadB64: string): string {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

/** A guest token is deliberately usable only by a request with no valid auth.
 *  Authenticated markers are HMACs scoped to the client app session: they do
 *  not expose a raw user id and cannot be joined across app sessions. */
export function adPrincipalScope(userId: string | null, appSessionId: string): string {
  if (!userId) return 'g';
  const digest = createHmac('sha256', secret())
    .update('swift-ad-principal-v1\0')
    .update(userId)
    .update('\0')
    .update(appSessionId)
    .digest('base64url');
  return `u.${digest}`;
}

/** Constant-time comparison between the token's serve-time principal and the
 *  current request principal. The signed app session is used for recomputing
 *  the marker, so access-token/session rotation for the same user is safe. */
export function adTokenMatchesPrincipal(payload: AdTokenPayload, userId: string | null, authPresented: boolean): boolean {
  // Optional-auth routes intentionally degrade invalid credentials to a guest
  // principal. A guest ad event is nevertheless valid only when the client
  // explicitly omitted Authorization, never when it presented stale/invalid
  // credentials that happened to fail authentication.
  if (!userId && authPresented) return false;
  const expected = Buffer.from(adPrincipalScope(userId, payload.s), 'utf8');
  const actual = Buffer.from(payload.a, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Mint a token for a served creative. `ttlMinutes` default 15 (§11.3). */
export function signImpressionToken(
  payload: Omit<AdTokenPayload, 'v' | 'a' | 'e'>,
  userId: string | null,
  now = Date.now(),
  ttlMinutes = 15,
): string {
  const full: AdTokenPayload = {
    v: 1,
    ...payload,
    a: adPrincipalScope(userId, payload.s),
    e: now + ttlMinutes * 60_000,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(full), 'utf8'));
  return `${payloadB64}.${sign(payloadB64)}`;
}

export type TokenVerdict =
  | { ok: true; payload: AdTokenPayload }
  | { ok: false; reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' };

/** Verify a token: signature (constant-time) then expiry. Never throws. */
export function verifyImpressionToken(token: string, now = Date.now()): TokenVerdict {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'MALFORMED' };
  const [payloadB64, sig] = token.split('.', 2);
  if (!payloadB64 || !sig) return { ok: false, reason: 'MALFORMED' };
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_SIGNATURE' };
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (
    typeof payload !== 'object'
    || payload === null
    || (payload as Partial<AdTokenPayload>).v !== 1
    || typeof (payload as Partial<AdTokenPayload>).c !== 'string'
    || typeof (payload as Partial<AdTokenPayload>).r !== 'string'
    || typeof (payload as Partial<AdTokenPayload>).p !== 'string'
    || typeof (payload as Partial<AdTokenPayload>).s !== 'string'
    || typeof (payload as Partial<AdTokenPayload>).a !== 'string'
    || typeof (payload as Partial<AdTokenPayload>).e !== 'number'
  ) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const typed = payload as AdTokenPayload;
  if (now > typed.e) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, payload: typed };
}

/** sha256(userId + rotating daily salt) — the pseudonymous user key for
 *  frequency capping and stats. Raw user ids NEVER enter AdEvent (§12.2). The
 *  salt rotates each tenant-local day, so yesterday's hashes don't join to
 *  today's. */
export function userHash(userId: string, dayKey: string): string {
  return createHash('sha256').update(`${userId}:${dayKey}:${secret()}`).digest('hex');
}
