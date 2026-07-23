import type { FastifyInstance } from 'fastify';
import client from 'prom-client';
import * as Sentry from '@sentry/node';
import { AppError } from '../utils/errors';

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
export function initSentry() {
  const dsn = process.env['SENTRY_DSN'];
  if (!dsn || sentryReady) return sentryReady;
  Sentry.init({
    dsn,
    environment: process.env['NODE_ENV'] ?? 'development',
    // Errors only for V1 — tracing multiplies cost without a consumer yet.
    tracesSampleRate: 0,
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
      captureError(error, { method: request.method, url: request.url, requestId: request.id });
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
