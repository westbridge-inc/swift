import type { FastifyReply, FastifyRequest } from 'fastify';
import { resolveCorsOrigins } from '../../utils/cors-origin';
import { browserSessionCounter } from '../../plugins/observability';
import { isProduction } from '../../utils/runtime-mode';

// ---------------------------------------------------------------------------
// [A-01 / W-01] THE BROWSER SESSION — credentials a script can never read.
//
// The admin console and the web app kept both the access token and the
// seven-day refresh token in `localStorage`: any same-origin script — an XSS,
// a compromised dependency, an extension with page access — could read and
// replay a privileged session for a week.
//
// A browser client now opts into COOKIE MODE by naming itself with the
// `X-Swift-Client` header. In cookie mode the API never returns a credential
// in a response body: the access token and the refresh token travel as
// HttpOnly, Secure, SameSite=Strict cookies, the refresh cookie scoped to the
// auth path alone. A cookie is honoured only on a request that ALSO carries
// the client header (a custom header forces the CORS preflight the allowlist
// gates — no plain form or image tag can send it) and whose Origin is on the
// CORS allowlist: the three together are the cross-site request forgery
// defence. Everything else about the session — rotation, reuse detection,
// revocation on logout — is the same server-side session as before.
// ---------------------------------------------------------------------------

export const BROWSER_CLIENT_HEADER = 'x-swift-client';
export const BROWSER_CLIENTS = new Set(['admin-web', 'web']);

export const ACCESS_COOKIE = 'swift_at';
export const REFRESH_COOKIE = 'swift_rt';
/** The refresh cookie is sent only to the auth routes — never to an ordinary API call. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
export const ACCESS_COOKIE_PATH = '/api/v1';
/** Matches the refresh session's life (30 days); the access cookie carries the 15-minute JWT and expires with it. */
export const REFRESH_COOKIE_MAX_AGE_S = 30 * 24 * 3600;
export const ACCESS_COOKIE_MAX_AGE_S = 15 * 60;

export function browserClientOf(request: Pick<FastifyRequest, 'headers'>): string | null {
  const raw = request.headers[BROWSER_CLIENT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && BROWSER_CLIENTS.has(value) ? value : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name && !(name in out)) {
      try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
    }
  }
  return out;
}

let allowlist: Set<string> | null = null;
/** The CORS allowlist, resolved once from the same source the CORS plugin uses. */
export function allowedBrowserOrigins(env: Record<string, string | undefined> = process.env): Set<string> {
  if (!allowlist) {
    const resolved = resolveCorsOrigins(env['CORS_ORIGIN'], env['NODE_ENV']);
    allowlist = new Set(resolved === false ? [] : resolved.map((o) => o.toLowerCase()));
  }
  return allowlist;
}
export function resetBrowserOriginsForTests(): void { allowlist = null; }

function originOf(request: Pick<FastifyRequest, 'headers'>): string | null {
  const origin = request.headers['origin'];
  if (typeof origin === 'string' && origin) return origin.toLowerCase();
  const referer = request.headers['referer'];
  if (typeof referer === 'string' && referer) { try { return new URL(referer).origin.toLowerCase(); } catch { return null; } }
  return null;
}

/**
 * The credential for this request: a Bearer header when present (the native
 * apps), otherwise the access cookie — but only for a request that names a
 * browser client AND comes from an allowed origin. A cookie on a request
 * without both is not a credential.
 */
export function bearerOrCookieToken(request: Pick<FastifyRequest, 'headers'>): string {
  const bearer = request.headers.authorization;
  if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) return bearer.slice('Bearer '.length);
  const cookies = parseCookies(request.headers['cookie']);
  const cookie = cookies[ACCESS_COOKIE];
  if (!cookie) return '';
  if (!browserClientOf(request)) { browserSessionCounter.labels('cookie_rejected_header').inc(); return ''; }
  const origin = originOf(request);
  if (!origin || !allowedBrowserOrigins().has(origin)) { browserSessionCounter.labels('cookie_rejected_origin').inc(); return ''; }
  browserSessionCounter.labels('cookie_auth').inc();
  return cookie;
}

/** The JWT plugin verifies the Authorization header: when a request carries no Bearer but a
 *  cookie credential that passes the gate, the cookie becomes that header for this request. */
export function adoptCookieCredential(request: FastifyRequest): void {
  if (typeof request.headers.authorization === 'string' && request.headers.authorization.startsWith('Bearer ')) return;
  const token = bearerOrCookieToken(request);
  if (token) request.headers.authorization = `Bearer ${token}`;
}

/** The refresh credential for the auth routes: the body's token (native apps) or the refresh cookie (browsers, same gate). */
export function refreshCredentialOf(request: Pick<FastifyRequest, 'headers' | 'body'>): string | null {
  const body = (request.body ?? {}) as { refreshToken?: unknown };
  if (typeof body.refreshToken === 'string' && body.refreshToken) return body.refreshToken;
  const cookie = parseCookies(request.headers['cookie'])[REFRESH_COOKIE];
  if (!cookie) return null;
  if (!browserClientOf(request)) { browserSessionCounter.labels('cookie_rejected_header').inc(); return null; }
  const origin = originOf(request);
  if (!origin || !allowedBrowserOrigins().has(origin)) { browserSessionCounter.labels('cookie_rejected_origin').inc(); return null; }
  return cookie;
}

// The runtime posture comes from THE parser, never a bare NODE_ENV comparison —
// `runtime-mode.ts` exists because "is this production?" was answered a dozen
// different ways, and a census enforces it. A cookie's `Secure` flag is exactly
// the kind of answer that must not be a second opinion.
const secure = (env: Record<string, string | undefined> = process.env): boolean => isProduction(env);

function cookie(name: string, value: string, path: string, maxAgeS: number, env?: Record<string, string | undefined>): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAgeS}`, 'HttpOnly', 'SameSite=Strict'];
  if (secure(env)) parts.push('Secure');
  return parts.join('; ');
}

/** Issue the session as cookies. Called only in cookie mode; the body carries no credential. */
export function setSessionCookies(reply: FastifyReply, tokens: { accessToken: string; refreshToken: string }, env?: Record<string, string | undefined>): void {
  reply.header('Set-Cookie', [
    cookie(ACCESS_COOKIE, tokens.accessToken, ACCESS_COOKIE_PATH, ACCESS_COOKIE_MAX_AGE_S, env),
    cookie(REFRESH_COOKIE, tokens.refreshToken, REFRESH_COOKIE_PATH, REFRESH_COOKIE_MAX_AGE_S, env),
  ]);
  browserSessionCounter.labels('cookie_issued').inc();
}

export function clearSessionCookies(reply: FastifyReply, env?: Record<string, string | undefined>): void {
  reply.header('Set-Cookie', [
    cookie(ACCESS_COOKIE, '', ACCESS_COOKIE_PATH, 0, env),
    cookie(REFRESH_COOKIE, '', REFRESH_COOKIE_PATH, 0, env),
  ]);
  browserSessionCounter.labels('cookie_cleared').inc();
}

/** In cookie mode the tokens leave the response body; only the rest of the payload is returned. */
export function withoutTokens<T extends { tokens?: unknown }>(result: T): Omit<T, 'tokens'> & { session: 'cookie' } {
  const { tokens: _tokens, ...rest } = result;
  void _tokens;
  return { ...rest, session: 'cookie' };
}
