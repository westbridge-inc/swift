// ---------------------------------------------------------------------------
// [TAXI multi-stop · parts 6–7] TEST FIXTURES ONLY — nothing in the app imports
// this file. Every payload is copied from the API contract the server lanes
// publish (swift-coordination evidence CLAUDE-TAXI-MULTISTOP-P3-20261001,
// CONTRACT.md Rev 2): §2 the estimate, §3 the request and its answer, §5 the
// rider's ride, §6 the driver's board, offer and active ride, §8 the waiting
// charge. Shapes are kept byte-for-byte where the contract prints them; the
// two-stop variants reuse the §5/§6 stop rows.
// ---------------------------------------------------------------------------

export const PICKUP = { lat: 6.8013, lng: -58.1553 };
export const DROPOFF = { lat: 6.82, lng: -58.16 };
export const CAMP_STREET = { lat: 6.8143, lng: -58.1443, address: 'Camp Street' };
export const SHERIFF_STREET = { lat: 6.825, lng: -58.15, address: 'Sheriff Street' };

/** §2 — the estimate answer WITH one stop (byte-exact from the part-2 test). */
export const ESTIMATE_WITH_ONE_STOP = {
  success: true,
  data: {
    tiers: [
      { rideClass: 'ECONOMY', multiplier: 1, fare: 2800, capacity: 4, source: 'formula' },
      { rideClass: 'COMFORT', multiplier: 1.35, fare: 3800, capacity: 4, source: 'formula' },
      { rideClass: 'GROUP', multiplier: 2.5, fare: 7000, capacity: 14, source: 'formula' },
    ],
    currencyCode: 'GYD', distanceKm: 4.9, durationMin: 12, billableKm: 4.85, routeSource: 'haversine',
    legs: [
      { from: 'PICKUP', to: 'STOP_1', meters: 2454, seconds: null },
      { from: 'STOP_1', to: 'DESTINATION', meters: 2399, seconds: null },
    ],
    maxStops: 3, stopCount: 1,
  },
} as const;

/** §2 — the estimate answer WITHOUT stops: today's keys only. */
export const ESTIMATE_WITHOUT_STOPS = {
  success: true,
  data: {
    tiers: [
      { rideClass: 'ECONOMY', multiplier: 1, fare: 2400, capacity: 4, source: 'formula' },
      { rideClass: 'COMFORT', multiplier: 1.35, fare: 3200, capacity: 4, source: 'formula' },
    ],
    currencyCode: 'GYD', distanceKm: 3.1, durationMin: 9, billableKm: 3.05, routeSource: 'haversine',
  },
} as const;

/** §3 — the request body WITH one stop, exactly as the contract prints it. */
export const REQUEST_BODY_WITH_ONE_STOP = {
  pickup: { lat: 6.8013, lng: -58.1553 },
  dropoff: { lat: 6.82, lng: -58.16 },
  pickupAddress: 'Stabroek Market',
  dropoffAddress: 'Lamaha Street',
  passengerCount: 1,
  rideClass: 'ECONOMY',
  stops: [{ lat: 6.8143, lng: -58.1443, address: 'Camp Street' }],
  expectedFare: 2800,
} as const;

/** §3 — the 201 answer for a ride WITH one stop. */
export const REQUEST_ANSWER_WITH_ONE_STOP = {
  success: true,
  data: {
    ride: {
      id: 'cm-ride-1', orderNumber: 'TX-1001', status: 'PENDING', fare: 2800, rideClass: 'ECONOMY',
      currencyCode: 'GYD', fareSource: 'formula', distanceKm: 4.9, durationMin: 12, ridePin: '123456',
      pickupAddress: 'Stabroek Market', dropoffAddress: 'Lamaha Street',
      stopCount: 1,
      stops: [{ sequence: 1, address: 'Camp Street', lat: 6.8143, lng: -58.1443 }],
    },
    message: 'Looking for a driver near you…',
  },
} as const;

/** §5 — the two stop rows of the rider's ride (both PENDING). */
export const RIDE_STOPS_PENDING = [
  { sequence: 1, address: 'Camp Street', lat: 6.8143, lng: -58.1443, status: 'PENDING',
    legMeters: 2454, legSeconds: null, arrivedAt: null, departedAt: null, skippedAt: null, skipReason: null },
  { sequence: 2, address: 'Sheriff Street', lat: 6.825, lng: -58.15, status: 'PENDING',
    legMeters: 1750, legSeconds: null, arrivedAt: null, departedAt: null, skippedAt: null, skipReason: null },
] as const;

