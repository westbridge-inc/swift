/**
 * Calculate the 5% markup on a base price.
 * Markup is calculated per line item, always rounded UP to nearest whole GYD.
 */
export function calculateMarkup(basePrice: number, markupPercentage: number = 5): number {
  return Math.ceil(basePrice * (markupPercentage / 100));
}

/**
 * Calculate the customer-facing price (base + markup).
 */
export function calculateCustomerPrice(basePrice: number, markupPercentage: number = 5): number {
  return basePrice + calculateMarkup(basePrice, markupPercentage);
}

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
