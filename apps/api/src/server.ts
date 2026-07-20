import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';
import multipart from '@fastify/multipart';
import { rateLimitKey } from './utils/rate-limit-key';
import { authRoutes } from './modules/auth/auth.routes';
import { customerRoutes } from './modules/user/customer.routes';
import { vendorRoutes } from './modules/vendor/vendor.routes';
import { riderRoutes } from './modules/rider/rider.routes';
import { driverRoutes } from './modules/driver/driver.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { searchRoutes } from './modules/search/search.routes';
import { chatRoutes } from './modules/chat/chat.routes';
import { verificationRoutes } from './modules/verification/verification.routes';
import { ridesRoutes } from './modules/rides/rides.routes';
import { placesRoutes } from './modules/places/places.routes';
import courierRoutes from './modules/courier/courier.routes';
import { servicesRoutes } from './modules/services/services.routes';
import { partnerRoutes } from './modules/partner/partner.routes';
import { aiRoutes } from './modules/ai/ai.routes';
import { setAppLogger } from './utils/logger';
import { assertSafeBootConfig } from './utils/boot-config';
import { prismaPlugin, beginRequestTenantContext } from './plugins/prisma';
import { authPlugin } from './plugins/auth';
import { socketPlugin } from './plugins/socket';
import { redisPlugin } from './plugins/redis';
import { registerErrorHandler } from './middleware/error-handler';
import { registerEmptyJsonBodyParser } from './plugins/empty-json';
import { createQueues, createWorkers, scheduleRecurringJobs } from './jobs/queue';
import { loggerRedactConfig } from './utils/logger-config';
import { registerPublicUploads } from './utils/public-uploads';
import { observabilityPlugin } from './plugins/observability';
import { legalRoutes } from './modules/legal/legal.routes';
import { publicRoutes } from './modules/public/public.routes';
import { statementRoutes } from './modules/order/statement.routes';
import path from 'node:path';

