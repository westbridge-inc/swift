/**
 * [SWX-DEV-WEB-076 · integrated] ONE authority for the origin the browser
 * calls, and the CSP that permits exactly that origin.
 *
 * Before, each browser consumer read the public variable directly with its
 * own localhost fallback, the CSP allowed
 * `connect-src https: wss:` (any host), and a release build with the variable
 * unset silently pointed every browser at localhost. Now:
 *
 * - development (`next dev`) uses exactly `http://localhost:3000` when nothing
 *   is configured;
 * - a production browser calls the same public-site origin, `https://swiftgy.com`.
 *   Browser session cookies are `SameSite=Strict`; directing the browser to
 *   the separately registered `https://api.swift.gy` upstream would make
 *   authentication cross-site and the cookie rail unusable. Next proxies the
 *   `/api/v1/*` transport path to that upstream server-side instead.
 * - a production build requires both exact origins: `NEXT_PUBLIC_API_URL` is
 *   the browser-visible, same-site transport origin; server-only `API_URL` is
 *   the exact upstream. Neither has a release fallback.
 * - the CSP permits only the browser transport (`'self'`) in production,
 *   never a scheme wildcard or direct upstream connection.
 *
 * The public-site and API domains intentionally differ.  Their relationship is
 * asserted by release-contract tests rather than inferred by string surgery.
 */
import { SITE_ORIGIN } from '../site.domain';

export const DEVELOPMENT_BROWSER_API_ORIGIN = 'http://localhost:3000';
/** Browser-visible API transport. Production cookies remain same-site here. */
export const RELEASE_BROWSER_API_ORIGIN = SITE_ORIGIN;
/** Server-only rewrite target. This is not a browser cookie transport. */
export const RELEASE_UPSTREAM_API_ORIGIN = 'https://api.swift.gy' as const;

export type BrowserApiMode = 'development' | 'production';

// Next's compiler requires this exact dot-form lookup for static replacement.
// The ambient member makes that syntax type-safe under noPropertyAccessFromIndexSignature.
/* eslint-disable no-unused-vars */
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NEXT_PUBLIC_API_URL?: string;
      API_URL?: string;
    }
  }
}
/* eslint-enable no-unused-vars */

const CONFIGURED_BROWSER_API_ORIGIN = process.env.NEXT_PUBLIC_API_URL;
const CONFIGURED_UPSTREAM_API_ORIGIN = process.env.API_URL;

function assertOriginOnly(value: string, envName: 'NEXT_PUBLIC_API_URL' | 'API_URL'): void {
  if (value !== value.trim() || value.length === 0) {
    throw new Error(`${envName} must be an exact absolute origin`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${envName} must be an exact absolute origin`);
  }
  if (
    parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin !== value
  ) {
    throw new Error(`${envName} must not contain credentials, a path, query, fragment, or normalized port`);
  }
}

export function resolveBrowserApiOrigin(
  mode: BrowserApiMode,
  configuredOrigin: string | undefined,
): string {
  if (mode === 'development' && configuredOrigin === undefined) {
    return DEVELOPMENT_BROWSER_API_ORIGIN;
  }
  if (configuredOrigin === undefined) {
    throw new Error(`NEXT_PUBLIC_API_URL is required for a production web build (expected ${RELEASE_BROWSER_API_ORIGIN})`);
  }
  assertOriginOnly(configuredOrigin, 'NEXT_PUBLIC_API_URL');
  const expected = mode === 'production'
    ? RELEASE_BROWSER_API_ORIGIN
    : DEVELOPMENT_BROWSER_API_ORIGIN;
  if (configuredOrigin !== expected) {
    throw new Error(`NEXT_PUBLIC_API_URL must be exactly ${expected} in ${mode}`);
  }
  return expected;
}

export function resolveUpstreamApiOrigin(
  mode: BrowserApiMode,
  configuredOrigin: string | undefined,
): string {
  if (mode === 'development' && configuredOrigin === undefined) {
    return DEVELOPMENT_BROWSER_API_ORIGIN;
  }
  if (configuredOrigin === undefined) {
    throw new Error(`API_URL is required for a production web build (expected ${RELEASE_UPSTREAM_API_ORIGIN})`);
  }
  assertOriginOnly(configuredOrigin, 'API_URL');
  const expected = mode === 'production'
    ? RELEASE_UPSTREAM_API_ORIGIN
    : DEVELOPMENT_BROWSER_API_ORIGIN;
  if (configuredOrigin !== expected) {
    throw new Error(`API_URL must be exactly ${expected} in ${mode}`);
  }
  return expected;
}

/**
 * Resolve the origin used by server-rendered web fetchers. This deliberately
 * shares the upstream validator with Next's rewrite configuration, but picks
 * its mode from the server runtime rather than a browser-build phase:
 * development (and tests) may use the local API by default; production cannot
 * silently call localhost or the public browser transport.
 */
export function resolveServerUpstreamApiOrigin(
  env: Pick<NodeJS.ProcessEnv, 'NODE_ENV' | 'API_URL'> = process.env,
): string {
  return resolveUpstreamApiOrigin(env.NODE_ENV === 'production' ? 'production' : 'development', env.API_URL);
}

export function buildBrowserContentSecurityPolicy(mode: BrowserApiMode): string {
  const connectSources = mode === 'production'
    ? ["'self'"]
    : ["'self'", DEVELOPMENT_BROWSER_API_ORIGIN, 'ws://localhost:3000', 'ws://localhost:3002'];
  // [W-42] The legal pages inject document HTML. Nothing a script can reach
  // survives the legal grammar (src/legal/legal-html.ts), and the CSP shrinks
  // what an injected script could DO: 'unsafe-eval' is granted to development
  // alone (Next's HMR needs it) and never to a production build. A nonce/hash
  // policy and Trusted Types are the next step, stated as such in the register.
  const scriptSources = mode === 'production'
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

  return [
    "default-src 'self'",
    scriptSources,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

export function resolveConfiguredBrowserApiOrigin(mode: BrowserApiMode): string {
  return resolveBrowserApiOrigin(mode, CONFIGURED_BROWSER_API_ORIGIN);
}

export function resolveConfiguredUpstreamApiOrigin(mode: BrowserApiMode): string {
  return resolveUpstreamApiOrigin(mode, CONFIGURED_UPSTREAM_API_ORIGIN);
}

// next.config validates the mode and injects the exact value into every client
// chunk. Tests provide their synthetic origin through Vitest's isolated env.
export const BROWSER_API_ORIGIN = CONFIGURED_BROWSER_API_ORIGIN!;
