export const PLATFORM_DEFAULTS = {
  markupPercentage: 5,
  delivery: {
    baseFee: 500,
    perKmRate: 200,
    includedKm: 2,
  },
  courier: {
    baseFee: 1000,
    perKmRate: 300,
    sizeSurcharge: { SMALL: 0, MEDIUM: 500, LARGE: 1000, EXTRA_LARGE: 2000 },
    speedMultiplier: { standard: 1.0, express: 1.5, rush: 2.0 },
  },
  taxi: {
    baseFare: 1000,
    perKmRate: 300,
    perMinRate: 50,
    minimumFare: 1500,
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
