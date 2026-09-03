import type { FastifyInstance } from 'fastify';
import client from 'prom-client';
import * as Sentry from '@sentry/node';
import { AppError } from '../utils/errors';
import { runtimeMode } from '../utils/runtime-mode';

// ---------------------------------------------------------------------------
// Observability — both halves are env-gated and cost nothing when unset:
//   SENTRY_DSN     → error tracking (5xx + worker failures)
//   METRICS_TOKEN  → GET /metrics (Prometheus) behind a bearer token; without
//                    the env the endpoint 404s, so the public API never
//                    exposes internals by default.
// ---------------------------------------------------------------------------

let sentryReady = false;

/** Idempotent Sentry init. MUST be called in EVERY process entrypoint that can
 *  throw — the API server (via observabilityPlugin) AND the worker process
 *  (worker.ts main). captureError is a silent no-op until this runs, so a
 *  process that skips it reports nothing [SWIFT-042]. */
// [REPORT-013 F-013-04] Errors carry CONTEXT, never identifiers: tokenized
// public URLs (/track/:token, /public/trip/:token), querystrings, headers,
// cookies, and body data must not reach the error tracker. Every outgoing
// event passes through this scrubber; capture sites additionally pass route
// TEMPLATES instead of raw URLs.
const TOKENISH_PARAM = /\b(token|secret|key|authorization|otp|pin|code|sig|signature)=[^&\s]+/gi;
const TOKENISH_PATH = /\/(track|public\/trip|render)\/[A-Za-z0-9_.-]+/g;
function scrubSentryText(value: string): string {
  let out = value.replace(TOKENISH_PARAM, '$1=[scrubbed]').replace(TOKENISH_PATH, '/$1/[scrubbed]');
  // [REPORT-016 F-016-02] Any URL's query string can carry arbitrary user
  // input (a raw search term, an address) that the named-param rule above
  // won't catch — and the Sentry SDK's default RequestData integration
  // repopulates request.url. Drop every query string wholesale.
  out = out.replace(/(https?:\/\/[^\s"'<>]*?|\/[^\s"'<>?]*)\?[^\s"'<>]*/g, '$1?[scrubbed]');
  return out;
}
// [REPORT-016 F-016-02] Deep-walk the WHOLE event: the old scrubber only
// touched request.url, top-level extras, and breadcrumb message/url — it left
// `message`, `exception.values[].value`, nested extras, and other breadcrumb
// data unscrubbed. Every string in the event (bounded depth, cycle-guarded)
// now passes the scrubber.
function scrubDeep(node: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof node === 'string') return scrubSentryText(node);
  if (node === null || typeof node !== 'object' || depth <= 0) return node;
  if (seen.has(node as object)) return node;
  seen.add(node as object);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) node[i] = scrubDeep(node[i], depth - 1, seen);
    return node;
  }
  const rec = node as Record<string, unknown>;
  for (const key of Object.keys(rec)) rec[key] = scrubDeep(rec[key], depth - 1, seen);
  return rec;
}
export function scrubSentryEvent<T extends {
  request?: { url?: string; query_string?: unknown; headers?: unknown; cookies?: unknown; data?: unknown };
}>(event: T): T {
  if (event.request) {
    // Structural drops first — these fields are pure identifier surface.
    delete event.request.query_string;
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.data;
  }
  return scrubDeep(event, 8, new WeakSet()) as T;
}

export function initSentry() {
  const dsn = process.env['SENTRY_DSN'];
  if (!dsn || sentryReady) return sentryReady;
  Sentry.init({
    dsn,
    environment: runtimeMode(), // [TA-S1-007] the parsed mode — never a quiet 'development' label on a live host
    // Errors only for V1 — tracing multiplies cost without a consumer yet.
    tracesSampleRate: 0,
    beforeSend: (event) => scrubSentryEvent(event),
  });
  sentryReady = true;
  return true;
}

/** Test hook: clear the one-time init latch so a test can re-exercise it. */
export function resetSentryForTests() {
  sentryReady = false;
}

