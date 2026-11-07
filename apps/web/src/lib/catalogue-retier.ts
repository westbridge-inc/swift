// [RETIER PR-C] A tiny module of its own: the sign-up form and the pricing page both read it (no page pulls lib/api for it).
/** [RETIER PR-C · owner 30 Oct 2026] Whether Swift moves an existing store between catalogue steps (GET /auth/pricing
 *  `catalogueRetier`, the server's WEEKLY_RETIER_ON) and the notice a rise gets. 'ON' only for exactly `on: true` with a
 *  notice of 14 days or more; 'OFF' only for exactly `on: false`; anything else (an older server, a malformed answer) is
 *  null, and no claim either way is made. */
export function catalogueRetierOf(pricing: { catalogueRetier?: { on?: unknown; noticeDays?: unknown } } | null | undefined): { on: true; noticeDays: number } | { on: false } | null {
  const r = pricing?.catalogueRetier;
  if (!r || typeof r !== 'object') return null;
  if (r.on === false) return { on: false };
  if (r.on === true && typeof r.noticeDays === 'number' && Number.isInteger(r.noticeDays) && r.noticeDays >= 14) return { on: true, noticeDays: r.noticeDays };
  return null;
}
