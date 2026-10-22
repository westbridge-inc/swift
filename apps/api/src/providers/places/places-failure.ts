// ---------------------------------------------------------------------------
// [PLACES-LOUD 22 Oct 2026] An address-search provider FAILURE, told apart from
// "no matches".
//
// GooglePlacesProvider used to turn every failure (a refused, restricted or
// unbilled key, an API not enabled, quota, a timeout, a network error, an
// unreadable answer) into an empty list or null. The apps showed that as "No
// matches", so a broken key looked like a quiet day and nobody at Swift could
// know. A failure is now a PlacesProviderError carrying a bounded class and
// Google's own status words; the route turns it into an honest 503, a log
// line, a metric and, when it persists, a page (places-health.ts).
//
// What a failure record may carry: the class, the HTTP status, and Google's
// status / ErrorInfo reason ONLY when each is a plain upper-case token. Never
// Google's free-text message (it can quote a project, an address or the key),
// never the key, never the caller's query.
// ---------------------------------------------------------------------------

export type PlacesOp = 'autocomplete' | 'details' | 'reverse';

/**
 * auth         the key was refused: invalid, restricted (app/referrer/IP/API),
 *              the API not enabled, billing off (401/403, API_KEY_*, ...)
 * quota        over a rate or daily quota (429, RESOURCE_EXHAUSTED, OVER_QUERY_LIMIT)
 * rejected     Google refused the request itself (another 4xx, INVALID_ARGUMENT)
 * upstream     Google failed (5xx, UNAVAILABLE, UNKNOWN_ERROR)
 * timeout      no answer within the provider's timeout
 * network      the request never got an HTTP answer
 * bad_response an answer that is not the documented shape
 */
export type PlacesFailureReason = 'auth' | 'quota' | 'rejected' | 'upstream' | 'timeout' | 'network' | 'bad_response';

export interface PlacesFailure {
  reason: PlacesFailureReason;
  /** The HTTP status Google answered with, when it answered. */
  httpStatus?: number;
  /** Google's status word: Places (New) `error.status`, or the Geocoding API `status`. */
  googleStatus?: string;
  /** The google.rpc.ErrorInfo `reason` (API_KEY_INVALID, SERVICE_DISABLED, ...). */
  googleReason?: string;
}

/** A provider could not answer. The message is fixed text: no key, no query, no Google wording. */
export class PlacesProviderError extends Error {
  constructor(public readonly failure: PlacesFailure) {
    super(`Places provider failure: ${failure.reason}`);
    this.name = 'PlacesProviderError';
  }
}

/** What the apps receive (HTTP 503) when the provider fails. Builds 9-12 already show their own
 *  error / "set it on the map" state for any failed search; a later build can show this text. */
export const PLACES_UNAVAILABLE_CODE = 'PLACES_UNAVAILABLE';
export const PLACES_UNAVAILABLE_MESSAGE = "Address search isn't working right now. Set the place on the map.";

const STATUS_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/;

/** A Google status word or ErrorInfo reason, only when it is a plain token. */
function token(value: unknown): string | undefined {
  return typeof value === 'string' && STATUS_TOKEN.test(value) ? value : undefined;
}

const AUTH_STATUSES = new Set(['UNAUTHENTICATED', 'PERMISSION_DENIED']);
const QUOTA_STATUSES = new Set(['RESOURCE_EXHAUSTED']);
const UPSTREAM_STATUSES = new Set(['UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED', 'UNKNOWN', 'DATA_LOSS']);
const AUTH_REASONS = new Set([
  'SERVICE_DISABLED', 'BILLING_DISABLED', 'ACCESS_TOKEN_TYPE_UNSUPPORTED', 'CONSUMER_INVALID', 'CONSUMER_SUSPENDED',
  'PROJECT_DENIED', 'ACCOUNT_STATE_INVALID', 'IP_ADDRESS_BLOCKED', 'REFERRER_BLOCKED', 'CLIENT_APP_BLOCKED',
]);
const QUOTA_REASONS = new Set(['RATE_LIMIT_EXCEEDED', 'RESOURCE_QUOTA_EXCEEDED']);

