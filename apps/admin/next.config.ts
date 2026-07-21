import type { NextConfig } from 'next';

const API = process.env['NEXT_PUBLIC_API_URL'] || 'http://localhost:3000';

// Admin XSS hardening (SEC-11 mitigation — tokens stay in the browser, so we
// shrink the XSS blast radius). Next.js needs 'unsafe-inline'/'unsafe-eval' for
// hydration/HMR without nonce infrastructure; the load-bearing protections here
// are frame-ancestors (no clickjacking), a restricted connect-src (limits where
// an injected script could exfiltrate a token), object-src 'none', base-uri 'self'.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // UG-SEC-04: the admin app makes NO websocket connections (only the mobile
  // client does) — bare `ws: wss:` was any-host, an injected-script token
  // exfil path. connect-src is now exactly the admin API origins.
  `connect-src 'self' ${API} https://api.swift.gy`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
  transpilePackages: ['@swift/types'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
