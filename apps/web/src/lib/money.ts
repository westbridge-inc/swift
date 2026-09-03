// ---------------------------------------------------------------------------
// [W-13] ONE MONEY PARSER FOR THE WHOLE WEB APP.
//
// Prisma sends `Decimal` columns over the wire as STRINGS. The customer client
// declared those fields as `number` and did arithmetic on them directly, so a
// cart total was one schema change away from `"4000" + 500` — a displayed and
// submitted total off by a factor of a thousand. Today's cart endpoint happens
// to coerce before responding, which makes that half latent rather than live;
// the type says `number` and nothing enforces it, which is exactly the shape
// the register calls out.
//
// The live half was worse and simpler: a missing item price became ZERO.
// `Number(item.customerPrice ?? item.basePrice ?? 0)` renders a free item that
// can still be added to a cart and checked out, and `Math.round(n ?? 0)`
// printed "GY$0" for an undefined price and "GY$NaN" for a broken one.
//
// So: money is parsed EXACTLY or it is refused. There is no zero fallback and
// no `Number()` on an unknown. A total that cannot be computed from parsed
// parts is not computed at all, and the surface that needed it says so instead
// of showing a figure it invented.
//
// The vendor dashboard already reached this conclusion for its own surfaces
// (see lib/vendor-api). This is that parser, promoted to the whole app so
// there is one of it rather than two that drift.
// ---------------------------------------------------------------------------

/** A clean decimal: optional sign, digits, optional fractional part. Nothing else. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * The amount this value really is, or null.
 *
 * Accepts a finite number, or a string that is exactly a decimal literal.
 * Refuses: null, undefined, empty or blank strings, "NaN"/"Infinity", numbers
 * that are not finite, strings carrying currency symbols, separators or any
 * other decoration, and every non-scalar.
 */
export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The sum, or null if ANY part is unparseable. A total built from a part that
 * was quietly treated as zero is a wrong number wearing an authoritative face,
 * which is worse than no number.
 */
export function sumAmounts(...values: unknown[]): number | null {
  let total = 0;
  for (const value of values) {
    const amount = parseAmount(value);
    if (amount === null) return null;
    total += amount;
  }
  return total;
}

/** What a surface shows when money cannot be parsed. Never "0", never "NaN". */
export const MONEY_UNKNOWN = '—';

/**
 * Format an amount for display. A value that is not exactly money renders the
 * em-dash; a real zero still renders as zero, because free and unknown are
 * different facts.
 */
export function formatAmount(value: unknown, prefix: string): string {
  const amount = parseAmount(value);
  if (amount === null) return MONEY_UNKNOWN;
  return `${prefix}${Math.round(amount).toLocaleString()}`;
}