/** Report to Sentry when configured; always safe to call. */
export function captureError(err: unknown, context?: Record<string, unknown>) {
  if (!sentryReady) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

const registry = new client.Registry();
let metricsWired = false;

const httpDuration = new client.Histogram({
  name: 'swift_http_request_duration_seconds',
  help: 'HTTP request duration by route/method/status',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const ordersPlacedCounter = new client.Counter({
  name: 'swift_orders_placed_total',
  help: 'Orders placed, by type',
  labelNames: ['orderType'] as const,
  registers: [registry],
});

// Dispatch search lifecycle (availability spec §6) — incremented beside the
// §3 journal writes. Exhaustion RATE is a PromQL division of these counters.
export const dispatchSearchesCounter = new client.Counter({
  name: 'swift_dispatch_searches_total',
  help: 'Dispatch searches by lifecycle outcome (started/assigned/exhausted/cancelled)',
  labelNames: ['status'] as const,
  registers: [registry],
});

/** [R048-007] Money-surface authority transitions and refusals: staged, stage_replay, cancelled, cleared, applied,
 *  apply_lease_missed, refused_authority_moved, refused_no_decision, refused_step_up, refused_control_unavailable,
 *  notice_sent, notice_retry, notice_sweep. */
/** [A-01 / W-01] Browser (cookie-mode) sessions: cookie_issued, cookie_refreshed, cookie_auth, cookie_cleared,
 *  cookie_rejected_header (a cookie without the client header), cookie_rejected_origin (a cookie from an origin
 *  outside the CORS allowlist), body_tokens_refused. */
export const browserSessionCounter = new client.Counter({
  name: 'swift_browser_session_total',
  help: 'Browser cookie-session events (cookie_issued/cookie_refreshed/cookie_auth/cookie_cleared/cookie_rejected_header/cookie_rejected_origin)',
  labelNames: ['event'] as const,
  registers: [registry],
});

export const moneySurfaceCounter = new client.Counter({
  name: 'swift_money_surface_total',
  help: 'Money-surface authority transitions and refusals by event',
  labelNames: ['event'] as const,
  registers: [registry],
});
/** [R048-007] Velocity verdicts: allowed, limited, fail_open (non-money surface, Redis down), fail_closed (money surface, Redis down). */
export const velocityCounter = new client.Counter({
  name: 'swift_velocity_total',
  help: 'Velocity control outcomes (allowed/limited/fail_open/fail_closed)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
/** [R048-007] Signup identity capture, awaited: captured or failed. */
export const integrityCaptureCounter = new client.Counter({
  name: 'swift_integrity_capture_total',
  help: 'Signup identity capture outcomes (captured/failed)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** [R048-006] Readiness by dependency (1 ready / 0 not) after the last /ready evaluation. */
export const readinessGauge = new client.Gauge({
  name: 'swift_readiness_dependency',
  help: 'Readiness by dependency after the last /ready evaluation (1 ready, 0 not ready)',
  labelNames: ['dependency'] as const,
  registers: [registry],
});
/** [R048-006] Every 503 readiness answer, by the dependency that failed it. */
export const readyReasonCounter = new client.Counter({
  name: 'swift_ready_refused_total',
  help: 'Readiness refusals (503) by failing dependency',
  labelNames: ['reason'] as const,
  registers: [registry],
});
/** [R048-006] Requests served while the last readiness evaluation said NOT ready (the load balancer kept routing). */
export const routedWhileDegradedCounter = new client.Counter({
  name: 'swift_routed_while_degraded_total',
  help: 'Requests answered while the last readiness evaluation was not ready',
  labelNames: ['family'] as const,
  registers: [registry],
});
/** [R048-006] Platform page outcomes: delivered, zero_recipient_pending, already_open, deduped, resolved, failed. */
export const opsPageCounter = new client.Counter({
  name: 'swift_ops_page_total',
  help: 'Platform page outcomes (delivered/zero_recipient_pending/already_open/deduped/resolved/failed)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** [R048-005] Seed-plan outcomes: applied, noop (nothing to change), refused_drift, refused_target,
 *  refused_tampered, refused_config_mismatch, promotion_bootstrap, promotion_break_glass, promotion_refused,
 *  demo_seed_refused. */
export const seedPlanCounter = new client.Counter({
  name: 'swift_seed_plan_total',
  help: 'Versioned configuration seed plan outcomes (applied/noop/refused_*/promotion_*/demo_seed_refused)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** [R048-004] Chat secret protection by surface: redactions (send/socket/push/history/list/create/preview),
 *  legacy media hidden, a stale participant refused, a write to a closed room refused, a media upload
 *  rejected, a leaked ride PIN rotated, stale participant rows removed by reconcile. */
export const chatGuardCounter = new client.Counter({
  name: 'swift_chat_guard_total',
  help: 'Chat secret-guard outcomes by surface (redacted/legacy_media_hidden/stale_participant_refused/inactive_room_write_refused/media_rejected/ride_pin_rotated/stale_participant_removed/tenant_mismatch)',
  labelNames: ['surface', 'outcome'] as const,
  registers: [registry],
});

/** [R048-003] Public market / search scope outcomes: an unbound search refused, the public
 *  tenant unresolved, a disabled tenant hit, a cross-tenant page cursor refused, a filter value
 *  rejected, stale index documents removed by a reconcile, and a DB/index parity mismatch. */
export const searchScopeCounter = new client.Counter({
  name: 'swift_search_scope_total',
  help: 'Market/search scope outcomes (unbound_request_refused/public_tenant_unresolved/disabled_tenant_hit/cross_tenant_cursor/filter_rejected/stale_docs_removed/parity_mismatch)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
/** [R048-003] Index document counts by index and tenant, set on every full sync. */
export const searchIndexDocsGauge = new client.Gauge({
  name: 'swift_search_index_docs',
  help: 'Search index documents by index and tenant after the last full sync',
  labelNames: ['index', 'tenant'] as const,
  registers: [registry],
});

// [R048-002] A rating report whose legs do not resolve to one tenant — the
// rating outside the reporter's tenant at filing, a report the moderation
// queue cannot resolve, a foreign or malformed id at resolution — is refused
// or quarantined, and counted.
export const ratingReportTenancyCounter = new client.Counter({
  name: 'swift_rating_report_tenancy_total',
  help: 'Rating-report tenancy outcomes (report_refused_foreign_rating/quarantined_in_queue/resolve_refused/resolve_race)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

// [MOB-023] The door refused a hand-over: by the authority's block reason
// (rail_state), or because the screen acted on a stale authority version.
export const handoverBlockCounter = new client.Counter({
  name: 'swift_handover_block_total',
  help: 'Hand-overs refused at the door, by reason (MOBILE_MONEY_PENDING, MOBILE_MONEY_UNKNOWN, …, STALE_VERSION)',
  labelNames: ['reason'] as const,
  registers: [registry],
});

// [MOB-020] The checkout command key, by what the server did with it: a
// replay answered from the receipt or the cache, a key reused under another
// body refused, a concurrent twin refused, and the client's receipt probe.
export const checkoutIdempotencyCounter = new client.Counter({
  name: 'swift_checkout_idempotency_total',
  help: 'Checkout Idempotency-Key outcomes (replayed_receipt/replayed_cache/key_body_conflict/duplicate_in_flight/probe_placed/probe_in_flight/probe_none)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

// [MOB-018] How the public emergency-policy route answered: served, no-policy,
// invalid (a malformed stored policy is never served), unknown-market.
export const emergencyPolicyCounter = new client.Counter({
  name: 'swift_emergency_policy_total',
  help: 'GET /public/emergency-policy answers by outcome (served/no-policy/invalid/unknown-market)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

// [MOB-010] A vendor store header (x-vendor-id) received outside the vendor
// endpoint family is a client leak: counted per family, ignored or rejected.
export const unexpectedTenantHeaderCounter = new client.Counter({
  name: 'swift_unexpected_tenant_header_total',
  help: 'x-vendor-id received outside /api/v1/vendor, by outcome (ignored/rejected) and endpoint family',
  labelNames: ['outcome', 'family'] as const,
  registers: [registry],
});

export const dispatchTimeToAssign = new client.Histogram({
  name: 'swift_dispatch_time_to_assign_seconds',
  help: 'Seconds from search start to a mover claiming the job',
  buckets: [5, 15, 30, 60, 120, 300, 600, 1200],
  registers: [registry],
});

// OSRM routing outcome [SWIFT-UG-ETA-01]: when OSRM is configured but a call
// times out / errors / returns no route, the provider silently degrades to
// the haversine estimate — dispatch and fares carry on, so the degradation is
// otherwise invisible. The fallback RATE (fallback / (ok+fallback), by op) is
// the "is OSRM actually up?" signal. Labels: op = eta|route, outcome = ok|fallback.
export const osrmOutcomeCounter = new client.Counter({
  name: 'swift_osrm_calls_total',
  help: 'OSRM routing calls by operation and outcome (ok vs haversine fallback)',
  labelNames: ['op', 'outcome'] as const,
  registers: [registry],
});

// Notification delivery failures [SWIFT-100]: channel sends fail-soft (they must
// never break the request path), but a SILENT failure of the last-resort rung
// means a vendor/ops nudge vanished with no trace. Count every post-retry
// failure so the rate is visible. Labels: channel = sms|push, stage =
// escalation (vendor-alert ladder) | direct (OTP/fallback) | send (fan-out).
export const notificationFailuresCounter = new client.Counter({
  name: 'swift_notification_failures_total',
  help: 'Notification deliveries that failed after retries, by channel and stage',
  labelNames: ['channel', 'stage'] as const,
  registers: [registry],
});

/** [M-04] Terminal MMG payments (FAILED/EXPIRED) whose subscription carries no
 *  recorded outcome for that period — the state a crash between the terminal
 *  CAS and the dunning application used to leave behind. Set by the repair
 *  pass on every poll tick; the alert is on it staying above zero. */
export const billingTerminalWithoutOutcomeGauge = new client.Gauge({
  name: 'swift_billing_terminal_without_outcome',
  help: 'Terminal MMG weekly-fee payments with no recorded dunning outcome (count) and the oldest such gap in minutes',
  labelNames: ['measure'] as const,
  registers: [registry],
});

export const billingOutcomeRepairsCounter = new client.Counter({
  name: 'swift_billing_outcome_repairs_total',
  help: 'Dunning outcomes applied by the M-04 repair pass to terminal payments that had none',
  registers: [registry],
});

/** [DB-028] Stale weekly-charge attempts: an attempt event that committed and
 *  whose run then died before recording ANY outcome or reserving ANY provider
 *  intent. `reclaimed` is a run taking such an attempt forward; `lost_race` is
 *  a second reclaimer fenced off it; `blocked_intent` is one correctly left
 *  alone because the provider already holds a live request. A rising
 *  `reclaimed` means the biller is crashing mid-attempt. */
export const billingAttemptReclaimCounter = new client.Counter({
  name: 'swift_billing_attempt_reclaim_total',
  help: 'Stale CHARGE_ATTEMPT outcomes (reclaimed/lost_race/blocked_intent)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** [M-10] Terminal orders whose expected earnings tuples — the mover's fee or
 *  fare row, and the tip row when a tip was paid — are not all present. Set by
 *  the reconciler on every sweep: `found` before the repair, `unhealed` after
 *  it (equal to `found` in a dry run), and the oldest gap's age. The alert is
 *  on `unhealed` staying above zero. */
export const earningsMissingTuplesGauge = new client.Gauge({
  name: 'swift_earnings_missing_tuples',
  help: 'Terminal orders with a missing expected earnings tuple: found by the sweep, left unhealed, and the oldest gap in minutes',
  labelNames: ['measure'] as const,
  registers: [registry],
});

export const earningsRepairsCounter = new client.Counter({
  name: 'swift_earnings_repairs_total',
  help: 'Earnings tuples inserted by the M-10 reconciler that a completion path had missed, by earning type',
  labelNames: ['type'] as const,
  registers: [registry],
});

/** [M-08] A top-up attempted without an Idempotency-Key (refused: the client
 *  must retry with a key) and a key reused under a different request body
 *  (refused: a new top-up needs a new key). Both are alerts on the console. */
export const billingTopupMissingKeyCounter = new client.Counter({
  name: 'swift_billing_topup_missing_key_total',
  help: 'Prepaid top-up attempts refused for lack of an Idempotency-Key',
  registers: [registry],
});
/** [A-12] A top-up refused because its PROVIDER TRANSACTION reference had
 *  already been credited. Distinct from the fingerprint counter below, which
 *  counts an idempotency key reused for a different request: this one counts a
 *  second attempt to credit one real-world transfer. A rising number is either
 *  a reconciliation gap or an operator crediting from a stale list. */
export const billingTopupDuplicateReferenceCounter = new client.Counter({
  name: 'swift_billing_topup_duplicate_reference_total',
  help: 'Top-ups refused because the provider transaction reference was already credited',
  registers: [registry],
});

export const billingTopupDuplicateFingerprintCounter = new client.Counter({
  name: 'swift_billing_topup_duplicate_fingerprint_total',
  help: 'Prepaid top-up attempts refused because the key was reused for a different request',
  registers: [registry],
});
/** [M-08] Top-up commands whose downstream tail (payer notice, immediate
 *  re-bill) has not completed — retried by the billing poll; alert on it
 *  staying above zero. */
export const billingTopupTailsPendingGauge = new client.Gauge({
  name: 'swift_billing_topup_tails_pending',
  help: 'Committed prepaid top-ups whose notice / re-bill tail is still pending',
  registers: [registry],
});
/** [M-08 · operations] Historical unkeyed top-ups that look like the same
 *  payment recorded twice (same subscription, amount and reference within a
 *  day, time-based keys) — for human review against the provider reference. */
export const billingUnkeyedTopupDuplicatesGauge = new client.Gauge({
  name: 'swift_billing_unkeyed_topup_duplicates',
  help: 'Groups of historical unkeyed top-ups with the same subscription, amount and reference within a day',
  registers: [registry],
});

/** [M-20] Settlement files rejected before any row could publish, by the first
 *  reason; and published batches whose credited money disagrees with the
 *  file's own total (a page for a person). */
export const settlementImportsRejectedCounter = new client.Counter({
  name: 'swift_settlement_imports_rejected_total',
  help: 'Settlement files staged and rejected before publication, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});
export const settlementBatchesUnbalancedGauge = new client.Gauge({
  name: 'swift_settlement_batches_unbalanced',
  help: 'Published settlement imports whose credited total disagrees with the validated file total, or rejected imports with a credited row',
  labelNames: ['kind'] as const,
  registers: [registry],
});

/** [M-27] Sales digests whose latest row no longer matches a recompute from the
 *  ledger — periods to adjust. Set by the weekly digest job. */
export const salesDigestDeltaGauge = new client.Gauge({
  name: 'swift_sales_digest_delta',
  help: 'Recent vendor sales digests whose stored totals differ from the ledger',
  registers: [registry],
});

/** [M-22] Bank reconciliation refusals: a batch from another tenant, a second
 *  confirmation of a confirmed batch, a bank reference used before, and the
 *  read-only hold. Each is a page for a person. */
export const bankReconRefusalsCounter = new client.Counter({
  name: 'swift_bank_recon_refusals_total',
  help: 'Deposit confirmations refused: foreign batch, reconfirmation, reused bank reference, read-only hold',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/** [M-15] Grandfathered payers held past their tenant's sunset because a
 *  T−30 / T−7 notice has no delivery proof — pinned until it does. */
export const usdMigrationHeldGauge = new client.Gauge({
  name: 'swift_usd_migration_held_payers',
  help: 'Grandfathered payers past sunset held at their old rate for missing notice proof',
  registers: [registry],
});
export const usdMigrationFlipsCounter = new client.Counter({
  name: 'swift_usd_migration_flips_total',
  help: 'Mode B payers released to the USD book at sunset, and rolled back from the snapshot',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** [M-14] FX change notices written but not yet delivered to the payer (the
 *  event is the obligation; `deliveredAt` is the proof). The charge gate
 *  refuses the new rate until the proof is FX_NOTICE_WINDOW_DAYS old. */
export const fxNoticesUndeliveredGauge = new client.Gauge({
  name: 'swift_fx_notices_undelivered',
  help: 'FX change notices not yet delivered: how many, and the oldest in hours',
  labelNames: ['measure'] as const,
  registers: [registry],
});
/** [M-14] Charges priced at the PREVIOUS rate because the new rate's notice
 *  had not been delivered in time — the payer was charged what they were told. */
export const fxChargesIneligibleCounter = new client.Counter({
  name: 'swift_fx_charges_ineligible_total',
  help: 'Charges held at the previously announced rate because the new rate had no delivered notice in time',
  registers: [registry],
});
/** [M-14 · operations] Historical charges that used a rate the payer was not
 *  told about in time — for a remediation review. */
export const fxChargesWithoutNoticeGauge = new client.Gauge({
  name: 'swift_fx_charges_without_notice',
  help: 'Successful charges in the last 30 days at a materially changed rate with no delivered notice in time',
  registers: [registry],
});

/** [M-01 / M-02] Card charge intents whose outcome the processor has not yet
 *  proven (a timeout, a transport error, a 5xx) — count and the oldest one's
 *  age. The reconciler retrieves each by its key every billing poll; the alert
 *  is on the age. */
export const cardIntentsUnknownGauge = new client.Gauge({
  name: 'swift_card_intents_unknown',
  help: 'Card charge intents in UNKNOWN: how many, and the oldest in minutes',
  labelNames: ['measure'] as const,
  registers: [registry],
});
/** [M-01] What the reconciler found for an UNKNOWN card intent: captured_late
 *  (the processor took the money and we had no local payment — the defect the
 *  register names, repaired), declined, reissued (never received; sent again
 *  under the same key), expired. */
export const cardChargesReconciledCounter = new client.Counter({
  name: 'swift_card_charges_reconciled_total',
  help: 'UNKNOWN card charge intents resolved by the reconciler, by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** [M-29] Cash rides DELIVERED with no captured fare — the manual-review set.
 *  `total` includes the rows that predate the fare outcome (legacy);
 *  `since_enforced` counts rows delivered after it became mandatory, which the
 *  terminal authority refuses — so any value above zero is a bypass, and the
 *  queue pages on it. Set by the earnings reconciler on every sweep. */
/** [M-18] Agent cash: a credit refused because the provider transaction was
 *  already credited (stage=credit: the race loser or a later attach of the
 *  unmatched original) or an observation that arrived after the credit
 *  (stage=observed: the normal second channel). The alert is on stage=credit. */
export const agentCashDuplicateCreditsCounter = new client.Counter({
  name: 'swift_agent_cash_duplicate_credit_attempts_total',
  help: 'Agent-cash observations of an already-credited provider transaction, by channel and stage',
  labelNames: ['channel', 'stage'] as const,
  registers: [registry],
});

/** [M-18] The same provider transaction id observed with a different amount or
 *  currency — never credited, suspensed for a person. */
export const agentCashProviderIdConflictsCounter = new client.Counter({
  name: 'swift_agent_cash_provider_id_conflicts_total',
  help: 'Agent-cash observations whose provider transaction id already exists with a different amount or currency',
  labelNames: ['channel'] as const,
  registers: [registry],
});

/** [M-18] Provider transactions that hold MORE than one credited observation —
 *  the historical double credits the backfill could not resolve. Set by the
 *  billing poll; reversed only after provider / human reconciliation. */
export const agentCashDuplicateCreditsGauge = new client.Gauge({
  name: 'swift_agent_cash_duplicate_credits',
  help: 'Provider transactions with more than one credited agent-cash observation (legacy double credits awaiting reconciliation)',
  registers: [registry],
});

/** [M-28] Cash courier jobs DELIVERED with no collected fee — the same census
 *  as the rides', the same page. */
export const courierDeliveredUnpaidGauge = new client.Gauge({
  name: 'swift_courier_delivered_unpaid',
  help: 'Cash courier jobs delivered with no collected fee: all of them, and those delivered after the cash outcome became mandatory',
  labelNames: ['measure'] as const,
  registers: [registry],
});

export const taxiDeliveredUnpaidGauge = new client.Gauge({
  name: 'swift_taxi_delivered_unpaid',
  help: 'Cash rides delivered with no captured fare: all of them, and those delivered after the fare outcome became mandatory',
  labelNames: ['measure'] as const,
  registers: [registry],
});

// Security actions must remain externally uniform even when their audit sink
// is degraded. Count the write failure separately so a successful revocation
// can still return the required 401/200 while operations alerts on lost audit
// evidence instead of learning through customer-visible 500s.
export const securityAuditFailuresCounter = new client.Counter({
  name: 'swift_security_audit_failures_total',
  help: 'Security audit rows that could not be persisted, by action',
  labelNames: ['action'] as const,
  registers: [registry],
});

/** [M-32] Promo funding invariants, by check: active promos with invalid
 *  terms; discounted orders with no redemption snapshot (no named funder);
 *  orders whose tip was discounted — the order checks also fenced at the
 *  enforcement date. A non-zero since-enforced value is a page. */
export const promoFundingGauge = new client.Gauge({
  name: 'swift_promo_funding',
  help: 'Promo funding invariant breaches by check (invalid_terms, discount_without_funder[_since_enforced], tip_funding_gap[_since_enforced])',
  labelNames: ['check'] as const,
  registers: [registry],
});

/** [M-33] Return requests by where their discount share came from (SNAPSHOT,
 *  INFERRED, NONE) and the promo type — an INFERRED count is the review
 *  queue. */
export const refundBasisCounter = new client.Counter({
  name: 'swift_refund_basis_total',
  help: 'Return requests by refund basis (SNAPSHOT | INFERRED | NONE) and promo type',
  labelNames: ['basis', 'promo_type'] as const,
  registers: [registry],
});
/** [M-33] The dual calculation: |snapshot amount − inferred amount| in GYD,
 *  accumulated by promo type — the refund delta the old inference produced. */
export const refundInferenceDeltaCounter = new client.Counter({
  name: 'swift_refund_inference_delta_gyd_total',
  help: 'Absolute GYD delta between the snapshot refund and the aggregate inference, by promo type',
  labelNames: ['promo_type'] as const,
  registers: [registry],
});
/** [M-33] Open returns whose refund was inferred (no snapshot) — routed to review. */
export const refundsAwaitingReviewGauge = new client.Gauge({
  name: 'swift_refunds_awaiting_review',
  help: 'Open return requests whose discount share was inferred rather than read from the order snapshot',
  registers: [registry],
});

/** [M-34] Fare-zone resolution events: an ambiguous pick (equal-priority
 *  overlap decided by the tie-break), a shadow disagreement with the legacy
 *  first-match pick per end, or the table ignored by the kill switch. */
export const fareZoneCounter = new client.Counter({
  name: 'swift_fare_zone_events_total',
  help: 'Fare-zone resolution events (ambiguous, shadow_diff_from, shadow_diff_to, killed)',
  labelNames: ['event'] as const,
  registers: [registry],
});
/** [M-34] Standing ambiguity: pairs of active zones in one market overlapping at the same priority. */
export const fareZoneGauge = new client.Gauge({
  name: 'swift_fare_zone_state',
  help: 'Fare-zone table state by check (ambiguous_pairs)',
  labelNames: ['check'] as const,
  registers: [registry],
});

/** [M-35] Pricing config validity per country and kind (invalid = 1 while
 *  the live column fails the schema and readers price from the last known
 *  good version). */
export const pricingConfigGauge = new client.Gauge({
  name: 'swift_pricing_config',
  help: 'Pricing config state by kind, country and check (invalid)',
  labelNames: ['kind', 'country', 'check'] as const,
  registers: [registry],
});
/** [M-35] Pricing events: a refused (invalid) read, a shadow disagreement
 *  with the old tolerant merge, an unsane fare refused, an outlier fare. */
export const pricingConfigCounter = new client.Counter({
  name: 'swift_pricing_events_total',
  help: 'Pricing events (refused, shadow_diff, unsane_fare, outlier) by kind or context',
  labelNames: ['event', 'kind'] as const,
  registers: [registry],
});

/** [M-36] Money crossing a unit boundary: an unregistered currency answered
 *  with the counted fallback, or a major amount that already looked
 *  minor-scaled refused at a provider adapter (a 100× error caught). */
export const moneyBoundaryCounter = new client.Counter({
  name: 'swift_money_boundary_events_total',
  help: 'Money boundary events (unknown_currency, scale_anomaly) by currency or boundary',
  labelNames: ['event', 'boundary'] as const,
  registers: [registry],
});

/** [M-38] Sales components: legacy digests still to recompute, and the
 *  shadow — digests whose old "net" (every discount subtracted) disagrees
 *  with what the vendor actually keeps. */
export const salesComponentsGauge = new client.Gauge({
  name: 'swift_sales_components',
  help: 'Sales-component state by check (legacy_digests_pending)',
  labelNames: ['check'] as const,
  registers: [registry],
});
export const salesComponentsCounter = new client.Counter({
  name: 'swift_sales_components_events_total',
  help: 'Sales-component events (shadow_diff: the legacy net disagreed with the separated net)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** [R045-ADS] Ad refund obligations: outstanding count / minor amount / oldest
 *  age, intents awaiting a human's payout, failed, and terminal paid
 *  campaigns with no intent (the backfill's population). */
export const adRefundGauge = new client.Gauge({
  name: 'swift_ad_refund',
  help: 'Ad refund obligation state by check (outstanding, outstanding_minor, outstanding_oldest_minutes, awaiting_payout, failed, terminal_without_intent)',
  labelNames: ['check'] as const,
  registers: [registry],
});
export const adRefundCounter = new client.Counter({
  name: 'swift_ad_refund_events_total',
  help: 'Ad refund events (staged, executed, credited, settled, dead_letter)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** [R045-ADS-04 · 05] The ad checkout aggregate: a duplicate active invoice
 *  refused, a provider reference reused, a payment that arrived after the
 *  hold expired (late capture). */
export const adCheckoutCounter = new client.Counter({
  name: 'swift_ad_checkout_events_total',
  help: 'Ad checkout events (duplicate_invoice_refused, provider_ref_reused, late_capture)',
  labelNames: ['event'] as const,
  registers: [registry],
});
/** [R045-ADS-05 · operations] Paid campaigns with no confirmed inventory, and campaigns with more than one active invoice. */
export const adCheckoutGauge = new client.Gauge({
  name: 'swift_ad_checkout_state',
  help: 'Ad checkout state by check (paid_without_inventory, duplicate_active_invoices)',
  labelNames: ['check'] as const,
  registers: [registry],
});

/** [S-01] The SOS escalation outbox: ACTIVE alerts whose ops page is still
 *  undelivered (and the oldest such age), pending / failed rows, live alerts
 *  with no rows at all. */
export const sosEscalationGauge = new client.Gauge({
  name: 'swift_sos_escalation',
  help: 'SOS escalation state by check (active_without_page, active_without_page_oldest_seconds, pending, failed, live_without_rows)',
  labelNames: ['check'] as const,
  registers: [registry],
});
export const sosEscalationCounter = new client.Counter({
  name: 'swift_sos_escalation_events_total',
  help: 'SOS escalation events (staged, sent, failed, dead_letter, zero_listeners, backfilled)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** [S-02] The SOS retrigger log: alerts whose rows do not account for their
 *  count (a lost sequence), oversized JSON summaries, legacy history awaiting import. */
export const sosRetriggerGauge = new client.Gauge({
  name: 'swift_sos_retrigger',
  help: 'SOS retrigger log state by check (sequence_gaps, oversized_summary, legacy_pending)',
  labelNames: ['check'] as const,
  registers: [registry],
});

/** [S-04] Guardian driver confirmations: accepted, refused (and why), stale
 *  values cleared, and every de-escalation of an unanswered passenger check. */
export const guardianDriverConfirmCounter = new client.Counter({
  name: 'swift_guardian_driver_confirm_total',
  help: 'Guardian driver confirmation events (confirmed, no_hard_check_refused, stale_confirm_refused, bad_nonce_refused, nonce_reused_refused, stale_value_cleared, passenger_unanswered_deescalation, deescalation_killed)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** [S-05] Every safety sweep walks its population in keyset pages from a
 *  persisted cursor: the pass ages, the unvisited population and the poison
 *  rows are the SLO — maximum due age, not processed counts. */
export const sweepGauge = new client.Gauge({
  name: 'swift_sweep',
  help: 'Sweep state by work type and check (population, unvisited_in_pass, poison_rows, pass_age_seconds, current_pass_seconds, stalled)',
  labelNames: ['work', 'check'] as const,
  registers: [registry],
});

/** [S-06] Guardian check-in deliveries: the outbox's pending / failed rows,
 *  the oldest pending age, and every CHECKIN_PENDING session whose hard
 *  prompt has not been delivered — a deadline that must not run. */
export const guardianDeliveryGauge = new client.Gauge({
  name: 'swift_guardian_checkin_delivery',
  help: 'Guardian check-in delivery state by check (pending, failed, oldest_pending_seconds, deadline_without_delivery, asked_without_rows)',
  labelNames: ['check'] as const,
  registers: [registry],
});
export const guardianDeliveryCounter = new client.Counter({
  name: 'swift_guardian_checkin_delivery_events_total',
  help: 'Guardian check-in delivery events (staged, sent, skipped, failed, dead_letter, backfilled, deadline_held, deadline_without_delivery_escalated)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** [S-08] Incident intake: created, replayed (the same source again), merged;
 *  and the legacy duplicate clusters the scan names, with the ones that drove
 *  enforcement. */
export const incidentIntakeCounter = new client.Counter({
  name: 'swift_incident_intake_events_total',
  help: 'Incident intake events (created, created_unfingerprinted, replayed, merged)',
  labelNames: ['event'] as const,
  registers: [registry],
});
export const incidentIntakeGauge = new client.Gauge({
  name: 'swift_incident_intake',
  help: 'Incident intake state by check (duplicate_clusters, enforcement_from_duplicates)',
  labelNames: ['check'] as const,
  registers: [registry],
});

/** [S-09] Legal holds: partial aggregates (deletion frozen while any exist),
 *  vault manifests pending / failed, and the freeze itself. */
export const legalHoldGauge = new client.Gauge({
  name: 'swift_legal_hold',
  help: 'Legal hold state by check (partial, pending_vault, failed_vault, deletion_frozen)',
  labelNames: ['check'] as const,
  registers: [registry],
});
export const legalHoldCounter = new client.Counter({
  name: 'swift_legal_hold_events_total',
  help: 'Legal hold events (placed, extended, repaired, vaulted, vault_failed, vault_dead_letter, retention_frozen)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** [S-13] Not-my-driver decisions: released / manual (rollback) / repaired,
 *  and decisions found lacking their case or their dispatch command. */
export const notMyDriverCounter = new client.Counter({
  name: 'swift_not_my_driver_events_total',
  help: 'Not-my-driver decision events (released, manual_review, repaired)',
  labelNames: ['event'] as const,
  registers: [registry],
});
export const notMyDriverGauge = new client.Gauge({
  name: 'swift_not_my_driver',
  help: 'Not-my-driver decisions lacking an artifact (missing_case, missing_dispatch)',
  labelNames: ['check'] as const,
  registers: [registry],
});

/** [S-16] Trip-share tokens: mints, views, misses, throttled and blocked
 *  callers, enumeration events, legacy rotations; plaintext rows remaining. */
export const tripShareCounter = new client.Counter({
  name: 'swift_trip_share_events_total',
  help: 'Trip-share events (minted, viewed, miss, rate_limited, blocked, enumeration, lookup_killed, legacy_rotated)',
  labelNames: ['event'] as const,
  registers: [registry],
});
export const tripShareGauge = new client.Gauge({
  name: 'swift_trip_share',
  help: 'Trip-share state by check (legacy_plaintext_remaining)',
  labelNames: ['check'] as const,
  registers: [registry],
});

/** [A-15] The audited door to a handover secret: how often support reveals a
 *  pickup code, asks for one that does not exist, or rotates a spent code.
 *  A quiet counter is the normal state; a rising one is an access review. */
export const handoverBreakGlassCounter = new client.Counter({
  name: 'swift_handover_break_glass_total',
  help: 'Handover secret break-glass events (reveal, reveal_no_code, rotate)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** [A-18] How support tickets close, by category and disposition. A SAFETY
 *  ticket closing as ANSWERED is impossible by construction; this counter is
 *  how the safety SLA and the reopen rate are read. */
export const supportResolutionCounter = new client.Counter({
  name: 'swift_support_resolution_total',
  help: 'Support tickets resolved, by category and disposition',
  labelNames: ['category', 'resolution'] as const,
  registers: [registry],
});

/** [W-28] Mark-ready outcomes on a quantity-tracked store: an order refused
 *  because every line was removed, one marked ready with some lines removed,
 *  and one marked ready complete. A rising refused_empty means customers are
 *  ordering what the shelf does not have. */
export const pickingReadinessCounter = new client.Counter({
  name: 'swift_picking_readiness_total',
  help: 'Mark-ready outcomes for shelf-picked orders (refused_empty, ready_partial, ready_complete)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** [W-25] Manual MMG captures: a store's word that money reached its own
 *  wallet. `attested` is every capture with no provider evidence behind it;
 *  `reference_reused` is one transaction offered for two orders. */
export const mmgAttestationCounter = new client.Counter({
  name: 'swift_mmg_attestation_total',
  help: 'Vendor MMG payment attestations (attested, reference_reused)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** [A-14] Cash-order refunds by lifecycle event. `owed` is an obligation
 *  recorded when an operator decides a customer is due money back, `settled` is
 *  a refund proved to have been handed over, and the refusal labels are the
 *  evidence a settlement was turned away for. `owed` minus `settled` IS the
 *  outstanding cash-refund liability, by tender, which the register asks for. */
export const orderRefundCounter = new client.Counter({
  name: 'swift_order_refund_total',
  help: 'Cash-order refund lifecycle (owed, settled, refused_not_due, refused_duplicate)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** [A-13] Return refunds by lifecycle event. `owed` is an obligation recorded,
 *  `settled` is money proved to have moved, and the refusal labels are the
 *  evidence a settlement was turned away for. The gap between `owed` and
 *  `settled` IS the unpaid-refund backlog — the number the register asks for
 *  under "refunded-without-provider evidence and refund aging". */
export const returnRefundCounter = new client.Counter({
  name: 'swift_return_refund_total',
  help: 'Return refund lifecycle (owed, settled, refused_reference, refused_amount, refused_duplicate)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** [S-19] Ops alerts: opened, acknowledged, escalated (zero ACK by deadline),
 *  on-call texts, drills, and alerts nobody can acknowledge. */
export const opsAlertCounter = new client.Counter({
  name: 'swift_ops_alert_events_total',
  help: 'Ops alert events (opened, acknowledged, escalated, zero_ack_by_deadline, oncall_sms, closed_unacknowledged, escalation_killed, zero_recipients, drill)',
  labelNames: ['event'] as const,
  registers: [registry],
});
export const opsAlertGauge = new client.Gauge({
  name: 'swift_ops_alert',
  help: 'Ops alert state by check (unacknowledged_overdue, oldest_overdue_seconds, zero_recipients, last_drill_ack_seconds)',
  labelNames: ['check'] as const,
  registers: [registry],
});

/** [TEN-01] Every tenant-model query that reached the database with no tenant
 *  bound, by model, operation and mode — `system` work names its capability;
 *  `request` and `unbound` are the callers to fix (denied under the flag). */
export const tenantUnscopedAccessCounter = new client.Counter({
  name: 'swift_tenant_unscoped_access_total',
  help: 'Tenant-model queries with no tenant bound (mode = request | unbound | system; capability names system work)',
  labelNames: ['model', 'operation', 'mode', 'capability'] as const,
  registers: [registry],
});
/** [TEN-03] Transaction-local bindings performed (tenant / system) and the
 *  in-transaction fallbacks that could not be batched. */
export const tenantBindCounter = new client.Counter({
  name: 'swift_tenant_bind_total',
  help: 'RLS bindings by kind (tenant, system, tenant_fallback_in_tx, system_fallback_in_tx)',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export async function observabilityPlugin(app: FastifyInstance) {
  initSentry();
  if (!metricsWired) {
    client.collectDefaultMetrics({ register: registry });
    // Live supply gauge (§6): counted at scrape time — two indexed counts,
    // no background loop. "Zero riders online at lunch" is a founder-must-know.
    new client.Gauge({
      name: 'swift_supply_online',
      help: 'Movers currently online, by pool',
      labelNames: ['pool'] as const,
      registers: [registry],
      async collect() {
        try {
          const [riders, drivers] = await Promise.all([
            app.prisma.rider.count({ where: { isOnline: true } }),
            app.prisma.driver.count({ where: { isOnline: true } }),
          ]);
          this.set({ pool: 'RIDER' }, riders);
          this.set({ pool: 'DRIVER' }, drivers);
        } catch {
          // A scrape must never fail on a transient DB hiccup — stale beats broken.
        }
      },
    });
    // Scheduler liveness (launch-readiness Phase 6): seconds since the worker's
    // heartbeat job last ran. A dead worker → this climbs unbounded → alert
    // (e.g. > 180s). Reads Redis at scrape time; -1 if never beaten.
    new client.Gauge({
      name: 'swift_scheduler_heartbeat_age_seconds',
      help: 'Seconds since the job scheduler last beat (worker liveness); -1 if never',
      registers: [registry],
      async collect() {
        try {
          const last = await app.redis.get('scheduler:heartbeat');
          this.set(last ? Math.max(0, Math.round((Date.now() - Number(last)) / 1000)) : -1);
        } catch {
          // Redis unreachable at scrape — leave the last value rather than fail.
        }
      },
    });
    // DB connection-pool health (D7-04). Prisma's own pool counters, surfaced at
    // scrape time via the metrics preview feature. The launch signal to alert on
    // is state="waiting" climbing above 0 — queries queued for a free connection
    // means the pool is saturated and connection_limit should rise (see
    // .env.example). One labeled metric, matching swift_supply_online's shape.
    new client.Gauge({
      name: 'swift_db_pool',
      help: 'Prisma connection-pool state (open/busy/idle connections; queries waiting for one)',
      labelNames: ['state'] as const,
      registers: [registry],
      async collect() {
        try {
          const m = await app.prisma.$metrics.json();
          const g = (key: string) => m.gauges.find((x) => x.key === key)?.value ?? 0;
          this.set({ state: 'open' }, g('prisma_pool_connections_open'));
          this.set({ state: 'busy' }, g('prisma_pool_connections_busy'));
          this.set({ state: 'idle' }, g('prisma_pool_connections_idle'));
          this.set({ state: 'waiting' }, g('prisma_client_queries_wait'));
        } catch {
          // Pool not initialised yet, or prisma absent in a unit-test harness —
          // a scrape must never fail on it. Stale/absent beats broken.
        }
      },
    });
    metricsWired = true;
  }

  app.addHook('onResponse', (request, reply, done) => {
    // routeOptions.url keeps cardinality bounded (":id", not real ids).
    const route = request.routeOptions?.url ?? 'unmatched';
    httpDuration.observe(
      { method: request.method, route, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
    done();
  });

  // 5xx = our fault → Sentry. 4xx is the caller's problem and stays out.
  app.addHook('onError', (request, _reply, error, done) => {
    const status = (error as AppError).statusCode ?? 500;
    if (status >= 500) {
      // Route TEMPLATE, never the raw URL — /track/:token must not leak its
      // token into the tracker [REPORT-013 F-013-04].
      captureError(error, { method: request.method, url: request.routeOptions?.url ?? 'unmatched', requestId: request.id });
    }
    done();
  });

  app.get('/metrics', async (request, reply) => {
    const token = process.env['METRICS_TOKEN'];
    if (!token) throw new AppError(404, 'NOT_FOUND', 'Not found'); // off by default
    if (request.headers.authorization !== `Bearer ${token}`) {
      throw new AppError(401, 'UNAUTHORIZED', 'Metrics token required');
    }
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
}
