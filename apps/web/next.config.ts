import type { NextConfig } from 'next';

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
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
