import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// SWIFT-AUD-D1-01 — rate-limit key.
//
// The global ceiling used to key purely off the client IP. Two problems at
// launch scale:
//   • many legitimate users behind one carrier NAT / office proxy share a
//     single IP, so they collectively burn one ceiling and throttle each other;
//   • an authenticated abuser could rotate IPs to multiply their effective
//     allowance.
//
// So: bucket authenticated callers by their session token instead of their IP.
// The token is HASHED — never the raw bearer value in a Redis key (that would
// put a live credential into the store and any key-dump/log). Anonymous
// requests still fall back to the proxy-resolved IP (never the spoofable
// X-Forwarded-For, which fastify's trustProxy resolves for us).
//
// Keying by token, not decoded userId, is deliberate: it needs no JWT verify in
// the hot path and can't be spoofed to attack a victim's bucket — you'd need
// the victim's actual token. A user's separate sessions get separate buckets,
// which only ever loosens the limit for a real multi-device user.
// ---------------------------------------------------------------------------

export function rateLimitKey(req: Pick<FastifyRequest, 'headers' | 'ip'>): string {
  const authz = req.headers['authorization'];
  if (typeof authz === 'string' && authz.startsWith('Bearer ') && authz.length > 'Bearer '.length + 4) {
    const token = authz.slice('Bearer '.length);
    return 'u:' + createHash('sha256').update(token).digest('hex').slice(0, 32);
  }
  return req.ip;
}
