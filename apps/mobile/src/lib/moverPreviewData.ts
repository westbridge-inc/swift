/**
 * Sample data for the earner PREVIEW (R3). Two doors open it: "Preview the
 * driver app" on the welcome screen (no account), and "Preview your dashboard"
 * in the document area, where a signed-in rider or taxi driver waits for their
 * documents to be checked [owner, 1 Oct 2026]. Either way the REAL dashboards
 * are fed these canned values, one set per face (`previewSample(kind)`): a
 * delivery RIDER on a motorbike, or a taxi DRIVER on a car. Everything here is
 * obviously illustrative (Georgetown, round GYD figures) and shaped exactly as
 * that face's own endpoints answer, so the screens render it through their
 * normal paths and the preview can never drift from production. The one live
 * number is the weekly fee: it comes from the public price list, never from
 * this file. Read-only: the mutation hooks no-op in preview and the app client
 * refuses any write while it is on screen, so none of this is ever written.
 */

import { moverQuote, type MoverRole, type PartnerPricing } from './partnerPricing';

// Guyana-day keys for the 7-day earnings trend (oldest → today), in the shape
// GET /…/earnings/daily answers: Home turns `${date}T12:00:00Z` into a letter.
const DAY_MS = 24 * 60 * 60 * 1000;
const GUYANA_OFFSET_MS = -4 * 60 * 60 * 1000; // UTC-4 all year
const guyanaDay = (at: number) => new Date(at + GUYANA_OFFSET_MS).toISOString().slice(0, 10);
const SAMPLE_DAILY_TOTALS = [6200, 7400, 5100, 8800, 9600, 11200, 8400];
const sampleWeek = (totals: readonly number[], now = Date.now()) => totals.map((total, i) => ({
  date: guyanaDay(now - (totals.length - 1 - i) * DAY_MS),
  total,
  isToday: i === totals.length - 1,
}));
/** A moment `hours` before the preview opened — sample history reads as recent. */
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

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
  vehicleType: 'CAR',
  rideClass: 'ECONOMY',
  // Riders show a cash-float ceiling on Home; a driver has none, but the field
  // is read defensively (`profile?.float`), so a benign value is fine either way.
  float: { available: 40000, limit: 60000, committed: 20000 },
};

/** Verification status: a fully-approved mover (so the GO button reads eligible,
 *  never a blocked reason) — preview is about the earning experience, not KYC.
 *  Its documents are the sample's, approved, so the real Documents screen shows
 *  a finished checklist instead of "steps unavailable"; the mover's own
 *  documents are untouched and are where leaving the preview returns. */
export const PREVIEW_VERIFICATION = {
  roleVerified: true,
  canGoOnline: true,
  checklist: ['national_id', 'drivers_licence', 'police_clearance'],
  documents: [
    { docType: 'national_id', status: 'APPROVED', createdAt: hoursAgo(24 * 30) },
    { docType: 'drivers_licence', status: 'APPROVED', createdAt: hoursAgo(24 * 30) },
    { docType: 'police_clearance', status: 'APPROVED', createdAt: hoursAgo(24 * 30) },
  ],
  subscription: { status: 'ACTIVE' },
};

/** GET /driver/earnings/today: the count is `ridesCompleted` (lib/earnings). */
export const PREVIEW_EARNINGS_TODAY = {
  total: 8400,
  todayEarnings: 8400,
  ridesCompleted: 6,
  breakdown: { TAXI_FARE: 7200, TIP: 1200 },
  currencyCode: 'GYD',
};

/** GET /driver/earnings/summary: { total, count } per window. */
export const PREVIEW_EARNINGS_SUMMARY = {
  today: { total: 8400, count: 6 },
  thisWeek: { total: 56700, count: 41 },
  thisMonth: { total: 214000, count: 152 },
  allTime: { total: 1650000, count: 1180 },
  todayRides: 6,
  totalRides: 1180,
  currencyCode: 'GYD',
};

/** Paginated finished-job history shape { data, meta }. */
export const PREVIEW_EARNINGS = {
  data: [
    { id: 'p1', orderNumber: 'SW-8842', amount: 2000, type: 'TAXI_FARE', createdAt: hoursAgo(1) },
    { id: 'p2', orderNumber: 'SW-8836', amount: 1500, type: 'TAXI_FARE', createdAt: hoursAgo(2) },
    { id: 'p3', orderNumber: 'SW-8829', amount: 2500, type: 'TAXI_FARE', createdAt: hoursAgo(3) },
    { id: 'p4', orderNumber: 'SW-8815', amount: 1200, type: 'TIP', createdAt: hoursAgo(4) },
  ],
  meta: { page: 1, limit: 20, total: 4, hasNext: false },
};

