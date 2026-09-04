import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { SITE_DOMAIN } from './src/site.domain';
import {
  type BrowserApiMode,
  buildBrowserContentSecurityPolicy,
  resolveConfiguredBrowserApiOrigin,
} from './src/lib/browser-api-origin';

// The public face of Swift — marketing + (coming) customer web + operator
// dashboards. Same hardening posture as the admin console.

// [SWX-DEV-WEB-076 · integrated] The browser API origin and the CSP that
// permits exactly it come from ONE authority (src/lib/browser-api-origin.ts).
// `next dev` runs in development mode; every other phase — build, start,
// export — is production and REQUIRES the canonical release origin.
export default function createNextConfig(phase: string): NextConfig {
  // `next lint` loads this config with the production-build phase but produces
  // no artifact; the release law binds artifacts, so linting runs as
  // development. `next build`, `next start` and `next export` do not.
  const linting = process.argv.includes('lint');
  const browserApiMode: BrowserApiMode = phase === PHASE_DEVELOPMENT_SERVER || linting ? 'development' : 'production';
  const browserApiOrigin = resolveConfiguredBrowserApiOrigin(browserApiMode);
  const csp = buildBrowserContentSecurityPolicy(browserApiMode);

  return {
    poweredByHeader: false,
    // The exact origin is inlined into every client chunk from the authority,
    // so no consumer can fall back to localhost in a release by accident.
    env: {
      NEXT_PUBLIC_API_URL: browserApiOrigin,
    },
    // App Router ignores dot-prefixed folders, so the OS association files are
    // route handlers under /well-known/* surfaced at their mandated paths here.

    // [SITE-1.1 Part 2 / AC-13] The route names the spec mandates, without
    // breaking a single link that already exists in the wild — every former
    // path 301s to its replacement. 301 rather than 302 so search engines and
    // any printed material transfer their authority to the new URL.
    async redirects() {
      return [
        { source: '/for-vendors', destination: '/vendors', permanent: true },
        { source: '/for-drivers', destination: '/drivers', permanent: true },
        { source: '/delete-account', destination: '/account/delete', permanent: true },
        // [AC-12] Canonical host is the apex. www 301s to it, so every share
        // link resolves on exactly one origin.
        //
        // ...except the two association files, which must NOT redirect.
        //
        // Apple's AASA fetcher and Android's App Links verifier both refuse to
        // follow redirects, and the app claims BOTH hosts —
        // `applinks:www.<domain>` in associatedDomains, and a www intent filter
        // for /s and /store. With the rule below unscoped, iOS and Android
        // fetched the association from www, got a 301, and silently failed to
        // verify it. The apex kept working, so nothing looked broken; a www
        // link just opened a browser tab on a phone that had Swift installed —
        // which is the exact failure universal links exist to prevent, hiding
        // inside the redirect that was added to tidy the origins.
        //
        // The original comment said the rule "never touches the apex", which
        // was true and was the wrong half to worry about.
        {
          source: '/:path((?!\\.well-known/).*)',
          has: [{ type: 'host', value: `www.${SITE_DOMAIN}` }],
          destination: `https://${SITE_DOMAIN}/:path*`,
          permanent: true,
        },
      ];
    },

    async rewrites() {
      const api = browserApiOrigin;
      return [
        { source: '/.well-known/apple-app-site-association', destination: '/well-known/apple-app-site-association' },
        { source: '/.well-known/assetlinks.json', destination: '/well-known/assetlinks.json' },
        // The printed QR URL is {APP_PUBLIC_URL}/s/{code}; the web domain
        // proxies it to the API's public resolver (302 passes through). Only
        // wired when the build knows its API — dev keeps the route local.
        { source: '/s/:code', destination: `${api}/s/:code` },
      ];
    },
    async headers() {
      return [
        {
          // [AC-11] Apple fetches this via its CDN and requires application/json
          // with no redirect. The route handler already returns JSON; this pins
          // the content type at the edge and keeps the file out of any cache
          // that might outlive a Team ID change.
          source: '/.well-known/apple-app-site-association',
          headers: [
            { key: 'Content-Type', value: 'application/json' },
            { key: 'Cache-Control', value: 'public, max-age=3600' },
          ],
        },
        {
          source: '/.well-known/assetlinks.json',
          headers: [
            { key: 'Content-Type', value: 'application/json' },
            { key: 'Cache-Control', value: 'public, max-age=3600' },
          ],
        },
        {
          source: '/(.*)',
          headers: [
            { key: 'X-Frame-Options', value: 'DENY' },
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
            { key: 'Content-Security-Policy', value: csp },
            // [SITE-1.1 Part 6.3] Two years, subdomains included, preload-eligible.
            // Matches the admin console's posture; the site is the company's
            // public identity and is only ever served over TLS.
            { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
            // [SITE-1.1 Part 6.3] An EMPTY allowlist — `camera=()` — disables the
            // feature for every origin INCLUDING self. This site genuinely uses two
            // of them: /selfie captures a KYC selfie via getUserMedia, and the taxi,
            // courier, order-location and signup flows read a pickup point through
            // lib/geolocate.ts. Locking those to `()` does not harden anything; it
            // silently breaks the product, and it breaks it in the browser rather
            // than at build time, so nothing here would catch it.
            // `(self)` is the correct posture: same-origin may ask, and the user is
            // still prompted. Third parties and embeds get nothing. Microphone stays
            // fully off — no surface on this site records audio.
            // permissions-policy.test.ts enforces this against the real source tree.
            {
              key: 'Permissions-Policy',
              value: 'geolocation=(self), microphone=(), camera=(self)',
            },
          ],
        },
      ];
    },
  };
}
