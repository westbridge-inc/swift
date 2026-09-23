/**
 * Public browser links are not API links.  This value intentionally lives next
 * to the server output that emits QR and trip-share URLs; `api.swift.gy` stays
 * the API boundary and is never substituted here.
 */
export const CANONICAL_PUBLIC_WEB_ORIGIN = 'https://swiftgy.com' as const;

/**
 * APP_PUBLIC_URL existed as a free-form redirect base.  A hostile or stale
 * process value could therefore mint a QR/SMS that sent people elsewhere.  A
 * release may repeat the canonical value explicitly, but cannot select a
 * different target.  Missing input resolves only to the declared canonical
 * public origin — never to the retired swift.gy host.
 */
export function publicWebOrigin(env: Record<string, string | undefined> = process.env): typeof CANONICAL_PUBLIC_WEB_ORIGIN {
  const configured = env['APP_PUBLIC_URL'];
  if (configured === undefined || configured === CANONICAL_PUBLIC_WEB_ORIGIN) {
    return CANONICAL_PUBLIC_WEB_ORIGIN;
  }
  throw new Error(`[swift] APP_PUBLIC_URL must be exactly ${CANONICAL_PUBLIC_WEB_ORIGIN}`);
}
