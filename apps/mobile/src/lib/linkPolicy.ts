// The LINK POLICY [MOB-002 / TST-005] — PURE, no RN imports, fully testable.
//
// A universal link or a scanned QR hands the app a URL, and the parser used to
// ask only "is the PATH shaped like ours?" — any https, http or swift URL with
// /store/{slug} or /s/{code} was treated as Swift-owned, so
// https://attacker.example/store/valid-slug resolved and navigated exactly like
// a printed Swift sign, teaching people that an attacker's QR is trusted.
//
// Now the ORIGIN is judged first, exactly, and the path only afterwards:
//
//   universal links     https ONLY · the host is EXACTLY one of the production
//                       hosts (the web origin the app already uses, and its
//                       www. twin) or an explicit preview host · no credentials,
//                       no non-default port, no fragment · no trailing dot, no
//                       punycode, no percent-encoding in the path
//   the custom scheme   swift://{s|store}/… — the authority IS the route word,
//                       nothing else; no credentials, no port, no fragment
//   development         http is tolerated for a LOOPBACK host only, and only
//                       when the build says it is a development build
//
// A rollback can only SHRINK the allowlist (`restrictPolicy`), never widen it,
// and never allow-all. Every decision is reported to an observer so the router
// and the scanner can count accepted origins and rejection reasons.

export interface LinkPolicy {
  /** Exact production hosts, lowercase, no port, no trailing dot. */
  readonly hosts: readonly string[];
  /** Exact preview/staging hosts, explicit per build channel; empty in production. */
  readonly previewHosts: readonly string[];
  /** The app's custom scheme (app.config.ts `scheme`). */
  readonly scheme: string;
  /** Development builds only: plain http to a loopback host (the local web app). */
  readonly allowInsecureLoopback: boolean;
}

export type LinkRejection =
  | 'unparseable'
  | 'scheme'
  | 'http_downgrade'
  | 'credentials'
  | 'port'
  | 'fragment'
  | 'host_trailing_dot'
  | 'host_punycode'
  | 'host_not_allowed'
  | 'encoded_path'
  | 'custom_scheme_authority'
  | 'custom_scheme_port'
  /** the origin is ours but the path is not one of the two printed shapes (the parser's verdict) */
  | 'path_shape';

export type LinkOrigin = 'production' | 'preview' | 'custom-scheme' | 'loopback';

export type LinkVerdict =
  | { ok: true; origin: LinkOrigin; host: string; /** route segments: the authority folded in for the custom scheme */ parts: string[]; query: URLSearchParams }
  | { ok: false; reason: LinkRejection; host: string | null };

export type LinkDecision =
  | { kind: 'accepted'; origin: LinkOrigin; host: string }
  | { kind: 'rejected'; reason: LinkRejection; host: string | null };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** A host as the policy stores it, or null when it cannot be an exact production/preview host. */
export function normalizeHost(raw: string): string | null {
  const host = raw.trim().toLowerCase();
  if (!host || host.endsWith('.') || host.includes(':') || host.includes('/')) return null;
  if (host.split('.').some((label) => label.startsWith('xn--'))) return null;
  if (!HOST_RE.test(host)) return null;
  return host;
}

/**
 * The policy for a build: the production hosts are derived from the ONE web
 * origin the app already uses for the links it hands out, so the app cannot
 * disagree with itself about which domain is Swift's.
 */
export function policyFrom(opts: { webUrl: string; previewHosts?: string | null; scheme?: string; isDev: boolean }): LinkPolicy {
  let host: string | null = null;
  try { host = normalizeHost(new URL(opts.webUrl).hostname); } catch { host = null; }
  const hosts = host && !LOOPBACK.has(host) ? [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`] : [];
  const previewHosts = (opts.previewHosts ?? '')
    .split(',')
    .map((h) => normalizeHost(h))
    .filter((h): h is string => h !== null && !hosts.includes(h));
  return { hosts, previewHosts, scheme: opts.scheme ?? 'swift', allowInsecureLoopback: opts.isDev };
}

/** A rollback shrinks: the result holds only hosts BOTH the policy and the restriction name. Never widens, never allow-all. */
export function restrictPolicy(policy: LinkPolicy, keep: readonly string[]): LinkPolicy {
  const allowed = new Set(keep.map((h) => normalizeHost(h)).filter((h): h is string => h !== null));
  return {
    ...policy,
    hosts: policy.hosts.filter((h) => allowed.has(h)),
    previewHosts: policy.previewHosts.filter((h) => allowed.has(h)),
  };
}

function reject(reason: LinkRejection, host: string | null): LinkVerdict {
  return { ok: false, reason, host };
}

/** Judge the ORIGIN of a URL against the policy. The path shape is the parser's business, after this says yes. */
export function classifyLink(url: string, policy: LinkPolicy): LinkVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return reject('unparseable', null);
  }
  const protocol = parsed.protocol;
  const hostname = parsed.hostname;

  if (protocol === `${policy.scheme}:`) {
    // swift://s/{code} · swift://store/{slug}: the WHATWG parser puts the route
    // word in `host`. That authority is the whole grammar — a hostname, a port,
    // credentials or a fragment there is not a Swift link.
    if (parsed.username || parsed.password) return reject('credentials', hostname || null);
    if (parsed.port) return reject('custom_scheme_port', hostname || null);
    if (parsed.hash || parsed.href.includes('#')) return reject('fragment', hostname || null);
    if (hostname !== 's' && hostname !== 'store') return reject('custom_scheme_authority', hostname || null);
    if (parsed.pathname.includes('%')) return reject('encoded_path', hostname);
    return { ok: true, origin: 'custom-scheme', host: hostname, parts: [hostname, ...parsed.pathname.split('/').filter(Boolean)], query: parsed.searchParams };
  }

  if (protocol !== 'https:' && protocol !== 'http:') return reject('scheme', hostname || null);
  if (parsed.username || parsed.password) return reject('credentials', hostname || null);
  // an EMPTY fragment (a trailing '#') parses to hash === '' but the href still carries it
  if (parsed.hash || parsed.href.includes('#')) return reject('fragment', hostname || null);

  const loopback = LOOPBACK.has(hostname);
  if (protocol === 'http:') {
    if (!(policy.allowInsecureLoopback && loopback)) return reject('http_downgrade', hostname || null);
  } else if (parsed.port) {
    return reject('port', hostname);
  }
  if (hostname.endsWith('.')) return reject('host_trailing_dot', hostname);
  if (hostname.split('.').some((label) => label.startsWith('xn--'))) return reject('host_punycode', hostname);
  if (parsed.pathname.includes('%')) return reject('encoded_path', hostname);

  let origin: LinkOrigin;
  if (policy.hosts.includes(hostname)) origin = 'production';
  else if (policy.previewHosts.includes(hostname)) origin = 'preview';
  else if (loopback && policy.allowInsecureLoopback) origin = 'loopback';
  else return reject('host_not_allowed', hostname);

  return { ok: true, origin, host: hostname, parts: parsed.pathname.split('/').filter(Boolean), query: parsed.searchParams };
}
