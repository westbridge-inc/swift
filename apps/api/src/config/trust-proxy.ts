import type { FastifyServerOptions } from 'fastify';

/**
 * SEC (OWASP API4) — who is allowed to tell us a request's real source IP.
 *
 * `X-Forwarded-For` is a client-supplied header. Trusting it blindly lets a
 * caller claim any source address and walk past every per-IP rate limit and
 * block. So it is trusted ONLY when we are explicitly told what sits in front
 * of us, and the default is `false`.
 *
 * TRUST_PROXY accepts:
 *   "false" / unset   trust nothing (the default)
 *   "true"            trust everything (only behind a proxy you control)
 *   "10.0.0.0/8, …"   an IP / CIDR / preset list — the RECOMMENDED form
 *
 * [DEP-2] A BARE HOP COUNT IS REFUSED, and that is a deliberate change.
 *
 * fastify ≤5.8 read a number as "trust this many hops from the edge". fastify
 * 5.12 changed the RUNTIME, not just the type, in response to a published
 * advisory (X-Forwarded-* spoofing under trustProxy):
 *
 *   // fastify 5.12 lib/request.js
 *   if (typeof tp === 'number') {
 *     // Hop-count-only trust cannot validate the immediate peer. Fail closed so
 *     // direct clients cannot spoof X-Forwarded-* values by supplying enough hops.
 *     return function () { return false }
 *   }
 *
 * So on the new version a hop count silently means TRUST NOTHING. Every request
 * would then be attributed to the proxy's own address: per-IP rate limiting
 * would still "work" while counting the entire internet as one client, and no
 * error would ever be raised.
 *
 * Refusing at boot is the only honest option. A misconfigured deployment stops
 * with a message a person can act on, instead of running with silently broken
 * IP attribution. `DEP-1` (#1071) kept the number to preserve the old
 * behaviour; that was based on a diff of `fastify.js`, which only forwards the
 * option — the branch that actually changed lives in `lib/request.js`. This
 * corrects it.
 */
export class TrustProxyConfigError extends Error {
  readonly code = 'TRUST_PROXY_INVALID';
}

const HOP_COUNT = /^\d+$/;

export function parseTrustProxy(v?: string): boolean | string {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  const trimmed = v.trim();
  if (HOP_COUNT.test(trimmed)) {
    throw new TrustProxyConfigError(
      `TRUST_PROXY=${trimmed} is a hop count, and hop-count trust is no longer honoured: ` +
      'fastify fails it closed because a direct client can spoof X-Forwarded-* by supplying enough hops. ' +
      'Set TRUST_PROXY to the proxy\'s address or CIDR (for example "10.0.0.0/8" or "loopback, 10.0.0.0/8"), ' +
      'or to "true" if every path to this service goes through a proxy you control.',
    );
  }
  return trimmed;
}

/** The same value, typed for fastify. */
export function asFastifyTrustProxy(v?: string): FastifyServerOptions['trustProxy'] {
  return parseTrustProxy(v);
}
