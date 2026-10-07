// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-1] ONE PLACE FOR THE WORDS.
//
// The console printed the database's enum values to people: PENDING_APPROVAL,
// MOBILE_MONEY, RIDER_EN_ROUTE_PICKUP. Owner ruling (6 Oct): statuses in plain
// words, never raw enums. This map holds the words for every Prisma enum the
// console shows; labels.test.ts reads apps/api/prisma/schema.prisma and fails
// when one of these enums gains a value that has no words here.
//
// The words follow the apps where the apps already have them (ride classes are
// Car / Estate / Van / Minibus, as the rider sees them in the taxi screen; MMG
// is "MMG", as the finance page says it). Statuses are third person: the
// console describes a record, it does not talk to the customer.
// ---------------------------------------------------------------------------

export const ENUM_LABELS = {
  UserRole: {
    CUSTOMER: 'Customer', RIDER: 'Rider', DRIVER: 'Driver', MOVER: 'Rider or driver',
    VENDOR_OWNER: 'Business owner', ADMIN: 'Admin', SUPER_ADMIN: 'Super admin',
  },
  UserStatus: {
    ACTIVE: 'Active', SUSPENDED: 'Suspended', BANNED: 'Banned',
    PENDING_VERIFICATION: 'Waiting for verification', DEACTIVATED: 'Account closed',
  },
  VendorStatus: {
    PENDING_APPROVAL: 'Waiting for approval', ACTIVE: 'Live', SUSPENDED: 'Suspended', CLOSED: 'Closed',
  },
  VendorType: {
    RESTAURANT: 'Restaurant', SUPERMARKET: 'Supermarket', STORE: 'Store', SERVICE: 'Service business',
  },
  VendorTier: {
    UNREGISTERED: 'Unregistered seller', REGISTERED: 'Registered business',
  },
  OrderStatus: {
    PENDING: 'Waiting to be accepted', ACCEPTED: 'Accepted', PREPARING: 'Being prepared',
    READY_FOR_PICKUP: 'Ready for pickup', RIDER_ASSIGNED: 'Rider assigned',
    RIDER_EN_ROUTE_PICKUP: 'Rider on the way to pick up', RIDER_ARRIVED_PICKUP: 'Rider at pickup',
    PICKED_UP: 'Picked up', EN_ROUTE_DELIVERY: 'On the way to the customer', ARRIVED: 'Arrived at the customer',
    DRIVER_ASSIGNED: 'Driver assigned', DRIVER_EN_ROUTE: 'Driver on the way', DRIVER_ARRIVED: 'Driver arrived',
    RIDE_IN_PROGRESS: 'Ride in progress', DELIVERED: 'Delivered', COMPLETED: 'Completed',
    CANCELLED: 'Cancelled', REFUNDED: 'Refunded', FAILED: 'Failed',
    RETURNING: 'Being returned', RETURNED: 'Returned to sender',
  },
  OrderType: {
    FOOD_DELIVERY: 'Food delivery', GROCERY_DELIVERY: 'Grocery delivery', COURIER: 'Courier', TAXI: 'Taxi ride',
  },
  RideClass: {
    ECONOMY: 'Car', COMFORT: 'Estate', XL: 'Van', GROUP: 'Minibus',
  },
  FulfillmentType: {
    DELIVERY: 'Delivery', APPOINTMENT: 'Appointment', PICKUP: 'Customer pickup',
  },
  PaymentMethod: {
    CASH: 'Cash', MOBILE_MONEY: 'MMG', BANK_TRANSFER: 'Bank transfer', CARD: 'Card', WALLET: 'Wallet',
  },
  PaymentStatus: {
    PENDING: 'Not paid yet', AUTHORIZED: 'Authorised', CAPTURED: 'Paid',
    CLAIMED: 'Store says paid', FAILED: 'Payment failed', REFUNDED: 'Refunded',
    PARTIALLY_REFUNDED: 'Partly refunded', UNKNOWN: 'Not confirmed', EXPIRED: 'Payment expired',
    CANCELLED: 'Payment cancelled',
  },
  RiderType: {
    DELIVERY: 'Delivery', COURIER: 'Courier', BOTH: 'Delivery and courier',
  },
  VehicleType: {
    BICYCLE: 'Bicycle', MOTORCYCLE: 'Motorcycle', CAR: 'Car', WAGON_CAR: 'Wagon',
    BUS_9: 'Minibus (9 seats)', BUS_15: 'Minibus (15 seats)',
    CANTER_SHORT: 'Canter (short)', CANTER_LONG: 'Canter (long)',
    BOX_TRUCK_SHORT: 'Box truck (short)', BOX_TRUCK_LONG: 'Box truck (long)',
  },
  SubscriptionStatus: {
    ACTIVE: 'Active', PAUSED: 'Paused', PAST_DUE: 'Past due', SUSPENDED: 'Suspended',
    CANCELLED: 'Cancelled', TRIAL: 'Free trial', CHURNED: 'Left Swift',
  },
  SubscriptionType: {
    DELIVERY_RIDER: 'Delivery rider', COURIER_RIDER: 'Courier rider', TAXI_DRIVER: 'Taxi driver',
    RESTAURANT: 'Restaurant', SUPERMARKET: 'Supermarket', RETAIL_STORE: 'Retail store',
    SERVICE_PROVIDER: 'Service provider',
  },
  BillingEventType: {
    CHARGE_ATTEMPT: 'Weekly fee charge started', CHARGE_ATTEMPT_RECLAIMED: 'Stalled charge restarted',
    CHARGE_SUCCESS: 'Weekly fee paid', CHARGE_FAILED: 'Weekly fee not paid', PREPAID_TOPUP: 'Prepaid top-up',
    SUSPENDED: 'Suspended for an unpaid fee', REINSTATED: 'Reinstated', REMINDER: 'Reminder sent',
    TIER_CHANGE: 'Plan changed', CHURNED: 'Left Swift',
  },
  EarningType: {
    DELIVERY_FEE: 'Delivery fee', COURIER_FEE: 'Courier fee', TAXI_FARE: 'Taxi fare', TIP: 'Tip',
    RESCUE_INCENTIVE: 'Rescue bonus',
  },
  ClaimStatus: {
    AUTO_APPROVED: 'Approved automatically', PENDING_REVIEW: 'Waiting for review', APPROVED: 'Approved',
    REJECTED: 'Rejected', PAID: 'Paid',
  },
  ReturnStatus: {
    REQUESTED: 'Requested', APPROVED: 'Approved', REJECTED: 'Rejected', REFUND_DUE: 'Refund owed', REFUNDED: 'Refunded',
  },
  CustodyRecoveryState: {
    SUPPORT_HOLD: 'Held by support', RETURN_REQUIRED: 'Must be returned', RELAY_REQUIRED: 'Needs another rider',
    TRANSFER_IN_PROGRESS: 'Handing to another rider', DELIVERED: 'Delivered', RETURNED: 'Returned',
    TRANSFERRED: 'Handed over', CLOSED: 'Closed',
  },
  ReportReason: {
    SPAM: 'Spam', HARASSMENT: 'Harassment', HATE_SPEECH: 'Hate speech', VIOLENCE: 'Violence',
    SEXUAL_CONTENT: 'Sexual content', CSAE: 'Child sexual abuse or exploitation', ILLEGAL_GOODS: 'Illegal goods',
    OTHER: 'Other',
  },
  ReportTargetType: {
    RATING: 'Review', CHAT_MESSAGE: 'Chat message', USER: 'Person', VENDOR: 'Store', ITEM: 'Item for sale',
  },
  ReportStatus: {
    PENDING: 'Waiting for review', REVIEWING: 'Being reviewed', ACTIONED: 'Action taken', DISMISSED: 'Dismissed',
  },
  DiscountType: {
    PERCENTAGE: 'Percent off', FIXED_AMOUNT: 'Amount off', FREE_DELIVERY: 'Free delivery',
  },
  DiscoveryCategoryKind: {
    CUISINE: 'Cuisine', DISH: 'Dish', DIETARY: 'Dietary', AISLE: 'Aisle', RETAIL: 'Retail category',
  },
  DiscoveryCategoryVertical: {
    FOOD: 'Food', GROCERY: 'Grocery', RETAIL: 'Retail',
  },
  DiscoveryCategoryStatus: {
    ACTIVE: 'Visible', HIDDEN: 'Hidden', MERGED: 'Merged', PENDING: 'Waiting for review',
  },
  VerificationDocumentStatus: {
    PENDING: 'Waiting for review', APPROVED: 'Approved', REJECTED: 'Rejected', EXPIRED: 'Expired',
  },
  CoverageClass: {
    HIRE: 'Hire (commercial) cover', PRIVATE: 'Private cover only',
  },
  SupportCategory: {
    ORDER_ISSUE: 'Order problem', PAYMENT: 'Payment', SAFETY: 'Safety', ACCOUNT: 'Account', VENDOR: 'Store',
    MOVER: 'Rider or driver', OTHER: 'Other',
  },
  SupportStatus: {
    OPEN: 'Open', IN_PROGRESS: 'Being handled', RESOLVED: 'Resolved',
  },
  SupportResolution: {
    ANSWERED: 'Answered', ACTION_TAKEN: 'Action taken', ESCALATED_SAFETY: 'Escalated to safety',
    NO_RISK_FOUND: 'No risk found', UNABLE_TO_CONTACT: "Couldn't reach them",
  },
  CashSettlementStatus: {
    OWED: 'Owed', RIDER_CONFIRMED: 'Rider confirmed', STORE_CONFIRMED: 'Store confirmed', SETTLED: 'Settled',
  },
  AdvertiserStatus: {
    PENDING_REVIEW: 'Waiting for review', APPROVED: 'Approved', REJECTED: 'Rejected', SUSPENDED: 'Suspended',
  },
  AdCreativeStatus: {
    PENDING: 'Waiting for review', APPROVED: 'Approved', REJECTED: 'Rejected',
  },
} as const satisfies Record<string, Record<string, string>>;