/** Server-aggregated per-day totals for the Home 7-day bars. */
export const PREVIEW_DAILY_EARNINGS = sampleWeek(SAMPLE_DAILY_TOTALS);

/** Nearby demand (Home leads with a real count), as GET /driver/demand
 *  answers: people waiting for a ride, people watching, rounded pickup points. */
export const PREVIEW_DEMAND = {
  waiting: 5,
  watchers: 3,
  points: [
    { lat: 6.808, lng: -58.155 },
    { lat: 6.812, lng: -58.149 },
    { lat: 6.803, lng: -58.161 },
    { lat: 6.809, lng: -58.156 },
    { lat: 6.804, lng: -58.16 },
  ],
  clusters: [{ lat: 6.806, lng: -58.157, count: 3 }],
};

/** A couple of board jobs so the "available" list isn't empty in preview. */
export const PREVIEW_AVAILABLE = [
  { id: 'pa1', orderNumber: 'SW-8850', pickupAddress: 'Stabroek Market', deliveryAddress: 'Kitty', taxiFareTotal: 1800, etaMinutes: 4 },
  { id: 'pa2', orderNumber: 'SW-8851', pickupAddress: 'Bourda', deliveryAddress: 'Campbellville', taxiFareTotal: 1500, etaMinutes: 6 },
];

/** A sample in-progress ride so the nav-grade Active-trip screen is previewable:
 *  Home shows it as the active job, and "tap to manage" opens the real screen. */
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

/** Finished rides as GET /driver/rides lists them. */
export const PREVIEW_RIDE_HISTORY = {
  data: [
    { id: 'pr1', orderNumber: 'SW-8842', status: 'DELIVERED', taxiPickupAddress: 'Stabroek Market', taxiDropoffAddress: 'Kitty', taxiFareTotal: 2000, tipAmount: 500, taxiDistance: 3.2, taxiDuration: 11, deliveredAt: hoursAgo(1) },
    { id: 'pr2', orderNumber: 'SW-8836', status: 'DELIVERED', taxiPickupAddress: 'Bourda', taxiDropoffAddress: 'Campbellville', taxiFareTotal: 1500, taxiDistance: 2.4, taxiDuration: 9, deliveredAt: hoursAgo(2) },
    { id: 'pr3', orderNumber: 'SW-8829', status: 'DELIVERED', taxiPickupAddress: 'Georgetown Ferry Stelling', taxiDropoffAddress: 'Providence Mall', taxiFareTotal: 2500, taxiDistance: 8.2, taxiDuration: 18, deliveredAt: hoursAgo(3) },
  ],
  meta: { page: 1, limit: 20, total: 3, hasNext: false },
};

// ---------------------------------------------------------------------------
// The delivery RIDER face — a rider on a motorbike, working Georgetown stores.
// ---------------------------------------------------------------------------

/** A verified, online sample rider (GET /rider/profile). Riders carry a cash
 *  float: the cash they may front for CASH orders. */
export const PREVIEW_RIDER_PROFILE = {
  id: 'preview-rider',
  isOnline: true,
  isAvailable: true,
  firstName: 'Sample',
  lastName: 'Rider',
  averageRating: 4.9,
  totalDeliveries: 1800,
  vehicleType: 'MOTORCYCLE',
  vehicleMake: 'Honda',
  vehicleModel: 'CG125',
  vehicleColor: 'Red',
  licensePlate: 'PREVIEW',
  float: { available: 20000, limit: 30000, committed: 10000 },
};

/** GET /rider/earnings/today: the count is `deliveries` (lib/earnings). */
export const PREVIEW_RIDER_EARNINGS_TODAY = {
  total: 5200,
  deliveries: 8,
  breakdown: { DELIVERY_FEE: 4400, TIP: 800 },
};

/** GET /rider/earnings/summary: { total, count } per window. */
export const PREVIEW_RIDER_EARNINGS_SUMMARY = {
  today: { total: 5200, count: 9 },
  thisWeek: { total: 42000, count: 63 },
  thisMonth: { total: 168000, count: 250 },
  allTime: { total: 1250000, count: 1900 },
  pendingPayout: 0,
};

