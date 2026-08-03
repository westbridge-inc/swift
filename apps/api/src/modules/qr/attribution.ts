import { createHash } from 'crypto';
import { normalizeShortCode, sanitizeTemplate } from './qr-codes';

// ---------------------------------------------------------------------------
// Install attribution — pure pieces. Android is deterministic (the Play URL
// carries the code through the Install Referrer); iOS is a coarse, ephemeral
// server-side fingerprint whose ONLY power is matching a single candidate.
// The client never supplies fingerprint components on either path.
// ---------------------------------------------------------------------------

export const ATTRIB_TTL_MINUTES = Math.max(1, Number(process.env['ATTRIB_TTL_MINUTES'] ?? 30));
export const ATTRIB_MAX_OPEN_PER_FP = Math.max(1, Number(process.env['ATTRIB_MAX_OPEN_PER_FP'] ?? 3));

/** Mirrors the identitySalt()/scanIpSalt() contract. */
export function attribSalt(): string {
  const salt = process.env['ATTRIB_SALT'];
  if (!salt) {
    if (process.env['NODE_ENV'] === 'production') throw new Error('ATTRIB_SALT is required in production');
    return 'dev-attrib-salt';
  }
  return salt;
}

/** IPv4 → full address; IPv6 → /64 prefix (carrier-grade NAT reality: good
 *  enough to bucket a household/cell for minutes, useless as an identifier). */
export function normalizeIpForFp(ip: string): string {
  if (ip.includes(':')) {
    const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (!clean.includes(':')) return clean; // v4-mapped
    return clean.split(':').slice(0, 4).join(':');
  }
  return ip;
}

/** "iOS-18"-style coarse family from the UA; non-iOS collapses to a family
 *  bucket (those requests never create candidate rows anyway). */
export function uaMajorFamily(ua: string | undefined): string {
  const s = ua ?? '';
  const ios = /(?:iPhone|CPU) OS (\d+)/i.exec(s) ?? /iPhone.*Version\/(\d+)/i.exec(s);
  if (/iphone|ipad|ipod/i.test(s)) return `iOS-${ios?.[1] ?? '0'}`;
  if (/android/i.test(s)) return 'android';
  return 'other';
}

export function computeFpHash(ip: string, ua: string | undefined): string {
  return createHash('sha256')
    .update(`${normalizeIpForFp(ip)}|${uaMajorFamily(ua)}|${attribSalt()}`)
    .digest('hex');
}

/** Android Install Referrer payload: the Play API hands back the decoded
 *  string "swift_qr={code}&t={tpl}". Anything that doesn't parse to a valid
 *  code is null — sideloads/organic installs simply go Home. */
export function parseInstallReferrer(referrer: string): { code: string; template: string | null } | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(referrer);
  } catch {
    return null;
  }
  const code = normalizeShortCode(params.get('swift_qr') ?? '');
  if (!code) return null;
  return { code, template: sanitizeTemplate(params.get('t')) };
}

/** The exact Play URL for install CTAs: the whole referrer value URL-encoded
 *  once (Play decodes it before the app reads it). Null until the founder
 *  supplies store identifiers (LAUNCH_BLOCKERS). */
export function playStoreUrlFor(code: string, template: string | null): string | null {
  const base = process.env['PLAY_STORE_URL'];
  const pkg = process.env['ANDROID_PACKAGE_ID'];
  if (!base || !pkg) return null;
  const referrer = encodeURIComponent(`swift_qr=${code}${template ? `&t=${template}` : ''}`);
  return `${base}?id=${pkg}&referrer=${referrer}`;
}

export function appStoreUrl(): string | null {
  return process.env['APP_STORE_URL'] ?? null;
}
