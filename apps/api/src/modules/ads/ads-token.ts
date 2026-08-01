import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

// Impression token (ads-platform spec §11.3) — what makes a stat billable. The
// serve endpoint signs one per rendered creative; the events endpoint verifies
// it. An event whose token was never issued by a real serve is impossible by
// construction — that IS the anti-fraud core. Secret is ADS_EVENT_SECRET
// (server-only, never in the client bundle).

export interface AdTokenPayload {
  c: string; // campaignId
  r: string; // creativeId
  p: string; // placementKey
  s: string; // sessionId
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

/** Mint a token for a served creative. `ttlMinutes` default 15 (§11.3). */
export function signImpressionToken(payload: Omit<AdTokenPayload, 'e'>, now = Date.now(), ttlMinutes = 15): string {
  const full: AdTokenPayload = { ...payload, e: now + ttlMinutes * 60_000 };
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
  let payload: AdTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (typeof payload.e !== 'number' || now > payload.e) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, payload };
}

/** sha256(userId + rotating daily salt) — the pseudonymous user key for
 *  frequency capping and stats. Raw user ids NEVER enter AdEvent (§12.2). The
 *  salt rotates each tenant-local day, so yesterday's hashes don't join to
 *  today's. */
export function userHash(userId: string, dayKey: string): string {
  return createHash('sha256').update(`${userId}:${dayKey}:${secret()}`).digest('hex');
}
