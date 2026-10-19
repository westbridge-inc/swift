import type { FastifyRequest } from 'fastify';
import { AppError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// [Row 225 · AUTH-PIN] A WRITE IS BOUND TO THE ACCOUNT ITS PAGE WAS SHOWING.
//
// A browser's session is a cookie, and a cookie jar is shared by every tab. A
// tab left open on account A, after someone signs in as account B in another
// tab of the same browser, still shows A — but its next request carries B's
// cookie. The web client refuses that locally when it can tell (apps/web
// lib/auth.ts, SESSION_CHANGED), yet only the server can be sure who a cookie
// names. So the web app sends the account it expects to be acting as, and the
// API refuses any state-changing request whose session names someone else:
// 409 SESSION_CHANGED, before the route runs — nothing is written to B's
// account on A's behalf.
//
// The header is OPTIONAL. A request without it is exactly what it was before:
// the phone apps (builds 9-11 and every native client) never send it, and they
// carry their own bearer token, which no other tab can swap. Reads are not
// refused (they write nothing, and the web client already refuses to render an
// answer that arrives under a changed account).
// ---------------------------------------------------------------------------

/** The account id the web client expects the session to name. */
export const EXPECTED_PRINCIPAL_HEADER = 'x-swift-expected-principal';

const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class SessionChangedError extends AppError {
  constructor() {
    super(409, 'SESSION_CHANGED', 'The signed-in account changed in another tab. Nothing was saved — reload to continue as the account now signed in.');
  }
}

/**
 * The expected principal a request declares: undefined when it declares none
 * (no header, or an empty one). A repeated header is not one expectation — it
 * is returned as `null`, which matches no account.
 */
export function expectedPrincipalOf(request: Pick<FastifyRequest, 'headers'>): string | null | undefined {
  const raw = request.headers[EXPECTED_PRINCIPAL_HEADER];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw.length === 0 ? undefined : null;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/**
 * Refuse a state-changing request whose session is not the account it
 * declared. `principal` is the account the session resolved to (null for a
 * guest). Called by `authenticate` and `authenticateOptional` once they have
 * decided, so every route that reads a session is covered by the one check.
 */
export function refuseUnexpectedPrincipal(request: Pick<FastifyRequest, 'headers' | 'method'>, principal: string | null): void {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) return;
  const expected = expectedPrincipalOf(request);
  if (expected === undefined) return;
  if (expected === null || expected !== principal) throw new SessionChangedError();
}
