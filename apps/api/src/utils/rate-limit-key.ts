import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// SWIFT-AUD-D1-01 — rate-limit key (hardened).
//
// The global ceiling used to key purely off the client IP. Two problems at
// launch scale:
//   • many legitimate users behind one carrier NAT / office proxy share a
//     single IP, so they collectively burn one ceiling and throttle each other;
//   • an authenticated abuser could rotate IPs to multiply their effective
//     allowance.
//
// The original fix bucketed authenticated callers by their raw session token,
// hashed. That closed the rotation but opened a worse hole: `onRequest` (where
// the limiter's hook runs) precedes `authenticate`, so ANY string after
// `Bearer ` minted its own bucket — an anonymous attacker rotated fake tokens
// to strip every route-level and global ceiling at zero cost (audit High #1).
//
// So: the bucket now derives from a VERIFIED principal. The key generator
// HMAC-verifies the HS256 access token (algorithm pinned by the auth plugin,
// expiry included) and keys on `u:` + hash(payload.userId). Every token that
// fails verification — malformed, expired, wrong signature, garbage — and
// every request with no token falls back to the proxy-resolved `req.ip`
// (never the spoofable X-Forwarded-For: fastify's trustProxy resolves it and
// TRUST_PROXY decides who may set it). Cookie-carried browser sessions key by
// IP here because the cookie is only adopted later in `authenticate` — a real
// user behind their own IP still gets the normal ceiling, and this key is only
// a rate-limit bucket, never an authorization decision.
// ---------------------------------------------------------------------------

/** The verified token payload shape this key generator needs. */
export interface RateLimitPrincipal {
  userId: string;
}

type TokenVerifier = (token: string) => RateLimitPrincipal | Promise<RateLimitPrincipal>;

export function rateLimitKey(
  verifyToken: TokenVerifier,
): (req: Pick<FastifyRequest, 'headers' | 'ip'>) => Promise<string> {
  return async (req) => {
    const authz = req.headers['authorization'];
    if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
      const token = authz.slice('Bearer '.length);
      if (token.length > 0) {
        try {
          const payload = await verifyToken(token);
          const userId = payload?.userId;
          if (typeof userId === 'string' && userId.length > 0) {
            return 'u:' + createHash('sha256').update(userId).digest('hex').slice(0, 32);
          }
        } catch {
          // Invalid / expired / malformed token: anonymous IP bucket.
        }
      }
    }
    return req.ip;
  };
}
