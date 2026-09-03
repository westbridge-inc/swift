import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';
import multipart from '@fastify/multipart';
import { helmetOptions } from './config/security-headers';
import { rateLimitKey } from './utils/rate-limit-key';
import { authRoutes } from './modules/auth/auth.routes';
import { customerRoutes } from './modules/user/customer.routes';
import { vendorRoutes } from './modules/vendor/vendor.routes';
import { registerTenantHeaderScope } from './plugins/tenant-header-scope';
import { riderRoutes } from './modules/rider/rider.routes';
import { driverRoutes } from './modules/driver/driver.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { searchRoutes } from './modules/search/search.routes';
import { chatRoutes } from './modules/chat/chat.routes';
import { moderationRoutes } from './modules/moderation/moderation.routes';
import { verificationRoutes } from './modules/verification/verification.routes';
import { ridesRoutes } from './modules/rides/rides.routes';
import { safetyRoutes } from './modules/safety/safety.routes';
import { adsRoutes } from './modules/ads/ads.routes';
import { placesRoutes } from './modules/places/places.routes';
import courierRoutes from './modules/courier/courier.routes';
import { servicesRoutes } from './modules/services/services.routes';
import { partnerRoutes } from './modules/partner/partner.routes';
import { aiRoutes } from './modules/ai/ai.routes';
import { setAppLogger } from './utils/logger';
import { assertSafeBootConfig, assertProductionData } from './utils/boot-config';
import { evaluateSchedulerHealth, schedulerStallMs, workerCheckStatus } from './utils/scheduler-health';
import { prismaPlugin, beginRequestTenantContext } from './plugins/prisma';
import { authPlugin } from './plugins/auth';
import { socketPlugin } from './plugins/socket';
import { redisPlugin } from './plugins/redis';
import { registerErrorHandler } from './middleware/error-handler';
import { registerEmptyJsonBodyParser } from './plugins/empty-json';
import { initializeJobRuntime, type JobRuntime } from './jobs/runtime';
import { registerLivenessRoute, registerReadinessRoute, registerRoutedWhileDegradedCounter, type RuntimeReadinessState } from './plugins/readiness';
import { pageOps, resolveOpsPage } from './modules/ops/ops-page';
import { loggerRedactConfig } from './utils/logger-config';
import { registerPublicUploads } from './utils/public-uploads';
import { observabilityPlugin } from './plugins/observability';
import { legalRoutes } from './modules/legal/legal.routes';
import { publicRoutes } from './modules/public/public.routes';
import { qrResolverRoutes } from './modules/qr/qr-resolver.routes';
import { attributionRoutes } from './modules/qr/attribution.routes';
import { qrPublicRoutes } from './modules/qr/qr-public.routes';
import { discoveryRoutes } from './modules/discovery/discovery.routes';
import { marketRoutes } from './modules/market/market.routes';
import { statementRoutes } from './modules/order/statement.routes';
import path from 'node:path';
import { installProcessLifecycle } from './utils/process-lifecycle';
import { resolveCorsOrigins } from './utils/cors-origin';
import { isDevelopment, isProduction } from './utils/runtime-mode';

const PORT = parseInt(process.env['PORT'] || '3000', 10);
const HOST = process.env['HOST'] || '0.0.0.0';

// Process start ≈ API boot. Grace-windows the scheduler "never booted" page so a
// fleet that is still coming up isn't paged before its first heartbeat (SWIFT-122).
const SERVER_BOOTED_AT = Date.now();

// Public upload trees (items/, avatars/) are served via registerPublicUploads.
// KYC / verification documents live under other /uploads folders and stay
// private — they are only ever reachable through short-lived signed URLs.
const UPLOAD_BASE = process.env['UPLOAD_DIR'] ?? path.join(process.cwd(), 'uploads');