const PORT = parseInt(process.env['PORT'] || '3000', 10);
const HOST = process.env['HOST'] || '0.0.0.0';

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
        process.env['NODE_ENV'] === 'development'
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

  // Give deep services (order, dispatch) the real logger for orderId tracing.
  setAppLogger(app.log);

  // Global error handler
  registerErrorHandler(app);

  // Action POSTs (go-online, accept, …) legitimately carry no body; the axios
  // clients still send Content-Type: application/json, so tolerate an empty body
  // instead of rejecting it with EMPTY_JSON_BODY (400).
  registerEmptyJsonBodyParser(app);

  // Core plugins
  const corsOrigin = process.env['CORS_ORIGIN']
    ? process.env['CORS_ORIGIN'].split(',')
    : process.env['NODE_ENV'] === 'development'
      ? [
          'http://localhost:3001', 'http://localhost:3000', 'http://127.0.0.1:3001',
          // Web app dev server + Mission Control's Tauri webview origins
          'http://localhost:3002', 'tauri://localhost', 'http://tauri.localhost',
        ]
      : false;
  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'wss:', 'ws:'],
      },
    },
  });
  // SWIFT-AUD-D6-02: back the limiter with Redis IN PRODUCTION so the ceiling is
  // shared across all API instances. An in-memory store gives each instance its
  // own counter → the effective limit becomes N×max, and the deliberately tight
  // OTP/login limits weaken linearly with the fleet size you scale up for launch.
  // Dev/test keep the in-memory store (a shared Redis counter across vitest's
  // per-file workers would cross-contaminate the whole suite's rate-limit state).
  const rateLimitRedis =
    process.env['NODE_ENV'] === 'production'
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

  // Multi-tenancy: give every request a fresh tenant store BEFORE any auth runs,
  // so `authenticate` can bind the caller's tenant without leaking across
  // requests. Unauthenticated requests stay tenant-null (unscoped browse).
  app.addHook('onRequest', async () => {
    beginRequestTenantContext();
  });
  // Sentry (SENTRY_DSN) + Prometheus /metrics (METRICS_TOKEN) — both env-gated,
  // free when unset.
  await app.register(observabilityPlugin);
  // Public legal pages (ToS/Privacy) — linked from the app's register screen.
  await app.register(legalRoutes, { prefix: '/legal' });

  // Health check. The load balancer needs a bare status; per-dependency
  // detail (db/redis state, uptime) is an internal map of the deployment and
  // stays behind HEALTH_DETAIL_TOKEN outside development.
  app.get('/health', async (request) => {
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

    // SWIFT-AUD-D7-02: scheduler-stall paging. A stalled worker can't page
    // about itself, so the check rides the load balancer's /health polls —
    // the one thing still running when the job scheduler is dead. Dedup'd
    // (30 min) and fire-and-caught: paging never slows a probe.
    void (async () => {
      const beat = await app.redis.get('scheduler:heartbeat');
      if (!beat) return; // no worker has EVER run here (fresh boot / RUN_WORKERS=0 fleet mid-deploy)
      const ageMs = Date.now() - Number(beat);
      const stallMs = Number(process.env['SCHEDULER_STALL_ALERT_MINUTES'] ?? '5') * 60_000;
      if (ageMs <= stallMs) return;
      const claimed = await app.redis.set('ops_page:scheduler-stall', '1', 'EX', 1800, 'NX');
      if (claimed !== 'OK') return;
      const { notifyAdmins, NotificationService } = await import('./modules/notification/notification.service');
      await notifyAdmins(app.prisma, new NotificationService(app.prisma, app.io), {
        title: 'Job scheduler stalled',
        body: `No scheduler heartbeat for ${Math.round(ageMs / 60_000)} min — holds, expiry sweeps, billing and settlements are NOT running. Restart the worker.`,
        data: { kind: 'ops_scheduler_stall', ageMs },
      });
    })().catch(() => {});

    const allOk = Object.values(checks).every((v) => v === 'ok');
    const status = allOk ? 'healthy' : 'degraded';

    const detailToken = process.env['HEALTH_DETAIL_TOKEN'];
    const showDetail =
      process.env['NODE_ENV'] === 'development' ||
      (!!detailToken && request.headers['x-health-detail'] === detailToken);
    if (!showDetail) {
      return { status, timestamp: new Date().toISOString() };
    }
    return {
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks,
    };
  });

  // Readiness (launch-readiness Phase 6): distinct from /health's liveness.
  // "Can this instance serve traffic RIGHT NOW" — every hard dependency must be
  // reachable AND the schema migrated. The load balancer / orchestrator routes
  // traffic only to a 200 here; a booting or dependency-broken instance returns
  // 503 and is kept out of rotation. No auth (infra probe), no detail leaked.
  app.get('/ready', async (_request, reply) => {
    const deps: Record<string, boolean> = {};
    try {
      // Schema present? An un-migrated DB is "up" but cannot serve. Checking a
      // core table exists works whether the schema arrived via migrate deploy
      // (prod) or db push (CI) — both leave `users` present.
      const rows = await app.prisma.$queryRaw<Array<{ ok: boolean }>>`
        SELECT to_regclass('public.users') IS NOT NULL AS ok`;
      deps['database'] = rows[0]?.ok === true;
    } catch {
      deps['database'] = false;
    }
    try {
      deps['redis'] = (await app.redis.ping()) === 'PONG';
    } catch {
      deps['redis'] = false;
    }
    const ready = Object.values(deps).every(Boolean);
    reply.status(ready ? 200 : 503);
    return { ready, deps, timestamp: new Date().toISOString() };
  });

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
  await app.register(chatRoutes, { prefix: '/api/v1/chat' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(placesRoutes, { prefix: '/api/v1/places' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(aiRoutes, { prefix: '/api/v1/ai' });
  // Unauthenticated read-only storefront pages (web SEO) — see module header.
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  // HMAC-signed statement renders (the authed routes mint the links).
  await app.register(statementRoutes, { prefix: '/api/v1/statements' });

  // Background job queues.
  // SWIFT-AUD-D7-01: workers are opt-out per process. Default (unset) keeps
  // the single-process topology — the API runs its own workers, byte-identical
  // to before. Set RUN_WORKERS=0 on API instances when a dedicated worker
  // process (dist/worker.js) owns the queues, so N API instances don't run N
  // copies of billing/settlement/reconcile processing. Queues are always
  // created — routes still enqueue either way.
  try {
    const queues = createQueues(app.redis);
    const runWorkers = process.env['RUN_WORKERS'] !== '0';
    const workers = runWorkers
      ? createWorkers({
          prisma: app.prisma,
          io: app.io,
          redis: app.redis,
          log: app.log,
        })
      : null;
    // Repeatable-job registration lives with the process that consumes them.
    if (runWorkers) await scheduleRecurringJobs(queues);
    app.decorate('workersActive', runWorkers);
    app.log.info({ runWorkers }, 'Background job queues initialized');

    app.addHook('onClose', async () => {
      if (workers) await workers.cleanup();
      await queues.orderQueue.close();
      await queues.riderAssignmentQueue.close();
      await queues.subscriptionQueue.close();
      await queues.settlementQueue.close();
      await queues.notificationQueue.close();
      await queues.verificationQueue.close();
      await queues.dispatchQueue.close();
      await queues.searchQueue.close();
    });

    // Decorate so routes can enqueue jobs
    app.decorate('queues', queues);
    app.decorate('dispatchQueue', queues.dispatchQueue);
  } catch (err) {
    app.log.warn({ err }, 'Background jobs failed to initialize — running without queues');
  }

  // Last-resort visibility: an unhandled rejection or uncaught exception must
  // leave a loud, structured trace instead of a silent death (pre-launch audit
  // H5). Kept process-alive on rejection (Node default would too) but logged.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'UNHANDLED PROMISE REJECTION');
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'UNCAUGHT EXCEPTION');
  });

  // Graceful shutdown
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`${signal} received, shutting down gracefully...`);
      await app.close();
      process.exit(0);
    });
  }

  return app;
}

async function start() {
  try {
    assertSafeBootConfig();
    const app = await buildApp();
    await app.listen({ port: PORT, host: HOST });
    console.warn(`Swift API running on http://${HOST}:${PORT}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
