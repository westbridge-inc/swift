/**
 * Pricing helpers. Customer prices carry NO markup — customers pay the vendor
 * base price; platform revenue is weekly subscriptions only. The fees below
 * (delivery/courier/taxi) are mover earnings, not platform revenue.
 */

/**
 * Calculate delivery fee based on distance.
 * delivery_fee = base_fee + (distance_km - included_km) * per_km_rate
 */
export function calculateDeliveryFee(
  distanceKm: number,
  baseFee: number = 500,
  perKmRate: number = 200,
  includedKm: number = 2,
  surgeMultiplier: number = 1.0,
): number {
  const distanceFee = Math.max(0, distanceKm - includedKm) * perKmRate;
  const subtotal = baseFee + distanceFee;
  return Math.ceil(subtotal * surgeMultiplier);
}

/**
 * FUL-003b: the food/grocery delivery-fee schedule, per-country via
 * CountryConfig.deliveryRates — the SAME null→code-default pattern courier
 * (courierRates) and taxi (taxiRates) already use. Delivery was the one
 * remaining vertical whose fee was computed from `calculateDeliveryFee`'s
 * hardcoded parameter defaults instead of config: fine for Georgetown (the
 * defaults ARE its zone) but silently wrong for a second market. The defaults
 * below are byte-for-byte the old function defaults, so a null config changes
 * nothing.
 */
export interface DeliveryRates {
  baseFee: number;
  perKmRate: number;
  includedKm: number;
  surgeMultiplier: number;
}

export const DEFAULT_DELIVERY_RATES: DeliveryRates = {
  baseFee: 500,
  perKmRate: 200,
  includedKm: 2,
  surgeMultiplier: 1.0,
};

/** Tolerant merge of a CountryConfig.deliveryRates JSON over the defaults — a
 *  partial or malformed config can only override what it validly sets (mirrors
 *  mergeCourierRates). */
export function mergeDeliveryRates(raw: unknown): DeliveryRates {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Partial<DeliveryRates>;
  return {
    baseFee: typeof cfg.baseFee === 'number' ? cfg.baseFee : DEFAULT_DELIVERY_RATES.baseFee,
    perKmRate: typeof cfg.perKmRate === 'number' ? cfg.perKmRate : DEFAULT_DELIVERY_RATES.perKmRate,
    includedKm: typeof cfg.includedKm === 'number' ? cfg.includedKm : DEFAULT_DELIVERY_RATES.includedKm,
    surgeMultiplier: typeof cfg.surgeMultiplier === 'number' ? cfg.surgeMultiplier : DEFAULT_DELIVERY_RATES.surgeMultiplier,
  };
}

/** Delivery fee from a resolved schedule — the config-driven entry point.
 *  `deliveryFeeFromRates(d, DEFAULT_DELIVERY_RATES)` === `calculateDeliveryFee(d)`
 *  for every distance, so wiring a call site through this preserves behavior. */
export function deliveryFeeFromRates(distanceKm: number, rates: DeliveryRates): number {
  return calculateDeliveryFee(distanceKm, rates.baseFee, rates.perKmRate, rates.includedKm, rates.surgeMultiplier);
}

/** Express (priority) delivery multiplier — the whole premium is the rider's
 *  cash upside. ONE definition [SWIFT-070]: the cart quote and the checkout
 *  charge both derive the express fee from here, so the displayed total can
 *  never drift from the total actually charged. */
export const EXPRESS_DELIVERY_MULTIPLIER = 1.5;

/** The delivery fee when express/priority is chosen. */
export function expressDeliveryFee(standardFee: number): number {
  return Math.round(standardFee * EXPRESS_DELIVERY_MULTIPLIER);
}

/**
 * Calculate courier fee based on distance, package size, and speed.
 */
export function calculateCourierFee(
  distanceKm: number,
  packageSize: 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE',
  speed: 'standard' | 'express' | 'rush' = 'standard',
): number {
  const baseFee = 1000;
  const perKmRate = 300;
  const sizeSurcharge: Record<string, number> = {
    SMALL: 0,
    MEDIUM: 500,
    LARGE: 1000,
    EXTRA_LARGE: 2000,
  };
  const speedMultiplier: Record<string, number> = {
    standard: 1.0,
    express: 1.5,
    rush: 2.0,
  };

  const subtotal = baseFee + distanceKm * perKmRate + (sizeSurcharge[packageSize] ?? 0);
  return Math.ceil(subtotal * (speedMultiplier[speed] ?? 1.0));
}

/**
 * Calculate taxi fare.
 */
export function calculateTaxiFare(
  distanceKm: number,
  durationMin: number,
  baseFare: number = 1000,
  perKmRate: number = 300,
  perMinRate: number = 50,
  minimumFare: number = 1500,
  surgeMultiplier: number = 1.0,
  vehicleMultiplier: number = 1.0,
): number {
  const fare = baseFare + distanceKm * perKmRate + durationMin * perMinRate;
  const surgedFare = fare * surgeMultiplier * vehicleMultiplier;
  return Math.max(minimumFare, Math.ceil(surgedFare));
}

/**
 * Driver-set pricing (legal marketplace model). A mover may charge anywhere from a
 * floor UP TO the market rate Swift computed for the trip — never above it. Swift
 * computes the cap, but the driver sets the final price, so Swift is a service
 * provider / marketplace, not a price controller; the cap stops customers being
 * overcharged. This clamp runs server-side — the client value is never trusted.
 */
export const DRIVER_FARE_FLOOR_PCT = 0.6;
export function clampDriverFare(requested: number, marketMax: number): number {
  if (!Number.isFinite(requested) || marketMax <= 0) return marketMax;
  const floor = Math.ceil(marketMax * DRIVER_FARE_FLOOR_PCT);
  return Math.min(marketMax, Math.max(floor, Math.round(requested)));
}

const ORDER_SUFFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O/1/I/L

/**
 * Human-readable order number: SW-YYMMDD-XXX plus a 3-char random suffix.
 * The suffix makes the number collision-proof — two simultaneous checkouts
 * can read the same daily count, and orderNumber is a unique column.
 */
export function generateOrderNumber(sequence: number): string {
  const now = new Date();
  const yy = now.getFullYear().toString().slice(2);
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const seq = sequence.toString().padStart(3, '0');
  let suffix = '';
  for (let i = 0; i < 3; i++) {
    suffix += ORDER_SUFFIX_ALPHABET[Math.floor(Math.random() * ORDER_SUFFIX_ALPHABET.length)];
  }
  return `SW-${yy}${mm}${dd}-${seq}${suffix}`;
}