// SEC (OWASP API4): only trust X-Forwarded-For when explicitly behind a known proxy.
// TRUST_PROXY = hop count ("1" for Fly), an IP/CIDR list, or "true". Default false so
// a client cannot spoof its source IP to bypass rate limiting.
function parseTrustProxy(v?: string): boolean | number | string {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

async function buildApp() {
  const app = Fastify({
    trustProxy: parseTrustProxy(process.env['TRUST_PROXY']),
    logger: {
      level: process.env['LOG_LEVEL'] || 'info',
      // secrets and credentials never reach log output
      redact: loggerRedactConfig,
      transport:
        isDevelopment()
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    // A slow dependency (SMS, S3, search, an upstream provider) must not pin a
    // handler open forever and exhaust the connection pool. 30s is far above
    // any healthy request; anything longer is a stuck dependency, not work.
    requestTimeout: Number(process.env['REQUEST_TIMEOUT_MS'] ?? 30_000),
  });
  // [R048-006] Boot contracts — safe config, production data, the required
  // taxonomy — complete BEFORE listen (start() below); readiness proves it.
  let bootContractsComplete = false;
  const runtimeReadiness: RuntimeReadinessState = {
    checkQueues: () => false,
    checkConsumers: () => false,
    checkWorker: async () => {
      const beat = await app.redis.get('scheduler:heartbeat').catch(() => null);
      return workerCheckStatus(evaluateSchedulerHealth({ beat, nowMs: Date.now(), bootAtMs: SERVER_BOOTED_AT, stallMs: schedulerStallMs() }), beat);
    },
    checkBoot: () => bootContractsComplete,
  };
  app.decorate('markBootContractsComplete', () => { bootContractsComplete = true; });
  let jobRuntime: JobRuntime | undefined;

  // Give deep services (order, dispatch) the real logger for orderId tracing.
  setAppLogger(app.log);

  // Global error handler
  registerErrorHandler(app);

  // Action POSTs (go-online, accept, …) legitimately carry no body; the axios
  // clients still send Content-Type: application/json, so tolerate an empty body
  // instead of rejecting it with EMPTY_JSON_BODY (400).
  registerEmptyJsonBodyParser(app);

  // Core plugins
  const corsOrigin = resolveCorsOrigins(process.env['CORS_ORIGIN'], process.env['NODE_ENV']);
  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });
  await app.register(helmet, helmetOptions);
  // SWIFT-AUD-D6-02: back the limiter with Redis IN PRODUCTION so the ceiling is
  // shared across all API instances. An in-memory store gives each instance its
  // own counter → the effective limit becomes N×max, and the deliberately tight
  // OTP/login limits weaken linearly with the fleet size you scale up for launch.
  // Dev/test keep the in-memory store (a shared Redis counter across vitest's
  // per-file workers would cross-contaminate the whole suite's rate-limit state).
  const rateLimitRedis =
    isProduction()
      ? new Redis(process.env['REDIS_URL'] || 'redis://localhost:6379', {
          connectionName: 'swift-rate-limit',
          // A rate-limit store must fail OPEN, never queue or crash a request if
          // Redis blips — the plugin degrades gracefully on a store error.
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        })
      : undefined;
  await app.register(rateLimit, {
    // Global ceiling. Tunable via RATE_LIMIT_MAX so a load test or a busy launch
    // can raise it without a code change (per-route limits on auth/OTP stay tight
    // regardless). Authenticated callers are bucketed per session token, anonymous
    // ones per resolved IP (never the spoofable X-Forwarded-For) — see D1-01.
    ...(rateLimitRedis ? { redis: rateLimitRedis, nameSpace: 'swift-rl:' } : {}),
    keyGenerator: rateLimitKey,
    max: parseInt(process.env['RATE_LIMIT_MAX'] || '200', 10),
    timeWindow: '1 minute',
  });
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });

  // Custom plugins
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  runtimeReadiness.checkRealtime = app.checkSocketAdapterReady;

  // Multi-tenancy: give every request a fresh tenant store BEFORE any auth runs,
  // so `authenticate` can bind the caller's tenant without leaking across
  // requests. Unauthenticated requests stay tenant-null (unscoped browse).
  app.addHook('onRequest', async () => {
    beginRequestTenantContext();
  });
  // [MOB-010] The vendor store header (x-vendor-id) belongs to the vendor
  // endpoint family only. Outside it the server ignores it (default) or rejects
  // it (TENANT_HEADER_OUTSIDE_VENDOR=reject) and counts the leak per family.
  registerTenantHeaderScope(app);
  // Sentry (SENTRY_DSN) + Prometheus /metrics (METRICS_TOKEN) — both env-gated,
  // free when unset.
  await app.register(observabilityPlugin);
  // Public legal pages (ToS/Privacy) — linked from the app's register screen.
  await app.register(legalRoutes, { prefix: '/legal' });

  // Health check. The load balancer needs a bare status; per-dependency
  // detail (db/redis state, uptime) is an internal map of the deployment and
  // stays behind HEALTH_DETAIL_TOKEN outside development.
  // [R048-006] Liveness is dependency-free (/live); /health and /ready are
  // readiness-grade and say 503 for a known failure — a green container on a
  // degraded API was the lie the container probe believed.
  registerLivenessRoute(app);
  registerRoutedWhileDegradedCounter(app);
  app.get('/health', async (request, reply) => {
    const checks: Record<string, string> = { api: 'ok' };

    try {
      await app.prisma.$queryRaw`SELECT 1`;
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'error';
    }

    try {
      await app.redis.ping();
      checks['redis'] = 'ok';
    } catch {
      checks['redis'] = 'error';
    }

    // [BUILD_NOW Band A] The worker fleet, reported as its own check. A green
    // /health that does not look at the workers is exactly the lie that
    // matters: RUN_WORKERS unset means holds, expiry sweeps, billing and
    // settlements are silently not running while every probe says healthy.
    // ONE read of ONE heartbeat key, evaluated ONCE — the paging block below
    // reuses this verdict rather than forming a second opinion.
    const beat = await app.redis.get('scheduler:heartbeat').catch(() => null);
    const workerHealth = evaluateSchedulerHealth({ beat, nowMs: Date.now(), bootAtMs: SERVER_BOOTED_AT, stallMs: schedulerStallMs() });
    checks['worker'] = workerCheckStatus(workerHealth, beat);

    // SWIFT-AUD-D7-02: scheduler-stall paging. A stalled worker can't page
    // about itself, so the check rides the load balancer's /health polls —
    // the one thing still running when the job scheduler is dead. Dedup'd
    // (30 min) and fire-and-caught: paging never slows a probe.
    void (async () => {
      // `!beat` is NOT benign: the heartbeat key has no TTL, so its absence means
      // the worker fleet never booted (crash / RUN_WORKERS misconfigured). Page it
      // once we're past the grace window — the case this check used to swallow.
      const health = workerHealth;
      if (!health.page) return;
      const neverBooted = health.kind === 'never-booted';
      // Separate dedup keys so a "never booted" alert and a later "stall" don't mask each other.
      const pageKey = neverBooted ? 'ops_page:scheduler-never-booted' : 'ops_page:scheduler-stall';
      const mins = Math.round(health.ageMs / 60_000);
      const { NotificationService } = await import('./modules/notification/notification.service');
      // [R048-006] A page is an OpsAlert row before it is a notification: the dedupe key is claimed
      // only for a page that reached someone; nobody staffed leaves it PENDING and retryable.
      await pageOps({ prisma: app.prisma, redis: app.redis, notifications: new NotificationService(app.prisma, app.io) }, {
        key: pageKey,
        title: neverBooted ? 'Job scheduler never started' : 'Job scheduler stalled',
        body: neverBooted
          ? `No scheduler heartbeat since boot (${mins} min) — the worker fleet never started (crash or RUN_WORKERS misconfigured). Holds, expiry sweeps, billing and settlements have NEVER run. Start the worker.`
          : `No scheduler heartbeat for ${mins} min — holds, expiry sweeps, billing and settlements are NOT running. Restart the worker.`,
        data: { kind: neverBooted ? 'ops_scheduler_never_booted' : 'ops_scheduler_stall', ageMs: health.ageMs },
      });
    })().catch(() => {});
    // the condition cleared: close the open page so the outbox stays truthful
    if (!workerHealth.page && beat) {
      void resolveOpsPage(app.prisma, 'Job scheduler stalled').catch(() => {});
      void resolveOpsPage(app.prisma, 'Job scheduler never started').catch(() => {});
    }

    // `starting` is the worker inside its boot grace: not a failure, and not a
    // reason to call a freshly deployed API degraded. Everything else must be ok.
    const allOk = Object.values(checks).every((v) => v === 'ok' || v === 'starting');
    const status = allOk ? 'healthy' : 'degraded';
    // [R048-006] A known failure is never a 200: the container probe reads the status code.
    reply.status(allOk ? 200 : 503);

    const detailToken = process.env['HEALTH_DETAIL_TOKEN'];
    const showDetail =
      isDevelopment() ||
      (!!detailToken && request.headers['x-health-detail'] === detailToken);
    if (!showDetail) {
      return { status, timestamp: new Date().toISOString() };
    }
    const { EXHAUST_CAP, REDISPATCH_DELAY_MS } = await import('./modules/dispatch/dispatch.service');
    return {
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks,
      // [F-028-17] THIS process's effective dispatch tuning. The baselines
      // derive their wait math from these numbers, and a baseline shell can
      // carry different env than the server it drives — a cap-3 shell judged
      // a cap-5 API "late" before its page was even due. The server states
      // its own truth; the harness pins to it. Detail-gated like the rest.
      dispatch: { exhaustCap: EXHAUST_CAP, redispatchDelayMs: REDISPATCH_DELAY_MS },
    };
  });

  // Readiness is stricter than liveness: schema, Redis, BullMQ producer
  // connections, and host/DB/Redis clock agreement must all be healthy.
  registerReadinessRoute(app, runtimeReadiness);

  // Public upload trees only (items/, avatars/). Path-traversal-guarded;
  // KYC docs in other /uploads folders are never exposed here.
  registerPublicUploads(app, UPLOAD_BASE);

  // API routes
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(searchRoutes, { prefix: '/api/v1' });
  // [SCR-003] Test-control exists only in isolated load builds; production never registers it.
  {
    const { testControlEnabled } = await import('./modules/ops/test-control');
    if (testControlEnabled()) {
      const { testControlRoutes } = await import('./modules/ops/test-control.routes');
      await app.register(testControlRoutes, { prefix: '/api/v1' });
    }
  }
  await app.register(chatRoutes, { prefix: '/api/v1/chat' });
  await app.register(moderationRoutes, { prefix: '/api/v1' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.register(adsRoutes, { prefix: '/api/v1/ads' });
  await app.register(placesRoutes, { prefix: '/api/v1/places' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(aiRoutes, { prefix: '/api/v1/ai' });
  // Unauthenticated read-only storefront pages (web SEO) — see module header.
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  // Printed-QR short links: /s/{code} at the ROOT path (the production web
  // domain proxies /s/* here — LAUNCH_BLOCKERS deploy item). Public attack
  // surface; treatment and decision table live in the module header.
  await app.register(qrResolverRoutes);
  // Install attribution (Android referrer / iOS single-candidate fingerprint).
  await app.register(attributionRoutes, { prefix: '/api/v1/attribution' });
  // App-side QR twins: JSON resolve for in-app /s/ links + APP_OPEN reports.
  await app.register(qrPublicRoutes, { prefix: '/api/v1/public' });
  // Category discovery rail data (#17) — flag-dark until the founder flips it.
  await app.register(discoveryRoutes, { prefix: '/api/v1/discovery' });
  // [MKT G1] The market feed — items across stores. Public like search: a
  // shopper browses the catalogue before they have an account.
  await app.register(marketRoutes, { prefix: '/api/v1/market' });
  // HMAC-signed statement renders (the authed routes mint the links).
  await app.register(statementRoutes, { prefix: '/api/v1/statements' });
  // MMG agent-cash channels [san spec 4.1/4.2] — dark (503) until the
  // webhook secret arrives with MMG biller onboarding.
  const { agentCashRoutes } = await import('./modules/billing/agent-cash.routes');
  await app.register(agentCashRoutes, { prefix: '/api/v1/billing/mmg' });

  // Background job queues.
  // SWIFT-AUD-D7-01: workers are opt-out per process. Default (unset) keeps
  // the single-process topology — the API runs its own workers, byte-identical
  // to before. Set RUN_WORKERS=0 on API instances when a dedicated worker
  // process (dist/worker.js) owns the queues, so N API instances don't run N
  // copies of billing/settlement/reconcile processing. Queues are always
  // created — routes still enqueue either way.
  try {
    const runWorkers = process.env['RUN_WORKERS'] !== '0';
    const runtime = await initializeJobRuntime({
      prisma: app.prisma,
      io: app.io,
      redis: app.redis,
      log: app.log,
    }, { runWorkers });
    jobRuntime = runtime;
    const { queues } = runtime;
    runtimeReadiness.checkQueues = runtime.checkProducersReady;
    runtimeReadiness.checkConsumers = runtime.checkConsumersReady;
    app.decorate('workersActive', runWorkers);
    app.log.info(
      { runWorkers, maxClockSkewMs: Math.round(runtime.clock.maxSkewMs) },
      'Background job queues initialized',
    );

    app.addHook('onClose', async () => {
      runtimeReadiness.checkQueues = () => false;
      runtimeReadiness.checkConsumers = () => false;
      await runtime.cleanup();
    });

    // Decorate so routes can enqueue jobs
    app.decorate('queues', queues);
    app.decorate('dispatchQueue', queues.dispatchQueue);
  } catch (err) {
    if (isProduction()) {
      app.log.fatal({ err }, 'Background jobs failed to initialize — refusing production boot');
      await app.close().catch((closeError) => {
        app.log.error({ err: closeError }, 'Failed to close app after queue initialization failure');
      });
      throw err;
    }
    app.log.warn({ err }, 'Background jobs failed to initialize — readiness remains false');
  }

  const processLifecycle = installProcessLifecycle({
    cleanup: () => app.close(),
    markNotReady: () => {
      runtimeReadiness.checkQueues = () => false;
      runtimeReadiness.checkConsumers = () => false;
      jobRuntime?.markNotReady();
    },
    exit: (code) => process.exit(code),
    onSignal: (signal) => {
      app.log.info({ signal }, 'Shutdown signal received');
    },
    onFatal: (event, error) => {
      const message = event === 'unhandledRejection'
        ? 'UNHANDLED PROMISE REJECTION — draining process'
        : 'UNCAUGHT EXCEPTION — draining process';
      app.log.fatal({ err: error, event }, message);
    },
    onCleanupError: (error) => {
      app.log.fatal({ err: error }, 'Server bounded shutdown failed');
    },
  });
  // Test-created apps may close without a process signal. Remove only the exact
  // listeners this app installed so repeated builds do not leak handlers.
  app.addHook('onClose', async () => {
    processLifecycle.dispose();
  });

  return app;
}

async function start() {
  try {
    assertSafeBootConfig();
    const app = await buildApp();
    // SWIFT-010: refuse to serve a production DB with no active market seeded
    // (empty CountryConfig = every signup rejected). Dev/test/CI skip inside.
    await assertProductionData(app.prisma);
    await app.listen({ port: PORT, host: HOST });
    console.warn(`Swift API running on http://${HOST}:${PORT}`);

    // [MKT G3/G5] PLANT THE DISCOVERY TAXONOMY.
    //
    // `seedDiscoveryTaxonomy` shipped with 14 RETAIL categories, an alias
    // dictionary that is the local moat, and full idempotency — and NOTHING
    // EVER CALLED IT outside tests. So the taxonomy existed in code and in no
    // database: every deployment had zero categories, the rail had nothing to
    // show, and the market feed could only ever return an empty grid however
    // correct its query was. A seeder with no caller is the same defect as an
    // endpoint with no caller, one layer down.
    //
    // Runs AFTER listen, so it can never delay the port opening (the same rule
    // the Meilisearch warm-up follows), and never in tests — they call
    // `buildApp` directly and seed their own tenants explicitly.
    //
    // Idempotent by contract: name/emoji/sortWeight are create-only so a
    // founder's admin edits win forever, and aliases UNION so shipped alias
    // extensions reach existing tenants without trampling admin additions.
    // Failure is logged, never fatal — a missing taxonomy degrades the rail,
    // it must not take the API down.
    void (async () => {
      try {
        const { seedDiscoveryTaxonomy } = await import('./modules/discovery/taxonomy.seed');
        const { created, aliasUpdated } = await seedDiscoveryTaxonomy(app.prisma);
        if (created > 0 || aliasUpdated > 0) {
          app.log.info({ created, aliasUpdated }, 'discovery: taxonomy seeded');
        }
        // [R048-006] The contract is COMPLETE only here. Readiness answers 503
        // until this line runs, so an orchestrator never routes to a process
        // whose category rail would be empty.
        app.markBootContractsComplete();
      } catch (err) {
        app.log.warn({ err }, 'discovery: taxonomy seed failed — the category rail will be empty');
      }
    })();
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
