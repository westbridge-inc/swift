import type { FastifyRequest } from 'fastify';
import { browserClientOf } from '../auth/browser-session';

/**
 * [F-021-21] The surface a consent was given on, from the client's own
 * attestation, constrained to the known set — never a hardcoded guess. The
 * privacy policy promises to record on what surface each consent happened.
 *
 *  - An `x-client-platform` naming a known platform (ios, android, web) wins.
 *  - Otherwise a request from the web app's browser session is the web: the
 *    web names itself with `X-Swift-Client: web` on every call (its session
 *    cookie is honoured only with that header).
 *  - Otherwise 'mobile': a native app that did not name its platform.
 */
export function consentSurfaceOf(request: Pick<FastifyRequest, 'headers'>): 'ios' | 'android' | 'mobile' | 'web' {
  const platform = String(request.headers['x-client-platform'] ?? '').toLowerCase();
  if (platform === 'ios' || platform === 'android' || platform === 'web') return platform;
  return browserClientOf(request) === 'web' ? 'web' : 'mobile';
}
