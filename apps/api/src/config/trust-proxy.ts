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
 *   "1", "2", …       a HOP COUNT — trust that many proxies from the edge
 *   "10.0.0.0/8, …"   an IP / CIDR / preset list
 *
 * [DEP-1] The return type is deliberately WIDER than fastify's own
 * `trustProxy` option. fastify 5.12 narrowed that option to
 * `boolean | string | string[] | TrustProxyFunction` and dropped `number` —
 * but the RUNTIME did not change: `getTrustProxyFn` in fastify/lib/request.js
 * still branches on `typeof tp === 'number'` with the comment "Support
 * trusting hop count", while a STRING is split on commas and compiled as
 * IP/CIDR values by @fastify/proxy-addr.
 *
 * So `"1"` and `1` are NOT the same instruction: the number means one hop, the
 * string means an address literally called "1". Coercing the hop count to a
 * string to satisfy the narrowed type would silently change which proxies are
 * trusted — a security control — while the compiler went quiet. The number
 * stays, and `asFastifyTrustProxy` is the one place the gap is absorbed.
 */
export function parseTrustProxy(v?: string): boolean | number | string {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

/**
 * The same value, typed for fastify. A cast, and the only one — kept next to
 * the explanation above so it is never mistaken for laziness.
 */
export function asFastifyTrustProxy(v?: string): FastifyServerOptions['trustProxy'] {
  return parseTrustProxy(v) as FastifyServerOptions['trustProxy'];
}
