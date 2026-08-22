/**
 * How much of today's money was tips.
 *
 * `/earnings/today` returns `breakdown` — today's total split by `EarningType`
 * (DELIVERY_FEE · COURIER_FEE · TAXI_FARE · TIP) — and the earner home rendered
 * only the grand total, so the split was computed and discarded. That left
 * tips invisible to a mover at BOTH ends of the day: absent from the offer card
 * when they decide (F-257) and absent from the panel when they count (F-261).
 *
 * A mover who can see that $600 of their $4,200 was tips learns which work and
 * which behaviour earns them. That is not decoration; it is the only feedback
 * loop the product offers on service quality.
 */
export interface EarningsSplit {
  /** Today's tips, in GYD. 0 when absent or unusable. */
  tips: number;
  /** false ⇒ render the total alone; there was no tip today worth a line. */
  showTips: boolean;
}

export function earningsSplit(breakdown: unknown): EarningsSplit {
  // The payload is a Record<EarningType, number> built server-side, but this
  // sits on a money line — an unexpected shape must degrade to "no tips
  // today", never to NaN under the day's total.
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
    return { tips: 0, showTips: false };
  }
  const raw = (breakdown as Record<string, unknown>)['TIP'];
  const n = Number(raw);
  const tips = Number.isFinite(n) && n > 0 ? n : 0;
  return { tips, showTips: tips > 0 };
}
