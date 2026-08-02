import { createHmac } from 'node:crypto';

// Identity-signal normalization + hashing (trial-integrity spec §2.1).
// PURE functions, table-driven-tested. The hashing law: every value is stored
// as HMAC-SHA256(normalized, IDENTITY_SALT) — the subsystem cannot leak what
// it never stores raw. IDENTITY_SALT is env-only under secret hygiene;
// prod-required like ADS_EVENT_SECRET.

export function identitySalt(): string {
  const salt = process.env['IDENTITY_SALT'];
  if (!salt) {
    if (process.env['NODE_ENV'] === 'production') throw new Error('IDENTITY_SALT is required in production');
    return 'dev-identity-salt';
  }
  return salt;
}

export function hashSignal(normalized: string): string {
  return createHmac('sha256', identitySalt()).update(normalized).digest('hex');
}

/** ID / TIN / business-reg / plate: strip everything non-alphanumeric, uppercase.
 *  "154-829-063", "154 829 063", "154829063" → one value. */
export function normalizeDocNumber(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** Plates share the doc-number law ("PAB 1234" == "pab-1234"). */
export const normalizePlate = normalizeDocNumber;

/** E.164-ish: digits only (leading + dropped — the digits ARE the number). */
export function normalizePhone(raw: string): string {
  return raw.replace(/[^0-9]/g, '');
}

/** Email: lowercase; plus-alias stripped; dots stripped from the local part
 *  (gmail-style — a cheap alias factory either way). */
export function normalizeEmail(raw: string): string {
  const lower = raw.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 0) return lower;
  let local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** Fuzzy-name + exact-DOB composite (SOFT): lowercase, collapse whitespace,
 *  alpha only for the name; DOB as YYYY-MM-DD. */
export function normalizeNameDob(name: string, dobIso: string): string {
  const n = name.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  return `${n}|${dobIso.slice(0, 10)}`;
}

/** IPv4 → /24 subnet; IPv6 → first 4 hextets. CGNAT reality: the subnet is
 *  the signal, and even then it is the WEAKEST one. */
export function normalizeIpSubnet(ip: string): string {
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':').toLowerCase();
  }
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : ip;
}

/** Device identifier: the client's stable install id, hashed as-is (already
 *  opaque); trimmed so header padding can't fork it. */
export function normalizeDevice(raw: string): string {
  return raw.trim();
}
