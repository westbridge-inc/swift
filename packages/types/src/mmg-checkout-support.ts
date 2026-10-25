// [MMG support lookup] The admin console's view of one MMG weekly-fee checkout:
//   GET /api/v1/admin/billing/mmg-checkouts?q=&status=&cursor=   search and list
//   GET /api/v1/admin/billing/mmg-checkouts/:id                  one checkout, with its timeline
// (apps/api/src/modules/billing/MMG-CHECKOUT-API.md, section 11). The API builds
// every object below field by field. The key lists are the contract both sides
// test against: the API test asserts its real responses carry exactly these
// keys, and the console's tests build their fixtures from the same lists. Never
// part of it: the MMG page URL, a token, an Idempotency-Key, MMG's reply HTML,
// a key or a header.

export const MMG_CHECKOUT_SUPPORT_STATUSES = ['OPEN', 'CONFIRMING', 'CONFIRMED', 'NOT_PAID', 'EXPIRED', 'HELD'] as const;
export type MmgCheckoutSupportStatus = (typeof MMG_CHECKOUT_SUPPORT_STATUSES)[number];

/** Which identifier a search matched, exactly, after normalisation. */
export const MMG_CHECKOUT_SUPPORT_MATCHES = ['SWIFT_REFERENCE', 'MMG_TRANSACTION_ID', 'MMG_CANDIDATE', 'MMG_REFERENCE', 'PARTNER_PHONE'] as const;
export type MmgCheckoutSupportMatch = (typeof MMG_CHECKOUT_SUPPORT_MATCHES)[number];

export interface MmgCheckoutSupportPartner {
  kind: 'VENDOR' | 'RIDER' | 'DRIVER' | 'UNKNOWN';
  /** The store's name, or the mover's name. */
  displayName: string | null;
  /** The paying partner's phone, masked (+592•••••1234). */
  maskedPhone: string | null;
  subscriptionId: string;
}
export const MMG_CHECKOUT_SUPPORT_PARTNER_KEYS = ['kind', 'displayName', 'maskedPhone', 'subscriptionId'] as const;

export interface MmgCheckoutSupportRow {
  /** The checkout, for the detail view. */
  id: string;
  /** Ours: the merchantTransactionId sent to MMG (18 digits). */
  swiftReference: string;
  /** MMG's transaction, once MMG's records confirmed it (CONFIRMED). */
  mmgTransactionId: string | null;
  /** MMG's own ledger number for the payment (its lookup's transactionReference), when known. */
  mmgTransactionReference: string | null;
  /** Whole GYD, exactly what MMG was asked for. */
  amount: number;
  currencyCode: string;
  status: MmgCheckoutSupportStatus;
  /** ios | android | web | unknown: where the checkout was started. */
  platform: string;
  partner: MmgCheckoutSupportPartner;
  createdAt: string;
  replyAt: string | null;
  confirmedAt: string | null;
  /** Why NOT_PAID, EXPIRED or HELD. For operators only, never shown to a partner. */
  reason: string | null;
  /** Search only: which identifier(s) matched. Empty when listing. */
  matchedBy: MmgCheckoutSupportMatch[];
}
export const MMG_CHECKOUT_SUPPORT_ROW_KEYS = [
  'id', 'swiftReference', 'mmgTransactionId', 'mmgTransactionReference', 'amount', 'currencyCode', 'status',
  'platform', 'partner', 'createdAt', 'replyAt', 'confirmedAt', 'reason', 'matchedBy',
] as const;

/** The list answer: `data` rows, newest first, and the cursor for the next page. */
export interface MmgCheckoutSupportPage {
  data: MmgCheckoutSupportRow[];
  nextCursor: string | null;
}

/** One reply, callback, MMG lookup or MMG history answer the checkout recorded, in order. */
export interface MmgCheckoutTimelineEntry {
  at: string;
  source: 'RETURN' | 'NOTIFY' | 'LOOKUP' | 'HISTORY';
  /** MMG's ResultCode on a reply (0 successful … 7 timed out). */
  resultCode: string | null;
  /** MMG's lookup transactionStatus ("successful"), or its history record's ("completed"), exactly as sent. */
  transactionStatus: string | null;
  /** The MMG transaction a reply named, or the one a lookup or history answer was about. */
  mmgTransactionId: string | null;
  /** MMG's ledger number a lookup returned. */
  mmgTransactionReference: string | null;
  /** The amount and currency MMG's lookup or history record reported, as sent. */
  amount: string | null;
  currency: string | null;
  /** A history answer: where MMG's time for the payment stands, by the same check that credits: INSIDE,
   *  OUTSIDE the checkout's window, AFTER_REPLY (more than two minutes after the first reply naming it:
   *  MMG's time may not match the configured zone, or it is not this checkout's payment), UNREADABLE,
   *  NOT_IN_HISTORY, AMBIGUOUS (more than one record), DISAGREES (the record does not match the
   *  checkout), or UNAVAILABLE (history could not be read in full). A reply: did it arrive by the
   *  deadline. A lookup: none (its creationDate is the lookup's own moment, MMG 7 Oct). */
  windowCheck: 'INSIDE' | 'OUTSIDE' | 'AFTER_REPLY' | 'UNREADABLE' | 'NOT_IN_HISTORY' | 'AMBIGUOUS' | 'DISAGREES' | 'UNAVAILABLE' | null;
  /** Why nothing could be used (NO_TOKEN, INVALID_RESPONSE, LOOKUP_NOT_FOUND, LOOKUP_FAILED, HISTORY_NOT_FOUND, HISTORY_FAILED, RESULT_CODE_n). */
  failure: string | null;
}
export const MMG_CHECKOUT_TIMELINE_KEYS = [
  'at', 'source', 'resultCode', 'transactionStatus', 'mmgTransactionId', 'mmgTransactionReference',
  'amount', 'currency', 'windowCheck', 'failure',
] as const;

/** What a CONFIRMED checkout's credit paid. */
export interface MmgCheckoutCreditedPeriod {
  /** APPLIED: it paid the week below at once. CREDIT: kept as credit toward the next bill. PENDING: credited, being applied. */
  state: 'APPLIED' | 'CREDIT' | 'PENDING';
  periodStart: string | null;
  periodEnd: string | null;
  /** The receipt issued for the credit. */
  receiptNumber: string | null;
}
export const MMG_CHECKOUT_CREDITED_PERIOD_KEYS = ['state', 'periodStart', 'periodEnd', 'receiptNumber'] as const;

export interface MmgCheckoutSupportDetail extends Omit<MmgCheckoutSupportRow, 'matchedBy'> {
  timeline: MmgCheckoutTimelineEntry[];
  /** True when the checkout has more records than the timeline shows. */
  timelineTruncated: boolean;
  creditedPeriod: MmgCheckoutCreditedPeriod | null;
}
export const MMG_CHECKOUT_SUPPORT_DETAIL_KEYS = [
  ...MMG_CHECKOUT_SUPPORT_ROW_KEYS.filter((key) => key !== 'matchedBy'),
  'timeline', 'timelineTruncated', 'creditedPeriod',
] as const;
