import { placesCallsCounter } from '../../plugins/observability';
import { describePlacesFailure, PlacesProviderError, type PlacesFailure, type PlacesOp } from './places-failure';

// ---------------------------------------------------------------------------
// [PLACES-LOUD 22 Oct 2026] Address-search health: what /ready reports, and
// when a failing provider pages ops.
//
// Passive by design. The status is the outcome of the LAST real call this
// process made; /ready reads it from memory and never calls Google (a probe on
// every /ready hit would bill the owner's key for a load-balancer poll). The
// launch smoke (places-smoke.ts) is the active check, run once at deploy.
//
// Only PROVIDER-side failures count (auth, quota, upstream, timeout, network,
// bad_response). A 'rejected' request (Google refused that caller's own input)
// is the caller's "no matches": it is counted and logged at warn, but it never
// changes the status, never counts toward a page and never pages, so nobody
// can page ops or flip /ready by sending malformed searches.
//
// Paging: PLACES_ALERT_FAILURES failures inside PLACES_ALERT_WINDOW_MS (answers
// in between do not hide an intermittent failure) from at least
// PLACES_ALERT_MIN_CALLERS different callers (one account alone, say one that
// burned the quota itself, never pages) open ONE platform page
// through the durable ops path (ops-page.ts: an OpsAlert row, push + on-call
// SMS, ACK deadline, escalation; one open page per title; a delivered page
// holds its Redis key for PLACES_PAGE_WINDOW_SECONDS). This process retries a
// page no sooner than PLACES_PAGE_RETRY_MS apart (a page nobody received stays
// retryable). The open page closes once an answer arrives and the window no
// longer holds the threshold: the condition cleared.
// ---------------------------------------------------------------------------

export const PLACES_ALERT_FAILURES = 5;
export const PLACES_ALERT_MIN_CALLERS = 2;
export const PLACES_ALERT_WINDOW_MS = 10 * 60_000;
/** The most callers remembered (each by its last failure time); the oldest is forgotten first. */
const PLACES_CALLERS_TRACKED = 16;
export const PLACES_PAGE_RETRY_MS = 5 * 60_000;
export const PLACES_PAGE_WINDOW_SECONDS = 3600;
export const PLACES_PAGE_TITLE = 'Address search is failing';
export const PLACES_PAGE_KEY = 'ops_page:places-failing';

export type PlacesStatus = 'unknown' | 'ok' | 'failing';

/** The public /ready field: fixed words and a time, never a failure detail. */
export interface PlacesReadiness {
  provider: string;
  status: PlacesStatus;
  /** When the current status began (the first call of the current ok / failing streak). */
  since: string | null;
}

/** The token-gated /health detail: the last failure's class and Google status words. */
export interface PlacesHealthDetail extends PlacesReadiness {
  lastOkAt: string | null;
  lastFailureAt: string | null;
  lastFailure: (PlacesFailure & { op: PlacesOp }) | null;
  failuresInWindow: number;
  /** How many different callers failed inside the window: a count, never who. */
  callersInWindow: number;
  alertThreshold: { failures: number; callers: number; windowMinutes: number };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Google refused the caller's own request: the caller's problem, never the provider's health. */
export function isCallerCaused(failure: PlacesFailure): boolean {
  return failure.reason === 'rejected';
}

export class PlacesHealth {
  private status: PlacesStatus = 'unknown';
  private since: number | null = null;
  private lastOkAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailure: (PlacesFailure & { op: PlacesOp }) | null = null;
  /** The most recent failure times, at most PLACES_ALERT_FAILURES of them (bounded memory). */
  private recent: number[] = [];
  /** Caller -> its last failure time, at most PLACES_CALLERS_TRACKED of them. In memory only, never reported. */
  private callers = new Map<string, number>();
  private lastPageAttemptAt: number | null = null;
  private pageOpen = false;

  constructor(private readonly now: () => number = Date.now) {}

