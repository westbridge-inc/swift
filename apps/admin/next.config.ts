import type { NextConfig } from 'next';

const API = process.env['NEXT_PUBLIC_API_URL'] || 'http://localhost:3000';

// The admin console is a high-value target — refuse to build it pointed at a
// plaintext backend on a real host (an http:// API is a token-stealable MITM).
// Only the dangerous case throws; unset / http-localhost stay allowed so it
// never breaks a CI/dev build.
{
  const url = process.env['NEXT_PUBLIC_API_URL'];
  const isLocal = !!url && (url.includes('localhost') || url.includes('127.0.0.1'));
  if (url && url.startsWith('http://') && !isLocal) {
    throw new Error('NEXT_PUBLIC_API_URL must use https:// — a plaintext admin API exposes admin tokens to MITM');
  }
}

// [ADMIN-CONSOLE] apps/admin/Dockerfile sets SWIFT_ADMIN_IMAGE_BUILD=1, and
// nothing else does: CI, development and Vercel get exactly the config they
// had. The image runs Next's standalone server, and the type check and lint
// stay where they already run on the full workspace (CI's Lint & Type Check
// and Admin Build jobs, which every main commit passed; deploy/pilot-up.sh
// builds only main commits). An image serves real browsers on a real host, so
// it must be built for the https ORIGIN of the API it calls: unset, http (even
// localhost, which would be the viewer's own machine) or a path is refused
// rather than shipped as a console that cannot sign anyone in.
const imageBuild = process.env['SWIFT_ADMIN_IMAGE_BUILD'] === '1';
if (imageBuild && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(process.env['NEXT_PUBLIC_API_URL'] ?? '')) {
  throw new Error('NEXT_PUBLIC_API_URL must be the https origin of the API (https://host, no path) to build the admin image');
}
const imageBuildConfig: Pick<NextConfig, 'output' | 'typescript' | 'eslint'> = imageBuild
  ? { output: 'standalone', typescript: { ignoreBuildErrors: true }, eslint: { ignoreDuringBuilds: true } }
  : {};

// Admin XSS hardening (SEC-11 mitigation — tokens stay in the browser, so we
// shrink the XSS blast radius). Next.js needs 'unsafe-inline'/'unsafe-eval' for
// hydration/HMR without nonce infrastructure; the load-bearing protections here
// are frame-ancestors (no clickjacking), a restricted connect-src (limits where
// an injected script could exfiltrate a token), object-src 'none', base-uri 'self'.
// [A-01] No credential lives in the browser any more (the session is an
// HttpOnly cookie pair), so an injected script has nothing to read; the CSP
// still shrinks what it could DO: 'unsafe-eval' is granted only to development
// (Next's HMR needs it) and never to a production build. A nonce/hash script
// policy and Trusted Types are the next step, stated as such in the register.
const isProductionBuild = process.env['NODE_ENV'] === 'production';
const csp = [
  "default-src 'self'",
  isProductionBuild ? "script-src 'self' 'unsafe-inline'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // UG-SEC-04: the admin app makes NO websocket connections (only the mobile
  // client does) — bare `ws: wss:` was any-host, an injected-script token
  // exfil path. connect-src is now exactly the admin API origins.
  `connect-src 'self' ${API} https://api.swiftgy.com`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

// [DS110-15] The verification render proxy streams the document's OWN mime
// type, which includes application/pdf (insurance certificates). The page's
// fetch() succeeds for a PDF — a 200 stream — but the tab Chrome opens then
// shows a CSP-blocked blank viewer under `object-src 'none'`, which is exactly
// the "Approve unlocked without seeing the evidence" failure #15 closes. The
// render path gets its own policy: everything the admin CSP already grants,
// with object-src relaxed to same-origin so the built-in viewer can render.
// The response body is still the upstream HMAC-gated stream — this grants no
// extra read authority, only the ability to display it.
const renderCsp = csp.replace("object-src 'none'", "object-src 'self'");

// [ADMIN-CONSOLE] The console is internet-facing (deploy/Caddyfile, ADMIN_HOST)
// and the proxy adds no header of its own, so these are the whole defence at
// this layer, on every path. Nothing on this origin is meant for a search
// engine (X-Robots-Tag), and no page or document URL leaves it in a Referer
// (no-referrer; the API's cookie gate reads the Origin header, which a CORS
// request carries whatever the referrer policy).
const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  ...imageBuildConfig,
  transpilePackages: ['@swift/types'],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Matching entries are applied in array order and a later entry with the
      // same key wins, so this specific path overrides the catch-all above.
      {
        source: '/api/v1/verification/render/:path*',
        headers: [{ key: 'Content-Security-Policy', value: renderCsp }],
      },
    ];
  },
};

export default nextConfig;
