// PURE deep-link parsing [qr spec Part 6.2] — no RN imports, fully testable.
// A universal link hands the app a full https URL; only exactly-shaped
// /store/{slug} and /s/{code} paths are ours, anything else opens the app
// normally (never a crash, never a guess).

export type LinkDestination =
  | { kind: 'store'; slug: string; code: string | null }
  | { kind: 'short'; code: string };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CODE_RE = /^[23456789bcdfghjkmnpqrstvwxyz]{10}$/i;

export function destinationForUrl(url: string): LinkDestination | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'swift:') return null;
  // Custom scheme: in swift://s/{code} the WHATWG parser puts "s" in host —
  // fold it back so both schemes share one path shape.
  const parts = [
    ...(parsed.protocol === 'swift:' && parsed.host ? [parsed.host] : []),
    ...parsed.pathname.split('/').filter(Boolean),
  ];
  if (parts.length !== 2) return null;
  const [head, tail] = parts as [string, string];
  if (head === 'store' && SLUG_RE.test(tail)) {
    const c = parsed.searchParams.get('c');
    return { kind: 'store', slug: tail, code: c && CODE_RE.test(c) ? c.toUpperCase() : null };
  }
  if (head === 's' && CODE_RE.test(tail)) return { kind: 'short', code: tail.toUpperCase() };
  return null;
}
