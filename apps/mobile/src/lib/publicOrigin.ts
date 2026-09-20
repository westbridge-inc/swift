/**
 * The one public origin Swift is allowed to put on paper, in an SMS, or into a
 * production native-link policy.  It is deliberately not inferred from the API
 * origin: api.swift.gy is a separate service boundary, while public links land
 * at the web application.
 *
 * Keep this module free of React Native imports.  app.config.ts runs it during
 * native generation and the runtime uses it for the same exact contract.
 */
export const CANONICAL_PUBLIC_SITE_ORIGIN = 'https://swiftgy.com' as const;
export const CANONICAL_PUBLIC_SITE_HOST = 'swiftgy.com' as const;

export type LinkBuildChannel = 'production' | 'preview' | null;

/**
 * Native entitlements must never be steered to an arbitrary domain by the
 * build environment.  Release channels have to name the canonical domain
 * explicitly; local development receives the same fixed entitlement without
 * pretending it is a release artifact.
 */
export function resolveNativeLinkDomain(
  configuredDomain: string | undefined,
  channel: LinkBuildChannel,
): typeof CANONICAL_PUBLIC_SITE_HOST {
  if (configuredDomain !== undefined && configuredDomain !== CANONICAL_PUBLIC_SITE_HOST) {
    throw new Error(`[swift] SWIFT_LINK_DOMAIN must be exactly ${CANONICAL_PUBLIC_SITE_HOST}`);
  }
  if ((channel === 'production' || channel === 'preview') && configuredDomain !== CANONICAL_PUBLIC_SITE_HOST) {
    throw new Error(`[swift] ${channel} native links require SWIFT_LINK_DOMAIN=${CANONICAL_PUBLIC_SITE_HOST}`);
  }
  return CANONICAL_PUBLIC_SITE_HOST;
}

/** Convert only the two declared release channels; unknown release input opens
 * no web link.  Preview hosts remain a separately supplied, exact allowlist. */
export function resolveLinkBuildChannel(value: string | undefined): LinkBuildChannel {
  return value === 'production' || value === 'preview' ? value : null;
}