  private inWindow(t: number): number {
    return this.recent.filter((x) => t - x < PLACES_ALERT_WINDOW_MS).length;
  }

  private callersInWindow(t: number): number {
    let n = 0;
    for (const at of this.callers.values()) if (t - at < PLACES_ALERT_WINDOW_MS) n += 1;
    return n;
  }

  /** The page condition: enough provider failures, from enough different callers, inside the window. */
  private thresholdHeld(t: number): boolean {
    return this.inWindow(t) >= PLACES_ALERT_FAILURES && this.callersInWindow(t) >= PLACES_ALERT_MIN_CALLERS;
  }

  /** The provider answered (with results or with none). `resolve`: close the open page now. */
  recordOk(): { resolve: boolean } {
    const t = this.now();
    if (this.status !== 'ok') {
      this.status = 'ok';
      this.since = t;
    }
    this.lastOkAt = t;
    if (this.pageOpen && !this.thresholdHeld(t)) {
      this.pageOpen = false;
      this.lastPageAttemptAt = null;
      return { resolve: true };
    }
    return { resolve: false };
  }

  /** The provider failed for `caller`. `page`: the threshold is crossed and a page attempt is due now.
   *  A caller-caused rejection is ignored here (defence in depth: the route never sends one). */
  recordFailure(op: PlacesOp, failure: PlacesFailure, caller: string): { page: boolean; failuresInWindow: number } {
    const t = this.now();
    if (isCallerCaused(failure)) return { page: false, failuresInWindow: this.inWindow(t) };
    if (this.status !== 'failing') {
      this.status = 'failing';
      this.since = t;
    }
    this.lastFailureAt = t;
    this.lastFailure = { op, ...failure };
    this.recent.push(t);
    if (this.recent.length > PLACES_ALERT_FAILURES) this.recent.shift();
    this.callers.delete(caller);
    this.callers.set(caller, t); // re-inserted: the Map's first key is the longest-quiet caller
    if (this.callers.size > PLACES_CALLERS_TRACKED) this.callers.delete(this.callers.keys().next().value as string);
    const failuresInWindow = this.inWindow(t);
    const due = this.thresholdHeld(t)
      && (this.lastPageAttemptAt === null || t - this.lastPageAttemptAt >= PLACES_PAGE_RETRY_MS);
    if (due) {
      this.lastPageAttemptAt = t;
      this.pageOpen = true;
    }
    return { page: due, failuresInWindow };
  }

  readiness(provider: string): PlacesReadiness {
    return { provider, status: this.status, since: iso(this.since) };
  }

