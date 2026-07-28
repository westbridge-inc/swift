/**
 * Sample data for the earner PREVIEW (R3). A prospective driver taps "Preview
 * the driver app" and sees the REAL dashboards fed these canned values — no
 * account, no documents, no network. Everything here is obviously illustrative
 * (Georgetown, round GYD figures) and the screens render it through their normal
 * paths, so preview can never drift from production. Read-only: the mutation
 * hooks no-op in preview, so none of this is ever written anywhere.
 */

// Guyana-day keys for the 7-day earnings trend (oldest → today).
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SAMPLE_DAILY_TOTALS = [6200, 7400, 5100, 8800, 9600, 11200, 8400];

export const PREVIEW_KIND = 'DRIVER' as const;

/** A verified, online sample driver — drives `online`, the GO gate, identity. */
export const PREVIEW_PROFILE = {
  id: 'preview-driver',
  isOnline: true,
  isAvailable: true,
  firstName: 'Sample',
  lastName: 'Driver',
  averageRating: 4.9,
  totalRides: 214,
  vehicleMake: 'Toyota',
  vehicleModel: 'Allion',
  vehicleColor: 'Silver',
  licensePlate: 'PREVIEW',
  rideClass: 'ECONOMY',
  // Riders show a cash-float ceiling on Home; a driver has none, but the field
  // is read defensively (`profile?.float`), so a benign value is fine either way.
  float: { available: 40000, limit: 60000, committed: 20000 },
};

/** Verification status: a fully-approved mover (so the GO button reads eligible,
 *  never a blocked reason) — preview is about the earning experience, not KYC. */
export const PREVIEW_VERIFICATION = {
  roleVerified: true,
  canGoOnline: true,
  documents: [],
  subscription: { status: 'ACTIVE' },
};

export const PREVIEW_EARNINGS_TODAY = {
  total: 8400,
  todayEarnings: 8400,
  trips: 6,
  tripCount: 6,
  jobsToday: 6,
  tips: 1200,
  currencyCode: 'GYD',
};

export const PREVIEW_EARNINGS_SUMMARY = {
  today: 8400,
  week: 56700,
  month: 214000,
  tips: 9800,
  currencyCode: 'GYD',
};

/** Paginated finished-job history shape { data, meta }. */
export const PREVIEW_EARNINGS = {
  data: [
    { id: 'p1', orderNumber: 'SW-8842', amount: 2000, type: 'TAXI_FARE', createdAt: '2026-07-28T13:10:00Z' },
    { id: 'p2', orderNumber: 'SW-8836', amount: 1500, type: 'TAXI_FARE', createdAt: '2026-07-28T12:20:00Z' },
    { id: 'p3', orderNumber: 'SW-8829', amount: 2500, type: 'TAXI_FARE', createdAt: '2026-07-28T11:05:00Z' },
    { id: 'p4', orderNumber: 'SW-8815', amount: 1200, type: 'TIP', createdAt: '2026-07-28T10:40:00Z' },
  ],
  meta: { page: 1, limit: 20, total: 4, hasNext: false },
};

/** Server-aggregated per-day totals for the Home 7-day bars. */
export const PREVIEW_DAILY_EARNINGS = SAMPLE_DAILY_TOTALS.map((total, i) => ({
  date: DAY_LABELS[i],
  total,
  isToday: i === SAMPLE_DAILY_TOTALS.length - 1,
}));

/** Nearby demand (Home leads with a real count). Driver = waiting taxi
 *  requests + watchers; the screen reads these defensively. */
export const PREVIEW_DEMAND = {
  taxiRequests: 5,
  watchers: 3,
  pickups: [
    { lat: 6.808, lng: -58.155, count: 2 },
    { lat: 6.812, lng: -58.149, count: 1 },
    { lat: 6.803, lng: -58.161, count: 2 },
  ],
  stores: [],
};

export const PREVIEW_STATS = {
  onlineHoursToday: 4.5,
  weekDeliveries: 38,
};

/** A couple of board jobs so the "available" list isn't empty in preview. */
export const PREVIEW_AVAILABLE = [
  { id: 'pa1', orderNumber: 'SW-8850', pickupAddress: 'Stabroek Market', deliveryAddress: 'Kitty', taxiFareTotal: 1800, etaMinutes: 4 },
  { id: 'pa2', orderNumber: 'SW-8851', pickupAddress: 'Bourda', deliveryAddress: 'Campbellville', taxiFareTotal: 1500, etaMinutes: 6 },
];

/** A sample in-progress ride so the nav-grade Active-trip screen is previewable.
 *  Home keeps `useActiveJob` null (so it shows the live GO/demand dashboard);
 *  ActiveJobScreen substitutes this in preview. */
export const PREVIEW_ACTIVE_JOB = {
  id: 'preview-trip',
  orderNumber: 'SW-8852',
  status: 'RIDE_IN_PROGRESS',
  orderType: 'TAXI',
  pickupAddress: 'Georgetown Ferry Stelling',
  deliveryAddress: 'Providence Mall',
  pickupLat: 6.807, pickupLng: -58.163,
  deliveryLat: 6.83, deliveryLng: -58.16,
  taxiFareTotal: 2400,
  taxiDistance: 8.2,
  taxiDuration: 18,
  ridePinVerified: true,
  customer: { id: 'preview-cust', firstName: 'Ava', phone: null },
};

export const PREVIEW_SUBSCRIPTION = {
  status: 'ACTIVE',
  type: 'TAXI_DRIVER',
  weeklyRate: 12000,
  currencyCode: 'GYD',
  currentPeriodEnd: '2026-08-04T00:00:00Z',
  nextBillingDate: '2026-08-04T00:00:00Z',
};

// ---------------------------------------------------------------------------
// react-query-shaped stubs so a hook can return sample data / a no-op mutation
// without the screens knowing they're in preview (zero screen drift).
// ---------------------------------------------------------------------------

/** A resolved useQuery result carrying preview data (never loading/erroring). */
export function previewQuery<T>(data: T): any {
  return {
    data,
    isLoading: false,
    isFetching: false,
    isPending: false,
    isError: false,
    error: null,
    isSuccess: true,
    status: 'success',
    refetch: async () => ({ data }),
  };
}

/** A no-op useMutation result — read-only preview never writes server state. */
export function previewMutation(): any {
  return {
    mutate: () => {},
    mutateAsync: async () => undefined,
    isPending: false,
    isError: false,
    error: null,
    isSuccess: false,
    reset: () => {},
    data: undefined,
  };
}
