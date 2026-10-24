import { isIP } from 'node:net';
import { AppError } from './errors';

export const MMG_PAY_URL_ALLOWED_HOSTS_ENV = 'MMG_PAY_URL_ALLOWED_HOSTS';

export type MmgPayUrlRejection =
  | 'MISSING'
  | 'TOO_LONG'
  | 'MALFORMED'
  | 'HTTPS_REQUIRED'
  | 'CREDENTIALS_FORBIDDEN'
  | 'FRAGMENT_FORBIDDEN'
  | 'NON_DEFAULT_PORT'
  | 'LOCAL_OR_IP_HOST'
  | 'ALLOWLIST_NOT_CONFIGURED'
  | 'ALLOWLIST_INVALID'
  | 'HOST_NOT_ALLOWED';

export type MmgPayUrlValidation =
  | { valid: true; url: string; hostname: string }
  | { valid: false; reason: MmgPayUrlRejection };

const LOCAL_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home.arpa',
] as const;

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/**
 * MMG links are opened by a customer's browser, never fetched by Swift, but a
 * stored link is still a phishing/open-redirect boundary. Restrict it to a
 * public DNS hostname. IP literals and local/single-label names are rejected,
 * which also prevents private, loopback, link-local, and alternate-numeric IP
 * spellings from becoming a payment destination.
 */
function isPublicDnsHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  if (!host || isIP(host) !== 0 || !host.includes('.')) return false;
  if (host === 'localhost' || LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && !host.includes('..');
}

/** Parse an exact-host allowlist. Wildcards, schemes, ports, paths, and local
 * targets are deliberately unsupported: the real MMG hostname remains an
 * onboarding/configuration decision rather than an assumption in source. */
export function parseMmgPayUrlAllowedHosts(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') return [];
  const entries = raw.split(',').map((entry) => normalizedHostname(entry.trim())).filter(Boolean);
  if (
    entries.length === 0
    || entries.some((entry) => entry.includes('*') || entry.includes('/') || entry.includes(':') || !isPublicDnsHostname(entry))
  ) {
    return null;
  }
  return [...new Set(entries)];
}

/**
 * Validate and canonicalize one vendor/driver MMG direct-pay link.
 *
 * Fail-closed is intentional in every environment. Tests and local stacks use
 * an explicit allowlist too, so a permissive development path can never mask a
 * production launch failure. Query parameters are allowed because a provider
 * may encode an opaque merchant reference there; fragments and credentials are
 * not. No external MMG hostname is hard-coded as authoritative.
 */
export function validateMmgPayUrl(
  rawUrl: string | null | undefined,
  rawAllowedHosts: string | undefined = process.env[MMG_PAY_URL_ALLOWED_HOSTS_ENV],
): MmgPayUrlValidation {
  const candidate = rawUrl?.trim();
  if (!candidate) return { valid: false, reason: 'MISSING' };
  if (candidate.length > 500) return { valid: false, reason: 'TOO_LONG' };

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, reason: 'MALFORMED' };
  }

  if (parsed.protocol !== 'https:') return { valid: false, reason: 'HTTPS_REQUIRED' };
  if (parsed.username || parsed.password) return { valid: false, reason: 'CREDENTIALS_FORBIDDEN' };
  if (parsed.hash) return { valid: false, reason: 'FRAGMENT_FORBIDDEN' };
  if (parsed.port && parsed.port !== '443') return { valid: false, reason: 'NON_DEFAULT_PORT' };

  const hostname = normalizedHostname(parsed.hostname);
  if (!isPublicDnsHostname(hostname)) return { valid: false, reason: 'LOCAL_OR_IP_HOST' };

  const allowedHosts = parseMmgPayUrlAllowedHosts(rawAllowedHosts);
  if (allowedHosts === null) return { valid: false, reason: 'ALLOWLIST_INVALID' };
  if (allowedHosts.length === 0) return { valid: false, reason: 'ALLOWLIST_NOT_CONFIGURED' };
  if (!allowedHosts.includes(hostname)) return { valid: false, reason: 'HOST_NOT_ALLOWED' };

  // Canonicalize harmless spelling differences before persistence/response.
  parsed.hostname = hostname;
  parsed.port = '';
  return { valid: true, url: parsed.toString(), hostname };
}

/** A legacy database value is untrusted until this read/checkout boundary. */
export function safeMmgPayUrl(rawUrl: string | null | undefined): string | null {
  const result = validateMmgPayUrl(rawUrl);
  return result.valid ? result.url : null;
}

/** Write-boundary adapter shared by vendor and driver profiles. Empty means
 * explicit opt-out; a bad deployment allowlist is an availability/config error,
 * while a bad submitted destination is a validation error. */
export function mmgPayUrlForWrite(rawUrl: string | null | undefined): string | null {
  if (!rawUrl?.trim()) return null;
  const result = validateMmgPayUrl(rawUrl);
  if (result.valid) return result.url;
  const configurationError = result.reason === 'ALLOWLIST_NOT_CONFIGURED' || result.reason === 'ALLOWLIST_INVALID';
  throw new AppError(
    configurationError ? 503 : 400,
    configurationError ? 'MMG_PAY_LINKS_NOT_CONFIGURED' : 'INVALID_MMG_PAY_URL',
    mmgPayUrlErrorMessage(result.reason),
  );
}

export function mmgPayUrlErrorMessage(reason: MmgPayUrlRejection): string {
  if (reason === 'ALLOWLIST_NOT_CONFIGURED' || reason === 'ALLOWLIST_INVALID') {
    return 'MMG pay links are not configured for this environment yet.';
  }
  return 'Use an approved public HTTPS MMG pay link without credentials, a fragment, or a local/private address.';
}

// ---------------------------------------------------------------------------
// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The taxi driver's MMG pay link is OFF.
// Passengers pay the driver directly at drop-off, in cash or by MMG, the way
// cash already works: the app shows the fare and Swift never touches the money.
// DRIVER_MMG_PAY_LINK turns the old link back on only when it is exactly '1';
// unset (every environment today) means OFF. While OFF, no passenger surface
// carries a driver's link, the driver's profile hides it, and a new link is
// refused. A stored link is never deleted by the switch: it stays dormant.
// ---------------------------------------------------------------------------
export const DRIVER_MMG_PAY_LINK_ENV = 'DRIVER_MMG_PAY_LINK';

export function driverMmgPayLinkEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[DRIVER_MMG_PAY_LINK_ENV] === '1';
}

/** The ONE read every surface uses for a driver's link: null while the switch is off. */
export function offeredDriverMmgPayUrl(rawUrl: string | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  return driverMmgPayLinkEnabled(env) ? safeMmgPayUrl(rawUrl) : null;
}

export const DRIVER_MMG_PAY_LINK_OFF_CODE = 'MMG_PAY_LINK_OFF';
export const DRIVER_MMG_PAY_LINK_OFF_MESSAGE =
  'Passengers pay you directly at drop-off, in cash or by MMG. Swift does not use an MMG pay link, so there is nothing to set up here.';

/** A NEW driver link while the switch is off is refused; clearing one (empty) is always allowed. */
export function assertDriverMmgPayLinkWritable(rawUrl: string | null | undefined, env: Record<string, string | undefined> = process.env): void {
  if (driverMmgPayLinkEnabled(env)) return;
  if (!rawUrl?.trim()) return;
  throw new AppError(409, DRIVER_MMG_PAY_LINK_OFF_CODE, DRIVER_MMG_PAY_LINK_OFF_MESSAGE);
}