export type EnumName = keyof typeof ENUM_LABELS;

/** "SOMETHING_NEW" → "Something new". The floor for a value this map has not
 *  been taught yet: never the raw enum (labels.test.ts keeps it unreachable
 *  for the enums above). */
function humanise(value: string): string {
  const words = value.toLowerCase().replaceAll('_', ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '—';
}

/** The plain words for an enum value. */
export function label(group: EnumName, value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  const words = (ENUM_LABELS[group] as Record<string, string>)[value];
  return words ?? humanise(value);
}

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

/** Colour for a status-like value. Unlisted values are neutral, never alarming. */
const TONES: Partial<Record<EnumName, Record<string, Tone>>> = {
  UserStatus: { ACTIVE: 'good', SUSPENDED: 'bad', BANNED: 'bad', PENDING_VERIFICATION: 'warn', DEACTIVATED: 'neutral' },
  VendorStatus: { PENDING_APPROVAL: 'warn', ACTIVE: 'good', SUSPENDED: 'bad', CLOSED: 'neutral' },
  OrderStatus: {
    PENDING: 'warn', DELIVERED: 'good', COMPLETED: 'good', CANCELLED: 'bad', REFUNDED: 'neutral', FAILED: 'bad',
    RETURNING: 'warn', RETURNED: 'neutral',
  },
  PaymentStatus: { CAPTURED: 'good', CLAIMED: 'warn', FAILED: 'bad', UNKNOWN: 'warn', PENDING: 'neutral' },
  SubscriptionStatus: { ACTIVE: 'good', TRIAL: 'info', PAUSED: 'neutral', PAST_DUE: 'warn', SUSPENDED: 'bad', CANCELLED: 'neutral', CHURNED: 'neutral' },
  ClaimStatus: { AUTO_APPROVED: 'good', PENDING_REVIEW: 'warn', APPROVED: 'good', REJECTED: 'bad', PAID: 'good' },
  ReturnStatus: { REQUESTED: 'warn', APPROVED: 'good', REJECTED: 'bad', REFUND_DUE: 'warn', REFUNDED: 'good' },
  VerificationDocumentStatus: { PENDING: 'warn', APPROVED: 'good', REJECTED: 'bad', EXPIRED: 'bad' },
  SupportStatus: { OPEN: 'warn', IN_PROGRESS: 'info', RESOLVED: 'good' },
  CashSettlementStatus: { OWED: 'warn', RIDER_CONFIRMED: 'info', STORE_CONFIRMED: 'info', SETTLED: 'good' },
  AdvertiserStatus: { PENDING_REVIEW: 'warn', APPROVED: 'good', REJECTED: 'bad', SUSPENDED: 'bad' },
  AdCreativeStatus: { PENDING: 'warn', APPROVED: 'good', REJECTED: 'bad' },
  ReportStatus: { PENDING: 'warn', REVIEWING: 'info', ACTIONED: 'good', DISMISSED: 'neutral' },
};

export function statusTone(group: EnumName, value: string | null | undefined): Tone {
  if (!value) return 'neutral';
  return TONES[group]?.[value] ?? 'neutral';
}

/**
 * A rating, honestly. The schema defaults `averageRating` to 5.0 and
 * `totalRatings` to 0, so an unrated store used to read "5.0". With no ratings
 * there is no average: it is New (the customer apps say the same, from the
 * rating surface on the server).
 */
export function ratingText(average: number | null | undefined, count: number | null | undefined): string {
  const n = typeof count === 'number' && Number.isFinite(count) ? count : 0;
  if (n <= 0 || average == null || !Number.isFinite(Number(average))) return 'New';
  return `${Number(average).toFixed(1)} · ${n.toLocaleString('en-GY')} rating${n === 1 ? '' : 's'}`;
}