/** GET /rider/earnings: fee and tip rows. */
export const PREVIEW_RIDER_EARNINGS = {
  data: [
    { id: 'pe1', orderNumber: 'SW-8868', amount: 800, type: 'DELIVERY_FEE', createdAt: hoursAgo(1) },
    { id: 'pe2', orderNumber: 'SW-8868', amount: 200, type: 'TIP', createdAt: hoursAgo(1) },
    { id: 'pe3', orderNumber: 'SW-8864', amount: 600, type: 'DELIVERY_FEE', createdAt: hoursAgo(2) },
    { id: 'pe4', orderNumber: 'SW-8861', amount: 800, type: 'DELIVERY_FEE', createdAt: hoursAgo(3) },
  ],
  meta: { page: 1, limit: 20, total: 4, hasNext: false },
};

/** GET /rider/stats. */
export const PREVIEW_STATS = {
  onlineHoursToday: 4,
  todayDeliveries: 8,
  weekDeliveries: 60,
  totalDeliveries: 1800,
};

/** GET /rider/demand: orders waiting at stores near the rider — never people. */
export const PREVIEW_RIDER_DEMAND = {
  ready: 3,
  soon: 2,
  stores: [
    { vendorId: 'preview-store-1', name: 'Sample Kitchen', lat: 6.8125, lng: -58.152, ready: 2, soon: 1, feesWaiting: 2400 },
    { vendorId: 'preview-store-2', name: 'Sample Grocery', lat: 6.805, lng: -58.159, ready: 1, soon: 1, feesWaiting: 1600 },
  ],
};

/** The rider's board: deliveries waiting for a rider. */
export const PREVIEW_RIDER_AVAILABLE = [
  { id: 'pd1', orderNumber: 'SW-8870', vendor: { name: 'Sample Kitchen' }, pickupAddress: 'Regent Street', deliveryAddress: 'Kitty', pickupLat: 6.8125, pickupLng: -58.152, totalAmount: 4000, deliveryFee: 800, paymentMethod: 'CASH', itemCount: 3, distanceKm: 1.2 },
  { id: 'pd2', orderNumber: 'SW-8871', vendor: { name: 'Sample Grocery' }, pickupAddress: 'Camp Street', deliveryAddress: 'Lamaha Gardens', pickupLat: 6.805, pickupLng: -58.159, totalAmount: 6500, deliveryFee: 1000, paymentMethod: 'CASH', itemCount: 6, distanceKm: 2.1 },
];

/** A sample delivery in hand: collected from the store, on the way to the
 *  customer, cash at the door. Home shows it; "tap to manage" opens the real
 *  delivery screen, where every step is a no-op in preview. */
export const PREVIEW_RIDER_ACTIVE_JOB = {
  id: 'preview-delivery',
  orderNumber: 'SW-8872',
  status: 'PICKED_UP',
  orderType: 'FOOD_DELIVERY',
  vendor: { name: 'Sample Kitchen' },
  pickupAddress: 'Sample Kitchen, Regent Street',
  deliveryAddress: 'Lamaha Gardens',
  pickupLat: 6.8125, pickupLng: -58.152,
  deliveryLat: 6.822, deliveryLng: -58.145,
  totalAmount: 5000,
  deliveryFee: 800,
  tipAmount: 0,
  paymentMethod: 'CASH',
  customer: { id: 'preview-cust', firstName: 'Ava', phone: null },
};

/** Finished deliveries as GET /rider/orders lists them. */
export const PREVIEW_RIDER_HISTORY = {
  data: [
    { id: 'ph1', orderNumber: 'SW-8868', status: 'DELIVERED', vendor: { name: 'Sample Kitchen' }, deliveryAddress: 'Kitty', totalEarning: 1000, tipAmount: 200, deliveredAt: hoursAgo(1) },
    { id: 'ph2', orderNumber: 'SW-8864', status: 'DELIVERED', vendor: { name: 'Sample Grocery' }, deliveryAddress: 'Bourda', totalEarning: 600, deliveredAt: hoursAgo(2) },
    { id: 'ph3', orderNumber: 'SW-8861', status: 'DELIVERED', vendor: { name: 'Sample Kitchen' }, deliveryAddress: 'Campbellville', totalEarning: 800, deliveredAt: hoursAgo(3) },
  ],
  meta: { page: 1, limit: 20, total: 3, hasNext: false },
};

const RIDER_DAILY_TOTALS = [4000, 5000, 3000, 6000, 7000, 8000, 5200];

// ---------------------------------------------------------------------------
// One sample per face. The vehicle is the one each face's quote is read for.
// ---------------------------------------------------------------------------

/** Both samples work Georgetown, so the preview reads the Guyana price list. */
export const PREVIEW_MARKET = 'GY';
/** The taxi driver's car (the Allion above). */
export const PREVIEW_VEHICLE = 'CAR';
/** The delivery rider's motorbike. */
export const PREVIEW_RIDER_VEHICLE = 'MOTORCYCLE';

export type PreviewFace = MoverRole;

