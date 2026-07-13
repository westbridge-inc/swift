import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
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
import { prismaPlugin } from './plugins/prisma';
import { authPlugin } from './plugins/auth';
import { socketPlugin } from './plugins/socket';
import { redisPlugin } from './plugins/redis';
import { registerErrorHandler } from './middleware/error-handler';
import { registerEmptyJsonBodyParser } from './plugins/empty-json';
import { createQueues, createWorkers, scheduleRecurringJobs } from './jobs/queue';
import { loggerRedactConfig } from './utils/logger-config';
import { registerPublicUploads } from './utils/public-uploads';
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
      ? ['http://localhost:3001', 'http://localhost:3000', 'http://127.0.0.1:3001']
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
  await app.register(rateLimit, {
    // Global per-IP ceiling. Tunable via RATE_LIMIT_MAX so a load test or a
    // busy launch can raise it without a code change (per-route limits on
    // auth/OTP stay tight regardless). Keys off request.ip (resolved via
    // trustProxy above) — never the raw, client-spoofable X-Forwarded-For.
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

  // Background job queues
  try {
    const queues = createQueues(app.redis);
    const workers = createWorkers({
      prisma: app.prisma,
      io: app.io,
      redis: app.redis,
      log: app.log,
    });
    await scheduleRecurringJobs(queues);
    app.log.info('Background job queues initialized');

    app.addHook('onClose', async () => {
      await workers.cleanup();
      await queues.orderQueue.close();
      await queues.riderAssignmentQueue.close();
      await queues.subscriptionQueue.close();
      await queues.settlementQueue.close();
      await queues.notificationQueue.close();
      await queues.verificationQueue.close();
      await queues.dispatchQueue.close();
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

/** Refuse to boot in a dangerous config. The OTP master-code bypass is
 *  triple-guarded in code, but its last line of defence is NODE_ENV — if prod
 *  ever runs without NODE_ENV=production and the flag leaks in, `000000`
 *  becomes universal account takeover. Fail loud at boot instead. */
function assertSafeBootConfig() {
  if (process.env['NODE_ENV'] === 'production' && process.env['DEV_OTP_BYPASS'] === '1') {
    throw new Error('FATAL: DEV_OTP_BYPASS=1 in production — this disables OTP verification. Refusing to start.');
  }
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