  detail(provider: string): PlacesHealthDetail {
    return {
      ...this.readiness(provider),
      lastOkAt: iso(this.lastOkAt),
      lastFailureAt: iso(this.lastFailureAt),
      lastFailure: this.lastFailure,
      failuresInWindow: this.inWindow(this.now()),
      callersInWindow: this.callersInWindow(this.now()),
      alertThreshold: {
        failures: PLACES_ALERT_FAILURES,
        callers: PLACES_ALERT_MIN_CALLERS,
        windowMinutes: PLACES_ALERT_WINDOW_MS / 60_000,
      },
    };
  }
}

/** One tracker per process, shared by the places routes and the readiness/health wiring. */
let shared: PlacesHealth | undefined;
export function getPlacesHealth(): PlacesHealth {
  return (shared ??= new PlacesHealth());
}
export function resetPlacesHealthForTests(): void {
  shared = undefined;
}

const KNOWN_PROVIDERS = ['local', 'osm', 'google'];
/** The configured provider's name, for reports and metric labels: a known name or 'unknown', never the raw value. */
export function placesProviderName(env: Record<string, string | undefined> = process.env): string {
  const configured = env['PLACES_PROVIDER'] ?? 'local';
  return KNOWN_PROVIDERS.includes(configured) ? configured : 'unknown';
}

export interface PlacesPageInput {
  key: string;
  windowSeconds: number;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

/** The durable ops page and its resolution (ops-page.ts in production; a stub in tests). */
export interface PlacesPager {
  page(input: PlacesPageInput): Promise<unknown>;
  resolve(): Promise<unknown>;
}

export type PlacesCallResult<T> = { ok: true; value: T } | { ok: false; failure: PlacesFailure };

export interface PlacesObserver {
  provider: string;
  /** Who is calling (the authenticated user id): kept in memory to count distinct callers, never logged or paged. */
  caller: string;
  health: PlacesHealth;
  pager: PlacesPager;
  log: { error: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

function pageInput(provider: string, op: PlacesOp, failure: PlacesFailure, failures: number): PlacesPageInput {
  const minutes = PLACES_ALERT_WINDOW_MS / 60_000;
  return {
    key: PLACES_PAGE_KEY,
    windowSeconds: PLACES_PAGE_WINDOW_SECONDS,
    title: PLACES_PAGE_TITLE,
    body: `Address search (${provider}) failed ${failures} times in ${minutes} min; last: ${describePlacesFailure(failure)} on ${op}. `
      + 'Customers are told search is not working and must set places on the map. Check the server key\'s restrictions, '
      + 'the enabled APIs (Places API (New), Geocoding), quota and billing in Google Cloud, then run the places smoke '
      + '(deploy/PILOT-RUNBOOK.md, section 12).',
    data: {
      kind: 'ops_places_failing',
      provider,
      op,
      reason: failure.reason,
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure.googleStatus ? { googleStatus: failure.googleStatus } : {}),
      ...(failure.googleReason ? { googleReason: failure.googleReason } : {}),
      failures,
      windowMinutes: minutes,
    },
  };
}

/**
 * Run one provider call and make its outcome visible: count it, log a failure at
 * error level (the class, the HTTP status, Google's status words and the query's
 * LENGTH: never the query, never the key), feed the health tracker, and page or
 * resolve. A PlacesProviderError becomes `{ ok: false }` for the route to answer
 * 503; any other error (a database error from the local provider) is not an
 * address-search failure and is rethrown untouched. Paging is fire-and-caught:
 * it never slows or breaks the answer the customer gets.
 *
 * A caller-caused rejection (Google refused this caller's own input) answers
 * `empty` (the caller's "no matches"), is counted as 'rejected' and logged at
 * warn, and never touches the health tracker: it cannot page or flip /ready.
 */
export async function observePlacesCall<T>(
  ctx: PlacesObserver,
  op: PlacesOp,
  meta: { queryLength?: number },
  call: () => Promise<T>,
  isEmpty: (value: T) => boolean,
  empty: T,
): Promise<PlacesCallResult<T>> {
  let value: T;
  try {
    value = await call();
  } catch (err) {
    if (!(err instanceof PlacesProviderError)) throw err;
    const failure = err.failure;
    placesCallsCounter.labels(ctx.provider, op, failure.reason).inc();
    if (isCallerCaused(failure)) {
      ctx.log.warn({ places: { provider: ctx.provider, op, ...failure, ...meta } }, 'places request rejected');
      return { ok: true, value: empty };
    }
    ctx.log.error({ places: { provider: ctx.provider, op, ...failure, ...meta } }, 'places provider failure');
    const { page, failuresInWindow } = ctx.health.recordFailure(op, failure, ctx.caller);
    if (page) {
      void Promise.resolve()
        .then(() => ctx.pager.page(pageInput(ctx.provider, op, failure, failuresInWindow)))
        .catch(() => undefined);
    }
    return { ok: false, failure };
  }
  placesCallsCounter.labels(ctx.provider, op, isEmpty(value) ? 'no_results' : 'ok').inc();
  if (ctx.health.recordOk().resolve) {
    void Promise.resolve().then(() => ctx.pager.resolve()).catch(() => undefined);
  }
  return { ok: true, value };
}
