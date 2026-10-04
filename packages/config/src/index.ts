// The delivery, courier and taxi rates repeat the API's defaults
// (DEFAULT_DELIVERY_RATES, DEFAULT_COURIER_RATES, DEFAULT_TAXI_RATES), the one
// place they live; apps/api's fares-georgetown-defaults test pins them to it.
export const PLATFORM_DEFAULTS = {
  markupPercentage: 5,
  delivery: {
    baseFee: 500,
    perKmRate: 100,
    includedKm: 3,
  },
  courier: {
    baseFee: 800,
    perKmRate: 120,
    sizeSurcharge: { SMALL: 0, MEDIUM: 500, LARGE: 1000, EXTRA_LARGE: 2000 },
    speedMultiplier: { standard: 1.0, express: 1.5, rush: 2.0 },
  },
  taxi: {
    baseFare: 800,
    includedKm: 3,
    perKmRate: 175,
    perMinRate: 0,
    minimumFare: 800,
  },
  subscription: {
    gracePeriodHours: 24,
    maxFailedAttempts: 3,
    rates: {
      DELIVERY_RIDER: 10000,
      COURIER_RIDER: 20000,
      TAXI_DRIVER: 20000,
      RESTAURANT: 20000,
      SUPERMARKET: 20000,
    },
  },
  surge: {
    threshold: 0.8,
    maxMultiplier: 2.0,
    recalculateIntervalMinutes: 2,
  },
  order: {
    autoRejectMinutes: 5,
    rideRequestTimeoutSeconds: 15,
    maxRiderAttempts: 3,
    maxDriverAttempts: 5,
  },
  ratings: {
    minRiderRating: 4.0,
    reviewTriggerThreshold: 4.0,
  },
  settlement: {
    cycleDays: 7,
  },
  currency: {
    code: 'GYD',
    symbol: '$',
    name: 'Guyanese Dollar',
  },
} as const;

export type PlatformConfig = typeof PLATFORM_DEFAULTS;
