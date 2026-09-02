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
