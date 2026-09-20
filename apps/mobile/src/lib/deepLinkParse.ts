// PURE deep-link parsing [qr spec Part 6.2] — no RN imports, fully testable.
// A universal link hands the app a full https URL; only exactly-shaped
// /store/{slug} and /s/{code} paths are ours, anything else opens the app
// normally (never a crash, never a guess).
//
// [MOB-002] The ORIGIN is judged before the path. A valid-looking path on a
// hostile host (https://attacker.example/store/valid-slug), an http lookalike,
// a suffix-confusion host, credentials, a port, a fragment, punycode, a
// trailing dot, an encoded separator or an unknown custom-scheme authority is
// NOT ours — the link policy (linkPolicy.ts) says so first, and says why.

import { classifyLink, policyFrom, restrictPolicy, type LinkDecision, type LinkPolicy, type LinkVerdict } from './linkPolicy';
import { CANONICAL_PUBLIC_SITE_ORIGIN, resolveLinkBuildChannel } from './publicOrigin';

export type LinkDestination =
  | { kind: 'store'; slug: string; code: string | null }
  | { kind: 'short'; code: string };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CODE_RE = /^[23456789bcdfghjkmnpqrstvwxyz]{10}$/i;

// ---------------------------------------------------------------------------
// The build's policy: production links are the one public-web origin declared
// for Swift, never an API host or a mutable EXPO_PUBLIC_WEB_URL. Preview hosts
// are an explicit, separately restricted allowlist; plain http is tolerated
// for loopback only in a development build.
// ---------------------------------------------------------------------------

declare const __DEV__: boolean | undefined;

let policy: LinkPolicy | null = null;

export function linkPolicyForBuild(opts: {
  isDev: boolean;
  channel?: string | undefined;
  webUrl?: string | undefined;
  previewHosts?: string | null | undefined;
}): LinkPolicy {
  if (opts.isDev) {
    return policyFrom({
      webUrl: opts.webUrl ?? 'http://localhost:3001',
      previewHosts: opts.previewHosts ?? null,
      scheme: 'swift',
      isDev: true,
    });
  }

  const channel = resolveLinkBuildChannel(opts.channel);
  if (channel === 'production') {
    // An absent, stale, API, or hostile public origin opens nothing.  Do not
    // substitute the legacy swift.gy domain in a release.
    if (opts.webUrl !== CANONICAL_PUBLIC_SITE_ORIGIN) {
      return policyFrom({ webUrl: '', scheme: 'swift', isDev: false });
    }
    return policyFrom({ webUrl: CANONICAL_PUBLIC_SITE_ORIGIN, scheme: 'swift', isDev: false });
  }

  if (channel === 'preview') {
    // Preview must name each host explicitly.  It does not inherit the live
    // public domain, otherwise a staging build could handle a production link.
    const candidate = policyFrom({
      webUrl: CANONICAL_PUBLIC_SITE_ORIGIN,
      previewHosts: opts.previewHosts ?? null,
      scheme: 'swift',
      isDev: false,
    });
    return restrictPolicy(candidate, candidate.previewHosts);
  }

  // A release artifact with no declared link channel is fail-closed.
  return policyFrom({ webUrl: '', scheme: 'swift', isDev: false });
}

export function defaultLinkPolicy(): LinkPolicy {
  if (!policy) {
    const isDev = typeof __DEV__ !== 'undefined' && __DEV__ === true;
    policy = linkPolicyForBuild({
      isDev,
      channel: process.env['EXPO_PUBLIC_LINK_ENV'],
      webUrl: process.env['EXPO_PUBLIC_WEB_URL'],
      previewHosts: process.env['EXPO_PUBLIC_LINK_PREVIEW_HOSTS'] ?? null,
    });
  }
  return policy;
}

/** Test seam: replace (or, with null, recompute) the build policy. */
export function setLinkPolicyForTests(next: LinkPolicy | null): void {
  policy = next;
}

// ---------------------------------------------------------------------------
// Decisions are observable: deep_link_accepted (origin) and deep_link_rejected
// (reason). The router installs an observer that hands them to analytics;
// nothing leaves the device unless analytics does (lib/analytics.ts).
// ---------------------------------------------------------------------------

let observer: ((decision: LinkDecision) => void) | null = null;
const counters = { accepted: new Map<string, number>(), rejected: new Map<string, number>() };

export function setLinkDecisionObserver(fn: ((decision: LinkDecision) => void) | null): void {
  observer = fn;
}

/** On-device counters of every decision, keyed by origin (accepted) and reason (rejected). */
export function linkDecisionCounters(): { accepted: Record<string, number>; rejected: Record<string, number> } {
  return { accepted: Object.fromEntries(counters.accepted), rejected: Object.fromEntries(counters.rejected) };
}

export function resetLinkDecisionsForTests(): void {
  counters.accepted.clear();
  counters.rejected.clear();
}

function report(decision: LinkDecision): void {
  const map = decision.kind === 'accepted' ? counters.accepted : counters.rejected;
  const key = decision.kind === 'accepted' ? decision.origin : decision.reason;
  map.set(key, (map.get(key) ?? 0) + 1);
  try { observer?.(decision); } catch { /* an observer never breaks a link */ }
}

/** Why a URL is or is not a Swift link — the policy verdict, for the scanner's copy and for tests. */
export function explainUrl(url: string, linkPolicy: LinkPolicy = defaultLinkPolicy()): LinkVerdict {
  return classifyLink(url, linkPolicy);
}

export function destinationForUrl(url: string, linkPolicy: LinkPolicy = defaultLinkPolicy()): LinkDestination | null {
  const verdict = classifyLink(url, linkPolicy);
  if (!verdict.ok) {
    report({ kind: 'rejected', reason: verdict.reason, host: verdict.host });
    return null;
  }
  const { parts, query, origin, host } = verdict;
  if (parts.length !== 2) {
    report({ kind: 'rejected', reason: 'path_shape', host });
    return null;
  }
  const [head, tail] = parts as [string, string];
  if (head === 'store' && SLUG_RE.test(tail)) {
    const c = query.get('c');
    report({ kind: 'accepted', origin, host });
    return { kind: 'store', slug: tail, code: c && CODE_RE.test(c) ? c.toUpperCase() : null };
  }
  if (head === 's' && CODE_RE.test(tail)) {
    report({ kind: 'accepted', origin, host });
    return { kind: 'short', code: tail.toUpperCase() };
  }
  report({ kind: 'rejected', reason: 'path_shape', host });
  return null;
}
