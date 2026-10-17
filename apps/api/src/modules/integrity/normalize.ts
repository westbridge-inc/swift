import { createHmac } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { isProduction } from '../../utils/runtime-mode';

// Identity-signal normalization + hashing (trial-integrity spec §2.1).
// PURE functions, table-driven-tested. The hashing law: every value is stored
// as HMAC-SHA256(normalized, IDENTITY_SALT) — the subsystem cannot leak what
// it never stores raw. IDENTITY_SALT is env-only under secret hygiene;
// prod-required like ADS_EVENT_SECRET.

/** The development fallback. It is printed in this public repository, so a
 *  production key equal to it would make every identity hash recomputable. */
const DEV_IDENTITY_SALT = 'dev-identity-salt';

/** [row 331 · CONFIG-GUARDS] One contract for the boot guard
 *  (assertSafeBootConfig calls this in production, so a server without the key
 *  refuses to START instead of failing the first identity capture mid-signup)
 *  and for the hasher. Production: set, not blank, not the public development
 *  default. Elsewhere: the fixed development salt when unset or blank. Never
 *  echo the value. */
export function identitySalt(env: Record<string, string | undefined> = process.env): string {
  const salt = env['IDENTITY_SALT'];
  // A real key needs no mode (scripts that hash with the key set keep working).
  if (salt?.trim() && salt !== DEV_IDENTITY_SALT) return salt;
  if (isProduction(env)) {
    throw new Error(salt === DEV_IDENTITY_SALT
      ? 'FATAL: IDENTITY_SALT is the development default printed in the public repository — identity hashes keyed with it can be recomputed by anyone. Set a generated secret (deploy/gen-secrets.sh). Refusing to start.'
      : 'FATAL: IDENTITY_SALT is required and must not be blank in production — every identity-signal hash (phone, document number, plate, device) is keyed with it. Refusing to start.');
  }
  return DEV_IDENTITY_SALT;
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

/** `::ffff:a.b.c.d` (an IPv4 client seen by a dual-stack socket) is that IPv4 address. Zone ids are dropped. */
function plainAddress(ip: string): string {
  const raw = ip.trim().split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  return mapped ? mapped[1]! : raw;
}

/** A valid IPv6 address as its eight 4-digit hextets ("::" filled, an IPv4 tail folded in). */
function ipv6Hextets(addr: string): string[] {
  let text = addr.toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const fill = rest === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((h) => h.padStart(4, '0'));
}

/** IPv4 → its /24; IPv6 → its /64 (however the address is written: "::"
 *  compressed, leading zeros dropped, upper case); an IPv4-mapped IPv6
 *  address → its IPv4 /24. Anything else is kept as given. CGNAT reality: the
 *  subnet is the signal, and even then it is the WEAKEST one. */
export function normalizeIpSubnet(ip: string): string {
  const addr = plainAddress(ip);
  const family = isIP(addr);
  if (family === 4) {
    const parts = addr.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (family === 6) return `${ipv6Hextets(addr).slice(0, 4).join(':')}::/64`;
  return ip;
}

/** Addresses that name no outside network: our own side of a proxy (loopback,
 *  private, link-local, unique-local), carrier-shared space (100.64.0.0/10,
 *  only ever seen inside a carrier or an overlay network) and "unspecified". */
const NOT_A_PUBLIC_NETWORK = (() => {
  const list = new BlockList();
  for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) {
    list.addSubnet(net, bits, 'ipv4');
  }
  for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) list.addSubnet(net, bits, 'ipv6');
  return list;
})();

/** [AUD-1 row 301] Is this source address a public network a signup can be
 *  counted against? request.ip follows TRUST_PROXY, so behind a proxy we were
 *  told to trust it is the client's address; a non-public one means the request
 *  came from our own side (or the proxy is not in TRUST_PROXY), and counting
 *  it would put every user behind that hop into one bucket. */
export function isPublicNetworkAddress(ip: string): boolean {
  const addr = plainAddress(ip);
  const family = isIP(addr);
  if (family === 0) return false;
  return !NOT_A_PUBLIC_NETWORK.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

/** Device identifier: the client's stable install id, hashed as-is (already
 *  opaque); trimmed so header padding can't fork it. */
export function normalizeDevice(raw: string): string {
  return raw.trim();
}