function reasonFor(httpStatus: number, googleStatus?: string, googleReason?: string): PlacesFailureReason {
  if (googleReason) {
    if (googleReason.startsWith('API_KEY_') || AUTH_REASONS.has(googleReason)) return 'auth';
    if (QUOTA_REASONS.has(googleReason)) return 'quota';
  }
  if (googleStatus) {
    if (AUTH_STATUSES.has(googleStatus)) return 'auth';
    if (QUOTA_STATUSES.has(googleStatus)) return 'quota';
    if (UPSTREAM_STATUSES.has(googleStatus)) return 'upstream';
  }
  if (httpStatus === 401 || httpStatus === 403) return 'auth';
  if (httpStatus === 429) return 'quota';
  if (httpStatus >= 500) return 'upstream';
  if (httpStatus >= 400) return 'rejected';
  // A 2xx carrying a google.rpc.Status: a known status word that is none of the above is
  // Google refusing the request; anything else is an answer we cannot read.
  return googleStatus ? 'rejected' : 'bad_response';
}

/**
 * Classify a Google API answer that is a failure: a non-2xx, or a 2xx whose body is a
 * google.rpc.Status (`{ error: { code, status, message, details: [ErrorInfo] } }`).
 * `body` is the parsed JSON when there was any.
 */
export function classifyGoogleApiFailure(httpStatus: number, body: unknown): PlacesFailure {
  const error = body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  let googleStatus: string | undefined;
  let googleReason: string | undefined;
  if (error !== null && typeof error === 'object') {
    googleStatus = token((error as { status?: unknown }).status);
    const details = (error as { details?: unknown }).details;
    if (Array.isArray(details)) {
      for (const d of details) {
        if (d === null || typeof d !== 'object') continue;
        const type = (d as { '@type'?: unknown })['@type'];
        if (typeof type === 'string' && type.endsWith('google.rpc.ErrorInfo')) {
          googleReason = token((d as { reason?: unknown }).reason);
          if (googleReason) break;
        }
      }
    }
  }
  const failure: PlacesFailure = { reason: reasonFor(httpStatus, googleStatus, googleReason), httpStatus };
  if (googleStatus) failure.googleStatus = googleStatus;
  if (googleReason) failure.googleReason = googleReason;
  return failure;
}

/** The Geocoding API (JSON) reports in `status`: OK and ZERO_RESULTS are answers; the rest fail. */
export function classifyGeocodeStatus(httpStatus: number, status: unknown): PlacesFailure {
  const googleStatus = token(status);
  let reason: PlacesFailureReason;
  switch (googleStatus) {
    case 'REQUEST_DENIED':
    // OVER_DAILY_LIMIT is Google's word for a missing/invalid key, billing off, an exhausted
    // self-imposed cap or a lapsed payment method: an account problem, not a burst.
    case 'OVER_DAILY_LIMIT':
      reason = 'auth';
      break;
    case 'OVER_QUERY_LIMIT':
      reason = 'quota';
      break;
    case 'INVALID_REQUEST':
      reason = 'rejected';
      break;
    case 'UNKNOWN_ERROR':
      reason = 'upstream';
      break;
    default:
      reason = 'bad_response';
  }
  return googleStatus ? { reason, httpStatus, googleStatus } : { reason, httpStatus };
}

/** "auth (HTTP 403, PERMISSION_DENIED, API_KEY_SERVICE_BLOCKED)": the class and the status words only. */
export function describePlacesFailure(f: PlacesFailure): string {
  const parts = [
    ...(f.httpStatus !== undefined ? [`HTTP ${f.httpStatus}`] : []),
    ...(f.googleStatus ? [f.googleStatus] : []),
    ...(f.googleReason ? [f.googleReason] : []),
  ];
  return parts.length > 0 ? `${f.reason} (${parts.join(', ')})` : f.reason;
}