export interface PreviewSample {
  vehicle: string;
  profile: Record<string, any>;
  earningsToday: Record<string, any> & { total: number };
  earningsSummary: Record<string, any>;
  earnings: { data: Array<Record<string, any>>; meta: Record<string, any> };
  daily: Array<{ date: string; total: number; isToday: boolean }>;
  demand: Record<string, any>;
  /** GET /rider/stats; a driver has no such route. */
  stats: Record<string, any> | null;
  available: Array<Record<string, any>>;
  activeJob: Record<string, any>;
  history: { data: Array<Record<string, any>>; meta: Record<string, any> };
  subscriptionType: 'TAXI_DRIVER' | 'DELIVERY_RIDER';
}

const DRIVER_SAMPLE: PreviewSample = {
  vehicle: PREVIEW_VEHICLE,
  profile: PREVIEW_PROFILE,
  earningsToday: PREVIEW_EARNINGS_TODAY,
  earningsSummary: PREVIEW_EARNINGS_SUMMARY,
  earnings: PREVIEW_EARNINGS,
  daily: PREVIEW_DAILY_EARNINGS,
  demand: PREVIEW_DEMAND,
  stats: null,
  available: PREVIEW_AVAILABLE,
  activeJob: PREVIEW_ACTIVE_JOB,
  history: PREVIEW_RIDE_HISTORY,
  subscriptionType: 'TAXI_DRIVER',
};

const RIDER_SAMPLE: PreviewSample = {
  vehicle: PREVIEW_RIDER_VEHICLE,
  profile: PREVIEW_RIDER_PROFILE,
  earningsToday: PREVIEW_RIDER_EARNINGS_TODAY,
  earningsSummary: PREVIEW_RIDER_EARNINGS_SUMMARY,
  earnings: PREVIEW_RIDER_EARNINGS,
  daily: sampleWeek(RIDER_DAILY_TOTALS),
  demand: PREVIEW_RIDER_DEMAND,
  stats: PREVIEW_STATS,
  available: PREVIEW_RIDER_AVAILABLE,
  activeJob: PREVIEW_RIDER_ACTIVE_JOB,
  history: PREVIEW_RIDER_HISTORY,
  subscriptionType: 'DELIVERY_RIDER',
};

/** The sample for one face. The objects are module constants, so a hook that
 *  returns them hands the screens the same identity on every render. */
export function previewSample(kind: PreviewFace): PreviewSample {
  return kind === 'RIDER' ? RIDER_SAMPLE : DRIVER_SAMPLE;
}

/** The sample subscription, deliberately WITHOUT a fee of its own: a frozen
 *  number here is how the preview came to quote a rate nobody is billed. It
 *  renews a week from when the preview opened, so it never reads as overdue. */
export const PREVIEW_SUBSCRIPTION = {
  status: 'ACTIVE',
  type: 'TAXI_DRIVER',
  currencyCode: 'GYD',
  currentPeriodEnd: new Date(Date.now() + 7 * DAY_MS).toISOString(),
  nextBillingDate: new Date(Date.now() + 7 * DAY_MS).toISOString(),
  // Nothing is due on a sample: the weekly-fee screen reads "nothing due".
  amountDueGyd: 0,
};

/** The sample subscription billed at the live quote for the face's sample
 *  vehicle — what a real rider or driver on it signs up on — or null while
 *  there is no valid quote for that face: the fee is absent, never zero, and
 *  a rider is never billed a taxi rate (or the other way round). */
export function previewSubscription(pricing: PartnerPricing | null | undefined, kind: PreviewFace = 'DRIVER') {
  const sample = previewSample(kind);
  const quote = moverQuote(pricing, sample.vehicle);
  if (!quote || quote.role !== kind) return null;
  return { ...PREVIEW_SUBSCRIPTION, type: sample.subscriptionType, weeklyRate: quote.rate };
}

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

/** A no-op useMutation result — read-only preview never writes server state.
 *  [WR-036] The no-op now SAYS so: controls in preview look actionable, and a
 *  silent nothing taught users the buttons were broken. Still writes nothing,
 *  still never throws. */
export function previewMutation(): any {
  const explain = () => {
    try {
      // Lazy import keeps this lib dependency-free for pure logic tests.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../kit/toast').toast.show('Preview is read-only — nothing was changed.');
    } catch { /* non-UI context (tests) — stay a pure no-op */ }
  };
  return {
    mutate: () => explain(),
    mutateAsync: async () => { explain(); return undefined; },
    isPending: false,
    isError: false,
    error: null,
    isSuccess: false,
    reset: () => {},
    data: undefined,
  };
}
