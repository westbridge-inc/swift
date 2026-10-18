import type { PictogramName } from '@/components/glyphs';

// ---------------------------------------------------------------------------
// [Row 117 · owner 16 Oct 2026] The web's half of a taxi fare estimate.
//
// The price is the SERVER's: POST /api/v1/rides/estimate, the same engine the
// phone asks (base 800 for the first 3 km, then the per-km rate, minimum and
// rounding to 100; the airport rate; the real road route only — never a
// straight line — and the launch market only). This module only READS that
// answer: a tier the web cannot name, or a fare that is not a real amount, is
// dropped, never guessed, and an answer with no usable tier is no estimate.
// ---------------------------------------------------------------------------

export type TaxiRideClass = 'ECONOMY' | 'COMFORT' | 'XL' | 'GROUP';

/** The phone's own names (apps/mobile TaxiScreen TIER_META), so the two read the same. */
export const TAXI_TIER_META: Record<TaxiRideClass, { label: string; pictogram: PictogramName; blurb: string }> = {
  ECONOMY: { label: 'Car', pictogram: 'sedan', blurb: 'Everyday rides' },
  COMFORT: { label: 'Estate', pictogram: 'estate', blurb: 'Extra legroom and boot space' },
  XL: { label: 'Van', pictogram: 'van', blurb: 'Room for people and bags' },
  GROUP: { label: 'Minibus', pictogram: 'bus', blurb: 'Groups, tours and airport runs' },
};

export interface TaxiTierFare {
  rideClass: TaxiRideClass;
  fare: number;
  capacity: number;
}

export interface TaxiEstimate {
  tiers: TaxiTierFare[];
  /** Whole minutes of the server's route; null when it gave none. */
  durationMin: number | null;
  /** The server's own waiting-terms sentence, when it discloses one. */
  waitingText: string | null;
}

const isTierClass = (v: unknown): v is TaxiRideClass => typeof v === 'string' && Object.prototype.hasOwnProperty.call(TAXI_TIER_META, v);
const amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The server's estimate as the page may show it, or null when it holds no usable fare. */
export function readTaxiEstimate(raw: unknown): TaxiEstimate | null {
  const answer = raw as { tiers?: unknown; durationMin?: unknown; waiting?: { text?: unknown } | null } | null;
  if (!answer || !Array.isArray(answer.tiers)) return null;
  const tiers = answer.tiers.flatMap((tier: { rideClass?: unknown; fare?: unknown; capacity?: unknown }) => (
    tier && isTierClass(tier.rideClass) && amount(tier.fare) && Number.isInteger(tier.capacity) && (tier.capacity as number) > 0
      ? [{ rideClass: tier.rideClass, fare: tier.fare, capacity: tier.capacity as number }]
      : []
  ));
  if (tiers.length === 0) return null;
  const duration = answer.durationMin;
  const text = answer.waiting?.text;
  return {
    tiers,
    durationMin: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    waitingText: typeof text === 'string' && text.trim() ? text.trim() : null,
  };
}

/** The phone's sentence (apps/mobile lib/roadRouting.ts) for a road route the server could not get. */
export const ROAD_ROUTING_UNAVAILABLE = 'Road routing is unavailable. Try again in a moment.';
export const FARE_UNAVAILABLE = 'Couldn’t get a fare. Try another destination.';

/** What the customer is told when no fare can be shown — never a price. */
export function taxiEstimateRefusal(error: unknown): { message: string; retry: boolean } {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code === 'ROUTE_UNAVAILABLE') return { message: ROAD_ROUTING_UNAVAILABLE, retry: true };
  // The server names which end is outside the market, in plain words.
  if (code === 'ROUTE_OUT_OF_MARKET' && typeof message === 'string' && message.trim()) return { message: message.trim(), retry: false };
  return { message: FARE_UNAVAILABLE, retry: false };
}
