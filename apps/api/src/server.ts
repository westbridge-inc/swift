import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from './modules/auth/auth.routes';
import { customerRoutes } from './modules/user/customer.routes';
import { vendorRoutes } from './modules/vendor/vendor.routes';
import { riderRoutes } from './modules/rider/rider.routes';
import { driverRoutes } from './modules/driver/driver.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { searchRoutes } from './modules/search/search.routes';
import { chatRoutes } from './modules/chat/chat.routes';
import { verificationRoutes } from './modules/verification/verification.routes';
import { prismaPlugin } from './plugins/prisma';
import { authPlugin } from './plugins/auth';
import { socketPlugin } from './plugins/socket';
import { redisPlugin } from './plugins/redis';
import { registerErrorHandler } from './middleware/error-handler';
import { createQueues, createWorkers, scheduleRecurringJobs } from './jobs/queue';

const PORT = parseInt(process.env['PORT'] || '3000', 10);
const HOST = process.env['HOST'] || '0.0.0.0';

async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] || 'info',
      transport:
        process.env['NODE_ENV'] === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  });

  // Global error handler
  registerErrorHandler(app);

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
    max: 200,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      return request.headers['x-forwarded-for'] as string || request.ip;
    },
  });

  // Custom plugins
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);

  // Health check — detailed
  app.get('/health', async () => {
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
    return {
      status: allOk ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks,
    };
  });

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
    });

    // Decorate so routes can enqueue jobs
    app.decorate('queues', queues);
  } catch (err) {
    app.log.warn({ err }, 'Background jobs failed to initialize — running without queues');
  }

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
    const app = await buildApp();
    await app.listen({ port: PORT, host: HOST });
    console.warn(`Swift API running on http://${HOST}:${PORT}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
