import type { NextConfig } from 'next';
import { SITE_DOMAIN } from './src/site.domain';

// The public face of Swift — marketing + (coming) customer web + operator
// dashboards. Same hardening posture as the admin console.

// Refuse to build an app pointed at a plaintext backend: an http:// API on a
// real host is a token-stealable MITM. We only reject that dangerous case —
// unset (dev/CI falls back to localhost) and http://localhost stay allowed, so
// this never breaks a `next build` that hasn't been handed the prod URL.
{
  const apiUrl = process.env['NEXT_PUBLIC_API_URL'];
  const isLocal = !!apiUrl && (apiUrl.includes('localhost') || apiUrl.includes('127.0.0.1'));
  if (apiUrl && apiUrl.startsWith('http://') && !isLocal) {
    throw new Error('NEXT_PUBLIC_API_URL must use https:// — a plaintext API on a real host exposes tokens to MITM');
  }
}

// Pragmatic CSP: blocks external script injection, framing, object embeds and
// off-origin form posts, while still allowing Next's inline runtime and the
// https API/WebSocket calls. (A nonce-based strict-dynamic policy is the next
// step up but needs the app wired for nonces.)
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  poweredByHeader: false,
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
      // [AC-12] Canonical host is the apex. www 301s to it, so the AASA file
      // and every share link resolve on exactly one origin. Apple requires the
      // association file to be served with NO redirect, which is why this rule
      // is scoped to the www host and never touches the apex.
      {
        source: '/:path*',
        has: [{ type: 'host', value: `www.${SITE_DOMAIN}` }],
        destination: `https://${SITE_DOMAIN}/:path*`,
        permanent: true,
      },
    ];
  },

  async rewrites() {
    const api = process.env['NEXT_PUBLIC_API_URL'];
    return [
      { source: '/.well-known/apple-app-site-association', destination: '/well-known/apple-app-site-association' },
      { source: '/.well-known/assetlinks.json', destination: '/well-known/assetlinks.json' },
      // The printed QR URL is {APP_PUBLIC_URL}/s/{code}; the web domain
      // proxies it to the API's public resolver (302 passes through). Only
      // wired when the build knows its API — dev keeps the route local.
      ...(api ? [{ source: '/s/:code', destination: `${api}/s/:code` }] : []),
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

export default nextConfig;