/** §5 — a ride WITH two stops, mid-trip: stop 1 done, stop 2 the driver is at. */
export function riderRideWithStops(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cm-ride-2', orderNumber: 'TX-1002', status: 'RIDE_IN_PROGRESS', orderType: 'TAXI',
    pickupAddress: 'Stabroek Market', pickupLat: 6.8013, pickupLng: -58.1553,
    deliveryAddress: 'Lamaha Street', taxiDropoffAddress: 'Lamaha Street', deliveryLat: 6.82, deliveryLng: -58.16,
    taxiFareTotal: 3400, rideClass: 'ECONOMY', ridePin: '654321', ridePinVerified: true,
    driver: { id: 'drv-1', licensePlate: 'PXX 1234', user: { firstName: 'Devon' } },
    taxiStopCount: 2,
    nextStopSequence: 2,
    stops: [
      { ...RIDE_STOPS_PENDING[0], status: 'DEPARTED', arrivedAt: '2026-10-01T21:00:00.000Z', departedAt: '2026-10-01T21:04:00.000Z' },
      { ...RIDE_STOPS_PENDING[1], status: 'ARRIVED', arrivedAt: '2026-10-01T21:09:00.000Z' },
    ],
    ...overrides,
  };
}

/** §5 — the same ride as today's payload: no `stops`, no `nextStopSequence`. */
export function riderRideWithoutStops(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cm-ride-3', orderNumber: 'TX-1003', status: 'RIDE_IN_PROGRESS', orderType: 'TAXI',
    pickupAddress: 'Stabroek Market', pickupLat: 6.8013, pickupLng: -58.1553,
    deliveryAddress: 'Lamaha Street', deliveryLat: 6.82, deliveryLng: -58.16,
    taxiFareTotal: 2400, rideClass: 'ECONOMY', ridePin: '654321', ridePinVerified: true, taxiStopCount: null,
    driver: { id: 'drv-1', licensePlate: 'PXX 1234', user: { firstName: 'Devon' } },
    ...overrides,
  };
}

/** §6.1 — the board item's extra keys for a ride WITH two stops. */
export const BOARD_STOPS = {
  stopCount: 2,
  stops: [
    { sequence: 1, address: 'Camp Street', lat: 6.8143, lng: -58.1443 },
    { sequence: 2, address: 'Sheriff Street', lat: 6.825, lng: -58.15 },
  ],
} as const;

/** §6.3 — the driver's active ride WITH two stops, both still PENDING, trip started. */
export function driverRideWithStops(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cm-ride-4', orderNumber: 'TX-1004', status: 'RIDE_IN_PROGRESS', orderType: 'TAXI',
    pickupAddress: 'Stabroek Market', pickupLat: 6.8013, pickupLng: -58.1553,
    deliveryAddress: 'Lamaha Street', taxiDropoffAddress: 'Lamaha Street', deliveryLat: 6.82, deliveryLng: -58.16,
    taxiFareTotal: 3400, totalAmount: 3400, paymentMethod: 'CASH', ridePinVerified: true,
    customer: { firstName: 'Asha', lastName: 'K' },
    nextStopSequence: 1,
    stops: RIDE_STOPS_PENDING.map((s) => ({ ...s })),
    ...overrides,
  };
}

/** §8.2 — the waiting terms on the estimate, the capabilities read and the request answer. */
export const WAITING_TERMS = {
  chargePerBlock: 500, blockMinutes: 10, currencyCode: 'GYD',
  text: 'Waiting: 500 per 10 minutes after your driver arrives',
} as const;

/** §8.3 — the live waiting object (from the driver's arrival on). */
export const WAITING_LIVE = {
  chargePerBlock: 500, blockMinutes: 10, currencyCode: 'GYD',
  pickupWaitMinutes: 7,
  waitingMinutes: 13,
  waitingCharge: 500,
  running: true,
  nextChargeAt: '2026-10-01T21:10:00.000Z',
} as const;

/** §8.4 — the finished ride's breakdown. */
export const FARE_BREAKDOWN = { routeFare: 2800, waitingMinutes: 13, waitingCharge: 500, total: 3300, currencyCode: 'GYD' } as const;
