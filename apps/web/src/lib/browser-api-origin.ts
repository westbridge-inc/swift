import { SITE_DOMAIN } from '../site.domain';

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
 * - a production build REQUIRES `NEXT_PUBLIC_API_URL`, requires it to be an
 *   exact absolute https origin (no path, query, credentials or fragment), and
 *   requires it to be the canonical release origin — `https://api.<site
 *   domain>`, derived from the one file that owns the company's domain rather
 *   than a second hardcoded hostname; [Q11] a build that also declares the
 *   staging channel requires the staging origin, `https://api-staging.<site
 *   domain>`, instead, and nothing else;
 * - the CSP's connect-src names that one origin, never a scheme wildcard.
 *
 * The Codex candidate this integrates pinned the release origin to a literal
 * hostname under a different domain than the site's own domain file names,
 * so the literal is replaced by the derivation. Its sandbox evidence-build machinery
 * is not carried: CI type-checks and builds the real tree on every PR.
 */
export const DEVELOPMENT_BROWSER_API_ORIGIN = 'http://localhost:3000';
export const RELEASE_BROWSER_API_ORIGIN = `https://api.${SITE_DOMAIN}` as const;
/**
 * [Q11] The staging API, which the self-hosted staging site calls
 * (apps/web/Dockerfile, served by deploy/docker-compose.yml). Derived from the
 * same domain file, and the host the mobile staging builds use (eas.json).
 */
export const STAGING_BROWSER_API_ORIGIN = `https://api-staging.${SITE_DOMAIN}` as const;

export type BrowserApiMode = 'development' | 'production';

/**
 * [Q11] Which API a production build is FOR. SWIFT_WEB_CHANNEL unset (or
 * empty) is the public site, so Vercel and CI, which never set it, build
 * exactly what they did; `staging` is the one other value. A staging build
 * takes BOTH keys, the channel and the staging origin: a mis-set origin alone
 * is refused as it always was, so the public site can never be pointed at the
 * staging API by one wrong variable, nor the staging site at production.
 */
export type ReleaseChannel = 'production' | 'staging';

const RELEASE_CHANNEL_ORIGIN: Record<ReleaseChannel, string> = {
  production: RELEASE_BROWSER_API_ORIGIN,
  staging: STAGING_BROWSER_API_ORIGIN,
};

export function resolveReleaseChannel(value: string | undefined): ReleaseChannel {
  if (value === undefined || value === '' || value === 'production') return 'production';
  if (value === 'staging') return 'staging';
  throw new Error(`SWIFT_WEB_CHANNEL must be production or staging (got ${JSON.stringify(value)})`);
}

/** Read at build time by next.config only; nothing in the browser consults it. */
export function resolveConfiguredReleaseChannel(): ReleaseChannel {
  return resolveReleaseChannel(process.env['SWIFT_WEB_CHANNEL']);
}

// Next's compiler requires this exact dot-form lookup for static replacement.
// The ambient member makes that syntax type-safe under noPropertyAccessFromIndexSignature.
/* eslint-disable no-unused-vars */
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NEXT_PUBLIC_API_URL?: string;
    }
  }
}
/* eslint-enable no-unused-vars */

const CONFIGURED_BROWSER_API_ORIGIN = process.env.NEXT_PUBLIC_API_URL;

function assertOriginOnly(value: string): void {
  if (value !== value.trim() || value.length === 0) {
    throw new Error('NEXT_PUBLIC_API_URL must be an exact absolute origin');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('NEXT_PUBLIC_API_URL must be an exact absolute origin');
  }
  if (
    parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin !== value
  ) {
    throw new Error('NEXT_PUBLIC_API_URL must not contain credentials, a path, query, fragment, or normalized port');
  }
}

export function resolveBrowserApiOrigin(
  mode: BrowserApiMode,
  configuredOrigin: string | undefined,
  channel: ReleaseChannel = 'production',
): string {
  if (mode === 'development' && configuredOrigin === undefined) {
    return DEVELOPMENT_BROWSER_API_ORIGIN;
  }
  const expected = mode === 'production'
    ? RELEASE_CHANNEL_ORIGIN[channel]
    : DEVELOPMENT_BROWSER_API_ORIGIN;
  if (configuredOrigin === undefined) {
    throw new Error(`NEXT_PUBLIC_API_URL is required for a production web build (expected ${expected})`);
  }
  assertOriginOnly(configuredOrigin);
  if (configuredOrigin !== expected) {
    throw new Error(`NEXT_PUBLIC_API_URL must be exactly ${expected} in ${mode === 'production' ? channel : mode}`);
  }
  return expected;
}

export function buildBrowserContentSecurityPolicy(
  mode: BrowserApiMode,
  channel: ReleaseChannel = 'production',
): string {
  const releaseOrigin = RELEASE_CHANNEL_ORIGIN[channel];
  const connectSources = mode === 'production'
    ? ["'self'", releaseOrigin, releaseOrigin.replace('https://', 'wss://')]
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

export function resolveConfiguredBrowserApiOrigin(
  mode: BrowserApiMode,
  channel: ReleaseChannel = 'production',
): string {
  return resolveBrowserApiOrigin(mode, CONFIGURED_BROWSER_API_ORIGIN, channel);
}

// next.config validates the mode and injects the exact value into every client
// chunk. Tests provide their synthetic origin through Vitest's isolated env.
export const BROWSER_API_ORIGIN = CONFIGURED_BROWSER_API_ORIGIN!;
