import { randomInt } from 'crypto';

// ---------------------------------------------------------------------------
// QR growth engine — pure core. Short codes, slugs, and the scan decision
// table live here with zero I/O so every row is unit-testable in isolation.
// The printed artifact encodes {APP_PUBLIC_URL}/s/{shortCode}; the resolver
// classifies each scan with classifyScan and 302s via redirectTargetFor.
// ---------------------------------------------------------------------------

/** 28 chars: no vowels (no accidental words) and no 0/1/I/L/O/U lookalikes
 *  (no transcription ambiguity when a customer reads the code off paper). */
export const QR_CHARSET = '23456789BCDFGHJKMNPQRSTVWXYZ';

export const QR_CODE_LENGTH = 10;

const SHORT_CODE_RE = new RegExp(`^[${QR_CHARSET}]{${QR_CODE_LENGTH}}$`);

/** CSPRNG short code. randomInt is crypto-backed and internally rejection-
 *  sampled, so picking an index per char carries no modulo bias. */
export function generateShortCode(len = QR_CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < len; i += 1) out += QR_CHARSET[randomInt(QR_CHARSET.length)];
  return out;
}

/** Case-insensitive on input, canonical uppercase in storage. Anything that
 *  isn't exactly a valid code returns null — malformed and unknown then share
 *  one downstream path, so responses can't become an enumeration oracle. */
export function normalizeShortCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  return SHORT_CODE_RE.test(code) ? code : null;
}

/** NFKD → strip diacritics → lowercase → non-alphanumeric runs become "-" →
 *  collapse/trim → max 60 chars. Tenant-unique collision suffixing (-2, -3…)
 *  happens at the DB call site; slugs are immutable once created — a rename
 *  mints a NEW slug and writes a SlugRedirect row so printed links never die. */
export function makeSlug(displayName: string): string {
  return displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** Print-asset template ids ride the encoded URL as ?t=. The value is client
 *  input, so it re-enters the redirect ONLY through this allowlist shape. */
export function sanitizeTemplate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const t = input.trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,23}$/.test(t) ? t : null;
}

/** Same shape rule for the src funnel tag (qr | share | sms | …). */
export function sanitizeSrc(input: unknown): string | null {
  return sanitizeTemplate(input);
}

export type ScanVerdict = 'WEB_RENDER' | 'RETIRED_PAGE' | 'UNAVAILABLE_PAGE' | 'NOT_FOUND';

/** The slice of a QrCode row (plus its entity's public liveness) the decision
 *  table needs. entity is null when the storefront row no longer exists. */
export interface QrLookup {
  shortCode: string;
  status: 'ACTIVE' | 'SUPERSEDED' | 'DEACTIVATED';
  supersededAt: Date | null;
  entity: { live: boolean; slug: string } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The 5-row decision table (spec Part 4.1), evaluated in order:
 *   malformed / unknown code            → NOT_FOUND      (one shared path)
 *   DEACTIVATED, or SUPERSEDED past its → RETIRED_PAGE
 *     grace window
 *   entity missing / not publicly live  → UNAVAILABLE_PAGE (reason never leaks)
 *   valid + live                        → WEB_RENDER (to the CURRENT slug)
 * A SUPERSEDED code inside grace falls through — printed materials die slowly.
 */
export function classifyScan(qr: QrLookup | null, now: Date, graceDays: number): ScanVerdict {
  if (!qr) return 'NOT_FOUND';
  if (qr.status === 'DEACTIVATED') return 'RETIRED_PAGE';
  if (qr.status === 'SUPERSEDED') {
    const graceEndsAt = (qr.supersededAt?.getTime() ?? 0) + graceDays * DAY_MS;
    if (now.getTime() > graceEndsAt) return 'RETIRED_PAGE';
  }
  if (!qr.entity?.live) return 'UNAVAILABLE_PAGE';
  return 'WEB_RENDER';
}

/**
 * 302 targets are constructed HERE from server state only — base comes from
 * config, slug/code from the DB row, template through the allowlist. Client
 * input can never steer the redirect anywhere else (zero open-redirect surface).
 */
export function redirectTargetFor(
  verdict: ScanVerdict,
  qr: QrLookup | null,
  opts: { base: string; template?: string | null },
): string {
  const base = opts.base.replace(/\/+$/, '');
  switch (verdict) {
    case 'WEB_RENDER': {
      // classifyScan guarantees a live entity here; the non-null fallback only
      // satisfies the type system.
      const slug = qr?.entity?.slug ?? '';
      const t = opts.template ? `&t=${opts.template}` : '';
      return `${base}/store/${slug}?src=qr&c=${qr?.shortCode ?? ''}${t}`;
    }
    case 'RETIRED_PAGE':
      // The retired page links to the store's CURRENT page when it is live.
      return qr?.entity?.live ? `${base}/qr/retired?store=${qr.entity.slug}` : `${base}/qr/retired`;
    case 'UNAVAILABLE_PAGE':
      return `${base}/qr/unavailable`;
    case 'NOT_FOUND':
      return `${base}/qr/not-found`;
  }
}

/** The web origin printed QR codes point at. Reuses the codebase's existing
 *  public-web key (the old /vendor/qr route established it). */
export function publicWebBase(): string {
  return (process.env['APP_PUBLIC_URL'] ?? 'https://swift.gy').replace(/\/+$/, '');
}
